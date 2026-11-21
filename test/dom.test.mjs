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
        { value: 'opus', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
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
        { value: 'fast', name: 'Fast' },
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
  if (u === '/api/devin/options') {
    optionsCalls++;
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
  // 无会话时主输入框不存在；点「＋ 新对话」
  const newBtn = findBtn(/新对话/);
  assert.ok(newBtn, '侧栏有新对话按钮');
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
    ['adaptive', 'opus', 'sonnet'],
  );
  assert.equal(m.value, '');
  // 默认项标签显示 Devin 当前默认（currentValue → name）
  const row = container.querySelector('.model-row');
  assert.match(row.textContent, /默认（Adaptive）/);
  await select(m, 'opus');
  await select(t, 'low');
  await select(s, 'fast');
  const stored = JSON.parse(window.localStorage.getItem('newqa:v1'));
  const conv = stored.conversations.find((c) => c.id === stored.activeId);
  assert.deepEqual(
    conv.modelConfig,
    { model: 'opus', thought_level: 'low', speed: 'fast' },
    '选择写入会话持久化',
  );
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
    speed: 'fast',
  });
  await act(async () => {
    await tick(10);
  });
  assert.ok(container.textContent.includes('答：你好'), '回答上屏');
});

test('dom：支线 discussion 的 POST body 不含 modelConfig', async () => {
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
  await setText(branchTa, '追问一下');
  await key(branchTa, 'Enter');
  await act(async () => {
    await tick(30);
  });
  const body = chatCalls[chatCalls.length - 1].body;
  assert.equal(body.kind, 'discussion');
  assert.ok(!('modelConfig' in body), 'discussion 请求不含 modelConfig');
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
    ['opus', 'low', 'fast'],
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
    assert.equal(eff.getAttribute('title'), '此模型不在免费档（计费）');
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

test('dom：清理', async () => {
  await unmountApp();
  assert.ok(true);
});
