// 测试辅助：注入给 acp/index 的假 spawn。
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

// handler(msg, api) 处理 client 发过来的每个 JSON-RPC 请求；
// client 的响应（对 agent 请求的答复）记录在 child.responses。
export function fakeSpawn(handler) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const responses = new Map();
    const calls = []; // client 请求方法顺序
    const msgs = []; // 完整请求（含 params，供断言）
    let buf = '';
    let reqId = 9000;

    const api = {
      respond(id, result) {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      },
      respondError(id, error) {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n');
      },
      notify(method, params) {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      },
      request(method, params) {
        const id = ++reqId;
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return id;
      },
      exit(code = 0) {
        stdout.end();
        queueMicrotask(() => child.emit('exit', code, null));
      },
    };

    const stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof msg.method === 'string') {
            calls.push(msg.method);
            msgs.push(msg);
            handler(msg, api, child);
          } else if (msg.id !== undefined) {
            responses.set(msg.id, msg);
          }
        }
        cb();
      },
    });

    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      responses,
      calls,
      msgs,
      killed: null,
      kill(sig) {
        child.killed = sig || 'SIGTERM';
        api.exit(0);
        return true;
      },
      spawnargs: [cmd, ...(args || [])],
      spawnOpts: opts,
    });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

// 常规假 agent（discussion/summarizer 行为）：正常握手 + 流式回复。
export function agentScript({
  sessionId = 'fake-session',
  chunks = ['你好', '世界'],
  stopReason = 'end_turn',
  onPrompt,
  extraNotify = [],
} = {}) {
  return (msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId });
    } else if (msg.method === 'session/prompt') {
      for (const n of extraNotify) api.notify('session/update', n);
      for (const c of chunks) {
        api.notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: c } },
        });
      }
      onPrompt?.(msg, api);
      api.respond(msg.id, { stopReason });
    }
  };
}

// work 假 agent：支持 session/load、session/set_mode、工具与权限通知。
// 记录 sessionId 供通知用；load 时可回放历史（应被闸门挡掉）。
// newConfigOptions / loadConfigOptions / setConfigOptions：注入各响应的
// configOptions（setConfigOptions 可为 (params)=>configOptions 动态计算）。
export function workScript({
  sessionId = 'work-session',
  chunks = ['答'],
  replayOnLoad = true,
  setModeError = null,
  setConfigError = null, // 任何 set_config_option 都回该 RPC 错误
  loadError = null,
  onPrompt,
  notifyDuringPrompt,
  newConfigOptions = null,
  loadConfigOptions = null,
  setConfigOptions = null,
} = {}) {
  return (msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, {
        sessionId,
        modes: { availableModes: [{ id: 'ask' }] },
        ...(newConfigOptions ? { configOptions: newConfigOptions } : {}),
      });
    } else if (msg.method === 'session/load') {
      if (loadError) {
        api.respondError(msg.id, { code: -32016, message: 'cannot load session' });
        return;
      }
      if (replayOnLoad) {
        // 模拟原生回放：这些 chunk 不应被当作流式输出
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'REPLAYED-OLD' },
          },
        });
      }
      api.respond(msg.id, loadConfigOptions ? { configOptions: loadConfigOptions } : {});
    } else if (msg.method === 'session/set_config_option') {
      if (setConfigError) api.respondError(msg.id, setConfigError);
      else {
        const opts =
          typeof setConfigOptions === 'function'
            ? setConfigOptions(msg.params)
            : setConfigOptions || [];
        api.respond(msg.id, { configOptions: opts });
      }
    } else if (msg.method === 'session/set_mode') {
      if (setModeError) api.respondError(msg.id, setModeError);
      else api.respond(msg.id, {});
    } else if (msg.method === 'session/prompt') {
      notifyDuringPrompt?.(msg, api);
      for (const c of chunks) {
        api.notify('session/update', {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: c } },
        });
      }
      onPrompt?.(msg, api);
      api.respond(msg.id, { stopReason: 'end_turn' });
    }
  };
}

// 探测假 agent：session/new 回 configOptions（含应被过滤的 mode），
// 随后发 available_commands_update 通知（可延迟/不发，模拟超时）。
export function probeScript({
  sessionId = 'probe-session',
  configOptions = [
    {
      id: 'mode',
      currentValue: 'accept-edits',
      options: [{ value: 'accept-edits', name: 'Accept Edits' }],
    },
    {
      id: 'model',
      currentValue: 'adaptive',
      options: [
        { value: 'adaptive', name: 'Adaptive', _meta: { supportsImages: true } },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'thought_level',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'speed',
      currentValue: 'standard',
      options: [
        { value: 'standard', name: 'Standard' },
        { value: 'fast', name: 'Fast' },
      ],
    },
  ],
  commands = [
    {
      name: 'compact',
      description: '压缩当前会话上下文',
      input: { hint: '[可选说明]' },
      _meta: { category: 'session', icon: 'cmp' },
    },
    { name: 'context', description: '查看上下文用量', _meta: { category: 'session' } },
    { name: 'ask', description: '只读提问' },
  ],
  notifyCommands = true,
  notifyDelay = 0,
} = {}) {
  return (msg, api) => {
    if (msg.method === 'initialize') {
      api.respond(msg.id, { protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      api.respond(msg.id, { sessionId, configOptions });
      if (notifyCommands) {
        const send = () =>
          api.notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: commands,
            },
          });
        if (notifyDelay) setTimeout(send, notifyDelay);
        else send();
      }
    }
  };
}
