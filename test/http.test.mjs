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

// 可控节奏的假 agent：prompt 先吐「前半」，响应由测试经 release 触发
function controlledSpawn(releaseRef) {
  return fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/prompt') {
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '前半' } },
      });
      releaseRef.current = () => {
        api.notify('session/update', {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '后半' } },
        });
        api.respond(msg.id, { stopReason: 'end_turn' });
      };
    }
  });
}

test('断连不杀回合：attach 重放缓冲并追 live 至 done；turnId 精确绑定', async () => {
  const releaseRef = { current: null };
  await withServer(
    async (base) => {
      const c1 = new AbortController();
      const res1 = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...VALID, convId: 'cv1', turnId: 't-cv1' }),
        signal: c1.signal,
      });
      assert.equal(res1.status, 200);
      await new Promise((r) => setTimeout(r, 80)); // 让「前半」进缓冲
      c1.abort(); // 模拟刷新断连——不应杀回合
      res1.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 40));
      // turnId 不匹配 → 404，不误挂别人/别的回合
      assert.equal(
        (await postJson(`${base}/api/chat/attach`, { convId: 'cv1', turnId: 'wrong' }))
          .status,
        404,
      );
      // turnId 形状非法 → 400
      assert.equal(
        (await postJson(`${base}/api/chat/attach`, { convId: 'cv1', turnId: 'bad id' }))
          .status,
        400,
      );
      // 旧客户端不带 turnId → 按 convId 回退匹配
      const resLegacy = await postJson(`${base}/api/chat/attach`, { convId: 'cv1' });
      assert.equal(resLegacy.status, 200);
      // attach：回合应仍在跑，先重放「前半」
      const res2 = await postJson(`${base}/api/chat/attach`, {
        convId: 'cv1',
        turnId: 't-cv1',
      });
      assert.equal(res2.status, 200);
      // stop 带错 turnId → 404，不中止仍在跑的回合
      assert.equal(
        (await postJson(`${base}/api/chat/stop`, { convId: 'cv1', turnId: 'other' }))
          .status,
        404,
      );
      await new Promise((r) => setTimeout(r, 40));
      releaseRef.current?.(); // 后半 + 完成，应经 live 流到达
      const text = await res2.text();
      assert.match(text, /前半/);
      assert.match(text, /后半/);
      assert.match(text, /"type":"done"/);
      assert.doesNotMatch(text, /"type":"error"/);
      // 不带 turnId 的兼容 attach 也追到了完整流
      const legacyText = await resLegacy.text();
      assert.match(legacyText, /后半/);
      assert.match(legacyText, /"type":"done"/);
    },
    { spawnImpl: controlledSpawn(releaseRef) },
  );
});

test('attach 已完结回合：重放终态事件后流结束；未知 convId → 404', async () => {
  await withServer(async (base) => {
    const res1 = await post(base, { ...VALID, convId: 'cv2' });
    const start = Number(res1.headers.get('X-NewQA-Turn-Started-At'));
    assert.ok(Number.isSafeInteger(start) && start > 0);
    const done = (await readEvents(res1)).find((ev) => ev.type === 'done');
    assert.ok(Number.isSafeInteger(done?.durationMs) && done.durationMs >= 0);
    // 回合已 done 但回放缓冲仍在 TTL 内：attach 重放后 end
    const res2 = await postJson(`${base}/api/chat/attach`, { convId: 'cv2' });
    assert.equal(res2.status, 200);
    assert.equal(Number(res2.headers.get('X-NewQA-Turn-Started-At')), start);
    assert.deepEqual((await readEvents(res2)).find((ev) => ev.type === 'done'), done);
    // 未知 convId
    assert.equal((await postJson(`${base}/api/chat/attach`, { convId: 'nope' })).status, 404);
    assert.equal((await postJson(`${base}/api/chat/stop`, { convId: 'nope' })).status, 404);
    // 非法输入
    assert.equal((await postJson(`${base}/api/chat/attach`, {})).status, 400);
    assert.equal(
      (
        await fetch(`${base}/api/chat/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
      415,
    );
  });
});

test('stop 端点中止回合 → 广播 stopped 收尾；turnId 不匹配/重复 stop → 404', async () => {
  // 假 agent 永不响应 prompt
  const hanging = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    else if (msg.method === 'session/new') api.respond(msg.id, { sessionId: 's' });
  });
  await withServer(
    async (base) => {
      const res1 = await post(base, { ...VALID, convId: 'cv9', turnId: 't-cv9' });
      assert.equal(res1.status, 200);
      await new Promise((r) => setTimeout(r, 80));
      // turnId 不匹配 → 404 且不停仍在跑的回合（后续正确 stop 仍能命中）
      assert.equal(
        (await postJson(`${base}/api/chat/stop`, { convId: 'cv9', turnId: 'stale' }))
          .status,
        404,
      );
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(
        (await postJson(`${base}/api/chat/stop`, { convId: 'cv9', turnId: 't-cv9' }))
          .status,
        200,
      );
      const text = await res1.text();
      assert.match(text, /"type":"stopped"/);
      assert.doesNotMatch(text, /"type":"done"/);
      // 已收尾：重复 stop → 404（无论带不带 turnId）
      assert.equal((await postJson(`${base}/api/chat/stop`, { convId: 'cv9' })).status, 404);
      assert.equal(
        (await postJson(`${base}/api/chat/stop`, { convId: 'cv9', turnId: 't-cv9' }))
          .status,
        404,
      );
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
  // turnId：可缺省；非法形状拒绝；合法透传
  assert.equal(validateChatBody(VALID).turnId, '', '缺省 turnId 归一为空串');
  assert.equal(validateChatBody({ ...VALID, turnId: 't-ok_1' }).turnId, 't-ok_1');
  assert.ok(validateChatBody({ ...VALID, turnId: 42 }).error);
  assert.ok(validateChatBody({ ...VALID, turnId: 'a'.repeat(81) }).error);
  assert.ok(validateChatBody({ ...VALID, turnId: 'bad id!' }).error);
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

test('work session/load RPC 拒绝 → error 事件带 session_load_failed 码、无 done', async () => {
  await withServer(
    async (base) => {
      const res = await post(base, {
        ...VALID,
        kind: 'work',
        workspace: '',
        sessionId: 'gone-session',
      });
      assert.equal(res.status, 200, '开流后才失败 → 仍是 200 NDJSON');
      const events = await readEvents(res);
      const err = events.find((e) => e.type === 'error');
      assert.ok(err, '应有 error 事件');
      assert.equal(err.code, 'session_load_failed');
      assert.match(err.message, /无法恢复/);
      assert.ok(!events.some((e) => e.type === 'done'), '失败回合无 done');
    },
    { spawnImpl: fakeSpawn(workScript({ loadError: true })) },
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

test('/api/workspace/mkdir：建目录/重名 409/校验拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newqa-mkdir-'));
  await withServer(async (base) => {
    // 正常创建一级目录
    const ok = await postJson(`${base}/api/workspace/mkdir`, {
      path: join(dir, 'proj-new'),
    });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.path, join(dir, 'proj-new'));
    const st = await import('node:fs/promises').then((m) => m.stat(j.path));
    assert.ok(st.isDirectory(), '磁盘上真的建出来了');
    // 重名 → 409
    assert.equal(
      (await postJson(`${base}/api/workspace/mkdir`, { path: join(dir, 'proj-new') })).status,
      409,
    );
    // 校验：相对路径/缺失/非法段/非 JSON 方法
    assert.equal((await postJson(`${base}/api/workspace/mkdir`, { path: 'rel/x' })).status, 400);
    assert.equal((await postJson(`${base}/api/workspace/mkdir`, {})).status, 400);
    assert.equal(
      (await postJson(`${base}/api/workspace/mkdir`, { path: `${dir}/a/../b` })).status,
      400,
    );
    assert.equal((await fetch(`${base}/api/workspace/mkdir`)).status, 405);
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

// ---------- elicitation（agent 提问） ----------

function eliScript() {
  return (msg, api, child) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      const eid = api.request('elicitation/create', {
        mode: 'form',
        sessionId: 's1',
        message: 'Which color?',
        requestedSchema: {
          type: 'object',
          required: ['q0'],
          properties: {
            q0: {
              type: 'string',
              title: 'Color',
              oneOf: [{ const: 'red', title: '红色' }, { const: 'blue', title: '蓝色' }],
            },
            q1: { type: 'string', title: '备注' },
          },
        },
        _meta: { 'cognition.ai/allowOther': false, 'cognition.ai/toolCallId': 'tc1' },
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '问' } },
      });
      const t = setInterval(() => {
        if (child.responses.has(eid)) {
          clearInterval(t);
          clearTimeout(fallback);
          api.notify('session/update', {
            sessionId: 's1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: JSON.stringify(child.responses.get(eid).result) },
            },
          });
          api.respond(msg.id, { stopReason: 'end_turn' });
        }
      }, 10);
      const fallback = setTimeout(() => {
        clearInterval(t);
        api.respond(msg.id, { stopReason: 'end_turn' });
      }, 5000);
    }
  };
}

test('elicitation 链路：事件广播 + 决策回传 agent + 错误分支', async () => {
  await withServer(
    async (base) => {
      // 无活跃提问 → 404
      assert.equal(
        (
          await postJson(`${base}/api/chat/elicitation`, {
            requestId: 'nope',
            action: 'cancel',
          })
        ).status,
        404,
      );
      const res = await post(base, { ...VALID, kind: 'work', workspace: '' });
      let decided = false;
      const events = await readEvents(res, async (ev) => {
        if (ev.type !== 'elicitation' || decided) return;
        decided = true;
        // 缺 requestId → 400
        assert.equal(
          (await postJson(`${base}/api/chat/elicitation`, { action: 'accept' })).status,
          400,
        );
        // 错误 requestId → 404
        assert.equal(
          (
            await postJson(`${base}/api/chat/elicitation`, {
              requestId: 'wrong',
              action: 'accept',
            })
          ).status,
          404,
        );
        // 正常 accept（带 content + 超长/多余键应被有界清洗）
        assert.equal(
          (
            await postJson(`${base}/api/chat/elicitation`, {
              requestId: ev.requestId,
              action: 'accept',
              content: { q0: 'blue', q1: 'y'.repeat(5000), junk: 'evil' },
            })
          ).status,
          200,
        );
        // 重复作答 → 404
        assert.equal(
          (
            await postJson(`${base}/api/chat/elicitation`, {
              requestId: ev.requestId,
              action: 'accept',
            })
          ).status,
          404,
        );
      });
      const eli = events.find((e) => e.type === 'elicitation');
      assert.ok(eli, '应有 elicitation 事件');
      assert.equal(eli.message, 'Which color?');
      assert.equal(eli.fields[0].kind, 'select');
      assert.equal(eli.fields[0].required, true);
      assert.equal(eli.fields[0].options.length, 2);
      // agent 收到的应答：accept + 清洗后的 content（junk 被裁到 2000 字符内）
      const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
      const m = deltas.match(/\{.*\}/s);
      assert.ok(m, 'agent 应答应出现在文本里');
      const reply = JSON.parse(m[0]);
      assert.equal(reply.action, 'accept');
      assert.equal(reply.content.q0, 'blue');
      assert.equal(reply.content.junk, undefined, '非 schema 键应被剥离');
      assert.equal(reply.content.q1.length, 2000, '超长值应被截断到 2000');
      assert.ok(events.some((e) => e.type === 'done'));
    },
    { spawnImpl: fakeSpawn(eliScript()) },
  );
});

test('elicitation decline/cancel：动作原样回传，content 不回传', async () => {
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: '' });
      let decided = false;
      const events = await readEvents(res, async (ev) => {
        if (ev.type !== 'elicitation' || decided) return;
        decided = true;
        await postJson(`${base}/api/chat/elicitation`, {
          requestId: ev.requestId,
          action: 'decline',
          content: { q0: 'blue' },
        });
      });
      const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
      const reply = JSON.parse(deltas.match(/\{.*\}/s)[0]);
      assert.equal(reply.action, 'decline');
      assert.equal(reply.content, undefined);
    },
    { spawnImpl: fakeSpawn(eliScript()) },
  );
});

test('elicitation 无人作答：回合结束自动 cancel', async () => {
  // agent 提问后不等待答复、直接结束回合：回合收尾时应自动 cancel 未答提问
  const noWaitScript = (msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      api.request('elicitation/create', {
        mode: 'form',
        sessionId: 's1',
        message: 'Which color?',
        requestedSchema: {
          type: 'object',
          properties: {
            q0: { type: 'string', oneOf: [{ const: 'red' }, { const: 'blue' }] },
          },
        },
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答' } },
      });
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  };
  const spawnBase = fakeSpawn(noWaitScript);
  let child;
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: '' });
      const events = await readEvents(res);
      assert.ok(events.some((e) => e.type === 'elicitation'));
      assert.ok(events.some((e) => e.type === 'done'));
      // 给自动 cancel 的写入留出拍头发送时间
      await new Promise((r) => setTimeout(r, 50));
      const results = [...child.responses.values()].map((m) => m.result);
      assert.ok(
        results.some((r) => r && r.action === 'cancel'),
        '回合结束未答的提问应收到 cancel',
      );
    },
    { spawnImpl: (c, a, o) => (child = spawnBase(c, a, o)) },
  );
});

test('elicitation 已解决后 attach 重放不再复活提问', async () => {
  let firstStream = null;
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: '' });
      firstStream = res;
      let decided = false;
      const events = await readEvents(res, async (ev) => {
        if (ev.type !== 'elicitation' || decided) return;
        decided = true;
        // 作答后立刻 attach：已解决的提问不应重放
        await postJson(`${base}/api/chat/elicitation`, {
          requestId: ev.requestId,
          action: 'accept',
          content: { q0: 'red' },
        });
        const pid = ev.pid;
        const attach = await fetch(`${base}/api/chat/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid }),
        });
        const replayed = await readEvents(attach);
        assert.ok(
          !replayed.some((e) => e.type === 'elicitation'),
          '已作答的提问不应在重放中复活',
        );
      });
      assert.ok(events.some((e) => e.type === 'done'));
    },
    { spawnImpl: fakeSpawn(eliScript()) },
  );
});

test('role/model 事件透传：fusion 模型上报 model 与 role', async () => {
  const roleScript = (msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, {
        sessionId: 's1',
        configOptions: [
          { id: 'model', currentValue: 'fusion-opus-5-5-sidekick-swe-2-medium', options: [] },
        ],
      });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      api.notify('session/update', {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Ran explore subagent',
          rawInput: { profile: 'subagent_explore' },
          _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
        },
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答' } },
      });
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  };
  await withServer(
    async (base) => {
      const res = await post(base, { ...VALID, kind: 'work', workspace: '' });
      const events = await readEvents(res);
      const model = events.find((e) => e.type === 'model');
      assert.ok(model, '应有 model 事件');
      assert.equal(model.model, 'fusion-opus-5-5-sidekick-swe-2-medium');
      const roles = events.filter((e) => e.type === 'role').map((e) => e.role);
      assert.ok(roles.includes('sidekick'), 'subagent 委派应产生 sidekick 角色事件');
    },
    { spawnImpl: fakeSpawn(roleScript) },
  );
});
