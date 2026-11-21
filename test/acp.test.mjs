import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runTurn, makePrompt, probeOptions, AcpError } from '../server/acp.mjs';
import { fakeSpawn, agentScript, workScript, probeScript } from './helpers.mjs';

const BASE = { history: [], question: '测试问题', quote: '' };

test('makePrompt：首次无引用原样返回，否则打 JSON 上下文包', () => {
  assert.equal(makePrompt(BASE), '测试问题');
  const wrapped = makePrompt({
    history: [{ role: 'user', text: '旧问' }],
    question: '新问',
    quote: '引用',
  });
  assert.match(wrapped, /Continue this conversation/);
  const json = JSON.parse(wrapped.split('\n').pop());
  assert.deepEqual(json, {
    history: [{ role: 'user', text: '旧问' }],
    selectedText: '引用',
    question: '新问',
  });
  // 只有引用（无历史）也走 envelope
  const q = makePrompt({ history: [], question: '问', quote: '引' });
  assert.equal(JSON.parse(q.split('\n').pop()).selectedText, '引');
});

test('完整流程：握手→会话→流式 unicode 文本，忽略 thought/工具/异会话块', async () => {
  let promptText = null;
  const spawn = fakeSpawn(
    agentScript({
      chunks: ['你好，', '世界 🌍', '\n第二行　全角'],
      onPrompt: (msg) => {
        promptText = msg.params.prompt[0].text;
      },
      extraNotify: [
        // 思考块、工具块、其它会话的块都不该转发
        {
          sessionId: 'fake-session',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'SECRET-THOUGHT' },
          },
        },
        {
          sessionId: 'fake-session',
          update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: 't' },
        },
        {
          sessionId: 'other-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'WRONG-SESSION' },
          },
        },
      ],
    }),
  );
  const deltas = [];
  const res = await runTurn({
    ...BASE,
    spawnImpl: spawn,
    onDelta: (t) => deltas.push(t),
  });
  assert.equal(res.text, '你好，世界 🌍\n第二行　全角');
  assert.deepEqual(deltas, ['你好，', '世界 🌍', '\n第二行　全角']);
  assert.equal(promptText, '测试问题', '首次提问原样发送');
});

test('贴图：images 作为 image content block 附在文本块之后', async () => {
  let prompt = null;
  const spawn = fakeSpawn(
    agentScript({ onPrompt: (msg) => (prompt = msg.params.prompt) }),
  );
  await runTurn({
    ...BASE,
    images: [
      { data: 'QUJD', mime: 'image/png' },
      { data: 'REVG', mime: 'image/jpeg' },
    ],
    spawnImpl: spawn,
  });
  assert.equal(prompt[0].type, 'text');
  assert.equal(prompt[0].text, '测试问题');
  assert.deepEqual(prompt.slice(1), [
    { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    { type: 'image', data: 'REVG', mimeType: 'image/jpeg' },
  ]);
});

test('有历史时 prompt 为 JSON envelope', async () => {
  let promptText = null;
  const spawn = fakeSpawn(
    agentScript({ onPrompt: (msg) => (promptText = msg.params.prompt[0].text) }),
  );
  await runTurn({
    ...BASE,
    history: [{ role: 'user', text: '旧问' }],
    quote: '选段',
    spawnImpl: spawn,
  });
  const json = JSON.parse(promptText.split('\n').pop());
  assert.equal(json.selectedText, '选段');
  assert.equal(json.question, '测试问题');
});

test('权限请求一律拒绝，未知请求回 -32601', async () => {
  let captured = null;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    } else if (msg.method === 'session/prompt') {
      captured = { perm: api.request('session/request_permission', { options: [] }) };
      captured.unknown = api.request('session/fs/read_text_file', {});
      api.notify('session/update', {
        sessionId: 'fake-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '答' },
        },
      });
      // 等 client 回完权限/未知请求再结束回合
      setTimeout(() => api.respond(msg.id, { stopReason: 'end_turn' }), 20);
    }
  });
  let child;
  const wrapped = (cmd, args, opts) => (child = spawn(cmd, args, opts));
  const res = await runTurn({ ...BASE, spawnImpl: wrapped });
  assert.equal(res.text, '答');
  const perm = child.responses.get(captured.perm);
  assert.deepEqual(perm.result, { outcome: { outcome: 'cancelled' } });
  const unk = child.responses.get(captured.unknown);
  assert.equal(unk.error.code, -32601);
});

test('stopReason 非 end_turn 视为未完成', async () => {
  const spawn = fakeSpawn(agentScript({ stopReason: 'max_tokens' }));
  await assert.rejects(
    () => runTurn({ ...BASE, spawnImpl: spawn }),
    (e) => e instanceof AcpError && /未完成/.test(e.message),
  );
});

test('空回答报错，不产生内容', async () => {
  const spawn = fakeSpawn(agentScript({ chunks: [] }));
  await assert.rejects(
    () => runTurn({ ...BASE, spawnImpl: spawn }),
    (e) => e instanceof AcpError && /为空/.test(e.message),
  );
});

test('子进程中途退出 → 安全错误并终止', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    } else if (msg.method === 'session/prompt') {
      api.exit(2);
    }
  });
  await assert.rejects(
    () => runTurn({ ...BASE, spawnImpl: spawn }),
    (e) => e instanceof AcpError && /异常退出/.test(e.message),
  );
});

test('abort：立即 kill 子进程并 reject AbortError', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    }
    // prompt 不回应，模拟长任务
  });
  let child;
  const wrapped = (cmd, args, opts) => (child = spawn(cmd, args, opts));
  const controller = new AbortController();
  const p = runTurn({ ...BASE, spawnImpl: wrapped, signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(child.killed, '子进程应被 kill');
});

test('initialize 超时 → AcpError', async () => {
  const spawn = fakeSpawn(() => {});
  await assert.rejects(
    () => runTurn({ ...BASE, spawnImpl: spawn, timeouts: { request: 60, prompt: 500 } }),
    (e) => e instanceof AcpError && /超时/.test(e.message),
  );
});

test('prompt 空闲计时随流式更新顺延：活跃长回合不被中途掐断', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    } else if (msg.method === 'session/prompt') {
      const chunk = (text) =>
        api.notify('session/update', {
          sessionId: 'fake-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
      // 400ms/800ms 各一条更新（每次都重置 500ms 空闲计时），1000ms 结束回合
      setTimeout(() => chunk('半'), 400);
      setTimeout(() => chunk('程'), 800);
      setTimeout(() => api.respond(msg.id, { stopReason: 'end_turn' }), 1000);
    }
  });
  const res = await runTurn({
    ...BASE,
    spawnImpl: spawn,
    timeouts: { request: 60, prompt: 500 },
  });
  assert.equal(res.text, '半程');
});

test('prompt 期间权限等待不算卡死：用户慢决策不误杀回合', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      api.request('session/request_permission', {
        toolCall: { toolCallId: 't1', title: 'x', rawInput: {} },
        options: [],
      });
      // 等权限答复后结束回合
      setTimeout(
        () =>
          api.notify('session/update', {
            sessionId: 'fake-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '完' },
            },
          }),
        900,
      );
      setTimeout(() => api.respond(msg.id, { stopReason: 'end_turn' }), 1000);
    }
  });
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: spawn,
    timeouts: { request: 60, prompt: 500 },
    // 用户 800ms 后才决策（超过 500ms 空闲上限）：openPerms 顺延计时
    onPermission: () => new Promise((r) => setTimeout(() => r(null), 800)),
  });
  assert.equal(res.text, '完');
});

test('协议版本不符 → 拒绝', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 99, agentCapabilities: {} });
    }
  });
  await assert.rejects(
    () => runTurn({ ...BASE, spawnImpl: spawn }),
    (e) => e instanceof AcpError && /版本不兼容/.test(e.message),
  );
});

// ---------- work 模式 ----------

test('work：方法顺序 initialize→new→set_mode→prompt，返回 sessionId', async () => {
  const spawn = fakeSpawn(workScript({ sessionId: 'sid-1', chunks: ['完成'] }));
  let child;
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  assert.equal(res.text, '完成');
  assert.equal(res.sessionId, 'sid-1');
  assert.deepEqual(child.calls, [
    'initialize',
    'session/new',
    'session/set_mode',
    'session/prompt',
  ]);
  assert.deepEqual(child.spawnargs, ['devin', 'acp']);
  const setMode = child.msgs.find((m) => m.method === 'session/set_mode');
  assert.equal(setMode.params.modeId, 'accept-edits');
  assert.equal(setMode.params.sessionId, 'sid-1');
});

test('work + sessionId：session/load 原生续聊，不回放历史，回放更新不上屏', async () => {
  let promptText = null;
  const spawn = fakeSpawn(
    workScript({ onPrompt: (msg) => (promptText = msg.params.prompt[0].text) }),
  );
  let child;
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    sessionId: 'old-session',
    history: [{ role: 'user', text: '旧问' }],
    question: '新问',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  assert.deepEqual(child.calls, [
    'initialize',
    'session/load',
    'session/set_mode',
    'session/prompt',
  ]);
  assert.equal(res.sessionId, 'old-session');
  assert.equal(promptText, '新问', '原生续聊直接发问题，不打 JSON envelope');
  assert.equal(res.text, '答', 'load 回放的旧内容不进回答');
});

test('work：session/load 失败 → 可见错误，不偷换新会话', async () => {
  const spawn = fakeSpawn(workScript({ loadError: true }));
  let child;
  await assert.rejects(
    () =>
      runTurn({
        ...BASE,
        kind: 'work',
        sessionId: 'gone-session',
        spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
      }),
    (e) => e instanceof AcpError && /无法恢复/.test(e.message),
  );
  assert.ok(!child.calls.includes('session/prompt'), '失败后不发 prompt');
});

test('work：set_mode 失败 → fail closed', async () => {
  const spawn = fakeSpawn(
    workScript({ setModeError: { code: -32601, message: 'no such method' } }),
  );
  await assert.rejects(
    () => runTurn({ ...BASE, kind: 'work', spawnImpl: spawn }),
    (e) => e instanceof AcpError && /accept-edits/.test(e.message),
  );
});

test('discussion：spawn 带 --agent-type summarizer，无 sessionId 返回', async () => {
  const spawn = fakeSpawn(agentScript());
  let child;
  const res = await runTurn({
    ...BASE,
    kind: 'discussion',
    sessionId: 'should-be-ignored',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  assert.deepEqual(child.spawnargs, ['devin', 'acp', '--agent-type', 'summarizer']);
  assert.equal(res.sessionId, undefined);
  assert.deepEqual(child.calls, ['initialize', 'session/new', 'session/prompt']);
});

test('work：tool_call / tool_call_update 归一化后经 onTool 输出', async () => {
  const spawn = fakeSpawn(
    workScript({
      notifyDuringPrompt: (msg, api) => {
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc1',
            title: '读取文件',
            kind: 'read',
            status: 'in_progress',
          },
        });
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'file output' } }],
          },
        });
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'X' } },
        });
      },
    }),
  );
  const tools = [];
  await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn, onTool: (t) => tools.push(t) });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].id, 'tc1');
  assert.equal(tools[0].status, 'in_progress');
  assert.equal(tools[1].status, 'completed');
  assert.equal(tools[1].output, 'file output');
});

test('work：rawInput.command 经归一化进工具事件，其余 rawInput 字段不外泄', async () => {
  const spawn = fakeSpawn(
    workScript({
      notifyDuringPrompt: (msg, api) => {
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc2',
            title: 'Run: npm test',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'npm test -- --coverage', secret: 'should-not-leak', big: {} },
          },
        });
      },
    }),
  );
  const tools = [];
  await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn, onTool: (t) => tools.push(t) });
  assert.equal(tools[0].command, 'npm test -- --coverage');
  assert.equal(tools[0].secret, undefined, 'rawInput 其余字段不透出');
  assert.equal(tools[0].rawInput, undefined);
});

test('work：权限请求携带 rawInput.command（有界）', async () => {
  let permMsgId = null;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      permMsgId = api.request('session/request_permission', {
        toolCall: {
          title: 'Run: rm -rf build/',
          kind: 'execute',
          rawInput: { command: 'rm -rf build/ && ls', token: 'SECRET' },
        },
        options: [{ optionId: 'o1', name: '允许一次', kind: 'allow_once' }],
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
      });
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  });
  const perms = [];
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: spawn,
    onPermission: (info) => {
      perms.push(info);
      return Promise.resolve('o1');
    },
  });
  assert.equal(perms[0].command, 'rm -rf build/ && ls');
  assert.equal(perms[0].token, undefined, 'rawInput 其余字段不透出');
  assert.equal(perms[0].rawInput, undefined);
});

test('work（真实 ACP 形态）：权限请求只带 toolCallId → 从先前 tool_call 回填', async () => {
  let permMsgId = null;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      const sid = msg.params.sessionId;
      // 真实顺序：先 tool_call 更新（含标题/命令），再权限请求（只有 toolCallId）
      api.notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc9',
          title: 'Ran node',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'node --test test.mjs' },
        },
      });
      permMsgId = api.request('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'tc9', _meta: {} },
        options: [
          { optionId: 'o1', name: '允许一次', kind: 'allow_once' },
          { optionId: 'o2', name: '拒绝', kind: 'reject_once' },
        ],
      });
      api.notify('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
      });
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  });
  let child;
  const perms = [];
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    onPermission: (info) => {
      perms.push(info);
      return Promise.resolve('o1');
    },
  });
  assert.equal(perms[0].title, 'Ran node', '标题从 tool_call 回填');
  assert.equal(perms[0].toolKind, 'execute');
  assert.equal(perms[0].command, 'node --test test.mjs');
  assert.deepEqual(child.responses.get(permMsgId).result, {
    outcome: { outcome: 'selected', optionId: 'o1' },
  });
});

test('work：权限请求自带字段优先于 tool_call 快照', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      const sid = msg.params.sessionId;
      api.notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc9',
          title: 'Ran node',
          kind: 'execute',
          rawInput: { command: 'node a.mjs' },
        },
      });
      api.request('session/request_permission', {
        toolCall: { toolCallId: 'tc9', title: 'Run: custom', kind: 'execute' },
        options: [{ optionId: 'o1', name: '允许一次', kind: 'allow_once' }],
      });
      api.notify('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
      });
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  });
  const perms = [];
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: spawn,
    onPermission: (info) => {
      perms.push(info);
      return Promise.resolve('o1');
    },
  });
  assert.equal(perms[0].title, 'Run: custom', '权限请求自带标题优先');
  assert.equal(perms[0].command, 'node a.mjs', '缺失字段仍回填快照');
});

test('work：权限请求经 onPermission 决策，无自动批准', async () => {
  let permMsgId = null;
  let resolvePrompt;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      permMsgId = api.request('session/request_permission', {
        toolCall: { title: 'Run: rm -rf build/', kind: 'execute' },
        options: [
          { optionId: 'o1', name: '允许一次', kind: 'allow_once' },
          { optionId: 'o2', name: '总是允许', kind: 'allow_always' },
          { optionId: 'o3', name: '拒绝', kind: 'reject_once' },
        ],
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
      });
      resolvePrompt = () => api.respond(msg.id, { stopReason: 'end_turn' });
    }
  });
  let child;
  const perms = [];
  const turn = runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    onPermission: (info) => {
      perms.push(info);
      return new Promise((resolve) => setTimeout(() => resolve('o1'), 40));
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(perms.length, 1);
  assert.deepEqual(
    perms[0].options.map((o) => o.id),
    ['o1', 'o3'],
    'allow_always 选项被过滤',
  );
  assert.ok(!child.responses.has(permMsgId), '决策前不得自动答复 agent');
  resolvePrompt();
  const res = await turn;
  assert.equal(res.text, '好');
  // 决策 promise 于 40ms 后兑现；等它把响应写回 fake stdin 再断言
  await new Promise((r) => setTimeout(r, 80));
  const reply = child.responses.get(permMsgId);
  assert.deepEqual(reply.result, { outcome: { outcome: 'selected', optionId: 'o1' } });
});

test('work：决策 null → cancelled', async () => {
  let permMsgId = null;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 's1' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      permMsgId = api.request('session/request_permission', {
        toolCall: { title: 'x', kind: 'execute' },
        options: [{ optionId: 'o1', name: '允许一次', kind: 'allow_once' }],
      });
      api.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
      });
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  });
  let child;
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    onPermission: () => Promise.resolve(null),
  });
  assert.deepEqual(child.responses.get(permMsgId).result, {
    outcome: { outcome: 'cancelled' },
  });
});

test('work：permissionMode 透传 set_mode modeId（smart/bypass）', async () => {
  for (const mode of ['smart', 'bypass']) {
    const spawn = fakeSpawn(workScript({ sessionId: 'sid-m', chunks: ['ok'] }));
    let child;
    await runTurn({
      ...BASE,
      kind: 'work',
      permissionMode: mode,
      spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    });
    const setMode = child.msgs.find((m) => m.method === 'session/set_mode');
    assert.equal(setMode.params.modeId, mode);
  }
});

// ---------- 会话级 modelConfig → set_config_option ----------

test('work：modelConfig 非空键逐个 set_config_option，位于 set_mode 之前', async () => {
  const spawn = fakeSpawn(workScript({ sessionId: 'sid-cfg', chunks: ['ok'] }));
  let child;
  await runTurn({
    ...BASE,
    kind: 'work',
    modelConfig: { model: 'opus', thought_level: 'high', speed: 'fast' },
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  const cfgCalls = child.msgs.filter((m) => m.method === 'session/set_config_option');
  assert.equal(cfgCalls.length, 3);
  assert.deepEqual(
    cfgCalls.map((m) => [m.params.configId, m.params.value]),
    [
      ['model', 'opus'],
      ['thought_level', 'high'],
      ['speed', 'fast'],
    ],
  );
  assert.ok(cfgCalls.every((m) => m.params.sessionId === 'sid-cfg'));
  // 顺序：new → set_config_option ×3 → set_mode → prompt
  assert.deepEqual(child.calls, [
    'initialize',
    'session/new',
    'session/set_config_option',
    'session/set_config_option',
    'session/set_config_option',
    'session/set_mode',
    'session/prompt',
  ]);
});

test('work：modelConfig 空串键不下发；缺省字段也不下发', async () => {
  const spawn = fakeSpawn(workScript());
  let child;
  await runTurn({
    ...BASE,
    kind: 'work',
    modelConfig: { model: '', thought_level: 'max', speed: '' },
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  const cfgCalls = child.msgs.filter((m) => m.method === 'session/set_config_option');
  assert.equal(cfgCalls.length, 1);
  assert.equal(cfgCalls[0].params.configId, 'thought_level');
  assert.equal(cfgCalls[0].params.value, 'max');
  const spawn2 = fakeSpawn(workScript());
  let child2;
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: (c, a, o) => (child2 = spawn2(c, a, o)),
  });
  assert.ok(
    !child2.calls.includes('session/set_config_option'),
    '不传 modelConfig 时一次都不下发',
  );
});

test('work：modelConfig 对原生续聊（session/load）同样下发', async () => {
  const spawn = fakeSpawn(workScript({ replayOnLoad: false }));
  let child;
  await runTurn({
    ...BASE,
    kind: 'work',
    sessionId: 'resume-1',
    modelConfig: { speed: 'fast' },
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  const cfg = child.msgs.find((m) => m.method === 'session/set_config_option');
  assert.deepEqual(cfg.params, { sessionId: 'resume-1', configId: 'speed', value: 'fast' });
  assert.deepEqual(child.calls, [
    'initialize',
    'session/load',
    'session/set_config_option',
    'session/set_mode',
    'session/prompt',
  ]);
});

test('work：set_config_option RPC 错误 → fail closed，不发 prompt', async () => {
  const spawn = fakeSpawn(
    workScript({ setConfigError: { code: -32602, message: 'bad config value' } }),
  );
  let child;
  await assert.rejects(
    () =>
      runTurn({
        ...BASE,
        kind: 'work',
        modelConfig: { model: 'nope' },
        spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
      }),
    (e) => e instanceof AcpError && /无法应用会话配置/.test(e.message),
  );
  assert.ok(!child.calls.includes('session/prompt'), '失败后不发 prompt');
});

test('discussion：modelConfig 被忽略，不发 set_config_option', async () => {
  const spawn = fakeSpawn(agentScript());
  let child;
  await runTurn({
    ...BASE,
    kind: 'discussion',
    modelConfig: { model: 'opus', speed: 'fast' },
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  assert.ok(!child.calls.includes('session/set_config_option'));
});

// ---------- probeOptions（GET /api/devin/options 的探测体） ----------

test('probeOptions：归一化 configOptions（过滤 mode）与 available_commands_update', async () => {
  const spawn = fakeSpawn(probeScript());
  let child;
  const res = await probeOptions({
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    timeouts: { commandsWait: 500 },
  });
  assert.deepEqual(child.calls, ['initialize', 'session/new'], '不发 prompt/set_mode');
  assert.deepEqual(child.spawnargs, ['devin', 'acp']);
  // config：只保留 model/thought_level/speed（mode 被过滤）
  assert.deepEqual(Object.keys(res.config).sort(), ['model', 'speed', 'thought_level']);
  assert.equal(res.config.model.currentValue, 'adaptive');
  assert.deepEqual(res.config.model.options, [
    { value: 'adaptive', name: 'Adaptive' },
    { value: 'opus', name: 'Opus' },
  ]);
  assert.equal(res.config.speed.currentValue, 'standard');
  // commands：{name,description,hint,category} 归一化
  assert.equal(res.commands.length, 3);
  assert.deepEqual(res.commands[0], {
    name: 'compact',
    description: '压缩当前会话上下文',
    hint: '[可选说明]',
    category: 'session',
  });
  assert.equal(res.commands[2].hint, '');
  assert.equal(res.commands[2].category, '');
  assert.ok(child.killed, '探测完应 kill 子进程');
});

test('probeOptions：命令通知超时 → 空列表，不视为错误', async () => {
  const spawn = fakeSpawn(probeScript({ notifyCommands: false }));
  const res = await probeOptions({ spawnImpl: spawn, timeouts: { commandsWait: 40 } });
  assert.deepEqual(res.commands, []);
  assert.ok(res.config.model, 'configOptions 仍返回');
});

test('probeOptions：通知先于 session/new 响应到达也能收到', async () => {
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.notify('session/update', {
        sessionId: 's',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'recap', description: '回顾' }],
        },
      });
      api.respond(msg.id, { sessionId: 's', configOptions: [] });
    }
  });
  const res = await probeOptions({ spawnImpl: spawn });
  assert.deepEqual(res.commands.map((c) => c.name), ['recap']);
});

test('probeOptions：spawn 失败 / initialize 不兼容 → AcpError', async () => {
  const bad = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 99 });
    }
  });
  await assert.rejects(
    () => probeOptions({ spawnImpl: bad }),
    (e) => e instanceof AcpError && /版本不兼容/.test(e.message),
  );
  await assert.rejects(
    () =>
      probeOptions({
        spawnImpl: () => {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.stdin = new PassThrough();
          queueMicrotask(() => {
            const e = new Error('spawn devin ENOENT');
            e.code = 'ENOENT';
            child.emit('error', e);
          });
          return child;
        },
      }),
    (e) => e instanceof AcpError && /未找到 devin 命令/.test(e.message),
  );
});
