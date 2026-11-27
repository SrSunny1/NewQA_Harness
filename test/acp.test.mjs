import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  runTurn,
  makePrompt,
  probeOptions,
  AcpError,
  AcpSessionLoadError,
  DISCUSSION_MODEL,
} from '../server/acp.mjs';
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

test('work + sessionId：session/load 原生续聊，空历史直发、支线记录走 envelope', async () => {
  let promptText = null;
  const spawn = fakeSpawn(
    workScript({ onPrompt: (msg) => (promptText = msg.params.prompt[0].text) }),
  );
  let child;
  // 无支线时 history=[]（主线原生会话已有）→ 原样发问题
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    sessionId: 'old-session',
    history: [],
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
  assert.equal(promptText, '新问', '原生续聊空历史直接发问题');
  assert.equal(res.text, '答', 'load 回放的旧内容不进回答');
  // 有支线时 history=支线记录 → JSON envelope 一起发
  const res2 = await runTurn({
    ...BASE,
    kind: 'work',
    sessionId: 'old-session',
    history: [{ role: 'assistant', text: '[支线追问] 围绕「x」\n问：a\n答：b' }],
    question: '再问',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  assert.ok(promptText.startsWith('Continue this conversation.'), '支线记录走 envelope');
  assert.match(promptText, /支线追问/);
  assert.equal(res2.sessionId, 'old-session');
});

test('work：session/load RPC 拒绝 → AcpSessionLoadError，不偷换新会话/不发 prompt', async () => {
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
    (e) =>
      e instanceof AcpSessionLoadError &&
      /无法恢复/.test(e.message) &&
      /重试时将使用当前对话的记录继续/.test(e.message),
  );
  assert.ok(!child.calls.includes('session/new'), '不暗开新会话顶替');
  assert.ok(!child.calls.includes('session/prompt'), '失败后不发 prompt');
});

test('work：session/load 非 RPC 失败（进程退出/超时）→ 普通 AcpError，保留会话语义', async () => {
  // 进程在 load 期间退出：fatal 直接收口，不是「会话失效」，不带重试降级语义
  const exitSpawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/load') {
      api.exit(2);
    }
  });
  await assert.rejects(
    () =>
      runTurn({
        ...BASE,
        kind: 'work',
        sessionId: 'gone-session',
        spawnImpl: exitSpawn,
      }),
    (e) =>
      e instanceof AcpError &&
      !(e instanceof AcpSessionLoadError) &&
      /进程异常退出/.test(e.message),
  );
  // load 超时走 catch：包装为「暂时无法加载」，同样区分于 RPC 拒绝
  const hangSpawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    }
  });
  await assert.rejects(
    () =>
      runTurn({
        ...BASE,
        kind: 'work',
        sessionId: 'gone-session',
        spawnImpl: hangSpawn,
        timeouts: { request: 60 },
      }),
    (e) =>
      e instanceof AcpError &&
      !(e instanceof AcpSessionLoadError) &&
      /暂时无法加载/.test(e.message),
  );
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

test('discussion：固定免费档模型，忽略 sessionId，无 sessionId 返回', async () => {
  const spawn = fakeSpawn(agentScript());
  let child;
  const res = await runTurn({
    ...BASE,
    kind: 'discussion',
    sessionId: 'should-be-ignored',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  assert.deepEqual(child.spawnargs, [
    'devin',
    'acp',
    '--agent-type',
    'summarizer',
    '--model',
    DISCUSSION_MODEL,
  ]);
  // 默认值必须是免费档精确 SKU（Fusion/lightning 都不允许）
  assert.match(DISCUSSION_MODEL, /^swe-2(?:-flash)?-(?:medium|high|max)$/);
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

test('work：会话无 speed 选项（付费模型）→ speed 跳过不发、回合正常', async () => {
  // Gemini 等付费模型的 configOptions 没有 speed 项；发 'standard' 会
  // 被服务端拒绝——应识别为"无法兑现"直接跳过，不阻断回合。
  const gemOpts = [
    { id: 'mode', currentValue: 'accept-edits', options: [] },
    {
      id: 'model',
      currentValue: 'gemini-4-carbon-medium',
      options: [{ value: 'gemini-4-carbon-medium' }],
    },
    { id: 'thought_level', currentValue: 'medium', options: [{ value: 'medium' }] },
  ];
  const spawn = fakeSpawn(
    workScript({ newConfigOptions: gemOpts, setConfigOptions: gemOpts }),
  );
  let child;
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    modelConfig: { model: 'gemini-4-carbon-medium', thought_level: 'medium', speed: 'standard' },
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  const cfgs = child.msgs.filter((m) => m.method === 'session/set_config_option');
  assert.deepEqual(
    cfgs.map((m) => m.params.configId),
    ['model', 'thought_level'],
    'speed 选项缺失 → 未下发',
  );
  assert.equal(res.text, '答');
  assert.deepEqual(child.calls.at(-1), 'session/prompt');
});

test('work：thought_level 值不在该模型列表（如无 xhigh）→ 跳过不发', async () => {
  // 该会话的 thought_level 只有 low/high——存量的 xhigh/max 无法兑现，
  // 应跳过而不是让 set_config_option 报错终止回合；model 仍 fail closed。
  const opts = [
    { id: 'model', currentValue: 'opus', options: [{ value: 'opus' }] },
    {
      id: 'thought_level',
      currentValue: 'high',
      options: [{ value: 'low' }, { value: 'high' }],
    },
  ];
  const spawn = fakeSpawn(
    workScript({ newConfigOptions: opts, setConfigOptions: opts }),
  );
  let child;
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    modelConfig: { model: 'opus', thought_level: 'xhigh', speed: '' },
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
  });
  const cfgs = child.msgs.filter((m) => m.method === 'session/set_config_option');
  assert.deepEqual(
    cfgs.map((m) => m.params.configId),
    ['model'],
    'thought_level=xhigh 不在列表 → 未下发',
  );
  assert.equal(res.text, '答');
  assert.equal(child.calls.at(-1), 'session/prompt');
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

// ---------- 模型透明度：effectiveModel ----------

test('work：model 取自 session/new 与 set_config_option 响应的 configOptions', async () => {
  // session/new 上报存储模型；set_config_option 响应回全量 configOptions
  const spawn = fakeSpawn(
    workScript({
      sessionId: 'sid-m',
      chunks: ['ok'],
      newConfigOptions: [
        { id: 'model', currentValue: 'stored-m0', options: [] },
        { id: 'speed', currentValue: 'standard', options: [] },
      ],
      setConfigOptions: (params) => [
        { id: 'model', currentValue: params.configId === 'model' ? params.value : 'stored-m0' },
      ],
    }),
  );
  // 无覆盖：用 session/new 上报的模型
  const res1 = await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn });
  assert.equal(res1.model, 'stored-m0');
  // 下发 model=opus-b：以 set_config_option 响应的 currentValue 为准
  const spawn2 = fakeSpawn(
    workScript({
      chunks: ['ok'],
      newConfigOptions: [{ id: 'model', currentValue: 'stored-m0' }],
      setConfigOptions: (params) => [
        { id: 'model', currentValue: params.configId === 'model' ? params.value : 'stored-m0' },
      ],
    }),
  );
  const res2 = await runTurn({
    ...BASE,
    kind: 'work',
    modelConfig: { model: 'opus-b' },
    spawnImpl: spawn2,
  });
  assert.equal(res2.model, 'opus-b');
});

test('work：session/load 的 configOptions 给出续聊会话的存储模型', async () => {
  const spawn = fakeSpawn(
    workScript({
      replayOnLoad: false,
      chunks: ['ok'],
      loadConfigOptions: [
        { id: 'model', currentValue: 'fusion-gpt-6-2-sol-high-sidekick-swe-2-high' },
      ],
    }),
  );
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    sessionId: 'old-session',
    spawnImpl: spawn,
  });
  assert.equal(res.model, 'fusion-gpt-6-2-sol-high-sidekick-swe-2-high');
});

test('work：config_option_update 覆盖先前来源', async () => {
  const spawn = fakeSpawn(
    workScript({
      sessionId: 'sid-u',
      chunks: ['好'],
      newConfigOptions: [{ id: 'model', currentValue: 'm0' }],
      notifyDuringPrompt: (msg, api) => {
        const sid = msg.params.sessionId;
        // configOption 形状：{configOption:{id,currentValue}}
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'config_option_update',
            configOption: { id: 'model', currentValue: 'm-live' },
          },
        });
      },
    }),
  );
  const res = await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn });
  assert.equal(res.model, 'm-live', '回合中的 config_option_update 覆盖 session/new 的值');
});

test('work：无上报时 model 为 null', async () => {
  const spawn = fakeSpawn(workScript({ chunks: ['答'] }));
  const res = await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn });
  assert.equal(res.model, null);
});

test('discussion：即使 agent 上报 configOptions 也不返回 model', async () => {
  const spawn = fakeSpawn(
    agentScript({
      chunks: ['答'],
      extraNotify: [
        {
          sessionId: 'fake-session',
          update: {
            sessionUpdate: 'config_option_update',
            configOption: { id: 'model', currentValue: 'm-live' },
          },
        },
      ],
    }),
  );
  const res = await runTurn({ ...BASE, kind: 'discussion', spawnImpl: spawn });
  assert.equal(res.model, null);
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

test('probeOptions：传 model → 先 set_config_option 再取该模型的选项', async () => {
  // opus 会话只提供 medium/xhigh（无 max、无 speed 组）
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
  const spawn = fakeSpawn(probeScript({ setConfigOptions: opusOpts }));
  let child;
  const res = await probeOptions({
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    model: 'opus',
  });
  const setCfg = child.msgs.find((m) => m.method === 'session/set_config_option');
  assert.deepEqual(setCfg.params, {
    sessionId: 'probe-session',
    configId: 'model',
    value: 'opus',
  });
  assert.deepEqual(
    res.config.thought_level.options.map((o) => o.value),
    ['medium', 'xhigh'],
    '返回该模型实际提供的思考档',
  );
  assert.equal(res.config.speed, undefined, '该模型不暴露 speed 组');
  // set_config_option 失败 → 回落 session/new 的基础选项，不报错
  const spawnBad = fakeSpawn(
    probeScript({ setConfigError: { code: -32602, message: 'bad model' } }),
  );
  const res2 = await probeOptions({ spawnImpl: spawnBad, model: 'nope' });
  assert.equal(res2.config.model.currentValue, 'adaptive');
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

// ---------- elicitation（agent 提问） ----------

import { normalizeElicitation, sanitizeElicitationContent } from '../server/acp.mjs';

test('normalizeElicitation：select/multi/text 三种字段 + allowOther + 有界', () => {
  const info = normalizeElicitation({
    mode: 'form',
    message: '哪个颜色？',
    requestedSchema: {
      type: 'object',
      required: ['q0'],
      properties: {
        q0: {
          type: 'string',
          title: 'Color',
          description: 'Which color?',
          oneOf: [
            { const: 'red', title: '红色', _meta: { 'cognition.ai/description': 'Prefer red' } },
            { const: 'blue', title: '蓝色' },
          ],
        },
        q1: {
          type: 'array',
          title: 'Tags',
          items: { oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] },
        },
        q2: { type: 'string', title: '备注' },
      },
    },
    _meta: { 'cognition.ai/allowOther': true, 'cognition.ai/toolCallId': 'call_x' },
  });
  assert.equal(info.message, '哪个颜色？');
  assert.equal(info.allowOther, true);
  assert.equal(info.toolCallId, 'call_x');
  const [f0, f1, f2] = info.fields;
  assert.equal(f0.kind, 'select');
  assert.equal(f0.required, true);
  assert.deepEqual(f0.options[0], { value: 'red', label: '红色', description: 'Prefer red' });
  assert.equal(f1.kind, 'multi');
  assert.equal(f1.options.length, 2);
  assert.equal(f2.kind, 'text');
  // 缺 schema/字段为空 → null
  assert.equal(normalizeElicitation({}), null);
  assert.equal(normalizeElicitation({ requestedSchema: { properties: {} } }), null);
});

test('sanitizeElicitationContent：只留 schema 键，multi 滤非字符串', () => {
  const info = normalizeElicitation({
    message: 'm',
    requestedSchema: {
      type: 'object',
      properties: {
        q0: { type: 'string', oneOf: [{ const: 'red' }] },
        q1: { type: 'array', items: { enum: ['a', 'b'] } },
      },
    },
  });
  const out = sanitizeElicitationContent(info, {
    q0: 'red',
    q1: ['a', 42, 'b'],
    evil: 'x'.repeat(9000),
  });
  assert.deepEqual(out, { q0: 'red', q1: ['a', 'b'] });
  assert.equal(out.evil, undefined);
});

test('elicitation：work 模式转交 onElicitation，accept 应答回传 schema 内内容', async () => {
  let captured = null;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      captured = api.request('elicitation/create', {
        mode: 'form',
        sessionId: 'fake-session',
        message: 'Which color?',
        requestedSchema: {
          type: 'object',
          required: ['q0'],
          properties: {
            q0: {
              type: 'string',
              title: 'Color',
              oneOf: [{ const: 'red', title: 'red' }, { const: 'blue', title: 'blue' }],
            },
          },
        },
        _meta: { 'cognition.ai/allowOther': true },
      });
      setTimeout(() => {
        api.notify('session/update', {
          sessionId: 'fake-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完' } },
        });
        api.respond(msg.id, { stopReason: 'end_turn' });
      }, 30);
    }
  });
  let child;
  const wrapped = (c, a, o) => (child = spawn(c, a, o));
  const infos = [];
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: wrapped,
    onElicitation: (info) => {
      infos.push(info);
      return Promise.resolve({ action: 'accept', content: { q0: 'blue', evil: 'x' } });
    },
  });
  assert.equal(res.text, '完');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].message, 'Which color?');
  assert.equal(infos[0].fields[0].kind, 'select');
  assert.equal(infos[0].allowOther, true);
  const reply = child.responses.get(captured);
  assert.deepEqual(reply.result, { action: 'accept', content: { q0: 'blue' } });
});

test('elicitation：无 hook（discussion）一律 cancel；work 无 hook 也 cancel', async () => {
  for (const kind of ['discussion', 'work']) {
    let captured = null;
    const spawn = fakeSpawn((msg, api) => {
      if (msg.method === 'initialize') {
        api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
      } else if (msg.method === 'session/new') {
        api.respond(msg.id, { sessionId: 'fake-session' });
      } else if (msg.method === 'session/set_mode') {
        api.respond(msg.id, {});
      } else if (msg.method === 'session/prompt') {
        captured = api.request('elicitation/create', {
          mode: 'form',
          message: 'q?',
          requestedSchema: {
            type: 'object',
            properties: { q0: { type: 'string', oneOf: [{ const: 'a' }] } },
          },
        });
        setTimeout(() => {
          api.notify('session/update', {
            sessionId: 'fake-session',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完' } },
          });
          api.respond(msg.id, { stopReason: 'end_turn' });
        }, 30);
      }
    });
    let child;
    await runTurn({ ...BASE, kind, spawnImpl: (c, a, o) => (child = spawn(c, a, o)) });
    const reply = child.responses.get(captured);
    assert.deepEqual(reply.result, { action: 'cancel' }, `${kind} 无 hook 应 cancel`);
  }
});

test('elicitation：work+hook 才声明能力；discussion 与无 hook 不声明', async () => {
  for (const [kind, hook, expectCap] of [
    ['work', true, true],
    ['work', false, false],
    ['discussion', true, false],
  ]) {
    const spawn = fakeSpawn(workScript({}));
    let child;
    await runTurn({
      ...BASE,
      kind,
      spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
      ...(hook ? { onElicitation: () => Promise.resolve(null) } : {}),
    });
    const init = child.msgs.find((m) => m.method === 'initialize');
    const cap = init.params.clientCapabilities?.elicitation?.form;
    assert.equal(!!cap, expectCap, `kind=${kind} hook=${hook} 能力声明应为 ${expectCap}`);
  }
});

test('elicitation：回合 abort 时未答提问收到 cancel', async () => {
  let captured = null;
  const spawn = fakeSpawn((msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId: 'fake-session' });
    } else if (msg.method === 'session/set_mode') {
      api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      captured = api.request('elicitation/create', {
        mode: 'form',
        message: 'q?',
        requestedSchema: {
          type: 'object',
          properties: { q0: { type: 'string', oneOf: [{ const: 'a' }] } },
        },
      });
      // 永不结束回合：等 client abort
    }
  });
  let child;
  const controller = new AbortController();
  const p = runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: (c, a, o) => (child = spawn(c, a, o)),
    signal: controller.signal,
    onElicitation: () => new Promise(() => {}), // 用户始终不答
  });
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await assert.rejects(p);
  const reply = child.responses.get(captured);
  assert.deepEqual(reply.result, { action: 'cancel' });
});

// ---------- fusion 角色指示 ----------

test('fusion：run_subagent 工具事件触发 sidekick 角色，普通工具回 lead', async () => {
  const spawn = fakeSpawn(
    workScript({
      newConfigOptions: [
        { id: 'model', currentValue: 'fusion-opus-sidekick-swe-2-medium', options: [] },
      ],
      notifyDuringPrompt: (msg, api) => {
        const sid = msg.params.sessionId;
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            title: 'Ran explore subagent x',
            rawInput: { profile: 'subagent_explore' },
            _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
          },
        });
      },
    }),
  );
  const roles = [];
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: spawn,
    onRole: (r) => roles.push(r),
  });
  assert.deepEqual(roles, ['sidekick', 'lead'], '委派时切 sidekick，lead 继续流式后切回');
});

test('fusion：非 fusion 模型不上报角色；_meta sidekick 标记优先', async () => {
  // 非 fusion：无任何 role 事件
  const spawn1 = fakeSpawn(
    workScript({
      newConfigOptions: [{ id: 'model', currentValue: 'swe-2-1-medium', options: [] }],
      notifyDuringPrompt: (msg, api) => {
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            rawInput: { profile: 'subagent_explore' },
            _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
          },
        });
      },
    }),
  );
  const roles1 = [];
  await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn1, onRole: (r) => roles1.push(r) });
  assert.deepEqual(roles1, []);
  // fusion + _meta 显式 sidekick：chunk 也算 sidekick
  const spawn2 = fakeSpawn(
    workScript({
      chunks: [],
      newConfigOptions: [
        { id: 'model', currentValue: 'fusion-opus-sidekick-swe-2-medium', options: [] },
      ],
      notifyDuringPrompt: (msg, api) => {
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'side 产出' },
            _meta: { 'cognition.ai/sidekick': true },
          },
        });
      },
    }),
  );
  const roles2 = [];
  const res = await runTurn({ ...BASE, kind: 'work', spawnImpl: spawn2, onRole: (r) => roles2.push(r) });
  assert.deepEqual(roles2, ['sidekick']);
  assert.equal(res.text, 'side 产出');
});

test('fusion：思考与稀疏工具进度保留正确角色', async () => {
  const spawn = fakeSpawn(
    workScript({
      newConfigOptions: [
        { id: 'model', currentValue: 'fusion-opus-sidekick-swe-2-medium', options: [] },
      ],
      notifyDuringPrompt: (msg, api) => {
        const sid = msg.params.sessionId;
        // sidekick 委派工具（inferenceToolName 标记）
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'sk-1',
            title: 'Ran explore subagent',
            status: 'in_progress',
            _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
          },
        });
        // sidekick 思考：envelope 层级 _meta（思考文本不得进入回答）
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'SK-THOUGHT-ENVELOPE' },
            _meta: { 'cognition.ai/sidekick': true },
          },
        });
        // sidekick 思考：content 层级 _meta
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: {
              type: 'text',
              text: 'SK-THOUGHT-CONTENT',
              _meta: { 'cognition.ai/sidekick': true },
            },
          },
        });
        // 已知 sidekick 工具的稀疏进度（无任何标记）→ 仍按 sidekick 计
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'sk-1',
            status: 'completed',
          },
        });
        // 显式 lead 思考（sidekick:false）→ 切回 lead
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'LEAD-THOUGHT' },
            _meta: { 'cognition.ai/sidekick': false },
          },
        });
        // 显式 lead 标记的委派工具（sidekick:false + inferenceToolName）：
        // 显式标记优先，记为 lead；其稀疏进度不得被历史委派状态复活成
        // sidekick。
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'ld-1',
            title: 'Ran explore subagent',
            status: 'in_progress',
            _meta: {
              'cognition.ai/sidekick': false,
              'cognition.ai/inferenceToolName': 'run_subagent',
            },
          },
        });
        api.notify('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'ld-1',
            status: 'completed',
          },
        });
      },
    }),
  );
  const roles = [];
  const roleAtTool = []; // 每次 onTool 时的当前角色快照
  const res = await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: spawn,
    onRole: (r) => roles.push(r),
    onTool: () => roleAtTool.push(roles.at(-1) || 'lead'),
  });
  // 委派工具→sidekick；两处思考/稀疏进度不产生重复切换；lead 思考→lead；
  // 显式 lead 的委派工具及其稀疏更新都不得再冒 sidekick；结尾默认 chunk
  // （'答'）无标记，沿用 lead 不再上报。
  assert.deepEqual(roles, ['sidekick', 'lead']);
  assert.deepEqual(
    roleAtTool,
    ['sidekick', 'sidekick', 'lead', 'lead'],
    '已知工具的稀疏进度沿用既有角色，显式 lead 不被委派标记复活',
  );
  assert.equal(res.text, '答');
  assert.ok(!res.text.includes('THOUGHT'), '思考文本不得进入回答');
});

test('onModel：配置下发后、prompt 前上报实际模型', async () => {
  const order = [];
  const spawn = fakeSpawn(
    workScript({
      newConfigOptions: [{ id: 'model', currentValue: 'fusion-x-sidekick-y', options: [] }],
      onPrompt: () => order.push('prompt'),
    }),
  );
  const models = [];
  await runTurn({
    ...BASE,
    kind: 'work',
    spawnImpl: spawn,
    onModel: (m) => {
      models.push(m);
      order.push('model');
    },
  });
  assert.deepEqual(models, ['fusion-x-sidekick-y']);
  assert.deepEqual(order, ['model', 'prompt'], 'model 事件必须先于 prompt');
});
