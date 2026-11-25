// DOM 级测试：jsdom + React act 驱动真实 App 组件（esbuild 转译 .jsx）。
// 覆盖：斜杠命令面板、模型三下拉持久化、modelConfig 请求体（work 带 / discussion 省略）、
//       pending 禁用、窄视口不破版式。所有 /api/* 均 mock，不触网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

register('./jsx-loader.mjs', import.meta.url);

// ---- jsdom 环境（必须在 import App.jsx 之前就绪；App 底部检测到 #root 才自挂载） ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:4173/',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame =
  window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame =
  window.cancelAnimationFrame?.bind(window) ?? clearTimeout;
// jsdom 无 matchMedia（initTheme 用全局形式调用）
window.matchMedia =
  window.matchMedia ??
  (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
globalThis.matchMedia = window.matchMedia.bind(window);
window.HTMLElement.prototype.scrollIntoView =
  window.HTMLElement.prototype.scrollIntoView ?? (() => {});
window.Element.prototype.scrollTo = window.Element.prototype.scrollTo ?? (() => {});
// jsdom 的 Range 没有布局 API；划词工具条只需要返回值存在
if (!window.Range.prototype.getBoundingClientRect) {
  const rect = () => ({
    x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
    toJSON: () => ({}),
  });
  window.Range.prototype.getBoundingClientRect = rect;
  window.Range.prototype.getClientRects = () => [];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- /api mock ----
const OPTIONS = {
  commands: [
    { name: 'compact', description: '压缩会话上下文', hint: '', category: 'session' },
    { name: 'context', description: '查看上下文用量', hint: '', category: 'session' },
    { name: 'login', description: '登录 Devin', hint: '', category: 'auth' },
    { name: 'ask', description: '只读提问', hint: '', category: 'mode' },
  ],
  config: {
    model: {
      currentValue: 'adaptive',
      options: [
        { value: 'adaptive', name: 'Adaptive' },
        { value: 'swe-2-high', name: 'SWE-2' },
        { value: 'opus', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
        {
          value: 'fusion-opus-sidekick-swe-2-high',
          name: 'Fusion (Opus + SWE-2 High)',
        },
        {
          value: 'fusion-sonnet-sidekick-swe-2-high',
          name: 'Fusion (Sonnet + SWE-2 High)',
        },
        {
          value: 'fusion-sonnet-sidekick-glm-5-2',
          name: 'Fusion (Sonnet + GLM-5.2)',
        },
      ],
    },
    thought_level: {
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
    speed: {
      currentValue: 'standard',
      options: [
        { value: 'standard', name: 'Standard' },
        { value: 'ultrafast', name: 'Ultrafast' },
      ],
    },
  },
};

const enc = (s) => new TextEncoder().encode(s);
const chatCalls = []; // { body }，/api/chat 的每次请求体
let optionsCalls = 0;
let chatResponder = null; // 测试可注入自定义流（如挂起模拟 pending）

function ndjson(events) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc(JSON.stringify(e) + '\n'));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
  );
}

globalThis.fetch = async (url, init = {}) => {
  const u = typeof url === 'string' ? url : url.url;
  if (u === '/api/status') {
    return Response.json({ cli: 'ok', version: 'devin-test', defaultCwd: '/tmp/newqa' });
  }
  if (u === '/api/devin/options' || u.startsWith('/api/devin/options?')) {
    optionsCalls++;
    // ?model=opus → 该模型的真实选项：思考档无 max、speed 不暴露
    const q = new URL(u, 'http://x').searchParams.get('model');
    if (q === 'opus') {
      return Response.json({
        ...OPTIONS,
        config: {
          model: OPTIONS.config.model,
          thought_level: {
            currentValue: 'medium',
            options: [
              { value: 'medium', name: 'Medium' },
              { value: 'xhigh', name: 'XHigh' },
            ],
          },
        },
      });
    }
    return Response.json(OPTIONS);
  }
  if (u === '/api/chat') {
    const body = JSON.parse(init.body);
    chatCalls.push({ body });
    if (chatResponder) return chatResponder(body);
    return ndjson([
      { type: 'delta', text: '答：你好' },
      { type: 'done', sessionId: 'sess-1' },
    ]);
  }
  if (u === '/api/workspace/inspect') {
    return Response.json({ path: '/tmp/x', git: false });
  }
  if (u === '/api/workspace/browse') {
    return Response.json({ path: '/tmp', parent: null, folders: [], truncated: false });
  }
  if (u === '/api/chat/permission') return Response.json({ ok: true });
  return new Response('not found', { status: 404 });
};

// ---- React 挂载 / 事件辅助 ----
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('../src/App.jsx');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let container = null;
let root = null;

async function mountApp() {
  container = window.document.createElement('div');
  window.document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(App));
    await tick(10);
  });
}

async function unmountApp() {
  if (root) {
    await act(async () => {
      root.unmount();
      await tick(0);
    });
  }
  container?.remove();
  container = null;
  root = null;
}

// 用原生 setter 绕过 React 的 value 拦截，让 onChange 看到新值
const taSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  'value',
).set;
const selSetter = Object.getOwnPropertyDescriptor(
  window.HTMLSelectElement.prototype,
  'value',
).set;

async function setText(el, v, caret = v.length) {
  taSetter.call(el, v);
  el.selectionStart = el.selectionEnd = caret;
  await act(async () => {
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick(0);
  });
}

async function key(el, k, opts = {}) {
  await act(async () => {
    el.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...opts,
      }),
    );
    await tick(0);
  });
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick(0);
  });
}

async function select(el, v) {
  selSetter.call(el, v);
  await act(async () => {
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(0);
  });
}

const findBtn = (re) =>
  [...container.querySelectorAll('button')].find((b) => re.test(b.textContent));

test('dom：新对话 + conv 挂载自动取 /api/devin/options（静默一次）', async () => {
  window.localStorage.clear();
  await mountApp();
  // 无会话时主输入框不存在；未分组 ⋯ 菜单里点「新建对话」
  const ugBtn = container.querySelector('[aria-label="未分组的操作"]');
  assert.ok(ugBtn, '未分组有操作菜单');
  await click(ugBtn);
  const newBtn = findBtn(/^新建对话$/);
  assert.ok(newBtn, '菜单里有新建对话');
  await click(newBtn);
  await act(async () => {
    await tick(30);
  });
  assert.ok(container.querySelector('#composer-main'), '主输入框出现');
  assert.ok(optionsCalls >= 1, '工作区条挂载即预取 options');
  // 模型行渲染且控件因探测中/就绪状态正确
  const sels = container.querySelectorAll('.model-select');
  assert.equal(sels.length, 3, '模型/思考/速度三个下拉');
  assert.equal(sels[0].disabled, false, '探测成功后可用');
  // 对话设置收进 <details>：默认收起，且不再有独立目录横幅
  const settings = container.querySelector('.composer-settings');
  assert.ok(settings, '对话设置折叠区存在');
  assert.equal(settings.open, false, '设置区默认收起');
  assert.ok(!container.querySelector('.ws-path'), '不再显示目录路径横幅');
  await click(settings.querySelector('summary'));
  if (!settings.open) {
    // jsdom 不实现 summary 激活行为，直接置 open 兜底
    await act(async () => {
      settings.open = true;
    });
  }
  assert.equal(settings.open, true, '设置区可展开');
  const settingLabels = [...settings.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(settingLabels.includes('更改目录'), '展开后可见「更改目录」');
  assert.ok(settingLabels.includes('浏览文件夹'), '展开后可见「浏览文件夹」');
  await click(settings.querySelector('summary'));
  if (settings.open) {
    await act(async () => {
      settings.open = false;
    });
  }
  assert.equal(settings.open, false, '设置区可收起');
});

test('dom：主输入框 /co 弹过滤面板，Enter 接受 /compact ', async () => {
  const ta = container.querySelector('#composer-main');
  await setText(ta, '/co');
  const lb = container.querySelector('[role="listbox"]');
  assert.ok(lb, 'listbox 出现');
  const names = [...lb.querySelectorAll('[role="option"]')].map((o) =>
    o.textContent,
  );
  assert.ok(names.some((t) => t.includes('/compact')));
  assert.ok(names.some((t) => t.includes('/context')));
  assert.ok(!names.some((t) => t.includes('/login')), '前缀过滤生效');
  assert.ok(!names.some((t) => t.includes('/ask')));
  // aria-combobox 关联
  assert.equal(ta.getAttribute('aria-expanded'), 'true');
  assert.equal(ta.getAttribute('aria-controls'), lb.id);
  const actId = ta.getAttribute('aria-activedescendant');
  assert.ok(actId && window.document.getElementById(actId), 'activedescendant 指向首项');
  // Enter 接受首项（默认高亮第一项）
  await key(ta, 'Enter');
  assert.equal(ta.value, '/compact ');
  assert.ok(!container.querySelector('[role="listbox"]'), '接受后面板关闭');
  // caret 应在 '/compact ' 之后（setSelectionRange 生效）
  assert.equal(ta.selectionStart, '/compact '.length);
});

test('dom：斜杠面板 ↑↓ 移动、Tab 接受、Esc 关闭', async () => {
  const ta = container.querySelector('#composer-main');
  await setText(ta, '/co');
  assert.ok(container.querySelector('[role="listbox"]'));
  await key(ta, 'ArrowDown'); // compact → context
  await key(ta, 'Tab');
  assert.equal(ta.value, '/context ', 'Tab 接受第二项');
  // 再次打开后 Esc 关闭且不再自动重开（直至下次改动）
  await setText(ta, '/co');
  assert.ok(container.querySelector('[role="listbox"]'));
  await key(ta, 'Escape');
  assert.ok(!container.querySelector('[role="listbox"]'), 'Esc 关闭面板');
  // 清空草稿，避免影响后续
  await setText(ta, '');
});

test('dom：模型三下拉展示探测选项与 Devin 默认，选择即持久化', async () => {
  const [m, t, s] = container.querySelectorAll('.model-select');
  // 第一项「默认」(空值)，其后为探测选项
  assert.equal(m.options[0].value, '');
  assert.deepEqual(
    [...m.options].slice(1).map((o) => o.value),
    ['adaptive', 'swe-2-high', 'opus', 'sonnet'],
  );
  assert.equal(m.value, '');
  // 默认项标签显示 Devin 当前默认（currentValue → name）
  const row = container.querySelector('.model-row');
  assert.match(row.textContent, /默认（Adaptive）/);
  await select(t, 'low');
  await select(s, 'ultrafast');
  await select(m, 'opus');
  const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
  const conv = stored.conversations.find((c) => c.id === stored.activeId);
  assert.deepEqual(
    conv.modelConfig,
    { model: 'opus', thought_level: 'low', speed: 'ultrafast' },
    '选择写入会话持久化',
  );
  // fusion-* 配对不进模型下拉（由 /fusion 选择器负责）
  const vals = [...m.options].map((o) => o.value);
  assert.ok(!vals.some((v) => v.startsWith('fusion-')), 'fusion 不在模型下拉');
});

test('dom：换模型后按 ?model= 探测，思考档显示该模型真实可选项', async () => {
  const selects = container.querySelectorAll('.model-select');
  const m = selects[0];
  const t = selects[1];
  // 上个用例已选 opus：思考档按该模型探测结果给出（无 max），
  // 已存的 'low' 不在列表 → 兜底项保留显示
  const vals0 = [...t.options].slice(1).map((o) => o.value);
  assert.deepEqual(vals0, ['medium', 'xhigh', 'low']);
  await select(t, 'xhigh');
  const stored1 = JSON.parse(window.localStorage.getItem('newqa:v1'));
  assert.equal(
    stored1.conversations.find((c) => c.id === stored1.activeId).modelConfig
      .thought_level,
    'xhigh',
  );
  // 换 adaptive → 新的 ?model= 探测落地：基础档位恢复 + 'xhigh' 兜底项
  await select(m, 'adaptive');
  assert.deepEqual(
    [...t.options].slice(1).map((o) => o.value),
    ['low', 'high', 'max', 'xhigh'],
    '思考档随所选模型刷新，不支持值以兜底项保留',
  );
  // 还原为上个用例留下的 {opus, low, ultrafast}，避免污染后续用例
  await select(t, 'low');
  await select(m, 'opus');
});

test('dom：/fusion 弹双列选择器，Tab 切列、Enter 确认写入 modelConfig', async () => {
  const ta = container.querySelector('#composer-main');
  await setText(ta, '/fusion');
  const menu = container.querySelector('.fusion-menu');
  assert.ok(menu, '/fusion 触发选择器');
  const cols = menu.querySelectorAll('.fusion-col');
  assert.equal(cols.length, 2, 'Leader/Sidekick 两列');
  assert.deepEqual(
    [...cols[0].querySelectorAll('.fusion-opt')].map((o) => o.textContent),
    ['Opus', 'Sonnet'],
  );
  // 默认焦点 Opus → Sidekick 列只有一项；↓ 切 Sonnet 后刷新为两项
  assert.equal(cols[1].querySelectorAll('.fusion-opt').length, 1);
  await key(ta, 'ArrowDown');
  assert.deepEqual(
    [...cols[1].querySelectorAll('.fusion-opt')].map((o) => o.textContent),
    ['SWE-2 High', 'GLM-5.2'],
  );
  // Leader 列 Enter → 跳 Sidekick 列（未提交）；再 ↓ 选 GLM-5.2
  await key(ta, 'Enter');
  assert.ok(container.querySelector('.fusion-menu'), 'Leader 列回车不提交');
  await key(ta, 'ArrowDown');
  await key(ta, 'Enter');
  assert.ok(!container.querySelector('.fusion-menu'), '确认后选择器关闭');
  assert.equal(ta.value, '', '“/fusion” token 被剥掉');
  const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
  const conv = stored.conversations.find((c) => c.id === stored.activeId);
  assert.equal(
    conv.modelConfig.model,
    'fusion-sonnet-sidekick-glm-5-2',
    '配对 uid 写入 modelConfig',
  );
  // 当前值不在下拉选项里 → 回退项显示 Fusion 友好名
  const m = container.querySelector('.model-select');
  const cur = [...m.options].find((o) => o.value === conv.modelConfig.model);
  assert.equal(cur?.textContent, 'Fusion (Sonnet + GLM-5.2)');
  // 恢复后续测试期望的 modelConfig（model='opus'）
  await select(m, 'opus');
});

test('dom：work 回合 POST body 携带 modelConfig', async () => {
  const before = chatCalls.length;
  const ta = container.querySelector('#composer-main');
  await setText(ta, '你好');
  await key(ta, 'Enter');
  await act(async () => {
    await tick(30);
  });
  assert.ok(chatCalls.length > before, '发出 /api/chat');
  const body = chatCalls[chatCalls.length - 1].body;
  assert.equal(body.kind, 'work');
  assert.deepEqual(body.modelConfig, {
    model: 'opus',
    thought_level: 'low',
    speed: 'ultrafast',
  });
  await act(async () => {
    await tick(10);
  });
  assert.ok(container.textContent.includes('答：你好'), '回答上屏');
});

test('dom：支线走 work 通道——独立会话 id、不污染主线 sessionId', async () => {
  const block = container.querySelector('.source-block[data-block="0"]');
  assert.ok(block, '有已渲染的回答块');
  const range = window.document.createRange();
  range.selectNodeContents(block);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  await act(async () => {
    window.document.dispatchEvent(new window.Event('selectionchange'));
    await tick(30);
  });
  const askBtn = [...container.querySelectorAll('.sel-bar button')].find((b) =>
    b.textContent.includes('追问'),
  );
  assert.ok(askBtn, '划词工具条有「追问」');
  await click(askBtn);
  const branchTa = container.querySelector('.branch-ui .composer-input');
  assert.ok(branchTa, '支线输入框出现');
  // 支线输入框无斜杠面板（combo 未启用）
  assert.equal(branchTa.getAttribute('role'), null);
  // 支线回合用自己的 sessionId：quote 非空 → 'br-sess-1'，否则主线 'main-sess-9'
  chatResponder = (body) =>
    ndjson([
      { type: 'delta', text: '答' },
      { type: 'done', sessionId: body.quote ? 'br-sess-1' : 'main-sess-9' },
    ]);
  try {
    await setText(branchTa, '追问一下');
    await key(branchTa, 'Enter');
    await act(async () => {
      await tick(30);
    });
    const body = chatCalls[chatCalls.length - 1].body;
    assert.equal(body.kind, 'work', '支线回合走 work（完整 agent 能力）');
    assert.ok('modelConfig' in body, 'work 请求带 modelConfig');
    assert.equal(body.sessionId, null, '支线首轮无会话 → session/new');
    assert.ok(body.quote, '支线携带选段引用');
    // done 的 br-sess-1 写回支线节点；主线 sessionId 不被覆盖
    const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
    const conv = stored.conversations.find((x) => x.turns.some((t) => t.branches?.length));
    const br = conv.turns.flatMap((t) => t.branches).find((b) => b.turns.length);
    assert.equal(br.sessionId, 'br-sess-1', '支线会话 id 持久化到支线节点');
    assert.notEqual(conv.sessionId, 'br-sess-1', '主线 sessionId 未被支线覆盖');
    // 第二条支线追问 → 携带支线自己的 sessionId 原生续聊
    const branchTa2 = container.querySelector('.branch-ui .composer-input');
    await setText(branchTa2, '再问一层');
    await key(branchTa2, 'Enter');
    await act(async () => {
      await tick(30);
    });
    const body2 = chatCalls[chatCalls.length - 1].body;
    assert.equal(body2.sessionId, 'br-sess-1', '支线续聊复用自己的会话');
    assert.equal(body2.kind, 'work');
  } finally {
    chatResponder = null;
  }
});

test('dom：回合进行中模型下拉禁用，完成后恢复', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  chatResponder = () =>
    new Response(
      new ReadableStream({
        async start(c) {
          await gate;
          c.enqueue(enc('{"type":"delta","text":"答2"}\n'));
          c.enqueue(enc('{"type":"done","sessionId":"sess-2"}\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
    );
  try {
    const ta = container.querySelector('#composer-main');
    await setText(ta, '再问一下');
    await key(ta, 'Enter');
    await act(async () => {
      await tick(20);
    });
    const sels = [...container.querySelectorAll('.model-select')];
    assert.ok(sels.every((s) => s.disabled), 'pending 时三个下拉禁用');
    await act(async () => {
      release();
      await tick(30);
    });
    const sels2 = [...container.querySelectorAll('.model-select')];
    assert.ok(sels2.every((s) => !s.disabled), '完成后恢复可用');
  } finally {
    chatResponder = null;
  }
});

test('dom：重挂载（模拟刷新）后模型选择仍在', async () => {
  await unmountApp();
  await mountApp();
  await act(async () => {
    await tick(30);
  });
  const sels = [...container.querySelectorAll('.model-select')];
  assert.equal(sels.length, 3);
  assert.deepEqual(
    sels.map((s) => s.value),
    ['opus', 'low', 'ultrafast'],
    '刷新后选择恢复（parseStored 回读）',
  );
});

test('dom：窄视口（≤960px）模型行仍完整可用', async () => {
  const orig = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  try {
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'));
      await tick(20);
    });
    const row = container.querySelector('.model-row');
    assert.ok(row, '模型行存在');
    const sels = [...row.querySelectorAll('.model-select')];
    assert.equal(sels.length, 3);
    assert.equal(sels[0].value, 'opus', '窄屏下选择仍生效');
    assert.ok(!sels.every((s) => s.disabled), '窄屏下控件可用');
    // 斜杠面板在窄屏同样工作
    const ta = container.querySelector('#composer-main');
    await setText(ta, '/as');
    assert.ok(container.querySelector('[role="listbox"]'));
    await key(ta, 'Escape');
    await setText(ta, '');
  } finally {
    if (orig) Object.defineProperty(window, 'innerWidth', orig);
    else {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    }
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'));
      await tick(10);
    });
  }
});

test('dom：工具调用插入回答实际位置，流式与持久化顺序一致', async () => {
  let ctrl;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  chatResponder = () =>
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  // .turn-a 直接子节点分类：tool-list → 'tools'，其余（source-block 等）→ 'text'；
  // 生成光标 .cursor 忽略。
  const kinds = (el) =>
    [...el.children]
      .filter((c) => !c.classList.contains('cursor'))
      .map((c) => (c.classList.contains('tool-list') ? 'tools' : 'text'));
  try {
    const ta = container.querySelector('#composer-main');
    await setText(ta, '跑一下命令');
    await key(ta, 'Enter');
    await act(async () => {
      ctrl.enqueue(enc('{"type":"delta","text":"先检查"}\n'));
      ctrl.enqueue(
        enc(
          '{"type":"tool","tool":{"id":"cmd","kind":"execute","status":"in_progress","command":"printf ok"}}\n',
        ),
      );
      await tick(20);
    });
    // pending：文本块在前、工具列表紧随其后（同位置工具归一组）
    const pa = container.querySelector('.pending .turn-a');
    assert.ok(pa, 'pending 回合渲染');
    assert.deepEqual(kinds(pa), ['text', 'tools'], 'pending 中文本块后接工具');
    assert.match(pa.querySelector('.source-block').textContent, /先检查/);
    const det = pa.querySelector('.tool-detail');
    assert.ok(det, '工具命令详情存在');
    assert.equal(det.open, false, '命令详情默认收起');

    await act(async () => {
      ctrl.enqueue(
        enc('{"type":"tool","tool":{"id":"cmd","kind":"execute","status":"completed"}}\n'),
      );
      ctrl.enqueue(enc('{"type":"delta","text":"检查通过"}\n'));
      ctrl.enqueue(enc('{"type":"done","sessionId":"sess-tl"}\n'));
      ctrl.close();
      await tick(40);
    });

    // 最近一个完成回合：正文 → 工具 → 正文；工具不重复、块索引连续
    const checkTurn = () => {
      const turns = [...container.querySelectorAll('.turn[data-turn]')];
      const last = turns[turns.length - 1];
      const a = [...last.children].find((c) => c.classList.contains('turn-a'));
      assert.deepEqual(kinds(a), ['text', 'tools', 'text'], '正文-工具-正文顺序');
      const blocks = [...a.children].filter((c) => c.classList.contains('source-block'));
      assert.deepEqual(
        blocks.map((b) => b.dataset.block),
        ['0', '1'],
        '文本块索引 0/1',
      );
      const items = a.querySelectorAll('.tool-item');
      assert.equal(items.length, 1, '同一工具合并不重复');
      assert.equal(items[0].querySelector('.tool-status').textContent, 'completed');
    };
    checkTurn();

    // 重挂载（走 localStorage + parseStored）后顺序不变
    await unmountApp();
    await mountApp();
    await act(async () => {
      await tick(30);
    });
    checkTurn();
  } finally {
    chatResponder = null;
    try {
      ctrl?.close();
    } catch {}
  }
});

test('dom：done 带 model → 实际模型行（Fusion 含 swe-2 也标黄）', async () => {
  chatResponder = () =>
    ndjson([
      { type: 'delta', text: '答：模型' },
      {
        type: 'done',
        sessionId: 'sess-u',
        // Fusion 的 UID 里含 sidekick-swe-2，但主模型计费，必须标黄
        model: 'fusion-gpt-6-2-sol-medium-sidekick-swe-2-high',
      },
    ]);
  try {
    const ta = container.querySelector('#composer-main');
    await setText(ta, '模型测试');
    await key(ta, 'Enter');
    await act(async () => {
      await tick(40);
    });
    // 对话设置模型行：实际：值，Fusion 即使含 swe-2 也按计费标黄
    const eff = container.querySelector('.model-eff');
    assert.ok(eff, '实际模型行渲染');
    assert.match(eff.textContent, /实际：fusion-gpt-6-2-sol-medium-sidekick-swe-2-high/);
    assert.ok(eff.classList.contains('warn'), 'Fusion → warn 标黄');
    assert.match(eff.getAttribute('title'), /此模型不在免费档（计费）/);
    // 持久化：conv.effectiveModel + turn.model
    const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
    const conv = stored.conversations.find((c) => c.id === stored.activeId);
    assert.equal(conv.effectiveModel, 'fusion-gpt-6-2-sol-medium-sidekick-swe-2-high');
    const lastStored = conv.turns.at(-1);
    assert.equal(lastStored.model, 'fusion-gpt-6-2-sol-medium-sidekick-swe-2-high');
  } finally {
    chatResponder = null;
  }
});

test('dom：SWE-2 模型不标黄；无 model 上报时实际行隐藏', async () => {
  // 前面的测试把速度选成了 fast；先切回 standard，单独验证模型维度
  const sels = container.querySelectorAll('.model-select');
  await select(sels[2], 'standard');
  chatResponder = () =>
    ndjson([
      { type: 'delta', text: '答：swe' },
      { type: 'done', sessionId: 'sess-s', model: 'swe-2-flash-max' },
    ]);
  try {
    const ta = container.querySelector('#composer-main');
    await setText(ta, 'swe 测试');
    await key(ta, 'Enter');
    await act(async () => {
      await tick(40);
    });
    const eff = container.querySelector('.model-eff');
    assert.ok(eff, '实际模型行渲染');
    assert.match(eff.textContent, /实际：swe-2-flash-max/);
    assert.ok(!eff.classList.contains('warn'), '免费 SKU → 不标黄');
    assert.equal(eff.getAttribute('title'), null);
    // 持久化覆盖为最新值
    const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
    const conv = stored.conversations.find((c) => c.id === stored.activeId);
    assert.equal(conv.effectiveModel, 'swe-2-flash-max');
  } finally {
    chatResponder = null;
  }
});

test('dom：速度 Ultrafast 标「计费」，SWE-2 实际模型行也标黄', async () => {
  // 前面的测试已把速度选成 ultrafast；这里把模型切到免费的 SWE-2 家族
  const [m, , s] = container.querySelectorAll('.model-select');
  await select(m, 'swe-2-high');
  await select(s, 'ultrafast');
  const row = container.querySelector('.model-row');
  assert.ok(row.querySelector('.model-warn'), '非 Standard 速度档有常驻计费提示');
  assert.match(row.textContent, /Ultrafast 计费/);
  const fastOpt = [...s.options].find((o) => o.value === 'ultrafast');
  assert.match(fastOpt.textContent, /Ultrafast（计费）/, '速度选项标签标明计费');

  // done 只上报家族值 swe-2-high；提示必须结合 speed=ultrafast 标黄
  chatResponder = () =>
    ndjson([
      { type: 'delta', text: '答：fast' },
      { type: 'done', sessionId: 'sess-f', model: 'swe-2-high' },
    ]);
  try {
    const ta = container.querySelector('#composer-main');
    await setText(ta, 'fast 测试');
    await key(ta, 'Enter');
    await act(async () => {
      await tick(40);
    });
    const eff = container.querySelector('.model-eff');
    assert.ok(eff, '实际模型行渲染');
    assert.match(eff.textContent, /实际：SWE-2（Ultrafast 计费）/);
    assert.ok(eff.classList.contains('warn'), 'ultrafast → warn 标黄');
    assert.match(eff.getAttribute('title'), /Lightning/);
    // effSpeed 与 effFor 一起持久化
    const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
    const conv = stored.conversations.find((c) => c.id === stored.activeId);
    assert.equal(conv.effSpeed, 'ultrafast');
  } finally {
    chatResponder = null;
  }
});

test('dom：流中途断开 → 已生成内容存为不完整回合，问题不丢失', async () => {
  // 模拟 failed to fetch / 连接中断：有 delta 但流没有 done 就关了
  let ctrl;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  chatResponder = () =>
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  try {
    const ta = container.querySelector('#composer-main');
    await setText(ta, '断流测试问题');
    await key(ta, 'Enter');
    await act(async () => {
      ctrl.enqueue(enc('{"type":"delta","text":"已生成了一半"}\n'));
      ctrl.close(); // 无 done 直接结束 → 视为连接中断
      await tick(50);
    });
    const turns = [...container.querySelectorAll('.turn[data-turn]')];
    const last = turns[turns.length - 1];
    assert.match(last.querySelector('.turn-q').textContent, /断流测试问题/, '问题保留在回合');
    assert.match(last.querySelector('.turn-a').textContent, /已生成了一半/, '部分内容保留');
    assert.match(last.querySelector('.turn-a').textContent, /生成中断/, '有中断标记');
    assert.ok(!container.querySelector('.pending'), 'pending 卡片已移除');
    assert.equal(
      container.querySelector('#composer-main').value,
      '',
      '已存回合不再回填输入框',
    );
    // 持久化后重挂载仍在（不进历史黑洞）
    await unmountApp();
    await mountApp();
    await act(async () => {
      await tick(30);
    });
    const turns2 = [...container.querySelectorAll('.turn[data-turn]')];
    assert.match(turns2.at(-1).querySelector('.turn-a').textContent, /已生成了一半/);
  } finally {
    chatResponder = null;
    try {
      ctrl?.close();
    } catch {}
  }
});

test('dom：斜杠命令原文下发（history 不进 envelope）', async () => {
  const before = chatCalls.length;
  const ta = container.querySelector('#composer-main');
  await setText(ta, '/compact');
  await key(ta, 'Escape'); // 先关命令面板，Enter 才是提交
  await key(ta, 'Enter');
  await act(async () => {
    await tick(40);
  });
  const call = chatCalls.at(-1);
  assert.ok(chatCalls.length > before, '产生了 /api/chat 请求');
  assert.equal(call.body.question, '/compact', '命令原文下发');
  assert.deepEqual(call.body.history, [], '命令不打包历史');
});

test('dom：左栏搜索过滤会话、Esc 清空，且对话设置展示摘要', async () => {
  const sum = container.querySelector('.composer-settings > summary .settings-summary');
  assert.ok(sum, '对话设置摘要存在');
  assert.match(sum.textContent, /·/);

  const search = container.querySelector('.sidebar-search-input');
  assert.ok(search, '左栏搜索框存在');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      search,
      '不可能匹配的词xyz',
    );
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.ok(
    container.textContent.includes('未找到匹配的会话或工作区'),
    '无匹配时显示空提示',
  );
  await key(search, 'Escape');
  assert.equal(search.value, '', 'Esc 清空搜索');
});

test('dom：工作区文件夹——新建/重命名/菜单移入/删除回落顶层', async () => {
  // 种子：两个已注册工作区各挂一个会话
  await unmountApp();
  window.localStorage.clear();
  window.localStorage.setItem(
    'newqa:v1',
    JSON.stringify({
      v: 1,
      conversations: [
        { id: 'c1', title: 'A 的对话', turns: [], workspace: '/tmp/ws-a', sessionId: null },
        { id: 'c2', title: 'B 的对话', turns: [], workspace: '/tmp/ws-b', sessionId: null },
      ],
      activeId: 'c1',
      workspaces: ['/tmp/ws-a', '/tmp/ws-b'],
      wsNames: {},
    }),
  );
  await mountApp();
  await act(async () => {
    await tick(30);
  });
  const topGroups = () =>
    [...container.querySelectorAll('.ws-groups > .ws-group[data-ws]')].filter(
      (s) => s.dataset.ws !== '__ungrouped__',
    );
  assert.equal(topGroups().length, 2, '初始两个顶层工作区');
  assert.ok(!container.querySelector('.ws-folder'), '初始无文件夹');

  // 新建文件夹：点击后进入重命名，输入名并 Enter
  await click(container.querySelector('button[aria-label="新建文件夹（归类工作区）"]'));
  const renameInput = container.querySelector('.ws-folder .conv-rename input');
  assert.ok(renameInput, '新建文件夹后出现重命名输入');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      renameInput,
      '项目集',
    );
    renameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await key(renameInput, 'Enter');
  const folderHead = container.querySelector('.ws-folder .ws-group-name');
  assert.equal(folderHead?.textContent, '项目集', '文件夹名生效');
  const stored1 = JSON.parse(window.localStorage.getItem('newqa:v1'));
  assert.equal(stored1.wsFolders[0].name, '项目集', '文件夹持久化');

  // ws-a 经 ⋯ 菜单「移动到文件夹」移入
  const wsA = container.querySelector('.ws-group[data-ws="/tmp/ws-a"]');
  await click(wsA.querySelector('.conv-menu-btn'));
  const menuBtn = (re) =>
    [...container.querySelectorAll('.conv-menu button')].find((b) =>
      re.test(b.textContent),
    );
  await click(menuBtn(/移动到文件夹/));
  await click(menuBtn(/项目集/));
  const stored2 = JSON.parse(window.localStorage.getItem('newqa:v1'));
  assert.ok(stored2.wsFolderId['/tmp/ws-a'], '归属映射持久化');
  assert.equal(
    container.querySelectorAll('.ws-folder-body .ws-group[data-ws]').length,
    1,
    'ws-a 已进文件夹',
  );
  assert.equal(topGroups().length, 1, '顶层只剩 ws-b');

  // ws-b 也移入 → 顶层清空
  const wsB = container.querySelector(
    '.ws-groups > .ws-group[data-ws="/tmp/ws-b"]',
  );
  await click(wsB.querySelector('.conv-menu-btn'));
  await click(menuBtn(/移动到文件夹/));
  await click(menuBtn(/项目集/));
  assert.equal(
    container.querySelectorAll('.ws-folder-body .ws-group[data-ws]').length,
    2,
    '两个工作区同在一个文件夹',
  );
  assert.equal(topGroups().length, 0, '顶层无散落工作区');

  // 在「项目集」里建子文件夹并重命名
  await click(container.querySelector('.ws-folder .conv-menu-btn'));
  await click(menuBtn(/新建子文件夹/));
  const childInput = container.querySelector(
    '.ws-folder .ws-folder .conv-rename input',
  );
  assert.ok(childInput, '子文件夹重命名输入出现在嵌套层');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      childInput,
      '子集',
    );
    childInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await key(childInput, 'Enter');
  assert.equal(
    container.querySelectorAll('.ws-folder .ws-folder').length,
    1,
    '项目集内出现子文件夹',
  );
  const storedNest = JSON.parse(window.localStorage.getItem('newqa:v1'));
  const childF = storedNest.wsFolders.find((f) => f.name === '子集');
  assert.ok(childF, '子文件夹持久化');
  const parentF = storedNest.wsFolders.find((f) => f.name === '项目集');
  assert.equal(childF.parentId, parentF.id, '子文件夹指向父级');

  // ws-b 移入子文件夹（经 ⋯ 二级页，按精确名点选）
  const wsB2 = container.querySelector('.ws-group[data-ws="/tmp/ws-b"]');
  await click(wsB2.querySelector('.conv-menu-btn'));
  await click(menuBtn(/移动到文件夹/));
  const childEntry = [...container.querySelectorAll('.conv-menu button')].find(
    (b) => b.textContent.trim() === '子集',
  );
  assert.ok(childEntry, '二级页列出子文件夹');
  await click(childEntry);
  const storedNest2 = JSON.parse(window.localStorage.getItem('newqa:v1'));
  assert.equal(storedNest2.wsFolderId['/tmp/ws-b'], childF.id, 'ws-b 归入子集');

  // 删除父级「项目集」：ws-a 回落顶层；子集上挂为顶层且 ws-b 仍归其下
  const parentSection = container.querySelector('.ws-groups > .ws-folder');
  await click(parentSection.querySelector('.conv-menu-btn'));
  await click(menuBtn(/删除文件夹/));
  const storedEnd = JSON.parse(window.localStorage.getItem('newqa:v1'));
  assert.equal(
    container.querySelectorAll('.ws-groups > .ws-folder').length,
    1,
    '子集上挂为顶层文件夹',
  );
  assert.equal(topGroups().length, 1, 'ws-a 回落顶层');
  assert.equal(storedEnd.wsFolderId['/tmp/ws-b'], childF.id, 'ws-b 仍在子集下');
  assert.ok(!storedEnd.wsFolderId['/tmp/ws-a'], 'ws-a 归属清除');
  assert.equal(
    storedEnd.wsFolders.find((f) => f.id === childF.id)?.parentId,
    null,
    '子集父级置空',
  );
});

test('dom：文件夹菜单「新建工作区…」→ 选目录后直接归入该文件夹', async () => {
  // 上个用例结束态：顶层文件夹「子集」，ws-b 在其内，ws-a 在顶层
  const folderSection = container.querySelector('.ws-groups > .ws-folder');
  assert.ok(folderSection, '顶层仍有文件夹');
  const beforeStored = JSON.parse(window.localStorage.getItem('newqa:v1'));
  const folderId = beforeStored.wsFolders[0].id;
  await click(folderSection.querySelector('.conv-menu-btn'));
  const newWsItem = [...container.querySelectorAll('.conv-menu button')].find(
    (b) => b.textContent.trim() === '新建工作区…',
  );
  assert.ok(newWsItem, '文件夹菜单含「新建工作区…」');
  await click(newWsItem);
  await act(async () => {
    await tick(30);
  });
  // 目录选择器打开（mock browse → /tmp），直接确认当前目录
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, '目录选择器打开');
  const confirm = [...container.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === '选择此文件夹',
  );
  await click(confirm);
  await act(async () => {
    await tick(30);
  });
  // mock inspect 回 /tmp/x：注册 + 归入该文件夹 + 顺手开了新会话
  const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
  assert.equal(stored.wsFolderId['/tmp/x'], folderId, '新工作区直接归入文件夹');
  assert.ok(stored.workspaces.includes('/tmp/x'), '工作区已注册');
  assert.ok(
    stored.conversations.some((c) => c.workspace === '/tmp/x'),
    '新工作区下自动开了会话',
  );
  assert.ok(!container.querySelector('[role="dialog"]'), '选择器已关闭');
  // 渲染验证：/tmp/x 出现在文件夹 body 内，不在顶层
  assert.ok(
    container.querySelector('.ws-folder-body .ws-group[data-ws="/tmp/x"]'),
    '新工作区渲染在文件夹内',
  );
  assert.ok(
    !container.querySelector('.ws-groups > .ws-group[data-ws="/tmp/x"]'),
    '新工作区不出现在顶层',
  );
});

test('dom：清理', async () => {
  await unmountApp();
  assert.ok(true);
});
