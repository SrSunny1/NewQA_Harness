import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, validateChatBody, gitSnapshot } from '../server/index.mjs';
import { fakeSpawn, agentScript, workScript, probeScript } from './helpers.mjs';

function post(base, body, headers = {}) {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function withServer(fn, opts = {}) {
  const server = createServer({
    distDir: '/nonexistent-dist',
    spawnImpl: fakeSpawn(agentScript()),
    ...opts,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close').catch(() => {});
  }
}

const VALID = { history: [], question: '你好', quote: '' };

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readEvents(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    buf += dec.decode(value || new Uint8Array(), { stream: !done });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      const ev = JSON.parse(l);
      events.push(ev);
      if (onEvent) await onEvent(ev);
    }
    if (done) break;
  }
  return events;
}

test('validateChatBody 边界', () => {
  assert.ok(validateChatBody(VALID).question);
  assert.ok(validateChatBody({ question: 'q' }).question, 'history/quote 可缺省');
  assert.ok(validateChatBody({ ...VALID, question: '' }).error);
  assert.ok(validateChatBody({ ...VALID, question: 'x'.repeat(16 * 1024 + 1) }).error);
  assert.ok(validateChatBody({ ...VALID, quote: 'x'.repeat(16 * 1024 + 1) }).error);
  assert.ok(validateChatBody({ ...VALID, history: [{}] }).error);
  assert.ok(validateChatBody({ ...VALID, history: [{ role: 'system', text: 'x' }] }).error);
  assert.ok(validateChatBody({ ...VALID, history: [{ role: 'user', text: 'x'.repeat(160 * 1024 + 1) }] }).error);
  assert.ok(
    validateChatBody({ ...VALID, history: Array(201).fill({ role: 'user', text: 'x' }) }).error,
  );
  assert.ok(validateChatBody('str').error);
  assert.ok(validateChatBody(null).error);
});

test('合法请求 → 200 NDJSON delta + done', async () => {
  await withServer(async (base) => {
    const res = await post(base, VALID);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /x-ndjson/);
    const text = await res.text();
    assert.match(text, /"type":"delta"/);
    assert.match(text, /你好/);
    assert.match(text, /"type":"done"/);
    assert.doesNotMatch(text, /"type":"error"/);
  });
});

test('非法 Origin / Host / Content-Type 被拒绝', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, VALID, { Origin: 'https://evil.example' })).status, 403);
    assert.equal(
      (await post(base, VALID, { Origin: 'http://localhost' })).status,
      403,
      'Origin host 必须与请求 Host 完全一致',
    );
    assert.equal(
      (await post(base, VALID, { Origin: 'http://127.0.0.1:1' })).status,
      403,
      '不同端口的回环 Origin 拒绝',
    );
    const okRes = await post(base, VALID, { Origin: base });
    assert.equal(okRes.status, 200, '同源 Origin 放行');
    await okRes.text();
    assert.equal(
      (
        await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
      415,
    );
    // 非回环 Host（fetch 无法改 Host，用原生 http）
    const status = await new Promise((resolve) => {
      const req = http.request(
        `${base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.end(JSON.stringify(VALID));
    });
    assert.equal(status, 403);
  });
});

test('超大 body → 413', async () => {
  await withServer(async (base) => {
    // 非 chat 端点仍限 1 MiB
    const res = await postJson(
      `${base}/api/workspace/browse`,
      ' '.repeat(1024 * 1024 + 10),
    );
    assert.equal(res.status, 413);
    // /api/chat 放宽至 28 MiB（贴图）：>1 MiB 不再被截断，落到字段校验 400
    const big = await post(base, ' '.repeat(1024 * 1024 + 10));
    assert.equal(big.status, 400);
  });
});

test('非法 JSON / 非法字段 → 400', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, '{bad json')).status, 400);
    assert.equal((await post(base, { history: [], question: '  ', quote: '' })).status, 400);
    assert.equal(
      (await post(base, { history: [{ role: 'system', text: 'x' }], question: 'q', quote: '' }))
        .status,
      400,
    );
  });
});

test('并发第二单 → 409', async () => {
  // 假 agent 永不回应 prompt，占用唯一回合
  const hanging = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (msg.method === 'session/new') api.respond(msg.id, { sessionId: 's' });
  });
  await withServer(
    async (base) => {
      const c1 = new AbortController();
      const p1 = fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID),
        signal: c1.signal,
      })
        .then(async (r) => {
          await r.text();
          return r.status;
        })
        .catch((e) => (e.name === 'AbortError' ? 'aborted' : `err:${e.message}`));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal((await post(base, VALID)).status, 409);
      c1.abort();
      await p1;
    },
    { spawnImpl: hanging },
  );
});

function getRaw(base, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${rawPath}`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('静态路由只允许 / 与 /assets/安全文件名', async () => {
  await withServer(async (base) => {
    assert.equal(await getRaw(base, '/'), 404, '无 dist → 404');
    assert.equal(await getRaw(base, '/server/index.mjs'), 404);
    assert.equal(await getRaw(base, '/assets/..%2f..%2fetc%2fpasswd'), 404);
    assert.equal(await getRaw(base, '/assets/sub%2ffile.js'), 404);
    assert.equal(await getRaw(base, '/api/chat'), 405, 'GET /api/chat 不允许');
  });
});

// ---------- 升级：workspace / kind / sessionId / permission / git ----------

test('validateChatBody 新字段校验', () => {
  assert.ok(validateChatBody({ ...VALID, kind: 'bogus' }).error);
  assert.ok(validateChatBody({ ...VALID, workspace: 'relative/dir' }).error);
  assert.ok(validateChatBody({ ...VALID, sessionId: '../etc' }).error);
  assert.ok(validateChatBody({ ...VALID, sessionId: 'a'.repeat(300) }).error);
  assert.ok(validateChatBody({ ...VALID, kind: 'work', sessionId: 'sid-123.x' }).question);
  assert.ok(validateChatBody({ ...VALID, workspace: '/abs/dir' }).question);
});

test('validateChatBody images 校验', () => {
  const ok = validateChatBody({
    ...VALID,
    images: [{ data: 'QUJD', mime: 'image/png' }],
  });
  assert.equal(ok.images.length, 1);
  assert.equal(ok.images[0].mime, 'image/png');
  assert.ok(validateChatBody({ ...VALID, images: 'x' }).error);
  assert.ok(
    validateChatBody({ ...VALID, images: Array(5).fill({ data: 'x', mime: 'image/png' }) })
      .error,
  );
  assert.ok(
    validateChatBody({ ...VALID, images: [{ data: 'QUJD', mime: 'image/svg+xml' }] }).error,
  );
  assert.ok(validateChatBody({ ...VALID, images: [{ data: '', mime: 'image/png' }] }).error);
  assert.ok(validateChatBody({ ...VALID, images: [{ data: 1 }] }).error);
});

test('非法 workspace → 400；inspect 端点行为', async () => {
  await withServer(async (base) => {
    assert.equal(
      (await post(base, { ...VALID, kind: 'work', workspace: '/nonexistent-xyz-123' })).status,
      400,
    );
    assert.equal(
      (await postJson(`${base}/api/workspace/inspect`, { path: 'relative' })).status,
      400,
    );
    assert.equal(
      (await postJson(`${base}/api/workspace/inspect`, { path: '/nonexistent-xyz-123' }))
        .status,
      400,
    );
    const ok = await postJson(`${base}/api/workspace/inspect`, { path: tmpdir() });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(typeof j.path, 'string');
    assert.equal(typeof j.git, 'boolean');
    // 新端点同样拦非本机 Origin
    assert.equal(
      (
        await fetch(`${base}/api/workspace/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: JSON.stringify({ path: tmpdir() }),
        })
      ).status,
      403,
    );
  });
});

test('work 回合 → done 带 sessionId + git 事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newqa-ws-'));
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: dir });
      assert.equal(res.status, 200);
      const events = await readEvents(res);
      const types = events.map((e) => e.type);
      const git = events.find((e) => e.type === 'git');
      const done = events.find((e) => e.type === 'done');
      assert.ok(types.includes('git') && types.indexOf('git') < types.indexOf('done'));
      assert.equal(done.sessionId, 'work-session');
      assert.equal(git.snapshot.available, false, '临时目录非 git 仓库');
    },
    { spawnImpl: fakeSpawn(workScript()) },
  );
});

test('work done 事件透传 model；无上报时键缺省', async () => {
  // session/new 上报存储模型
  const script = workScript({
    newConfigOptions: [{ id: 'model', currentValue: 'swe-2-flash-max' }],
  });
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: tmpdir() });
      assert.equal(res.status, 200);
      const events = await readEvents(res);
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.sessionId, 'work-session');
      assert.equal(done.model, 'swe-2-flash-max');
    },
    { spawnImpl: fakeSpawn(script) },
  );
  // agent 未上报 → done 不带 model 键
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: tmpdir() });
      const events = await readEvents(res);
      const done = events.find((e) => e.type === 'done');
      assert.ok(!('model' in done), '无上报时 done 不含 model 键');
      // discussion 回合同样不带
      const res2 = await post(base, { ...VALID, kind: 'discussion' });
      const done2 = (await readEvents(res2)).find((e) => e.type === 'done');
      assert.ok(!('model' in done2));
    },
    { spawnImpl: fakeSpawn(workScript()) },
  );
});

test('权限决策：404 过期 / 400 无效选项 / 200 放行', async () => {
  const permScript = (msg, api, child) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      const pid = api.request('session/request_permission', {
        toolCall: { title: 'Run: ls', kind: 'execute' },
        options: [
          { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
          { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
        ],
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答' } },
      });
      const t = setInterval(() => {
        if (child.responses.has(pid)) {
          clearInterval(t);
          clearTimeout(fallback);
          api.respond(msg.id, { stopReason: 'end_turn' });
        }
      }, 10);
      const fallback = setTimeout(() => {
        clearInterval(t);
        api.respond(msg.id, { stopReason: 'end_turn' });
      }, 5000);
    }
  };
  await withServer(
    async (base) => {
      // 无活跃回合时 → 404
      assert.equal(
        (await postJson(`${base}/api/chat/permission`, { requestId: 'nope', optionId: null }))
          .status,
        404,
      );
      const res = await post(base, { ...VALID, kind: 'work', workspace: '' });
      let decided = false;
      const events = await readEvents(res, async (ev) => {
        if (ev.type !== 'permission' || decided) return;
        decided = true;
        assert.equal(
          (
            await postJson(`${base}/api/chat/permission`, {
              requestId: 'wrong-id',
              optionId: 'allow',
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await postJson(`${base}/api/chat/permission`, {
              requestId: ev.requestId,
              optionId: 'bogus-option',
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await postJson(`${base}/api/chat/permission`, {
              requestId: ev.requestId,
              optionId: 'allow',
            })
          ).status,
          200,
        );
        // 重复决定同一 requestId → 已失效 404
        assert.equal(
          (
            await postJson(`${base}/api/chat/permission`, {
              requestId: ev.requestId,
              optionId: 'allow',
            })
          ).status,
          404,
        );
      });
      const types = events.map((e) => e.type);
      assert.ok(types.includes('permission'));
      assert.ok(types.includes('done'));
      const perm = events.find((e) => e.type === 'permission');
      assert.deepEqual(
        perm.options.map((o) => o.id),
        ['allow', 'deny'],
      );
    },
    { spawnImpl: fakeSpawn(permScript) },
  );
});

test('gitSnapshot：隔离 fixture 捕获 unstaged，应用不改文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newqa-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'v1\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir },
  );
  writeFileSync(join(dir, 'f.txt'), 'v1\nCHANGED-LINE\n');
  writeFileSync(join(dir, 'untracked.txt'), 'new\n');
  const snap = await gitSnapshot(dir);
  assert.equal(snap.available, true);
  assert.match(snap.unstaged, /CHANGED-LINE/);
  assert.match(snap.status, /M f\.txt/);
  assert.match(snap.status, /\?\? untracked\.txt/);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'v1\nCHANGED-LINE\n');
  const nogit = mkdtempSync(join(tmpdir(), 'newqa-nogit-'));
  const s2 = await gitSnapshot(nogit);
  assert.equal(s2.available, false);
});

test('/api/workspace/browse：只列目录、parent、拒绝非法/异地源', async () => {
  const root = mkdtempSync(join(tmpdir(), 'newqa-browse-'));
  const { mkdirSync, symlinkSync } = await import('node:fs');
  mkdirSync(join(root, 'adir'));
  mkdirSync(join(root, 'bdir'));
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, 'afile.txt'), 'x'); // 文件不应出现
  try {
    symlinkSync(join(root, 'adir'), join(root, 'alink'), 'dir');
  } catch {
    /* 部分平台不允许 symlink，跳过 */
  }
  await withServer(async (base) => {
    const res = await postJson(`${base}/api/workspace/browse`, { path: root });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(typeof j.path, 'string');
    const names = j.folders.map((f) => f.name);
    assert.deepEqual(names, ['adir', 'bdir']); // 隐藏/文件/符号链接都剔除
    assert.ok(j.folders.every((f) => f.path.startsWith(j.path)));
    assert.equal(j.parent, dirname(j.path));
    assert.equal(j.truncated, false);
    // 空 path → 默认目录
    const dft = await postJson(`${base}/api/workspace/browse`, {});
    assert.equal(dft.status, 200);
    assert.equal((await dft.json()).path.length > 0, true);
    // 根目录 parent 为 null
    const rr = await postJson(`${base}/api/workspace/browse`, { path: '/' });
    assert.equal((await rr.json()).parent, null);
    // 非法输入
    assert.equal(
      (await postJson(`${base}/api/workspace/browse`, { path: 'rel' })).status,
      400,
    );
    assert.equal(
      (await postJson(`${base}/api/workspace/browse`, { path: '/nonexistent-zz' })).status,
      400,
    );
    assert.equal(
      (await postJson(`${base}/api/workspace/browse`, { path: 42 })).status,
      400,
    );
    // 同源守卫
    assert.equal(
      (
        await fetch(`${base}/api/workspace/browse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: JSON.stringify({}),
        })
      ).status,
      403,
    );
    // GET 不允许
    assert.equal((await fetch(`${base}/api/workspace/browse`)).status, 405);
  });
});

test('modelConfig 校验：非对象/未知键/非字符串/超长 → 400；合法透传', async () => {
  // 纯函数层
  assert.ok(validateChatBody({ ...VALID, kind: 'work', modelConfig: 'x' }).error);
  assert.ok(validateChatBody({ ...VALID, kind: 'work', modelConfig: { bogus: 'a' } }).error);
  assert.ok(validateChatBody({ ...VALID, kind: 'work', modelConfig: { model: 42 } }).error);
  assert.ok(
    validateChatBody({ ...VALID, kind: 'work', modelConfig: { model: 'x'.repeat(129) } })
      .error,
  );
  const ok = validateChatBody({
    ...VALID,
    kind: 'work',
    modelConfig: { model: 'opus', speed: 'fast' },
  });
  assert.deepEqual(ok.modelConfig, { model: 'opus', thought_level: '', speed: 'fast' });
  // HTTP 层
  await withServer(
    async (base) => {
      assert.equal(
        (
          await post(base, { ...VALID, kind: 'work', modelConfig: { mode: 'bypass' } })
        ).status,
        400,
        '未知 configId 一律 400',
      );
      assert.equal(
        (
          await post(base, { ...VALID, kind: 'work', modelConfig: { model: 'opus' } })
        ).status,
        200,
      );
    },
    { spawnImpl: fakeSpawn(workScript()) },
  );
});

test('免费 SWE-2 家族 + 非 Standard 速度档 → 400（防快速变体静默计费）', async () => {
  const free = (model, speed) =>
    validateChatBody({ ...VALID, kind: 'work', modelConfig: { model, speed } });
  // 免费家族（swe-2 / swe-2.1 / flash / family 别名）× 新旧速度档名
  for (const model of [
    'swe-2',
    'swe-2-high',
    'swe-2-flash-medium',
    'swe-2-max',
    'swe-2-flash-max',
    'swe-2-1',
    'swe-2-1-medium',
    'swe-2-1-flash-max',
  ]) {
    for (const speed of ['fast', 'ultrafast', 'turbo']) {
      const r = free(model, speed);
      assert.match(r.error, /快速变体|Standard/, `${model} + ${speed}`);
    }
  }
  assert.ok(!free('swe-2-high', 'standard').error, 'Standard 放行');
  assert.ok(!free('swe-2-1-medium', 'standard').error, 'SWE-2.1 Standard 放行');
  assert.ok(!free('swe-2-high', '').error, '缺省速度放行');
  assert.ok(
    !free('claude-opus-5-5-medium', 'ultrafast').error,
    '付费模型 + Ultrafast 本来就有意加速，放行',
  );
  // HTTP 层：请求在 spawn 前被拒
  await withServer(async (base) => {
    const res = await post(base, {
      ...VALID,
      kind: 'work',
      modelConfig: { model: 'swe-2-1-medium', speed: 'ultrafast' },
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Standard/);
  });
});

test('work POST 带 modelConfig → set_config_option 在 set_mode 前；discussion 忽略', async () => {
  const spawn = fakeSpawn(workScript());
  let child;
  await withServer(
    async (base) => {
      const res = await post(base, {
        ...VALID,
        kind: 'work',
        modelConfig: { model: 'opus', thought_level: 'low' },
      });
      assert.equal(res.status, 200);
      await res.text();
    },
    {
      spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    },
  );
  const cfg = child.msgs.filter((m) => m.method === 'session/set_config_option');
  assert.deepEqual(
    cfg.map((m) => [m.params.configId, m.params.value]),
    [
      ['model', 'opus'],
      ['thought_level', 'low'],
    ],
  );
  assert.ok(
    child.calls.indexOf('session/set_config_option') <
      child.calls.indexOf('session/set_mode'),
  );
  // discussion：即使带 modelConfig 也不下发
  const spawn2 = fakeSpawn(agentScript());
  let child2;
  await withServer(
    async (base) => {
      const res = await post(base, {
        ...VALID,
        kind: 'discussion',
        modelConfig: { model: 'opus' },
      });
      assert.equal(res.status, 200);
      await res.text();
    },
    { spawnImpl: (c, a, o) => (child2 = spawn2(c, a, o)) },
  );
  assert.ok(!child2.calls.includes('session/set_config_option'));
});

test('GET /api/devin/options：形状 + 5min 缓存 + 守卫拒绝', async () => {
  let spawns = 0;
  const probe = fakeSpawn(probeScript());
  await withServer(
    async (base) => {
      const r1 = await fetch(`${base}/api/devin/options`);
      assert.equal(r1.status, 200);
      const j = await r1.json();
      assert.ok(Array.isArray(j.commands));
      assert.equal(j.commands[0].name, 'compact');
      assert.deepEqual(Object.keys(j.config).sort(), [
        'model',
        'speed',
        'thought_level',
      ]);
      assert.equal(j.config.model.currentValue, 'adaptive');
      assert.equal(spawns, 1);
      // 5 分钟内第二次直接命中缓存，不再 spawn
      const r2 = await fetch(`${base}/api/devin/options`);
      assert.equal(r2.status, 200);
      assert.deepEqual(await r2.json(), j);
      assert.equal(spawns, 1, '缓存命中不应再次探测');
      // POST 不允许
      assert.equal(
        (await fetch(`${base}/api/devin/options`, { method: 'POST' })).status,
        405,
      );
      // 异地 Origin 拒绝
      assert.equal(
        (
          await fetch(`${base}/api/devin/options`, {
            headers: { Origin: 'https://evil.example' },
          })
        ).status,
        403,
      );
    },
    {
      spawnImpl: (c, a, o) => {
        spawns++;
        return probe(c, a, o);
      },
    },
  );
});

test('GET /api/devin/options?model=：按模型分键探测与缓存', async () => {
  let spawns = 0;
  const opusOpts = [
    { id: 'model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }] },
    {
      id: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    },
  ];
  await withServer(
    async (base) => {
      const r1 = await fetch(`${base}/api/devin/options?model=opus`);
      assert.equal(r1.status, 200);
      const j1 = await r1.json();
      assert.deepEqual(
        j1.config.thought_level.options.map((o) => o.value),
        ['medium', 'xhigh'],
      );
      // 无参基础探测是另一把键：互不影响、各自缓存
      const r2 = await fetch(`${base}/api/devin/options`);
      assert.equal(r2.status, 200);
      const j2 = await r2.json();
      assert.deepEqual(
        j2.config.thought_level.options.map((o) => o.value),
        ['low', 'high'],
      );
      const r3 = await fetch(`${base}/api/devin/options?model=opus`);
      assert.equal(r3.status, 200);
      assert.equal(spawns, 2, '每个模型各探测一次并缓存');
    },
    {
      spawnImpl: (c, a, o) => {
        spawns++;
        // 无 model 的探测不发 set_config_option → 基础选项；
        // ?model=opus 的探测会发 → 回 opus 选项
        return fakeSpawn(
          probeScript({
            setConfigOptions: (p) => (p.configId === 'model' ? opusOpts : []),
          }),
        )(c, a, o);
      },
    },
  );
});

test('GET /api/devin/options：探测失败 → 502 中文错误，且不污染缓存', async () => {
  let fail = true;
  let spawns = 0;
  const goodProbe = fakeSpawn(probeScript());
  await withServer(
    async (base) => {
      const r1 = await fetch(`${base}/api/devin/options`);
      assert.equal(r1.status, 502);
      const j = await r1.json();
      assert.match(j.error, /退出|Devin/);
      // 失败不写缓存：换一个正常的假进程重试即成功
      fail = false;
      const r2 = await fetch(`${base}/api/devin/options`);
      assert.equal(r2.status, 200);
      assert.ok((await r2.json()).commands.length > 0);
    },
    {
      spawnImpl: (c, a, o) => {
        spawns++;
        if (fail) {
          // 进程立即异常退出 → 立即 502（不等总超时）
          const bad = fakeSpawn((msg, api) => {
            if (msg.method === 'initialize') api.exit(2);
          });
          return bad(c, a, o);
        }
        return goodProbe(c, a, o);
      },
    },
  );
  assert.equal(spawns, 2, '失败未缓存 → 重试重新探测');
});

test('permissionMode 校验：ask/plan/未知值 → 400，合法值透传', async () => {
  await withServer(async (base) => {
    for (const bad of ['ask', 'plan', 'root', '', 42]) {
      assert.equal(
        (await post(base, { ...VALID, kind: 'work', permissionMode: bad })).status,
        400,
        bad,
      );
    }
    const res = await post(base, { ...VALID, kind: 'work', permissionMode: 'smart' });
    assert.equal(res.status, 200);
    await res.text();
    // 未传 permissionMode → 默认 accept-edits（不 400）
    const res2 = await post(base, { ...VALID, kind: 'work' });
    assert.equal(res2.status, 200);
    await res2.text();
  });
});

test('/api/attachment：上传落盘 → GET 取回原图；非法输入拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newqa-attach-'));
  await withServer(
    async (base) => {
      const png = Buffer.from('fake-png-bytes').toString('base64');
      const up = await postJson(`${base}/api/attachment`, {
        images: [
          { data: png, mime: 'image/png' },
          { data: 'QUJD', mime: 'image/jpeg' },
        ],
      });
      assert.equal(up.status, 200);
      const { attachments } = await up.json();
      assert.equal(attachments.length, 2);
      assert.match(attachments[0].url, /^\/api\/attachment\/[\w-]+\.png$/);
      assert.match(attachments[1].url, /^\/api\/attachment\/[\w-]+\.jpg$/);
      // GET 取回：字节一致 + 图片 MIME + 长缓存
      const g = await fetch(`${base}${attachments[0].url}`);
      assert.equal(g.status, 200);
      assert.match(g.headers.get('content-type'), /image\/png/);
      assert.equal(await g.text(), 'fake-png-bytes');
      assert.match(g.headers.get('cache-control'), /immutable/);
      // 非法文件名 / 目录穿越 → 404
      assert.equal(await getRaw(base, '/api/attachment/nope.txt'), 404);
      assert.equal(await getRaw(base, '/api/attachment/..%2f..%2fetc'), 404);
      // 上传校验：空表 / 超量 / 非法 mime / 缺 data
      assert.equal(
        (await postJson(`${base}/api/attachment`, { images: [] })).status,
        400,
      );
      assert.equal(
        (
          await postJson(`${base}/api/attachment`, {
            images: Array(5).fill({ data: 'QUJD', mime: 'image/png' }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await postJson(`${base}/api/attachment`, {
            images: [{ data: 'QUJD', mime: 'image/svg+xml' }],
          })
        ).status,
        400,
      );
      assert.equal(
        (await postJson(`${base}/api/attachment`, { images: [{}] })).status,
        400,
      );
      // 方法守卫
      assert.equal(
        (await fetch(`${base}/api/attachment`)).status,
        405,
        'GET /api/attachment（无文件名）不允许',
      );
    },
    { attachDir: dir },
  );
});
