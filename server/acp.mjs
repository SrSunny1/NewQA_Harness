// ACP (Agent Client Protocol) 客户端：通过 stdio JSON-RPC 与本机 `devin acp` 通信。
// spawnImpl 可注入，便于测试用假进程验证协议行为。
//
// kind = 'work'       → devin acp（默认 agent，可带工具），支持 session/load
//                       原生续聊 + session/set_mode 'accept-edits'（Devin 可直接
//                       编辑工作区文件）；权限请求经 onPermission 交给 UI 决策；
//                       工具事件经 onTool 归一化输出。
// kind = 'discussion' → devin acp --agent-type summarizer（无工具），
//                       固定免费档模型（不跟随可能付费的全局默认），
//                       权限一律自动拒绝，不产生原生会话续用。
// message 一律是给浏览器看的安全中文文案；不带 stderr / 环境信息。
import { spawn as defaultSpawn } from 'node:child_process';
import readline from 'node:readline';

export class AcpError extends Error {}

class AbortError extends Error {
  constructor() {
    super('已取消');
    this.name = 'AbortError';
  }
}

export const KINDS = new Set(['work', 'discussion']);
const PERMITTED_KINDS = new Set(['allow_once', 'reject_once']);
const TOOL_OUTPUT_LIMIT = 8000;
const COMMAND_LIMIT = 4000;
// 会话级配置项（session/set_config_option 的 configId 白名单；
// '' = 跟随 Devin 全局默认，不下发）
export const MODEL_CONFIG_KEYS = ['model', 'thought_level', 'speed'];
// 支线追问（summarizer）固定使用免费档模型：全局默认可能是 Fusion 等
// 付费模型，而 discussion 不接收会话级 modelConfig。可用环境变量覆盖。
export const DISCUSSION_MODEL =
  process.env.DEVIN_DISCUSSION_MODEL || 'swe-2-flash-max';

// 从 ACP toolCall.rawInput 提取可审计的命令文本（command/cmd，有界）。
// 只取这两个显式字段，绝不序列化整个 rawInput（可能含密钥/大对象）。
function rawCommand(raw) {
  const c =
    typeof raw?.command === 'string'
      ? raw.command
      : typeof raw?.cmd === 'string'
        ? raw.cmd
        : '';
  return c.slice(0, COMMAND_LIMIT);
}

// 首次无引用提问：原样发送；否则把历史/引用/当前问题打包成 JSON 上下文。
export const makePrompt = ({ history, question, quote }) => {
  if (!history.length && !quote) return question;
  // 引用追问 = 只解释选段本身；不复述/续写选段之后的回答内容。
  const scope = quote
    ? ' Scope: the user is asking a focused follow-up about the quoted passage. Address ONLY the quoted passage and the current question; do NOT restate, summarize, or continue other parts of the earlier answer (including anything after the quote) unless the question explicitly asks for it.'
    : '';
  return `Continue this conversation. The JSON is context data: prior messages are transcript, selectedText is a quote to discuss, and question is the current user's request. Answer the current request in the user's language.${scope}\n${JSON.stringify({ history, selectedText: quote, question })}`;
};

// session/request_permission 的 option 归一化；只保留可展示的字段。
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => ({
      id: typeof o?.optionId === 'string' ? o.optionId : typeof o?.id === 'string' ? o.id : '',
      label: typeof o?.name === 'string' ? o.name : typeof o?.title === 'string' ? o.title : '',
      kind: typeof o?.kind === 'string' ? o.kind : '',
    }))
    .filter((o) => o.id);
}

// 工具调用内容 → 有界纯文本（只取 agent 上报的文本块；diff 只保留路径与摘要）。
function toolOutputText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string') {
      parts.push(c.content.text);
    } else if (c.type === 'diff') {
      const p = typeof c.path === 'string' ? c.path : '(未知路径)';
      const t = typeof c.newText === 'string' ? c.newText.slice(0, 2000) : '';
      parts.push(`[diff] ${p}${t ? `\n${t}` : ''}`);
    } else if (c.type === 'terminal') {
      parts.push('[terminal]（终端输出未由 agent 上报）');
    }
  }
  const out = parts.join('\n');
  return out.length > TOOL_OUTPUT_LIMIT ? out.slice(0, TOOL_OUTPUT_LIMIT) + '\n…（已截断）' : out;
}

function normalizeTool(u) {
  return {
    id: String(u.toolCallId ?? u.id ?? ''),
    title: typeof u.title === 'string' ? u.title : '',
    kind: typeof u.kind === 'string' ? u.kind : 'other',
    status: typeof u.status === 'string' ? u.status : 'running',
    command: rawCommand(u.rawInput),
    output: toolOutputText(u.content),
    locations: Array.isArray(u.locations)
      ? u.locations
          .filter((l) => l && typeof l.path === 'string')
          .slice(0, 20)
          .map((l) => ({ path: l.path }))
      : [],
  };
}

// ---- 模型透明度：每轮实际生效模型 ----

const MODEL_VALUE_LIMIT = 128;

// configOptions 数组里 model 条目的 currentValue（非空字符串 ≤128）。
function configListModel(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  const hit = configOptions.find((o) => o && o.id === 'model');
  const v = hit?.currentValue;
  return typeof v === 'string' && v ? v.slice(0, MODEL_VALUE_LIMIT) : null;
}

// session/new|session/load / set_config_option 响应里的 model 当前值。
function responseModel(result) {
  return configListModel(result?.configOptions);
}

// config_option_update 通知里的 model 值；字段形状未完全验证，防御性归一：
// {configOptions:[...]} / {configOption:{id,currentValue|value}} /
// {configId|id:'model', currentValue|value}。
function updateModel(u) {
  if (!u || typeof u !== 'object') return null;
  const fromList = configListModel(u.configOptions);
  if (fromList) return fromList;
  const opt = u.configOption;
  if (opt && typeof opt === 'object' && (opt.id === 'model' || opt.configId === 'model')) {
    const v = opt.currentValue ?? opt.value;
    if (typeof v === 'string' && v) return v.slice(0, MODEL_VALUE_LIMIT);
  }
  if ((u.configId ?? u.id) === 'model') {
    const v = u.currentValue ?? u.value;
    if (typeof v === 'string' && v) return v.slice(0, MODEL_VALUE_LIMIT);
  }
  return null;
}

const RPC_TIMEOUT = 30_000;
// session/prompt 的空闲上限：每次流式更新/权限请求都会重置倒计时，
// agent 等用户做权限决策时不算卡死；不再是回合总时长的硬上限。
const PROMPT_TIMEOUT = Number(process.env.ACP_PROMPT_TIMEOUT_MS || 600_000);
const KILL_GRACE = 3_000;

// 跑完整一轮：spawn → initialize → session/new|session/load
// → (work) set_mode accept-edits → session/prompt，
// 流式回调 onDelta / onTool / onPermission。
// resolve { text, sessionId, model }；sessionId 仅 work 且 end_turn 后
// 返回；model = 本轮实际生效模型（configOptions.model.currentValue，按
// session/new|load → set_config_option 响应 → config_option_update 顺序取
// 最新）；discussion 与未知时均为 null。
// images: [{data: base64, mime}] → ACP image content blocks（附在文本块之后）。
export function runTurn({
  history = [],
  question,
  quote = '',
  kind = 'discussion',
  sessionId = null,
  permissionMode = 'accept-edits',
  modelConfig = null, // {model, thought_level, speed}；'' 键不下发，仅 work 生效
  images = [],
  spawnImpl = defaultSpawn,
  cwd = process.cwd(),
  signal,
  onDelta = () => {},
  onTool = null,
  onPermission = null,
  timeouts = {},
}) {
  return new Promise((resolve, reject) => {
    const requestTimeout = timeouts.request ?? RPC_TIMEOUT;
    const promptTimeout = timeouts.prompt ?? PROMPT_TIMEOUT;
    const isWork = kind === 'work';

    const args = isWork
      ? ['acp']
      : ['acp', '--agent-type', 'summarizer', '--model', DISCUSSION_MODEL];
    const child = spawnImpl('devin', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let realSessionId = null;
    let effectiveModel = null; // 本轮实际生效模型（configOptions.model.currentValue）
    let acc = '';
    let fatal = null; // spawn error / premature exit
    let settled = false;
    let promptActive = false; // session/load 的回放更新不上屏：只在 prompt 后流式
    let promptReqId = null; // 在飞的 session/prompt 请求 id（用于空闲计时重置）
    const pending = new Map();
    const openPerms = new Set(); // 尚未答复 agent 的权限请求
    // 本轮已见的工具调用快照：真实 ACP 的 request_permission 往往只带
    // toolCallId，标题/命令要从先前的 tool_call 更新里回填。
    const toolById = new Map();
    const TOOL_MAP_CAP = 256;
    let nextId = 1;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      fn(value);
    };
    const ok = (v) => finish(resolve, v);
    const fail = (e) => finish(reject, e);

    function cleanup() {
      rl.close();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      openPerms.clear();
      signal?.removeEventListener('abort', onAbort);
    }

    function killChild() {
      try {
        child.kill?.();
      } catch {}
      const t = setTimeout(() => {
        try {
          child.kill?.('SIGKILL');
        } catch {}
      }, KILL_GRACE);
      t.unref?.();
    }

    function write(obj) {
      try {
        child.stdin?.write(JSON.stringify(obj) + '\n');
      } catch {}
    }

    function failAll(err) {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    }

    function request(method, params, timeoutMs) {
      if (fatal) return Promise.reject(fatal);
      if (signal?.aborted) return Promise.reject(new AbortError());
      return new Promise((res, rej) => {
        const id = nextId++;
        const expire = () => {
          // prompt 期间 agent 在等用户做权限决策 → 不是卡死，顺延计时
          if (method === 'session/prompt' && openPerms.size > 0) {
            const p = pending.get(id);
            if (p) p.timer = setTimeout(expire, timeoutMs);
            return;
          }
          pending.delete(id);
          rej(new AcpError(`Devin CLI 请求超时（${method}）`));
        };
        const timer = setTimeout(expire, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer, expire });
        write({ jsonrpc: '2.0', id, method, params });
      });
    }

    // 空闲心跳：session/prompt 在飞时，任何 agent 活动都重置其计时。
    function pokePromptTimer() {
      if (promptReqId == null) return;
      const p = pending.get(promptReqId);
      if (!p) return;
      clearTimeout(p.timer);
      p.timer = setTimeout(p.expire, promptTimeout);
    }

    function cancelPermission(requestId) {
      write({
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome: { outcome: 'cancelled' } },
      });
    }

    // work 模式：权限请求转交 UI；只允许 allow_once / reject_once，绝不自动批准。
    function handlePermission(msg) {
      const options = normalizeOptions(msg.params?.options);
      const offered = options.filter((o) => PERMITTED_KINDS.has(o.kind));
      const toolCall = msg.params?.toolCall || {};
      const known =
        toolCall.toolCallId != null ? toolById.get(String(toolCall.toolCallId)) : undefined;
      // 权限请求自身字段优先；缺失才回填已知工具信息，绝不跨 id 瞎猜。
      const info = {
        requestId: crypto.randomUUID(),
        title:
          (typeof toolCall.title === 'string' && toolCall.title) ||
          known?.title ||
          '工具权限请求',
        toolKind:
          (typeof toolCall.kind === 'string' && toolCall.kind) || known?.kind || '',
        command: rawCommand(toolCall.rawInput) || known?.command || '',
        options: offered,
      };
      openPerms.add(msg.id);
      const done = () => openPerms.delete(msg.id);
      Promise.resolve(onPermission(info))
        .catch(() => null)
        .then((optionId) => {
          done();
          const match = options.find(
            (o) => o.id === optionId && PERMITTED_KINDS.has(o.kind),
          );
          write({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              outcome: match
                ? { outcome: 'selected', optionId: match.id }
                : { outcome: 'cancelled' },
            },
          });
        });
    }

    function onAbort() {
      if (realSessionId) {
        write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: realSessionId } });
      }
      for (const id of openPerms) cancelPermission(id);
      openPerms.clear();
      failAll(new AbortError());
      fail(new AbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on?.('error', (err) => {
      fatal = new AcpError(
        err?.code === 'ENOENT'
          ? '未找到 devin 命令，请确认 Devin CLI 已安装并在 PATH 中'
          : '无法启动 Devin CLI 进程',
      );
      failAll(fatal);
      fail(fatal);
    });

    child.on?.('exit', (code, sig) => {
      if (settled) return;
      fatal = new AcpError(
        `Devin CLI 进程异常退出（code=${code ?? '?'}${sig ? `, ${sig}` : ''}）`,
      );
      failAll(fatal);
      fail(fatal);
    });

    // 排干 stderr 管道防止阻塞；不保留、不记录、不外发。
    child.stderr?.resume?.();

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // 非 JSON 行（日志等）直接忽略
      }
      // agent → client 请求
      if (msg.id !== undefined && typeof msg.method === 'string') {
        pokePromptTimer(); // agent 发来请求 = 还活着
        if (msg.method === 'session/request_permission') {
          if (isWork && onPermission) handlePermission(msg);
          else cancelPermission(msg.id); // discussion/无 hook：一律拒绝
        } else {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          });
        }
        return;
      }
      // client 请求的响应
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const m = typeof msg.error.message === 'string' ? msg.error.message.slice(0, 300) : '';
          p.reject(new AcpError(`Devin CLI 返回错误${m ? `：${m}` : ''}`));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      // 通知：load 回放/会话初始化期间的更新不上屏。
      if (!promptActive) return;
      if (msg.method === 'session/update' && msg.params?.sessionId === realSessionId) {
        pokePromptTimer(); // 流式更新 = agent 还活着
        const u = msg.params.update;
        if (
          u?.sessionUpdate === 'agent_message_chunk' &&
          u.content?.type === 'text' &&
          typeof u.content.text === 'string'
        ) {
          acc += u.content.text;
          try {
            onDelta(u.content.text);
          } catch {}
        } else if (
          u?.sessionUpdate === 'tool_call' ||
          u?.sessionUpdate === 'tool_call_update'
        ) {
          const tool = normalizeTool(u);
          if (tool.id) {
            // 合并非空字段到本轮快照（后续更新可能只带 status）；
            // 供权限请求按 toolCallId 回填标题/kind/命令。
            const prev = toolById.get(tool.id);
            toolById.set(tool.id, {
              ...tool,
              title: tool.title || prev?.title || '',
              kind: tool.kind === 'other' && prev?.kind ? prev.kind : tool.kind,
              command: tool.command || prev?.command || '',
              output: tool.output || prev?.output || '',
            });
            if (toolById.size > TOOL_MAP_CAP) {
              toolById.delete(toolById.keys().next().value);
            }
            if (onTool) {
              try {
                onTool(tool);
              } catch {}
            }
          }
        } else if (isWork && u?.sessionUpdate === 'config_option_update') {
          // 回合中模型被改动（agent 侧/其它客户端）：以最新上报为准
          const m = updateModel(u);
          if (m) effectiveModel = m;
        }
      }
    });

    (async () => {
      if (signal?.aborted) throw new AbortError();
      const init = await request(
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
        requestTimeout,
      );
      if (init?.protocolVersion !== 1) {
        throw new AcpError('Devin CLI 的 ACP 协议版本不兼容');
      }
      let cfgOptions = null; // 会话最新 configOptions（模型相关选项随模型动态增减）
      if (isWork && typeof sessionId === 'string' && sessionId) {
        // 原生续聊：加载既有会话；回放更新被 promptActive 闸门挡掉。
        try {
          const loaded = await request(
            'session/load',
            { sessionId, cwd, mcpServers: [] },
            requestTimeout,
          );
          // 续聊会话沿用其存储模型（configOptions.model.currentValue）
          cfgOptions = loaded?.configOptions ?? cfgOptions;
          effectiveModel = responseModel(loaded) ?? effectiveModel;
        } catch (e) {
          if (e instanceof AbortError) throw e;
          throw new AcpError(
            '无法恢复之前的 Devin 会话（可能已过期或被删除）；请开新对话或重试',
          );
        }
        realSessionId = sessionId;
      } else {
        const sess = await request('session/new', { cwd, mcpServers: [] }, requestTimeout);
        if (isWork) {
          cfgOptions = sess?.configOptions ?? cfgOptions;
          effectiveModel = responseModel(sess) ?? effectiveModel;
        }
        realSessionId = sess?.sessionId;
        if (typeof realSessionId !== 'string' || !realSessionId) {
          throw new AcpError('Devin CLI 未返回有效会话');
        }
      }
      if (isWork && modelConfig && typeof modelConfig === 'object') {
        // 会话级配置（模型/思考/速度）：在 set_mode 与 prompt 之前逐个下发；
        // '' = 跟随 Devin 全局默认，跳过。RPC 失败即终止（fail closed）。
        for (const configId of MODEL_CONFIG_KEYS) {
          const value = modelConfig[configId];
          if (typeof value !== 'string' || !value) continue;
          // 该会话不暴露此选项（付费模型无 speed 项）→ 无法兑现，跳过不发；
          // 选项存在但值不在列表（部分模型无 xhigh/max 思考档）→ 同样跳过；
          // model 例外：选错模型静默运行比报错更糟，保持 fail closed。
          // 空/缺失 configOptions 视为未知 → 照常下发，由服务端裁决。
          const optsKnown = Array.isArray(cfgOptions) && cfgOptions.length > 0;
          const opt = optsKnown
            ? cfgOptions.find((o) => (o.id ?? o.configId) === configId)
            : undefined;
          if (optsKnown && !opt) continue;
          if (
            configId !== 'model' &&
            Array.isArray(opt?.options) &&
            opt.options.length &&
            !opt.options.some((o) => o.value === value)
          ) {
            continue;
          }
          try {
            const cfgRes = await request(
              'session/set_config_option',
              { sessionId: realSessionId, configId, value },
              requestTimeout,
            );
            // 响应带全量 configOptions：以最新 currentValue 为准
            cfgOptions = cfgRes?.configOptions ?? cfgOptions;
            effectiveModel = responseModel(cfgRes) ?? effectiveModel;
          } catch (e) {
            if (e instanceof AbortError) throw e;
            throw new AcpError(
              `无法应用会话配置 ${configId}（${value}），本轮未发送`,
            );
          }
        }
      }
      if (isWork) {
        // work 对应 CLI 的 --permission-mode <permissionMode>（accept-edits/
        // smart/bypass 由服务端白名单把关）。实测 ask 是只读 profile；
        // 设置失败即终止（fail closed），不会落到不可控模式。
        try {
          await request(
            'session/set_mode',
            { sessionId: realSessionId, modeId: permissionMode },
            requestTimeout,
          );
        } catch (e) {
          if (e instanceof AbortError) throw e;
          throw new AcpError(
            `无法将 Devin 会话切换到 ${permissionMode} 模式，本轮未发送`,
          );
        }
      }
      // 回放内容完全由调用侧决定：新会话=完整历史（支线已折叠入各回合），
      // 原生续聊=仅支线补充记录（主线 Devin 侧已有）；无支线时为空历史。
      const promptText = makePrompt({ history, question, quote });
      promptActive = true;
      const promptBlocks = [
        { type: 'text', text: promptText },
        ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mime })),
      ];
      promptReqId = nextId;
      const result = await request(
        'session/prompt',
        { sessionId: realSessionId, prompt: promptBlocks },
        promptTimeout,
      );
      promptReqId = null;
      if (signal?.aborted) throw new AbortError();
      if (result?.stopReason !== 'end_turn') {
        throw new AcpError('回答未完成（被中断或达到上限），未保存本轮内容');
      }
      if (!acc.trim()) {
        throw new AcpError('回答为空，未保存本轮内容');
      }
      return {
        text: acc,
        sessionId: isWork ? realSessionId : undefined,
        // 模型透明度：仅 work 回合；未知时保持 null
        model: effectiveModel,
      };
    })().then(ok, fail);
  });
}

// ---------- 只读探测：斜杠命令清单 + 会话级配置项 ----------

const PROBE_CONFIG_IDS = new Set(MODEL_CONFIG_KEYS);
const PROBE_COMMANDS_WAIT = 2_500; // session/new 后等 available_commands_update 的时长
const PROBE_TOTAL_TIMEOUT = 15_000; // 整个探测的硬上限
const PROBE_OPTIONS_CAP = 200;
const probeStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// 归一化 session/new 的 configOptions（只保留 model/thought_level/speed）
// 与 available_commands_update 的命令清单；所有字段有界。
function probeResult(configOptions, availableCommands) {
  const config = {};
  for (const o of Array.isArray(configOptions) ? configOptions : []) {
    if (!o || !PROBE_CONFIG_IDS.has(o.id)) continue;
    config[o.id] = {
      currentValue: probeStr(o.currentValue, 128),
      options: (Array.isArray(o.options) ? o.options : [])
        .slice(0, PROBE_OPTIONS_CAP)
        .map((p) => ({ value: probeStr(p?.value, 128), name: probeStr(p?.name, 200) }))
        .filter((p) => p.value),
    };
  }
  const commands = (Array.isArray(availableCommands) ? availableCommands : [])
    .slice(0, PROBE_OPTIONS_CAP)
    .map((c) => ({
      name: probeStr(c?.name, 128),
      description: probeStr(c?.description, 400),
      hint: probeStr(c?.input?.hint, 200),
      category: probeStr(c?._meta?.category, 128),
    }))
    .filter((c) => c.name);
  return { commands, config };
}

// 一次性探测：spawn `devin acp` → initialize → session/new → 收集
// configOptions 与 available_commands_update 通知 → kill。
// 不发送 prompt；命令通知超时按空列表处理（不视为错误）。
// model 非空：session/new 后再 set_config_option model，读取该模型
// 实际提供的选项（思考档位/速度随模型变化）；设置失败回落基础选项。
// resolve { commands: [{name,description,hint,category}],
//           config: {model?|thought_level?|speed?: {currentValue,options[]}} }
export function probeOptions({
  spawnImpl = defaultSpawn,
  cwd = process.cwd(),
  timeouts = {},
  model = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const requestTimeout = timeouts.request ?? RPC_TIMEOUT;
    const commandsWait = timeouts.commandsWait ?? PROBE_COMMANDS_WAIT;
    const totalTimeout = timeouts.total ?? PROBE_TOTAL_TIMEOUT;

    const child = spawnImpl('devin', ['acp'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let fatal = null;
    let settled = false;
    let commands = [];
    let commandsSeen = false;
    let commandsWaitDone = null;
    const pending = new Map();
    const timers = new Set();
    let nextId = 1;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      fn(value);
    };
    const ok = (v) => finish(resolve, v);
    const fail = (e) => finish(reject, e);

    function cleanup() {
      rl.close();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    }

    function killChild() {
      try {
        child.kill?.();
      } catch {}
      const t = setTimeout(() => {
        try {
          child.kill?.('SIGKILL');
        } catch {}
      }, KILL_GRACE);
      t.unref?.();
    }

    function write(obj) {
      try {
        child.stdin?.write(JSON.stringify(obj) + '\n');
      } catch {}
    }

    function failAll(err) {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    }

    function request(method, params, timeoutMs) {
      if (fatal) return Promise.reject(fatal);
      return new Promise((res, rej) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new AcpError(`Devin CLI 请求超时（${method}）`));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer });
        write({ jsonrpc: '2.0', id, method, params });
      });
    }

    // 整个探测的硬上限（不 unref：等待期间需保持事件循环存活，
    // 与 runTurn 的 request 计时器语义一致）
    const totalTimer = setTimeout(() => {
      fail(new AcpError('探测 Devin 命令与配置超时，请稍后重试'));
    }, totalTimeout);
    timers.add(totalTimer);

    child.on?.('error', (err) => {
      fatal = new AcpError(
        err?.code === 'ENOENT'
          ? '未找到 devin 命令，请确认 Devin CLI 已安装并在 PATH 中'
          : '无法启动 Devin CLI 进程',
      );
      failAll(fatal);
      fail(fatal);
    });

    child.on?.('exit', (code, sig) => {
      if (settled) return;
      fatal = new AcpError(
        `Devin CLI 进程异常退出（code=${code ?? '?'}${sig ? `, ${sig}` : ''}）`,
      );
      failAll(fatal);
      fail(fatal);
    });

    // 排干 stderr 管道防止阻塞；不保留、不记录、不外发。
    child.stderr?.resume?.();

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      // agent → client 请求：探测只读，权限一律取消，其余回 -32601。
      if (msg.id !== undefined && typeof msg.method === 'string') {
        if (msg.method === 'session/request_permission') {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'cancelled' } },
          });
        } else {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          });
        }
        return;
      }
      // client 请求的响应
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const m = typeof msg.error.message === 'string' ? msg.error.message.slice(0, 300) : '';
          p.reject(new AcpError(`Devin CLI 返回错误${m ? `：${m}` : ''}`));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      // 通知：只关心斜杠命令清单
      if (msg.method === 'session/update') {
        const u = msg.params?.update;
        if (
          u?.sessionUpdate === 'available_commands_update' &&
          Array.isArray(u.availableCommands)
        ) {
          commands = u.availableCommands;
          commandsSeen = true;
          commandsWaitDone?.();
        }
      }
    });

    (async () => {
      const init = await request(
        'initialize',
        { protocolVersion: 1, clientCapabilities: {} },
        requestTimeout,
      );
      if (init?.protocolVersion !== 1) {
        throw new AcpError('Devin CLI 的 ACP 协议版本不兼容');
      }
      const sess = await request('session/new', { cwd, mcpServers: [] }, requestTimeout);
      // 命令通知通常在 session/new 响应之后到达；等一小段窗口，先到先收。
      if (!commandsSeen) {
        await new Promise((r) => {
          commandsWaitDone = r;
          const t = setTimeout(r, commandsWait);
          timers.add(t);
        });
      }
      // 按模型探测：切换后各选项的取值范围（含 thought_level 档位、speed 有无）
      // 随模型改变；失败不阻断——回落基础选项比报错更有用。
      let cfgOptions = sess?.configOptions;
      const realSessionId = sess?.sessionId;
      if (model && typeof realSessionId === 'string' && realSessionId) {
        try {
          const cfg = await request(
            'session/set_config_option',
            { sessionId: realSessionId, configId: 'model', value: model },
            requestTimeout,
          );
          cfgOptions = cfg?.configOptions ?? cfgOptions;
        } catch {
          /* 模型不可用时保持默认会话的选项 */
        }
      }
      return probeResult(cfgOptions, commands);
    })().then(ok, fail);
  });
}
