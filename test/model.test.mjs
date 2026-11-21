import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConversation,
  historyFor,
  historyForRequest,
  appendTurn,
  addNoteToTurn,
  addBranchToTurn,
  setNoteText,
  setNoteColor,
  removeNote,
  setBranchCollapsed,
  expandBranches,
  removeBranch,
  branchOrdinal,
  createTurn,
  createNote,
  createBranch,
  turnsAtPath,
  collectMarks,
  parseStored,
  parseLayout,
  effectivePanelWidths,
  branchAppearance,
  conversationIndex,
  DEFAULT_LAYOUT,
  titleFromQuestion,
  buildChatBody,
  isBillableModel,
  isBillableSpeed,
} from '../src/model.js';

const T = (id, q, a, extra = {}) => ({
  id,
  question: q,
  answer: a,
  notes: [],
  branches: [],
  ...extra,
});
const A = (quote = '选中文字') => ({
  startBlock: 0,
  startOffset: 0,
  endBlock: 0,
  endOffset: 4,
  quote,
});
const B = (id, anchor, turns = []) => ({ id, anchor, turns });

test('historyFor 主线返回全部回合', () => {
  const turns = [T('t1', '问1', '答1'), T('t2', '问2', '答2')];
  assert.deepEqual(historyFor(turns, []), [
    { role: 'user', text: '问1' },
    { role: 'assistant', text: '答1' },
    { role: 'user', text: '问2' },
    { role: 'assistant', text: '答2' },
  ]);
});

test('historyFor 支线：只含截止回合 + 支线内容，不含后续主线/兄弟支线', () => {
  const b1 = B('b1', A('引用一'), [T('bt1', '支问1', '支答1')]);
  const b2 = B('b2', A('引用二'), [T('bt2', '兄弟问', '兄弟答')]);
  const turns = [
    T('t1', '问1', '答1', { branches: [b1, b2] }),
    T('t2', '问2-之后', '答2-之后'),
  ];
  assert.deepEqual(historyFor(turns, ['b1']), [
    { role: 'user', text: '问1' },
    { role: 'assistant', text: '答1' },
    { role: 'user', text: '支问1' },
    { role: 'assistant', text: '支答1' },
  ]);
});

test('historyFor 嵌套支线与未知路径', () => {
  const inner = B('inner', A('内引用'), [T('it1', '内问', '内答')]);
  const outer = B('outer', A('外引用'), [T('ot1', '外问', '外答', { branches: [inner] })]);
  const turns = [T('t1', '问1', '答1', { branches: [outer] }), T('t2', '问2', '答2')];
  assert.deepEqual(historyFor(turns, ['outer', 'inner']), [
    { role: 'user', text: '问1' },
    { role: 'assistant', text: '答1' },
    { role: 'user', text: '外问' },
    { role: 'assistant', text: '外答' },
    { role: 'user', text: '内问' },
    { role: 'assistant', text: '内答' },
  ]);
  assert.throws(() => historyFor(turns, ['nope']), /Unknown thread/);
});

test('historyForRequest 给支线首个提问注入祖先引用', () => {
  const inner = B('inner', A('内层引用'), [T('it1', '内问', '内答')]);
  const outer = B('outer', A('外层引用'), [
    T('ot0', '外问0', '外答0'),
    T('ot1', '外问1', '外答1', { branches: [inner] }),
    T('ot2', '外问2-之后', '外答2-之后'), // 位于内支线宿主回合之后，应被截掉
  ]);
  const turns = [T('t1', '问1', '答1', { branches: [outer] })];
  const hist = historyForRequest(turns, ['outer', 'inner']);
  // 外支线首回合带外层引用
  assert.match(hist[2].text, /\[引用选段\] 外层引用/);
  assert.match(hist[2].text, /外问0/);
  // 外支线后续回合不重复注入
  assert.equal(hist[4].text, '外问1');
  // 内支线首回合带内层引用
  assert.match(hist[6].text, /\[引用选段\] 内层引用/);
  assert.match(hist[6].text, /内问/);
  // 宿主回合之后的内容被截掉
  assert.equal(hist.length, 8);
});

test('不可变更新保留无关数据', () => {
  const note = createNote(A());
  const conv1 = [T('a1', 'q', 'ans', { notes: [note] })];
  const conv2 = [T('b1', 'q2', 'ans2')];

  const after = addNoteToTurn(conv1, 'a1', createNote(A('新')));
  assert.equal(conv1[0].notes.length, 1, '原数组不被修改');
  assert.equal(after[0].notes.length, 2);
  assert.equal(conv2[0].answer, 'ans2');

  const branch = createBranch(A());
  const deep = [T('p', 'q', 'a', { branches: [B('br', A(), [T('child', 'cq', 'ca')])] })];
  const afterDeep = addNoteToTurn(deep, 'child', createNote(A('深层')));
  assert.equal(afterDeep[0].branches[0].turns[0].notes.length, 1, '支持嵌套回合');
  assert.equal(deep[0].branches[0].turns[0].notes.length, 0);

  const edited = setNoteText(after, 'a1', after[0].notes[0].id, '改过的笔记');
  assert.equal(edited[0].notes[0].text, '改过的笔记');
  assert.equal(after[0].notes[0].text, '');
  assert.equal(setNoteText(after, 'missing', 'x', 'y'), after, '未命中返回原引用');
});

test('appendTurn 按 path 追加；turnsAtPath 定位', () => {
  const br = B('br', A(), []);
  const turns = [T('t1', 'q', 'a', { branches: [br] })];
  const nt = T('nt', '新问', '新答');
  const next = appendTurn(turns, ['br'], nt);
  assert.equal(next[0].branches[0].turns[0], nt);
  assert.equal(turns[0].branches[0].turns.length, 0);
  assert.equal(turnsAtPath(next, ['br'])[0], nt);
  assert.equal(turnsAtPath(next, ['missing']), null);
});

test('collectMarks 汇总标注与支线（含嵌套）', () => {
  const n = createNote(A('笔记引用'));
  const inner = B('in', A('内引'), [T('it', 'q', 'a')]);
  const outer = B('out', A('外引'), [T('ot', 'q', 'a', { notes: [n], branches: [inner] })]);
  const turns = [T('t', 'q', 'a', { branches: [outer] })];
  const marks = collectMarks(turns);
  assert.deepEqual(
    marks.map((m) => m.kind),
    ['branch', 'note', 'branch'],
  );
  assert.equal(marks[0].branch.id, 'out');
  assert.equal(marks[2].branch.id, 'in');
});

test('parseStored 正常回读 + 坏数据抛错', () => {
  const good = {
    v: 1,
    activeId: 'c1',
    conversations: [
      {
        id: 'c1',
        title: '标题',
        turns: [
          {
            id: 't1',
            question: 'q',
            answer: 'a',
            notes: [{ id: 'n1', anchor: A(), text: '笔记' }],
            branches: [{ id: 'b1', anchor: A('引'), turns: [] }],
          },
        ],
      },
    ],
  };
  const parsed = parseStored(JSON.stringify(good));
  assert.equal(parsed.activeId, 'c1');
  assert.equal(parsed.conversations[0].turns[0].notes[0].text, '笔记');
  assert.equal(parsed.conversations[0].turns[0].branches[0].anchor.quote, '引');
  assert.throws(() => parseStored('not json'));
  assert.throws(() => parseStored('{"x":1}'));
});

test('titleFromQuestion 取首行截断', () => {
  assert.equal(titleFromQuestion('\n\n  这是一个问题\n第二行'), '这是一个问题');
  assert.equal(titleFromQuestion('   '), '新对话');
});

// ---------- 升级：颜色 / 折叠 / 删除 / 序号 / 新字段存档 ----------

const ANCH = { startBlock: 0, startOffset: 0, endBlock: 0, endOffset: 5, quote: '选段' };

test('createNote 颜色校验：非法色回落 yellow', () => {
  assert.equal(createNote(ANCH, 'blue').color, 'blue');
  assert.equal(createNote(ANCH, 'neon').color, 'yellow');
  assert.equal(createNote(ANCH).color, 'yellow');
});

test('setNoteColor / removeNote 不可变更新', () => {
  const n = createNote(ANCH, 'blue');
  const t = createTurn('q', 'a');
  t.notes.push(n);
  const turns = [t];
  const recolored = setNoteColor(turns, t.id, n.id, 'pink');
  assert.equal(recolored[0].notes[0].color, 'pink');
  assert.equal(turns[0].notes[0].color, 'blue', '原数组不变');
  assert.equal(setNoteColor(turns, t.id, n.id, 'bad')[0].notes[0].color, 'blue');
  assert.equal(removeNote(turns, t.id, n.id)[0].notes.length, 0);
});

test('createBranch collapsed=false；setBranchCollapsed / removeBranch 深层生效', () => {
  const b = createBranch(ANCH);
  assert.equal(b.collapsed, false);
  const outer = createTurn('o', 'oa');
  outer.branches.push(b);
  const inner = createBranch(ANCH);
  const innerTurn = createTurn('i', 'ia');
  innerTurn.branches.push(inner);
  b.turns.push(innerTurn);
  const turns = [outer];
  const collapsed = setBranchCollapsed(turns, inner.id, true);
  assert.equal(collapsed[0].branches[0].turns[0].branches[0].collapsed, true);
  assert.equal(turns[0].branches[0].turns[0].branches[0].collapsed, false);
  const expanded = expandBranches(collapsed, [b.id, inner.id]);
  assert.equal(expanded[0].branches[0].collapsed, false);
  assert.equal(expanded[0].branches[0].turns[0].branches[0].collapsed, false);
  const removed = removeBranch(turns, inner.id);
  assert.equal(removed[0].branches[0].turns[0].branches.length, 0);
});

test('branchOrdinal 按锚点排序，序号稳定', () => {
  const t = createTurn('q', 'a');
  const b1 = createBranch({ ...ANCH, endBlock: 2 });
  const b2 = createBranch({ ...ANCH, endBlock: 0 });
  const b3 = createBranch({ ...ANCH, endBlock: 0, startBlock: 0, startOffset: 3 });
  t.branches.push(b1, b2, b3);
  assert.equal(branchOrdinal(t, b2.id), 1);
  assert.equal(branchOrdinal(t, b3.id), 2);
  assert.equal(branchOrdinal(t, b1.id), 3);
});

test('collectMarks 携带 path 供索引展开祖先', () => {
  const t = createTurn('q', 'a');
  const n = createNote(ANCH);
  const b = createBranch(ANCH);
  const innerNote = createNote(ANCH);
  const bt = createTurn('bq', 'ba');
  bt.notes.push(innerNote);
  b.turns.push(bt);
  t.notes.push(n);
  t.branches.push(b);
  const marks = collectMarks([t]);
  assert.equal(marks.length, 3);
  const inner = marks.find((m) => m.note && m.note.id === innerNote.id);
  assert.deepEqual(inner.path, [b.id]);
  const main = marks.find((m) => m.note && m.note.id === n.id);
  assert.deepEqual(main.path, []);
});

test('parseStored：新字段消毒 + 旧数据兼容', () => {
  const t = createTurn('q', 'a');
  t.tools = [{ id: 't1', title: 'x', kind: 'read', status: 'completed', output: 'o', locations: [] }];
  t.changes = { available: true, status: ' M f', unstaged: '+l', staged: '', truncated: false };
  const n = createNote(ANCH, 'neon'); // 非法色 → yellow
  const b = createBranch(ANCH);
  b.collapsed = true;
  t.notes.push(n);
  t.branches.push(b);
  const raw = {
    v: 1,
    conversations: [
      { id: 'c1', title: '旧', turns: [t], workspace: '/w', sessionId: 'sid' },
      { id: 'c2', title: '旧版无新字段', turns: [createTurn('a', 'b')] },
    ],
    activeId: 'c1',
  };
  const store = parseStored(JSON.stringify(raw));
  assert.equal(store.conversations[0].workspace, '/w');
  assert.equal(store.conversations[0].sessionId, 'sid');
  assert.equal(store.conversations[0].turns[0].tools[0].output, 'o');
  assert.equal(store.conversations[0].turns[0].changes.available, true);
  assert.equal(store.conversations[0].turns[0].notes[0].color, 'yellow');
  assert.equal(store.conversations[0].turns[0].branches[0].collapsed, true);
  assert.equal(store.conversations[1].workspace, '');
  assert.equal(store.conversations[1].sessionId, null);
});

test('createConversation(workspace) 落盘工作区；旧调用仍可用', () => {
  const c = createConversation('/abs/dir');
  assert.equal(c.workspace, '/abs/dir');
  assert.equal(c.sessionId, null);
  assert.equal(createConversation().workspace, '');
});

test('parseStored：workspaces 注册表去重保序 + 旧存档兼容', () => {
  const raw = JSON.stringify({
    v: 1,
    conversations: [{ id: 'c1', title: 'x', turns: [] }],
    activeId: 'c1',
    workspaces: ['/a', '/b', '/a', 42, null],
  });
  const s = parseStored(raw);
  assert.deepEqual(s.workspaces, ['/a', '/b']);
  // 旧存档没有 workspaces 字段
  const old = parseStored(
    JSON.stringify({ v: 1, conversations: [{ id: 'c1', title: 'x', turns: [] }] }),
  );
  assert.deepEqual(old.workspaces, []);
});

test('parseStored：wsNames 别名消毒 + 旧存档兼容', () => {
  const raw = JSON.stringify({
    v: 1,
    conversations: [{ id: 'c1', title: 'x', turns: [] }],
    activeId: 'c1',
    workspaces: ['/a', '/b'],
    wsNames: { '/a': '  前端项目  ', '/b': '', '': 'x', 42: 'n', '/c': 7 },
  });
  const s = parseStored(raw);
  assert.deepEqual(s.wsNames, { '/a': '前端项目' });
  const old = parseStored(
    JSON.stringify({ v: 1, conversations: [{ id: 'c1', title: 'x', turns: [] }] }),
  );
  assert.deepEqual(old.wsNames, {});
});

test('parseStored：turn.images 缩略图消毒（非 dataURL/超长剔除，最多 4 张）', () => {
  const t = {
    id: 't1',
    question: 'q',
    answer: 'a',
    images: [
      'data:image/png;base64,QUJD',
      'https://evil.example/x.png',
      'x'.repeat(500 * 1024),
      'data:image/jpeg;base64,REVG',
      'data:image/png;base64,R0hJ',
      'data:image/png;base64,ektM',
    ],
  };
  const s = parseStored(
    JSON.stringify({ v: 1, conversations: [{ id: 'c1', title: 'x', turns: [t] }] }),
  );
  assert.deepEqual(s.conversations[0].turns[0].images, [
    'data:image/png;base64,QUJD',
    'data:image/jpeg;base64,REVG',
    'data:image/png;base64,R0hJ',
    'data:image/png;base64,ektM',
  ]);
});

test('parseLayout：默认、钳制、非法输入', () => {
  assert.equal(parseLayout(null), null);
  assert.equal(parseLayout('{bad'), null);
  const l = parseLayout(JSON.stringify({ leftWidth: 9999, rightWidth: 1, leftCollapsed: 1, collapsedWorkspaces: ['/w', '/w'] }));
  assert.equal(l.leftWidth, 360);
  assert.equal(l.rightWidth, 220);
  assert.equal(l.leftCollapsed, true);
  assert.deepEqual(l.collapsedWorkspaces, ['/w']);
  const d = parseLayout('{}');
  assert.deepEqual(d, DEFAULT_LAYOUT);
});

test('effectivePanelWidths：窄视口缩显示宽不改偏好，宽视口恢复', () => {
  const layout = { ...DEFAULT_LAYOUT, leftWidth: 360, rightWidth: 440 };
  // 1000px：溢出 160，先缩右栏 440→280，左栏不变
  const w1000 = effectivePanelWidths(layout, 1000);
  assert.deepEqual(w1000, { left: 360, right: 280 });
  // 961px：溢出 199，右栏缩到 241 恰好放下
  const w961 = effectivePanelWidths(layout, 961);
  assert.equal(w961.left + w961.right + 360 <= 961, true);
  assert.equal(w961.right, 241);
  // 溢出超过右栏可缩量时再缩左栏
  const w800 = effectivePanelWidths(layout, 800);
  assert.equal(w800.right, 220);
  assert.equal(w800.left, 220);
  // 宽视口恢复保存的宽度
  assert.deepEqual(effectivePanelWidths(layout, 1400), { left: 360, right: 440 });
  // 偏好对象本身未被改写
  assert.equal(layout.leftWidth, 360);
  assert.equal(layout.rightWidth, 440);
  // 折叠的面板为 0，不参与收缩
  const col = { ...layout, rightCollapsed: true };
  assert.deepEqual(effectivePanelWidths(col, 961), { left: 360, right: 0 });
});

const anchor = (sb, so, eb = sb, eo = so + 2) => ({
  startBlock: sb, startOffset: so, endBlock: eb, endOffset: eo, quote: 'q',
});

test('branchAppearance：父支线与首个嵌套支线不同色；兄弟不同色；深层包裹也不同', () => {
  const t = createTurn('q', 'a');
  let turns = appendTurn([], [], t);
  const b1 = createBranch(anchor(0, 0));
  const b2 = createBranch(anchor(0, 5));
  turns = addBranchToTurn(turns, t.id, b1);
  turns = addBranchToTurn(turns, t.id, b2);
  // 在 b1 里放一个回合并挂嵌套支线
  const inner = createTurn('iq', 'ia');
  const b1path = [b1.id];
  turns = {
    ...turns[0],
    branches: turns[0].branches.map((b) =>
      b.id === b1.id ? { ...b, turns: [inner] } : b),
  };
  const wrapped = [turns];
  const nested = createBranch(anchor(0, 1));
  const withNested = wrapped.map((tt) => ({
    ...tt,
    branches: tt.branches.map((b) =>
      b.id === b1.id
        ? { ...b, turns: addBranchToTurn(b.turns, inner.id, nested) }
        : b),
  }));
  const ap = branchAppearance(withNested);
  // b1 是第一个 → tone 0 / #1；b2 兄弟不同色
  assert.equal(ap.get(b1.id).number, 1);
  assert.equal(ap.get(b1.id).tone, 0);
  assert.equal(ap.get(b2.id).number, 3);
  assert.notEqual(ap.get(b2.id).tone, ap.get(b1.id).tone);
  // 深度优先：b1→nested(#2)→b2(#3)
  assert.equal(ap.get(nested.id).number, 2);
  assert.notEqual(ap.get(nested.id).tone, ap.get(b1.id).tone); // 嵌套首个 ≠ 父色
});

test('conversationIndex：同锚点标注排在支线前；嵌套树含嵌套回合/支线/标注', () => {
  const t = createTurn('主问题', '答');
  let turns = appendTurn([], [], t);
  const note = createNote(anchor(0, 3));
  const branch = createBranch(anchor(0, 3)); // 同起点 → 标注在前
  turns = addNoteToTurn(turns, t.id, note);
  turns = addBranchToTurn(turns, t.id, branch);
  // 支线内一个回合 + 嵌套支线 + 标注
  const innerTurn = createTurn('内层问题', '内答');
  const innerNote = createNote(anchor(0, 0));
  const innerBranch = createBranch(anchor(0, 4));
  turns = turns.map((tt) => ({
    ...tt,
    branches: tt.branches.map((b) =>
      b.id === branch.id
        ? {
            ...b,
            turns: [
              {
                ...innerTurn,
                notes: [innerNote],
                branches: [innerBranch],
              },
            ],
          }
        : b),
  }));
  const tree = conversationIndex(turns);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind, 'turn');
  assert.equal(tree[0].children[0].kind, 'note'); // 并列时标注在前
  assert.equal(tree[0].children[1].kind, 'branch');
  const bt = tree[0].children[1].children;
  assert.equal(bt.length, 1);
  assert.equal(bt[0].kind, 'turn');
  assert.equal(bt[0].question, '内层问题');
  assert.deepEqual(bt[0].path, [branch.id]);
  assert.equal(bt[0].children[0].kind, 'note');
  assert.equal(bt[0].children[1].kind, 'branch');
  assert.equal(bt[0].children[1].branch.id, innerBranch.id);
});

test('parseStored 保留 titleCustomized；旧档默认 false', () => {
  const s = parseStored(
    JSON.stringify({
      v: 1,
      conversations: [
        { id: 'a', title: '改名', titleCustomized: true, turns: [] },
        { id: 'b', title: '旧档', turns: [] },
      ],
    }),
  );
  assert.equal(s.conversations[0].titleCustomized, true);
  assert.equal(s.conversations[1].titleCustomized, false);
});

test('permissionMode：新建默认 accept-edits；parseStored 白名单回退', () => {
  assert.equal(createConversation().permissionMode, 'accept-edits');
  const s = parseStored(
    JSON.stringify({
      v: 1,
      conversations: [
        { id: 'a', title: 'x', permissionMode: 'bypass', turns: [] },
        { id: 'b', title: 'y', permissionMode: 'plan', turns: [] },
        { id: 'c', title: 'z', turns: [] },
      ],
    }),
  );
  assert.equal(s.conversations[0].permissionMode, 'bypass');
  assert.equal(s.conversations[1].permissionMode, 'accept-edits');
  assert.equal(s.conversations[2].permissionMode, 'accept-edits');
});

test('modelConfig：新建默认三空键；parseStored 消毒与兼容', () => {
  const DFT = { model: '', thought_level: '', speed: '' };
  assert.deepEqual(createConversation().modelConfig, DFT);
  const s = parseStored(
    JSON.stringify({
      v: 1,
      conversations: [
        { id: 'a', title: 'x', turns: [] }, // 旧档无字段 → 默认
        { id: 'b', title: 'y', turns: [], modelConfig: 'nonsense' }, // 非对象 → 默认
        {
          id: 'c',
          title: 'z',
          turns: [],
          modelConfig: { model: 'opus', bogus: 'drop', speed: 42 },
        },
        {
          id: 'd',
          title: 'w',
          turns: [],
          modelConfig: { thought_level: 'ultra-max', model: 'future-model-9' },
        },
      ],
    }),
  );
  assert.deepEqual(s.conversations[0].modelConfig, DFT);
  assert.deepEqual(s.conversations[1].modelConfig, DFT);
  assert.deepEqual(s.conversations[2].modelConfig, {
    model: 'opus',
    thought_level: '',
    speed: '',
  });
  // 未知值（不在探测选项里）按字符串保留，不校验值域
  assert.deepEqual(s.conversations[3].modelConfig, {
    model: 'future-model-9',
    thought_level: 'ultra-max',
    speed: '',
  });
});

test('buildChatBody：work 带 modelConfig，discussion 省略', () => {
  const conv = {
    workspace: '/tmp/ws',
    sessionId: 'sid-1',
    permissionMode: 'smart',
    modelConfig: { model: 'opus', thought_level: '', speed: 'fast' },
  };
  const work = buildChatBody({ conv, kind: 'work', history: [], question: 'q' });
  assert.equal(work.kind, 'work');
  assert.equal(work.sessionId, 'sid-1');
  assert.deepEqual(work.modelConfig, {
    model: 'opus',
    thought_level: '',
    speed: 'fast',
  });
  const disc = buildChatBody({ conv, kind: 'discussion', history: [], question: 'q' });
  assert.equal(disc.kind, 'discussion');
  assert.equal(disc.sessionId, null);
  assert.ok(!('modelConfig' in disc), 'discussion 请求不含 modelConfig');
  // conv 无 modelConfig（旧档）→ work 补全三空键
  const bare = buildChatBody({
    conv: { workspace: '', sessionId: null, permissionMode: 'accept-edits' },
    kind: 'work',
    history: [],
    question: 'q',
  });
  assert.deepEqual(bare.modelConfig, { model: '', thought_level: '', speed: '' });
});

// ---------- 模型透明度：effectiveModel / turn.model ----------

test('createTurn：extra.model 持久化到回合；非法值忽略', () => {
  const t = createTurn('q', 'a', { model: 'swe-2-flash-max' });
  assert.equal(t.model, 'swe-2-flash-max');
  const bare = createTurn('q', 'a');
  assert.ok(!('model' in bare), '缺省不产生字段');
  const bad = createTurn('q', 'a', { model: 42 });
  assert.ok(!('model' in bad));
});

test('createConversation：effectiveModel 默认 null', () => {
  assert.equal(createConversation().effectiveModel, null);
});

test('parseStored：conv.effectiveModel ≤128 与 turn.model 兼容消毒', () => {
  const long = 'm'.repeat(200);
  const s = parseStored(
    JSON.stringify({
      v: 1,
      conversations: [
        {
          id: 'a',
          title: 'x',
          effectiveModel: 'fusion-gpt-6-2',
          turns: [
            {
              question: 'q',
              answer: 'a',
              model: 'm1',
              usage: { tokens: 5 }, // 旧档用量字段不再保留
            },
          ],
        },
        { id: 'b', title: 'y', effectiveModel: 7, turns: [{ question: 'q', answer: 'a', model: 42 }] },
        { id: 'c', title: 'z', effectiveModel: long, turns: [] },
      ],
    }),
  );
  // conv：字符串生效、非字符串回 null、超长截断 ≤128
  assert.equal(s.conversations[0].effectiveModel, 'fusion-gpt-6-2');
  assert.equal(s.conversations[1].effectiveModel, null);
  assert.equal(s.conversations[2].effectiveModel.length, 128);
  // turn：model 字符串保留；旧档 usage 字段剔除
  const turn = s.conversations[0].turns[0];
  assert.equal(turn.model, 'm1');
  assert.ok(!('usage' in turn), '旧档 usage 字段不再保留');
  const bareTurn = s.conversations[1].turns[0];
  assert.ok(!('model' in bareTurn), '非法值不保留字段');
});

test('isBillableSpeed：Fast 计费，Standard/缺省不计费', () => {
  assert.equal(isBillableSpeed('fast'), true);
  for (const value of ['standard', '', null, undefined, 'max']) {
    assert.equal(isBillableSpeed(value), false, String(value));
  }
});

test('parseStored：effSpeed 字符串消毒', () => {
  const s = parseStored(
    JSON.stringify({
      conversations: [{ id: 'a', title: 'x', effSpeed: 'fast', turns: [] }],
    }),
  );
  assert.equal(s.conversations[0].effSpeed, 'fast');
  const bad = parseStored(
    JSON.stringify({
      conversations: [{ id: 'b', title: 'y', effSpeed: 7, turns: [] }],
    }),
  );
  assert.equal(bad.conversations[0].effSpeed, '');
});

test('isBillableModel：仅免费档 SWE-2 精确 SKU 不计费', () => {
  for (const value of [
    'swe-2-medium',
    'swe-2-high',
    'swe-2-max',
    'swe-2-flash-medium',
    'swe-2-flash-high',
    'swe-2-flash-max',
  ]) {
    assert.equal(isBillableModel(value), false, value);
  }
  for (const value of [
    // lightning 是收费变体，虽然名字里带 swe-2
    'swe-2-medium-lightning',
    'swe-2-max-lightning',
    'swe-2-flash-medium-lightning',
    // Fusion 的 UID 里也含 sidekick-swe-2，但主模型计费
    'fusion-gpt-6-2-sol-medium-sidekick-swe-2-high',
    'fusion-claude-opus-5-5-medium-sidekick-swe-2-medium',
    'claude-opus-5-5-medium',
    'adaptive',
    '',
    null,
  ]) {
    assert.equal(isBillableModel(value), true, String(value));
  }
});
