// NewQA 数据模型（纯函数，可在 Node 测试中使用）
//
// Conversation = { id, title, turns: Turn[] }
// Turn  = { id, question, answer, notes: Note[], branches: Branch[] }
// Branch = { id, anchor: Anchor, turns: Turn[] }
// Note  = { id, anchor: Anchor, text }
// Anchor = { startBlock, startOffset, endBlock, endOffset, quote }
//   偏移量基于每个 source block 的 textContent。
// 线程定位：主线 target 为 []；支线 target 是由 branch id 组成的数组，
// 只沿「当前线程 turns 里包含该 branch 的回合」向下走。

export const STORAGE_KEY = 'newqa:v1';
export const THEME_KEY = 'newqa:theme';
export const LAYOUT_KEY = 'newqa:layout';
export const QUOTE_LIMIT = 16 * 1024;
export const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink'];
// 会话级权限模式（对应 devin acp session/set_mode 的 modeId 白名单）
export const PERMISSION_MODES = ['accept-edits', 'smart', 'bypass'];
// 会话级模型配置（对应 devin acp session/set_config_option 的 configId）；
// '' = 跟随 Devin 全局默认（~/.config/devin/config.json）。
export const MODEL_CONFIG_KEYS = ['model', 'thought_level', 'speed'];
export const DEFAULT_MODEL_CONFIG = Object.freeze({
  model: '',
  thought_level: '',
  speed: '',
});
const MODEL_CONFIG_VALUE_LIMIT = 128;
// 实际生效模型值（conv.effectiveModel / turn.model）的存档上限
const EFFECTIVE_MODEL_LIMIT = 128;
// 免费档只有 SWE-2 家族（swe-2 / swe-2.1，含各自 flash）的 medium/high/max
// 精确 SKU。不能按「包含 swe-2」判断：Fusion 的 UID 里也有 sidekick-swe-2
// （副模型免费、主模型计费），swe-2-*-lightning 也是收费变体；未知值按计费处理。
const FREE_MODEL = /^swe-2(?:-1)?(?:-flash)?-(?:medium|high|max)$/i;
export const isBillableModel = (value) => !FREE_MODEL.test(String(value || ''));
// 非 standard 速度档会把模型解析成收费快速变体（SWE-2 → *-lightning，
// Claude/GPT → *-fast / *-priority）；'' = 跟随全局默认由调用方解析。
// fail closed：fast/ultrafast/未来新档一律按计费标黄。
export const isBillableSpeed = (speed) => !!speed && speed !== 'standard';

// 存档里的 modelConfig → 固定三键；非对象/缺省回默认，未知值保留字符串。
export function asModelConfig(raw) {
  const out = { ...DEFAULT_MODEL_CONFIG };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of MODEL_CONFIG_KEYS) {
    if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, MODEL_CONFIG_VALUE_LIMIT);
  }
  return out;
}
export const TOOL_OUTPUT_LIMIT = 8000;
export const COMMAND_LIMIT = 4000;
export const MAX_IMAGES = 4; // 每条提问最多贴图数（与服务端一致）
export const THUMB_LIMIT = 400 * 1024; // 存档缩略图 dataURL 字符上限

// 桌面侧栏布局持久化（移动端走抽屉，不吃这些值）
export const LEFT_MIN = 180;
export const LEFT_MAX = 360;
export const RIGHT_MIN = 220;
export const RIGHT_MAX = 440;
export const DEFAULT_LAYOUT = {
  leftWidth: 240,
  rightWidth: 290,
  leftCollapsed: false,
  rightCollapsed: false,
  collapsedWorkspaces: [],
};

const clamp = (v, lo, hi, dft) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dft;

// 解析布局偏好；异常值回落默认，layout 非法时返回 null。
export function parseLayout(raw) {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  return {
    leftWidth: clamp(raw.leftWidth, LEFT_MIN, LEFT_MAX, DEFAULT_LAYOUT.leftWidth),
    rightWidth: clamp(raw.rightWidth, RIGHT_MIN, RIGHT_MAX, DEFAULT_LAYOUT.rightWidth),
    leftCollapsed: !!raw.leftCollapsed,
    rightCollapsed: !!raw.rightCollapsed,
    collapsedWorkspaces: Array.isArray(raw.collapsedWorkspaces)
      ? [...new Set(raw.collapsedWorkspaces.filter((x) => typeof x === 'string'))]
      : [],
  };
}

// 桌面实际展示的侧栏宽度：视口放不下时收缩显示宽度，但不改写保存的偏好。
// 先缩右栏到下限，再缩左栏；中央转录保底 360px。
export function effectivePanelWidths(layout, viewportWidth) {
  let left = layout.leftCollapsed ? 0 : layout.leftWidth;
  let right = layout.rightCollapsed ? 0 : layout.rightWidth;
  let overflow = Math.max(0, left + right + 360 - viewportWidth);
  const rightCut = Math.min(overflow, Math.max(0, right - RIGHT_MIN));
  right -= rightCut;
  overflow -= rightCut;
  left -= Math.min(overflow, Math.max(0, left - LEFT_MIN));
  return { left, right };
}

export function makeId() {
  return crypto.randomUUID();
}

export function createConversation(workspace = '') {
  return {
    id: makeId(),
    title: '新对话',
    titleCustomized: false,
    turns: [],
    workspace: typeof workspace === 'string' ? workspace : '',
    sessionId: null,
    permissionMode: 'accept-edits',
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    effectiveModel: null, // 最近一轮实际生效的模型值（done 事件上报）
    effFor: '', // 该生效值对应的 model 选择（选择变了就不再用 effectiveModel 展示）
    effSpeed: '', // 该生效值对应的 speed 选择（Fast 计费提示用）
  };
}

// 附件原图 URL（服务端落盘）：灯箱展示用；非法/外链一律剔除。
const ATTACH_URL_RE = /^\/api\/attachment\/[\w-]+\.(?:png|jpe?g|webp|gif)$/;
const asAttachUrls = (v) =>
  Array.isArray(v)
    ? v.filter((s) => typeof s === 'string' && ATTACH_URL_RE.test(s)).slice(0, MAX_IMAGES)
    : [];

// extra 可带 { tools, changes, images, imageUrls, model }
// （images = 贴图缩略图 dataURL[]，供气泡展示；imageUrls = 附件原图地址；
//   model 为回合实际生效模型）
export function createTurn(question, answer, extra = {}) {
  const turn = { id: makeId(), question, answer, notes: [], branches: [] };
  if (Array.isArray(extra.tools) && extra.tools.length) turn.tools = extra.tools;
  if (extra.changes && typeof extra.changes === 'object') turn.changes = extra.changes;
  if (Array.isArray(extra.images) && extra.images.length)
    turn.images = extra.images.slice(0, MAX_IMAGES);
  const iurls = asAttachUrls(extra.imageUrls);
  if (iurls.length) turn.imageUrls = iurls;
  if (typeof extra.model === 'string' && extra.model)
    turn.model = extra.model.slice(0, EFFECTIVE_MODEL_LIMIT);
  return turn;
}

export function createNote(anchor, color = 'yellow') {
  return {
    id: makeId(),
    anchor,
    text: '',
    color: NOTE_COLORS.includes(color) ? color : 'yellow',
  };
}

export function createBranch(anchor) {
  // sessionId：支线自己的 Devin 会话（work 通道原生续聊）；首轮为空 → session/new
  return { id: makeId(), anchor, turns: [], collapsed: false, sessionId: null };
}

export function titleFromQuestion(question) {
  const first = String(question).split('\n').find((line) => line.trim()) || '';
  return first.trim().slice(0, 24) || '新对话';
}

// ---- 历史回放 ----

// 按约定实现：主线返回全部回合；支线返回「主线截止到 branch 所在回合」
// 加上支线内（递归）的回合，不含之后的兄弟/主线内容。
export function historyFor(turns, path) {
  if (!path.length) {
    return turns.flatMap(({ question, answer }) => [
      { role: 'user', text: question },
      { role: 'assistant', text: answer },
    ]);
  }
  const [id, ...rest] = path;
  const index = turns.findIndex((turn) => turn.branches.some((branch) => branch.id === id));
  if (index < 0) throw new Error('Unknown thread');
  const branch = turns[index].branches.find((b) => b.id === id);
  return [...historyFor(turns.slice(0, index + 1), []), ...historyFor(branch.turns, rest)];
}

// 支线内容折叠进历史：否则主线/原生续聊的 Devin 永远不知道追问过什么。
// 每个有回合的支线压成一段「[支线追问]」记录；skipId 在进入该支线时
// 跳过自身（其内容由支线回合另行回放，防重复）。
function branchDigest(branches, skipId = '') {
  const parts = [];
  for (const b of branches || []) {
    if (b.id === skipId || !b.turns?.length) continue;
    const qa = b.turns
      .map((t) => {
        const inner = branchDigest(t.branches);
        return `问：${t.question}\n答：${inner ? `${t.answer}\n${inner}` : t.answer}`;
      })
      .join('\n');
    const anchor = String(b.anchor?.quote || '').slice(0, 80);
    parts.push(`[支线追问] 围绕「${anchor}」\n${qa}`);
  }
  return parts.join('\n');
}

// 主线回合 → 历史条目：assistant 文本尾部附本回合各支线记录。
function turnEntries(turn, skipBranchId = '') {
  const d = branchDigest(turn.branches, skipBranchId);
  return [
    { role: 'user', text: turn.question },
    { role: 'assistant', text: d ? `${turn.answer}\n\n${d}` : turn.answer },
  ];
}

// 主线原生续聊（session/load 已有主线上下文）要补的上下文：
// 各回合的支线记录压成独立的 assistant 条目随本轮一起发。
export function branchContextEntries(turns) {
  const out = [];
  for (const t of turns || []) {
    const d = branchDigest(t.branches);
    if (d) out.push({ role: 'assistant', text: d });
  }
  return out;
}

// 实际发给后端的历史：在进入每一级支线时，把该支线的选段引用
// 注入到支线第一个回合的 user 文本里（与当前 envelope 的 selectedText 独立）。
// 主线与各级前缀回合的支线内容折叠进 assistant 文尾（进入中的支线除外）。
export function historyForRequest(turns, path) {
  if (!path.length) {
    return turns.flatMap((t) => turnEntries(t));
  }
  const [id, ...rest] = path;
  const index = turns.findIndex((turn) => turn.branches.some((branch) => branch.id === id));
  if (index < 0) throw new Error('Unknown thread');
  const branch = turns[index].branches.find((b) => b.id === id);
  const head = turns.slice(0, index + 1).flatMap((t) => turnEntries(t, id));
  const inner = historyForRequest(branch.turns, rest);
  const quote = branch.anchor?.quote;
  if (inner.length && quote) {
    inner[0] = { role: 'user', text: `[引用选段] ${quote}\n[我的提问] ${inner[0].text}` };
  }
  return [...head, ...inner];
}

// ---- 不可变更新 ----

export function appendTurn(turns, path, turn) {
  if (!path.length) return [...turns, turn];
  const [id, ...rest] = path;
  return turns.map((t) => {
    const branch = t.branches.find((b) => b.id === id);
    if (!branch) return t;
    return {
      ...t,
      branches: t.branches.map((b) =>
        b.id === id ? { ...b, turns: appendTurn(b.turns, rest, turn) } : b,
      ),
    };
  });
}

// 按路径取支线节点的 Devin 会话 id（无支线/未建立 → null）。
export function branchSessionAt(turns, path) {
  if (!Array.isArray(path) || !path.length) return null;
  let list = turns;
  let node = null;
  for (const id of path) {
    const t = (list || []).find((x) => x.branches?.some((b) => b.id === id));
    if (!t) return null;
    node = t.branches.find((b) => b.id === id);
    list = node.turns;
  }
  return typeof node?.sessionId === 'string' && node.sessionId ? node.sessionId : null;
}

// 深度不可变：把 sessionId 写到 path 指向的支线节点上（不动回合内容）。
export function setBranchSession(turns, path, sessionId) {
  if (!Array.isArray(path) || !path.length) return turns;
  const [id, ...rest] = path;
  return turns.map((t) => {
    const branch = t.branches.find((b) => b.id === id);
    if (!branch) return t;
    const nb = rest.length
      ? { ...branch, turns: setBranchSession(branch.turns, rest, sessionId) }
      : { ...branch, sessionId };
    return { ...t, branches: t.branches.map((b) => (b.id === id ? nb : b)) };
  });
}

// 深度不可变更新：在整棵树里找 turnId（含支线回合），未命中原样返回。
function updateTurnDeep(turns, turnId, fn) {
  let changed = false;
  const next = turns.map((t) => {
    if (t.id === turnId) {
      changed = true;
      return fn(t);
    }
    if (!t.branches.length) return t;
    const branches = t.branches.map((b) => {
      const nt = updateTurnDeep(b.turns, turnId, fn);
      return nt === b.turns ? b : { ...b, turns: nt };
    });
    if (branches.every((b, i) => b === t.branches[i])) return t;
    changed = true;
    return { ...t, branches };
  });
  return changed ? next : turns;
}

export function addBranchToTurn(turns, turnId, branch) {
  return updateTurnDeep(turns, turnId, (t) => ({
    ...t,
    branches: [...t.branches, branch],
  }));
}

export function addNoteToTurn(turns, turnId, note) {
  return updateTurnDeep(turns, turnId, (t) => ({ ...t, notes: [...t.notes, note] }));
}

export function setNoteText(turns, turnId, noteId, text) {
  return updateTurnDeep(turns, turnId, (t) => ({
    ...t,
    notes: t.notes.map((n) => (n.id === noteId ? { ...n, text } : n)),
  }));
}

export function setNoteColor(turns, turnId, noteId, color) {
  if (!NOTE_COLORS.includes(color)) return turns;
  return updateTurnDeep(turns, turnId, (t) => ({
    ...t,
    notes: t.notes.map((n) => (n.id === noteId ? { ...n, color } : n)),
  }));
}

export function removeNote(turns, turnId, noteId) {
  return updateTurnDeep(turns, turnId, (t) => ({
    ...t,
    notes: t.notes.filter((n) => n.id !== noteId),
  }));
}

// 深度支线更新：在整棵树的每一级 branches 里找 branchId。
function updateBranchDeep(turns, branchId, fn) {
  let changed = false;
  const walk = (list) =>
    list.map((t) => {
      const branches = t.branches.map((b) => {
        if (b.id === branchId) {
          changed = true;
          return fn(b);
        }
        const nt = walk(b.turns);
        return nt === b.turns ? b : { ...b, turns: nt };
      });
      return branches.every((b, i) => b === t.branches[i]) ? t : { ...t, branches };
    });
  const next = walk(turns);
  return changed ? next : turns;
}

export function setBranchCollapsed(turns, branchId, collapsed) {
  return updateBranchDeep(turns, branchId, (b) => ({ ...b, collapsed: !!collapsed }));
}

// 批量展开：索引跳转时打开所有祖先支线。
export function expandBranches(turns, ids) {
  let next = turns;
  for (const id of ids) next = setBranchCollapsed(next, id, false);
  return next;
}

export function removeBranch(turns, branchId) {
  let changed = false;
  const walk = (list) =>
    list.map((t) => {
      const kept = t.branches.filter((b) => {
        if (b.id === branchId) {
          changed = true;
          return false;
        }
        return true;
      });
      const branches = kept.map((b) => {
        const nt = walk(b.turns);
        return nt === b.turns ? b : { ...b, turns: nt };
      });
      return branches.length === t.branches.length &&
        branches.every((b, i) => b === t.branches[i])
        ? t
        : { ...t, branches };
    });
  const next = walk(turns);
  return changed ? next : turns;
}

// 支线按锚点的文档序排序（结束块→起始块，并列按创建顺序），全局共享。
export function orderedBranches(turn) {
  return turn.branches
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        x.b.anchor.endBlock - y.b.anchor.endBlock ||
        x.b.anchor.startBlock - y.b.anchor.startBlock ||
        x.i - y.i,
    )
    .map((x) => x.b);
}

// 支线在某回合下的「轮次」序号（按 orderedBranches 的文档序）。
export function branchOrdinal(turn, branchId) {
  return orderedBranches(turn).findIndex((b) => b.id === branchId) + 1;
}

// 支线编号与色调（对齐 CodeSlice threadRoundMap + (round-1)%5）：
// 每个顶层支线锚点（挂在主线回合上的支线）是独立的一棵树，
// 树内连同嵌套支线按深度优先文档序从 1 连号，tone = (round-1)%5；
// 父子/兄弟轮次相邻 → 天然异色；另一个顶层锚点重新从 1 计。
// number 仍是全局 DFS 序号（支线 #N 的展示编号不变）。
export function branchAppearance(turns) {
  const result = new Map();
  let nextNumber = 0;
  function visitTree(branch, counter) {
    counter.n += 1;
    result.set(branch.id, { number: ++nextNumber, tone: (counter.n - 1) % 5 });
    for (const turn of branch.turns) {
      for (const b of orderedBranches(turn)) visitTree(b, counter);
    }
  }
  for (const turn of turns) {
    for (const branch of orderedBranches(turn)) visitTree(branch, { n: 0 });
  }
  return result;
}

// 会话导航树：每个回合下列出按锚点排序的混合子项（标注与支线，
// 起点并列时标注在前），支线递归嵌套自己的回合树。
// 条目复用 collectMarks 的形状，便于跳转/编辑回调复用。
export function conversationIndex(turns, path = []) {
  return turns.map((turn) => {
    const anchorOf = (e) => (e.kind === 'note' ? e.note.anchor : e.branch.anchor);
    const children = [
      ...turn.notes.map((note) => ({ kind: 'note', turnId: turn.id, note, path })),
      ...turn.branches.map((branch) => ({
        kind: 'branch',
        turnId: turn.id,
        branch,
        path,
        children: conversationIndex(branch.turns, [...path, branch.id]),
      })),
    ].sort(
      (x, y) =>
        anchorOf(x).startBlock - anchorOf(y).startBlock ||
        anchorOf(x).startOffset - anchorOf(y).startOffset ||
        (x.kind === 'note' ? -1 : 0) - (y.kind === 'note' ? -1 : 0),
    );
    return { kind: 'turn', id: turn.id, question: turn.question, path, children };
  });
}

// ---- 查询 ----

export function turnsAtPath(turns, path) {
  for (const id of path) {
    const index = turns.findIndex((t) => t.branches.some((b) => b.id === id));
    if (index < 0) return null;
    turns = turns[index].branches.find((b) => b.id === id).turns;
  }
  return turns;
}

// 收集整棵树的标注与支线，供右侧索引条展示。
// path = 从主线到该条目需要经过的支线 id（用于折叠时逐层展开）。
export function collectMarks(turns, path = [], out = []) {
  for (const t of turns) {
    for (const note of t.notes) out.push({ kind: 'note', turnId: t.id, note, path });
    for (const branch of t.branches) {
      out.push({ kind: 'branch', turnId: t.id, branch, path });
      collectMarks(branch.turns, [...path, branch.id], out);
    }
  }
  return out;
}

// ---- 持久化 ----

function asAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const nums = ['startBlock', 'startOffset', 'endBlock', 'endOffset'];
  if (!nums.every((k) => Number.isInteger(a[k]) && a[k] >= 0)) return null;
  return {
    startBlock: a.startBlock,
    startOffset: a.startOffset,
    endBlock: a.endBlock,
    endOffset: a.endOffset,
    quote: typeof a.quote === 'string' ? a.quote.slice(0, QUOTE_LIMIT) : '',
  };
}

function asTool(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    kind: typeof raw.kind === 'string' ? raw.kind : 'other',
    status: typeof raw.status === 'string' ? raw.status : 'completed',
    command: typeof raw.command === 'string' ? raw.command.slice(0, COMMAND_LIMIT) : '',
    output: typeof raw.output === 'string' ? raw.output.slice(0, TOOL_OUTPUT_LIMIT) : '',
    locations: Array.isArray(raw.locations) ? raw.locations.slice(0, 20) : [],
    // 工具在回答文本中的插入点（字符偏移）；渲染时再按文本长度钳制，旧数据没有此字段。
    ...(Number.isInteger(raw.textOffset) && raw.textOffset >= 0
      ? { textOffset: raw.textOffset }
      : {}),
  };
}

function asChanges(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.available !== 'boolean') return null;
  return {
    available: raw.available,
    status: typeof raw.status === 'string' ? raw.status : '',
    unstaged: typeof raw.unstaged === 'string' ? raw.unstaged : '',
    staged: typeof raw.staged === 'string' ? raw.staged : '',
    truncated: !!raw.truncated,
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

function asTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.question !== 'string' || typeof raw.answer !== 'string') return null;
  const turn = {
    id: typeof raw.id === 'string' ? raw.id : makeId(),
    question: raw.question,
    answer: raw.answer,
    notes: Array.isArray(raw.notes)
      ? raw.notes
          .map((n) =>
            n && typeof n === 'object' && asAnchor(n.anchor)
              ? {
                  id: typeof n.id === 'string' ? n.id : makeId(),
                  anchor: asAnchor(n.anchor),
                  text: typeof n.text === 'string' ? n.text : '',
                  color: NOTE_COLORS.includes(n.color) ? n.color : 'yellow',
                }
              : null,
          )
          .filter(Boolean)
      : [],
    branches: Array.isArray(raw.branches)
      ? raw.branches
          .map((b) =>
            b && typeof b === 'object' && asAnchor(b.anchor)
              ? {
                  id: typeof b.id === 'string' ? b.id : makeId(),
                  anchor: asAnchor(b.anchor),
                  turns: Array.isArray(b.turns) ? b.turns.map(asTurn).filter(Boolean) : [],
                  collapsed: !!b.collapsed,
                  sessionId:
                    typeof b.sessionId === 'string' && b.sessionId
                      ? b.sessionId.slice(0, 256)
                      : null,
                }
              : null,
          )
          .filter(Boolean)
      : [],
  };
  const tools = Array.isArray(raw.tools) ? raw.tools.map(asTool).filter(Boolean) : [];
  if (tools.length) turn.tools = tools;
  const changes = asChanges(raw.changes);
  if (changes) turn.changes = changes;
  // 贴图缩略图：dataURL 字符串数组，有界消毒
  const images = Array.isArray(raw.images)
    ? raw.images
        .filter(
          (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length <= THUMB_LIMIT,
        )
        .slice(0, MAX_IMAGES)
    : [];
  if (images.length) turn.images = images;
  const iurls = asAttachUrls(raw.imageUrls);
  if (iurls.length) turn.imageUrls = iurls;
  // 回合实际生效模型（done 事件上报；旧档无字段 → 缺省）
  if (typeof raw.model === 'string' && raw.model)
    turn.model = raw.model.slice(0, EFFECTIVE_MODEL_LIMIT);
  return turn;
}

// 解析并校验 localStorage 数据；结构不合法时抛错，由调用方提示用户。
export function parseStored(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || !Array.isArray(data.conversations)) {
    throw new Error('存档结构不完整');
  }
  const conversations = data.conversations
    .map((c) =>
      c && typeof c === 'object'
        ? {
            id: typeof c.id === 'string' ? c.id : makeId(),
            title: typeof c.title === 'string' && c.title ? c.title : '新对话',
            titleCustomized: !!c.titleCustomized,
            turns: Array.isArray(c.turns) ? c.turns.map(asTurn).filter(Boolean) : [],
            workspace: typeof c.workspace === 'string' ? c.workspace : '',
            sessionId: typeof c.sessionId === 'string' ? c.sessionId : null,
            permissionMode: PERMISSION_MODES.includes(c.permissionMode)
              ? c.permissionMode
              : 'accept-edits',
            modelConfig: asModelConfig(c.modelConfig),
            effectiveModel:
              typeof c.effectiveModel === 'string' && c.effectiveModel
                ? c.effectiveModel.slice(0, EFFECTIVE_MODEL_LIMIT)
                : null,
            effFor:
              typeof c.effFor === 'string' ? c.effFor.slice(0, EFFECTIVE_MODEL_LIMIT) : '',
            effSpeed:
              typeof c.effSpeed === 'string' ? c.effSpeed.slice(0, EFFECTIVE_MODEL_LIMIT) : '',
          }
        : null,
    )
    .filter(Boolean);
  const activeId =
    typeof data.activeId === 'string' && conversations.some((c) => c.id === data.activeId)
      ? data.activeId
      : conversations[0]?.id ?? null;
  // 已注册工作区 canonical 路径（去重保序；旧存档无此字段）。
  const workspaces = Array.isArray(data.workspaces)
    ? [...new Set(data.workspaces.filter((w) => typeof w === 'string' && w))]
    : [];
  // 工作区显示别名（路径 → 自定义名；空值/非法项剔除，旧存档无此字段）。
  const wsNames =
    data.wsNames && typeof data.wsNames === 'object' && !Array.isArray(data.wsNames)
      ? Object.fromEntries(
          Object.entries(data.wsNames)
            .map(([k, v]) => [k, typeof v === 'string' ? v.trim().slice(0, 80) : ''])
            .filter(([k, v]) => k.startsWith('/') && v),
        )
      : {};
  // 工作区文件夹：{id,name,parentId} 列表 + 路径→folderId 归属映射（旧存档无此字段）。
  const wsFolders = Array.isArray(data.wsFolders)
    ? data.wsFolders
        .filter((f) => f && typeof f === 'object' && typeof f.id === 'string')
        .map((f) => ({
          id: f.id.slice(0, 64),
          name: (typeof f.name === 'string' ? f.name.trim() : '').slice(0, 80) || '文件夹',
          parentId: typeof f.parentId === 'string' ? f.parentId.slice(0, 64) : null,
        }))
    : [];
  const folderIds = new Set(wsFolders.map((f) => f.id));
  const folderById = new Map(wsFolders.map((f) => [f.id, f]));
  // parentId 悬空置顶层；沿父链检测环（含自指），断掉闭环的那条边。
  for (const f of wsFolders) {
    if (!folderIds.has(f.parentId)) f.parentId = null;
  }
  for (const f of wsFolders) {
    const seen = new Set([f.id]);
    let cur = f;
    while (cur.parentId) {
      const p = folderById.get(cur.parentId);
      if (!p) {
        cur.parentId = null;
        break;
      }
      if (seen.has(p.id)) {
        cur.parentId = null;
        break;
      }
      seen.add(p.id);
      cur = p;
    }
  }
  const wsFolderId =
    data.wsFolderId && typeof data.wsFolderId === 'object' && !Array.isArray(data.wsFolderId)
      ? Object.fromEntries(
          Object.entries(data.wsFolderId).filter(
            ([k, v]) => k.startsWith('/') && folderIds.has(v),
          ),
        )
      : {};
  return { conversations, activeId, workspaces, wsNames, wsFolders, wsFolderId };
}

// 组装 /api/chat 请求体：work 携带会话级 modelConfig（'' = 跟随默认，
// 服务端跳过下发）；discussion 完全省略该字段。
// sessionId 覆盖：支线回合传自己的会话 id（主线传 undefined 用 conv.sessionId）。
export function buildChatBody({
  conv,
  kind,
  history,
  question,
  quote = '',
  images = [],
  sessionId,
}) {
  const body = {
    history,
    question,
    quote,
    workspace: conv.workspace || '',
    convId: conv.id || '',
    sessionId: kind === 'work' ? (sessionId === undefined ? conv.sessionId : sessionId) : null,
    kind,
    permissionMode: conv.permissionMode || 'accept-edits',
  };
  if (kind === 'work') {
    body.modelConfig = { ...DEFAULT_MODEL_CONFIG, ...(conv.modelConfig || {}) };
  }
  if (Array.isArray(images) && images.length) {
    body.images = images
      .slice(0, MAX_IMAGES)
      .map((i) => ({ data: String(i?.data || ''), mime: String(i?.mime || '') }));
  }
  return body;
}
