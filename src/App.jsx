import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  STORAGE_KEY,
  THEME_KEY,
  LAYOUT_KEY,
  DEFAULT_LAYOUT,
  LEFT_MIN,
  LEFT_MAX,
  RIGHT_MIN,
  RIGHT_MAX,
  parseLayout,
  NOTE_COLORS,
  createConversation,
  createTurn,
  createNote,
  createBranch,
  titleFromQuestion,
  historyForRequest,
  branchContextEntries,
  branchSessionAt,
  setBranchSession,
  appendTurn,
  addBranchToTurn,
  addNoteToTurn,
  setNoteText,
  setNoteColor,
  removeNote,
  setBranchCollapsed,
  expandBranches,
  removeBranch,
  branchAppearance,
  conversationIndex,
  collectMarks,
  parseStored,
  effectivePanelWidths,
  makeId,
  DEFAULT_MODEL_CONFIG,
  buildChatBody,
  isBillableModel,
  isBillableSpeed,
  INFLIGHT_KEY,
} from './model.js';
import {
  splitFusionUid,
  prettifyModelKey,
  parseFusionPairs,
  isFusionValue,
} from './fusion.js';
import { COLOR_NAMES, shorten, baseName, samePath, mergeTool } from './utils/format.js';
import { uploadAttachments } from './utils/images.js';
import { readAnchorFromRange, rangesForAnchor, blockElOf } from './utils/highlights.js';
import { ConfirmButton, CtxConfirm, PermDialog, ElicitDialog } from './components/Dialogs.jsx';
import { Composer } from './components/Composer.jsx';
import { TurnView, PendingView, NoteEditor } from './components/TurnView.jsx';
import { WorkspaceBar, ModelBar } from './components/ModelControls.jsx';
import { FolderPicker } from './components/FolderPicker.jsx';
import { MarkRail, CiGroups, CiStrip, ResizeHandle } from './components/RightNav.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { hasStoreDb, readStoreDb, writeStoreDb } from './storedb.js';
import './styles.css';

const EXAMPLES = [
  '用三句话解释什么是 Agent Client Protocol',
  '帮我对比一下 TCP 和 UDP 的适用场景',
  'React 里 useEffect 和 useLayoutEffect 有什么区别？',
];

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
      return {
        conversations: [],
        activeId: null,
        workspaces: [],
        wsNames: {},
        wsFolders: [],
        wsFolderId: {},
        loadError: null,
      };
    return { ...parseStored(raw), loadError: null };
  } catch (e) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        localStorage.setItem(`${STORAGE_KEY}:corrupt`, raw);
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
    return {
      conversations: [],
      activeId: null,
      workspaces: [],
      wsNames: {},
      wsFolders: [],
      wsFolderId: {},
      loadError: '本地存档损坏（已备份为 newqa:v1:corrupt），从空白开始。',
    };
  }
}

function loadLayout() {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY)) || DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function initTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'dark' || t === 'light') return t;
  } catch {}
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

// 只限制等待响应头的时间；拿到流后仍由调用者控制取消。
async function fetchChatHeaders(url, { signal, ...init }, timeoutMs) {
  const request = new AbortController();
  const onAbort = () => request.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => request.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: request.signal });
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 重挂/停止某个进行中的回合：convId 必填，turnId 有则精确绑定
// （服务端会校验回合归属）；signal 供随本地 abort 一并撤销请求。
// attach 等首包可能耗时：只给响应头阶段加时限制，流本身不设限。
function chatTurnRequest(action, { convId, turnId }, signal) {
  const url = `/api/chat/${action}`;
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId, ...(turnId ? { turnId } : {}) }),
    signal,
  };
  return action === 'attach' ? fetchChatHeaders(url, init, 5000) : fetch(url, init);
}

// 有界停止请求：确认送达（ok）或服务端已无此回合（404）才算停干净；
// 超时/网络错误返回 false——调用方据此保留 interrupted 标记待重试。
async function stopChatTurn(entry) {
  try {
    const res = await chatTurnRequest('stop', entry, AbortSignal.timeout(4000));
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export default function App() {
  const [store, setStore] = useState(loadStore);
  const [saveError, setSaveError] = useState(null);
  const [drafts, setDrafts] = useState({ main: '' });
  const [imgs, setImgs] = useState({}); // draftKey → [{data,mime,thumb}] 粘贴附图
  const [pendings, setPendings] = useState([]); // 各对话可并行：进行中回合列表
  const [perms, setPerms] = useState([]);
  const [elis, setElis] = useState([]); // agent 提问（elicitation）表单队列
  const [notice, setNotice] = useState(null);
  const [selBar, setSelBar] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const [cli, setCli] = useState('checking');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [theme, setTheme] = useState(initTheme);
  const [focusNoteId, setFocusNoteId] = useState(null); // 右侧索引里编辑中的标注
  const [focusBranchId, setFocusBranchId] = useState(null);
  const [layout, setLayout] = useState(loadLayout);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [picker, setPicker] = useState(null); // { initial, onPick } 文件夹选择器
  const [delConv, setDelConv] = useState(null); // 待确认删除的会话
  const [delWs, setDelWs] = useState(null); // 待确认删除的工作区分组（路径）
  const [modeGate, setModeGate] = useState(false); // 全部放行确认弹窗
  const [ctxMenu, setCtxMenu] = useState(null); // 导航树右键菜单 {x,y,node}
  const [foldIds, setFoldIds] = useState(() => new Set()); // 导航树折叠节点
  // /api/devin/options 懒取结果：idle → loading → ok | error（失败静默不可用）
  const [devinOpts, setDevinOpts] = useState({ status: 'idle', commands: null, config: null });
  const optsRequested = useRef(false);
  const abortsRef = useRef(new Map()); // pid → { controller, convId }
  const unloadingRef = useRef(false); // 页面卸载中：跳过一切清理，保住 inflight 供重挂
  const liveRangeRef = useRef(null);
  const hlRef = useRef({});
  const transcriptRef = useRef(null);
  const storeRef = useRef(store);
  storeRef.current = store;
  // 挂载瞬间的初始 store：IndexedDB 水合只在用户/应用尚未改动状态时整体替换，
  // 永不重赋值，靠引用相等判断"状态是否还是出厂值"。
  const initialStoreRef = useRef(store);
  const writeSeqRef = useRef(0); // IDB 写入序号：只有最新一笔写入有权改 saveError

  const conv = store.conversations.find((c) => c.id === store.activeId) || null;
  // 会话级忙碌：本对话有回合在跑 → 禁用本对话控件；其它对话不受影响。
  const busy = !!conv && pendings.some((p) => p.convId === conv.id);
  // Fusion 配对表：探测到的 model 选项里所有 fusion-* 值拆成 Leader×Sidekick。
  const fusionPairs = useMemo(
    () =>
      devinOpts.status === 'ok'
        ? parseFusionPairs(devinOpts.config?.model?.options)
        : { leaders: [], sides: new Map() },
    [devinOpts],
  );
  const hlSupported =
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

  // ---- 视口宽度（响应式，非一次性取值） ----
  useEffect(() => {
    const fn = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  const narrow = viewportWidth <= 960;
  // 桌面实际展示宽度：视口不够时收缩显示，不改写保存的偏好；
  // 右栏折叠时是 34px 图标条而非 0。
  const panelPx = effectivePanelWidths(layout, viewportWidth);
  if (!narrow && layout.rightCollapsed) panelPx.right = 34;

  // 重新进入/切换会话时定位到最新回合（而非停留在顶部）；
  // 等一小拍让缩略图解码后再滚，避免滚完被撑高。
  const convId = conv?.id ?? null;
  useEffect(() => {
    setShowScrollDown(false);
    if (!convId) return;
    const t = setTimeout(() => {
      const sc = transcriptRef.current;
      if (sc) sc.scrollTop = sc.scrollHeight;
    }, 60);
    return () => clearTimeout(t);
  }, [convId]);

  const onTranscriptScroll = useCallback((e) => {
    const el = e.currentTarget;
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 220);
  }, []);

  const onTranscriptClick = useCallback((e) => {
    const btn = e.target.closest?.('.code-copy');
    if (!btn) return;
    const wrap = btn.closest('.code-wrap');
    const code = wrap?.querySelector('pre code, pre')?.textContent ?? '';
    if (!code) return;
    navigator.clipboard?.writeText(code).catch(() => {});
    btn.classList.add('copied');
    btn.setAttribute('aria-label', '已复制');
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove('copied');
      btn.setAttribute('aria-label', '复制代码');
    }, 1500);
  }, []);

  const scrollToBottom = useCallback(() => {
    const sc = transcriptRef.current;
    if (sc) sc.scrollTop = sc.scrollHeight;
    setShowScrollDown(false);
  }, []);

  // 页面卸载标记：刷新/关闭时浏览器 abort 在途 fetch，catch/finally 若照常
  // 清理会把 localStorage 里的 inflight 删掉，刷新后无从重挂。bfcache 回退
  // 经 pageshow 复位。
  useEffect(() => {
    const onHide = () => {
      unloadingRef.current = true;
    };
    const onShow = () => {
      unloadingRef.current = false;
    };
    window.addEventListener('beforeunload', onHide);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  // ---- 布局持久化 ----
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout]);

  // ---- 主题 ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  // ---- IndexedDB 水合 / 迁移（仅挂载时一次） ----
  // localStorage 配额太小，存档主存储迁到 IndexedDB；首次启动把 legacy
  // localStorage 数据搬进 IDB，写成功后才删 legacy key 释放配额。
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hasStoreDb() || hydratedRef.current) return;
    hydratedRef.current = true;
    readStoreDb(STORAGE_KEY)
      .then((raw) => {
        if (typeof raw === 'string') {
          // IDB 已有数据：优先于 localStorage。解析失败不动 IDB 记录、不水合。
          try {
            const parsed = parseStored(raw);
            if (parsed) {
              setStore((s) =>
                s === initialStoreRef.current ? { ...parsed, loadError: null } : s,
              );
            }
          } catch {}
          return;
        }
        // IDB 为空：尝试迁移 legacy localStorage。只有写入成功才删 legacy key。
        let legacy = null;
        try {
          legacy = localStorage.getItem(STORAGE_KEY);
        } catch {}
        if (!legacy) return;
        try {
          if (!parseStored(legacy)) return;
        } catch {
          return;
        }
        writeStoreDb(STORAGE_KEY, legacy).then((ok) => {
          if (!ok) return;
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {}
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 持久化 ----
  useEffect(() => {
    const json = JSON.stringify({
      v: 1,
      conversations: store.conversations,
      activeId: store.activeId,
      workspaces: store.workspaces || [],
      wsNames: store.wsNames || {},
      wsFolders: store.wsFolders || [],
      wsFolderId: store.wsFolderId || {},
    });
    if (hasStoreDb()) {
      const seq = ++writeSeqRef.current;
      writeStoreDb(STORAGE_KEY, json).then((ok) => {
        if (seq !== writeSeqRef.current) return; // 已有更新一笔写入接管错误态
        if (ok) {
          setSaveError(null);
          // 迁移清理：legacy key 还在就顺手删掉（配额释放）
          try {
            if (localStorage.getItem(STORAGE_KEY) !== null)
              localStorage.removeItem(STORAGE_KEY);
          } catch {}
        } else {
          setSaveError('无法写入本地存储，本次改动可能不会被保存。');
        }
      });
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, json);
      setSaveError(null);
    } catch {
      setSaveError('无法写入本地存储，本次改动可能不会被保存。');
    }
  }, [
    store.conversations,
    store.activeId,
    store.workspaces,
    store.wsNames,
    store.wsFolders,
    store.wsFolderId,
  ]);

  // ---- CLI 状态 ----
  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((j) => {
        setCli(j.cli === 'ok' ? 'ok' : 'missing');
        if (j.defaultCwd) setDefaultCwd(j.defaultCwd);
      })
      .catch(() => setCli('missing'));
  }, []);

  // ---- 斜杠命令 / 配置项探测：每页只取一次，失败静默不可用 ----
  const ensureDevinOptions = useCallback(() => {
    if (optsRequested.current) return;
    optsRequested.current = true;
    setDevinOpts((s) =>
      s.status === 'ok' ? s : { status: 'loading', commands: null, config: null },
    );
    fetch('/api/devin/options')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('probe failed'))))
      .then((j) =>
        setDevinOpts({
          status: 'ok',
          commands: Array.isArray(j?.commands) ? j.commands : [],
          config: j?.config && typeof j.config === 'object' ? j.config : {},
        }),
      )
      .catch(() => setDevinOpts({ status: 'error', commands: null, config: null }));
  }, []);

  // 工作区条挂载（有活动会话）即预取；首个 '/' 输入也会经 onSlashNeed 触发
  useEffect(() => {
    if (conv) ensureDevinOptions();
  }, [conv?.id, ensureDevinOptions]);

  // 按所选模型探测真实可选项（思考档位/速度随模型而异，如 xhigh 只有部分
  // 模型提供）；探测中/失败回落基础选项，不阻断设置界面。
  const cfgModelSel = conv?.modelConfig?.model || '';
  const [modelOptsCache, setModelOptsCache] = useState({}); // model → {status, config}
  const modelOptsRequested = useRef(new Set());
  useEffect(() => {
    if (!cfgModelSel || isFusionValue(cfgModelSel)) return;
    if (modelOptsRequested.current.has(cfgModelSel)) return;
    modelOptsRequested.current.add(cfgModelSel);
    fetch(`/api/devin/options?model=${encodeURIComponent(cfgModelSel)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('probe failed'))))
      .then((j) =>
        setModelOptsCache((m) => ({
          ...m,
          [cfgModelSel]: { status: 'ok', config: j?.config || {} },
        })),
      )
      .catch(() =>
        setModelOptsCache((m) => ({ ...m, [cfgModelSel]: { status: 'error' } })),
      );
  }, [cfgModelSel]);
  const convOpts =
    cfgModelSel && modelOptsCache[cfgModelSel]?.status === 'ok'
      ? { ...devinOpts, config: modelOptsCache[cfgModelSel].config }
      : devinOpts;

  // ---- 选区监听 ----
  useEffect(() => {
    const refresh = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          liveRangeRef.current = null;
          setSelBar(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const found = readAnchorFromRange(range);
        if (!found) {
          liveRangeRef.current = null;
          setSelBar(null);
          return;
        }
        liveRangeRef.current = range;
        const rect = range.getBoundingClientRect();
        setSelBar({
          turnId: found.msgId,
          anchor: found.anchor,
          top: Math.min(rect.bottom + 8, window.innerHeight - 60),
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 260)),
        });
      });
    };
    const reposition = () => {
      const r = liveRangeRef.current;
      if (!r) return;
      const rect = r.getBoundingClientRect();
      setSelBar((s) =>
        s
          ? {
              ...s,
              top: Math.min(rect.bottom + 8, window.innerHeight - 60),
              left: Math.max(8, Math.min(rect.left, window.innerWidth - 260)),
            }
          : s,
      );
    };
    document.addEventListener('selectionchange', refresh);
    document.addEventListener('pointerup', refresh);
    document.addEventListener('keyup', refresh);
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    return () => {
      document.removeEventListener('selectionchange', refresh);
      document.removeEventListener('pointerup', refresh);
      document.removeEventListener('keyup', refresh);
      window.removeEventListener('scroll', reposition, { capture: true });
    };
  }, []);

  // 支线输入框 autoFocus 会在 commit 阶段把文档选区带进控件（jsdom 把
  // 控件选区计入 getSelection()）；挂载后再清一次，保证原生选区不留残。
  useLayoutEffect(() => {
    if (focusBranchId) window.getSelection()?.removeAllRanges();
  }, [focusBranchId]);

  // ---- 高亮标注（CSS Custom Highlight API，不支持时降级为块级标记） ----
  // 读 storeRef 而非渲染期 conv：MutationObserver 回调里也能拿到最新会话。
  const applyMarks = useCallback(() => {
    const c =
      storeRef.current.conversations.find(
        (x) => x.id === storeRef.current.activeId,
      ) || null;
    const marks = c ? collectMarks(c.turns) : [];
    if (!hlSupported) {
      document
        .querySelectorAll('.source-block.marked')
        .forEach((el) =>
          el.classList.remove(
            'marked',
            'marked-note',
            'marked-branch',
            ...NOTE_COLORS.map((c2) => `marked-${c2}`),
          ),
        );
      for (const m of marks) {
        const anchor = (m.note || m.branch).anchor;
        const blocks = new Set();
        for (const r of rangesForAnchor(m.turnId, anchor)) {
          const el = blockElOf(r.startContainer) || blockElOf(r.endContainer);
          if (el) blocks.add(el);
        }
        for (const el of blocks) {
          el.classList.add(
            'marked',
            m.kind === 'note' ? 'marked-note' : 'marked-branch',
            ...(m.kind === 'note' ? [`marked-${m.note.color}`] : []),
          );
        }
      }
      return;
    }
    // 桶：nq-n-{color}（无笔记）/ nq-n-{color}-u（有笔记加下划线）/ nq-branch
    const used = new Set();
    const cleared = new Set(); // 每轮每个桶只 clear 一次：同色多条标注共桶
    for (const m of marks) {
      const anchor = (m.note || m.branch).anchor;
      const name =
        m.kind === 'note'
          ? `nq-n-${m.note.color}${m.note.text.trim() ? '-u' : ''}`
          : 'nq-branch';
      used.add(name);
      if (!cleared.has(name)) {
        cleared.add(name);
        if (!hlRef.current[name]) {
          hlRef.current[name] = new Highlight();
          CSS.highlights.set(name, hlRef.current[name]);
        } else {
          hlRef.current[name].clear();
        }
      }
      for (const r of rangesForAnchor(m.turnId, anchor)) hlRef.current[name].add(r);
    }
    for (const name of Object.keys(hlRef.current)) {
      if (!used.has(name)) {
        hlRef.current[name].clear();
        delete hlRef.current[name];
      }
    }
  }, [hlSupported]);

  // 依赖 conv 而非每次渲染：打字/流式只改 drafts/pendings，
  // DOM 结构不变，不必重算 Range——否则每个按键都阻塞绘制
  useLayoutEffect(() => {
    applyMarks();
  }, [conv, applyMarks]);

  // conv 不变但已提交块（.source-block[data-msg]）重挂载时 Range 会失效
  // （React 重建 DOM 节点），用 MutationObserver 兜底重放。pending/流式块
  // 没有 data-msg，打字流式不触发，不引入每键开销。rAF 合帧。
  useEffect(() => {
    const root = transcriptRef.current;
    if (!root || typeof window.MutationObserver !== 'function') return undefined;
    let raf = 0;
    const touchesMarks = (n) =>
      n.nodeType === 1 &&
      (n.matches?.('.source-block[data-msg]') ||
        !!n.querySelector?.('.source-block[data-msg]'));
    const mo = new window.MutationObserver((muts) => {
      const hit = muts.some(
        (mu) =>
          [...mu.addedNodes].some(touchesMarks) ||
          [...mu.removedNodes].some(touchesMarks),
      );
      if (hit && !raf) {
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          applyMarks();
        });
      }
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [applyMarks]);

  // ---- 变更辅助 ----
  const mutateConv = useCallback((convId, fn) => {
    setStore((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === convId ? fn(c) : c)),
    }));
  }, []);

  const mutateActive = useCallback(
    (fn) => {
      const id = storeRef.current.activeId;
      if (id) mutateConv(id, fn);
    },
    [mutateConv],
  );

  const newChat = (workspace = '') => {
    const c = createConversation(workspace);
    setStore((s) => ({ ...s, conversations: [c, ...s.conversations], activeId: c.id }));
    // 空白页示例 chips 的预填草稿/附图（未绑定会话的 'main' 种子）迁入新会话
    setDrafts((d) => {
      const { main = '', ...rest } = d;
      return { ...rest, [`main:${c.id}`]: rest[`main:${c.id}`] ?? main };
    });
    setImgs((d) => {
      const { main = [], ...rest } = d;
      return { ...rest, [`main:${c.id}`]: rest[`main:${c.id}`] ?? main };
    });
    setNotice(null);
    setPerms([]);
    setFocusNoteId(null);
    setSidebarOpen(false);
  };

  const switchConv = (id) => {
    const target = store.conversations.find((c) => c.id === id);
    // 打开会话时确保所在工作区分组是展开的
    if (target?.workspace) {
      setLayout((l) =>
        l.collapsedWorkspaces.includes(target.workspace)
          ? {
              ...l,
              collapsedWorkspaces: l.collapsedWorkspaces.filter(
                (w) => w !== target.workspace,
              ),
            }
          : l,
      );
    }
    setStore((s) => ({ ...s, activeId: id }));
    setSidebarOpen(false);
    setNotice(null);
    setFocusNoteId(null);
  };

  // 注册一个 canonical 工作区路径；返回是否为新增。
  const registerWorkspace = useCallback((path) => {
    const s = storeRef.current;
    const exists = (s.workspaces || []).includes(path);
    if (!exists) {
      setStore((st) => ({
        ...st,
        workspaces: [...new Set([...(st.workspaces || []), path])],
      }));
    }
    return !exists;
  }, []);

  const toggleWsGroup = useCallback((key) => {
    setLayout((l) => ({
      ...l,
      collapsedWorkspaces: l.collapsedWorkspaces.includes(key)
        ? l.collapsedWorkspaces.filter((w) => w !== key)
        : [...l.collapsedWorkspaces, key],
    }));
  }, []);

  // 文件夹选择器选定后：注册 canonical 路径、展开分组，新注册且无会话时顺手开一个。
  const pickWorkspace = useCallback(
    (canonical) => {
      const isNew = registerWorkspace(canonical);
      setLayout((l) =>
        l.collapsedWorkspaces.includes(canonical)
          ? {
              ...l,
              collapsedWorkspaces: l.collapsedWorkspaces.filter(
                (w) => w !== canonical,
              ),
            }
          : l,
      );
      if (
        isNew &&
        !storeRef.current.conversations.some((c) => c.workspace === canonical)
      ) {
        newChat(canonical);
      }
    },
    [registerWorkspace],
  );

  const renameConv = useCallback((id, title) => {
    setStore((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title, titleCustomized: true } : c,
      ),
    }));
  }, []);

  // 工作区显示别名：name 为空则恢复目录名（路径不变，只改侧栏显示）。
  const renameWs = useCallback((ws, name) => {
    setStore((s) => {
      const wsNames = { ...(s.wsNames || {}) };
      if (name) wsNames[ws] = name;
      else delete wsNames[ws];
      return { ...s, wsNames };
    });
  }, []);

  // ---- 工作区文件夹：wsFolders 列表（parentId 支持嵌套）+ wsFolderId 归属映射 ----
  const createWsFolder = useCallback((name, parentId = null) => {
    const n = (name || '').trim().slice(0, 80) || '文件夹';
    const valid =
      parentId && (storeRef.current.wsFolders || []).some((x) => x.id === parentId);
    const f = { id: makeId(), name: n, parentId: valid ? parentId : null };
    setStore((s) => ({ ...s, wsFolders: [...(s.wsFolders || []), f] }));
    return f;
  }, []);

  const renameWsFolder = useCallback((id, name) => {
    setStore((s) => ({
      ...s,
      wsFolders: (s.wsFolders || []).map((f) =>
        f.id === id ? { ...f, name: name.trim().slice(0, 80) || f.name } : f,
      ),
    }));
  }, []);

  // 移动文件夹到另一文件夹（null = 顶层）；目标为自身/后代时忽略（防环）。
  const moveWsFolder = useCallback((id, parentId) => {
    const fs = storeRef.current.wsFolders || [];
    if (!fs.some((f) => f.id === id)) return;
    if (parentId) {
      const bad = new Set([id]);
      for (;;) {
        let grew = false;
        for (const f of fs) {
          if (f.parentId && bad.has(f.parentId) && !bad.has(f.id)) {
            bad.add(f.id);
            grew = true;
          }
        }
        if (!grew) break;
      }
      if (bad.has(parentId)) return;
    }
    setStore((s) => ({
      ...s,
      wsFolders: (s.wsFolders || []).map((f) =>
        f.id === id ? { ...f, parentId: parentId || null } : f,
      ),
    }));
  }, []);

  // 删除文件夹：成员工作区与子文件夹上挂到被删文件夹的父级（顶层则回顶层），不删数据。
  const deleteWsFolder = useCallback((id) => {
    setStore((s) => {
      const gone = (s.wsFolders || []).find((f) => f.id === id);
      const parentId = gone?.parentId || null;
      const wsFolderId = { ...(s.wsFolderId || {}) };
      for (const k of Object.keys(wsFolderId)) {
        if (wsFolderId[k] === id) {
          if (parentId) wsFolderId[k] = parentId;
          else delete wsFolderId[k];
        }
      }
      return {
        ...s,
        wsFolders: (s.wsFolders || [])
          .filter((f) => f.id !== id)
          .map((f) => (f.parentId === id ? { ...f, parentId } : f)),
        wsFolderId,
      };
    });
    setLayout((l) => ({
      ...l,
      collapsedWorkspaces: l.collapsedWorkspaces.filter((k) => k !== `wf:${id}`),
    }));
  }, []);

  // 移动工作区到文件夹（null = 移回顶层）。
  const moveWsToFolder = useCallback((ws, folderId) => {
    setStore((s) => {
      const wsFolderId = { ...(s.wsFolderId || {}) };
      if (folderId) wsFolderId[ws] = folderId;
      else delete wsFolderId[ws];
      return { ...s, wsFolderId };
    });
    if (folderId) {
      setLayout((l) =>
        l.collapsedWorkspaces.includes(`wf:${folderId}`)
          ? {
              ...l,
              collapsedWorkspaces: l.collapsedWorkspaces.filter(
                (k) => k !== `wf:${folderId}`,
              ),
            }
          : l,
      );
    }
  }, []);

  // 删除工作区分组：连同其下对话一并移除本地记录；不动工作区文件与 Devin 会话。
  const confirmDeleteWs = useCallback(() => {
    if (!delWs) return;
    const ws = delWs;
    const activeGone = storeRef.current.conversations.some(
      (c) => c.workspace === ws && c.id === storeRef.current.activeId,
    );
    setStore((s) => {
      const remaining = s.conversations.filter((c) => c.workspace !== ws);
      const wsNames = { ...(s.wsNames || {}) };
      delete wsNames[ws];
      const wsFolderId = { ...(s.wsFolderId || {}) };
      delete wsFolderId[ws];
      return {
        ...s,
        conversations: remaining,
        workspaces: (s.workspaces || []).filter((w) => w !== ws),
        wsNames,
        wsFolderId,
        activeId: remaining.some((c) => c.id === s.activeId)
          ? s.activeId
          : (remaining[0]?.id ?? null),
      };
    });
    if (activeGone) {
      setFocusNoteId(null);
      setFocusBranchId(null);
    }
    setLayout((l) => ({
      ...l,
      collapsedWorkspaces: l.collapsedWorkspaces.filter((w) => w !== ws),
    }));
    setDelWs(null);
  }, [delWs]);

  // 只删除本地 NewQA 转录/标注；不动工作区文件与 Devin 原生会话。
  const confirmDeleteConv = useCallback(() => {
    if (!delConv) return;
    const id = delConv.id;
    setStore((s) => {
      const remaining = s.conversations.filter((c) => c.id !== id);
      return {
        ...s,
        conversations: remaining,
        activeId: s.activeId === id ? (remaining[0]?.id ?? null) : s.activeId,
      };
    });
    if (storeRef.current.activeId === id) {
      setFocusNoteId(null);
      setFocusBranchId(null);
    }
    setDelConv(null);
  }, [delConv]);

  // 导航树节点折叠（仅导航视图状态，与转录里的支线折叠相互独立）
  const toggleFold = useCallback((fid) => {
    setFoldIds((prev) => {
      const next = new Set(prev);
      if (next.has(fid)) next.delete(fid);
      else next.add(fid);
      return next;
    });
  }, []);

  // 树节点跳转：支线节点连同自身一并展开，标注/回合只展开祖先；
  // 滚动到滚动区顶部约 12% 处并闪烁。
  const jumpNode = useCallback(
    (node) => {
      const expandPath =
        node.kind === 'branch' ? [...node.path, node.branch.id] : node.path;
      mutateActive((c) => ({ ...c, turns: expandBranches(c.turns, expandPath) }));
      requestAnimationFrame(() =>
        setTimeout(() => {
          const el =
            node.kind === 'turn'
              ? document.querySelector(`[data-turn="${node.id}"]`)
              : node.kind === 'branch'
                ? document.querySelector(`[data-branch="${node.branch.id}"]`)
                : document.querySelector(
                      `.source-block[data-msg="${node.turnId}"][data-block="${node.note.anchor.endBlock}"]`,
                    ) ||
                  document.querySelector(`[data-turn="${node.turnId}"]`);
          if (!el) return;
          const sc = transcriptRef.current;
          if (sc) {
            const rc = el.getBoundingClientRect();
            const c2 = sc.getBoundingClientRect();
            sc.scrollTo({
              top: rc.top - c2.top + sc.scrollTop - sc.clientHeight * 0.12,
              behavior: 'smooth',
            });
          } else {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1400);
        }, 30),
      );
      if (narrow) setIndexOpen(false);
    },
    [mutateActive, narrow],
  );

  // 导航树右键/键盘菜单（标注与支线；回合行走浏览器默认菜单）
  const onCtx = useCallback((e, node) => {
    if (node.kind === 'turn') return;
    e.preventDefault();
    setCtxMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 90),
      node,
    });
  }, []);
  const onCtxKey = useCallback((e, node) => {
    if (node.kind === 'turn') return;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setCtxMenu({
        x: Math.min(r.right, window.innerWidth - 200),
        y: Math.min(r.bottom + 4, window.innerHeight - 90),
        node,
      });
    }
  }, []);
  useEffect(() => {
    if (!ctxMenu) return undefined;
    const close = () => setCtxMenu(null);
    const onDown = (e) => {
      if (!e.target.closest('.ctx-menu')) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', close, true);
    };
  }, [ctxMenu]);

  // 权限模式切换；「全部放行」先弹确认，切换对下一回合生效。
  const selectPermMode = useCallback(
    (mode) => {
      if (!conv || mode === conv.permissionMode) return;
      if (mode === 'bypass') {
        setModeGate(true);
        return;
      }
      mutateConv(conv.id, (c) => ({ ...c, permissionMode: mode }));
    },
    [conv, mutateConv],
  );

  const onDraft = useCallback((key, v) => setDrafts((d) => ({ ...d, [key]: v })), []);
  const onImgs = useCallback((key, list) => setImgs((d) => ({ ...d, [key]: list })), []);

  // ---- 进行中回合的断点续传（inflight 持久化）----
  // send 时把回合元信息写进 localStorage；刷新后按 convId 向服务端
  // /api/chat/attach 重放缓冲并追 live 流，回合在服务端从未中断。
  const readInflight = () => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(INFLIGHT_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (e) =>
          e &&
          typeof e.pid === 'string' &&
          typeof e.convId === 'string' &&
          typeof e.question === 'string' &&
          Array.isArray(e.path),
      );
    } catch {
      return [];
    }
  };
  const writeInflight = (list) => {
    try {
      if (list.length) window.localStorage.setItem(INFLIGHT_KEY, JSON.stringify(list));
      else window.localStorage.removeItem(INFLIGHT_KEY);
    } catch {}
  };
  const addInflight = (entry) => writeInflight([...readInflight(), entry]);
  const removeInflight = (pid) =>
    writeInflight(readInflight().filter((e) => e.pid !== pid));
  // 停止请求没送达时保留精确 turnId，下一次发送前再清理。
  const markInterrupted = (pid) =>
    writeInflight(
      readInflight().map((e) => (e.pid === pid ? { ...e, interrupted: true } : e)),
    );
  const finishInflight = (pid) => {
    const list = readInflight();
    writeInflight(list.filter((e) => e.pid !== pid || e.interrupted === true));
  };

  // 消费 NDJSON 流（首发与重挂共用）：delta/tool/permission 上屏，
  // done 提交完整回合；中断/错误存不完整回合；stopped 不存。
  // 不抛出——所有收尾（含 inflight 清理）都在内部完成。
  const consumeChatStream = useCallback(async (res, ctx) => {
    const {
      pid,
      convId,
      path,
      question,
      thumbs = [],
      imageUrls = null,
      draftKey = '',
      modelAtSend = '',
      speedAtSend = '',
      turnId,
      sessionId: requestedSessionId = null,
      allowReconnect = true,
      controller,
      restoreImages = null,
    } = ctx;
    // 服务端回合起始时间经响应头透传：重挂（attach）时用服务端时间，
    // 计时跨刷新连续而不是从 0 重计。
    const startedAt = Number(res.headers.get('X-NewQA-Turn-Started-At'));
    if (Number.isSafeInteger(startedAt) && startedAt > 0) {
      setPendings((ps) => ps.map((p) => (p.id === pid ? { ...p, startedAt } : p)));
    }
    let acc = '';
    let toolsAcc = [];
    let changes = null;
    let doneSessionId = null;
    let doneModel = null; // done 上报的本轮实际生效模型
    let durationMs; // done 上报的本轮耗时（createTurn 校验入库）
    let finished = false;
    let streamErr = null;
    let stoppedSeen = false; // 服务端广播的主动停止
    let resetSession = false; // 服务端报告原生会话失效 → 清掉存的 sessionId 重试
    let replaying = false; // 断流后已切到 attach 重挂流：收尾归重挂分支负责
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const handleLine = (line) => {
        if (!line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          streamErr = streamErr || '服务数据格式异常';
          return;
        }
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          acc += ev.text;
          setPendings((ps) =>
            ps.map((p) => (p.id === pid ? { ...p, text: p.text + ev.text } : p)),
          );
        } else if (ev.type === 'tool' && ev.tool) {
          const nextTools = mergeTool(toolsAcc, ev.tool, acc.length);
          toolsAcc = nextTools;
          setPendings((ps) =>
            ps.map((p) => (p.id === pid ? { ...p, tools: nextTools } : p)),
          );
        } else if (ev.type === 'permission' && ev.requestId) {
          setPerms((ps) =>
            ps.some((x) => x.requestId === ev.requestId)
              ? ps
              : [
                  ...ps,
                  {
                    requestId: ev.requestId,
                    pid,
                    title: ev.title || '工具权限请求',
                    toolKind: ev.toolKind || '',
                    command: typeof ev.command === 'string' ? ev.command : '',
                    options: Array.isArray(ev.options) ? ev.options : [],
                  },
                ],
          );
        } else if (ev.type === 'elicitation' && ev.requestId) {
          setElis((ps) =>
            ps.some((x) => x.requestId === ev.requestId)
              ? ps
              : [
                  ...ps,
                  {
                    requestId: ev.requestId,
                    pid,
                    message: typeof ev.message === 'string' ? ev.message : '',
                    fields: Array.isArray(ev.fields) ? ev.fields : [],
                    allowOther: ev.allowOther === true,
                  },
                ],
          );
        } else if (ev.type === 'role' && (ev.role === 'lead' || ev.role === 'sidekick')) {
          setPendings((ps) => ps.map((p) => (p.id === pid ? { ...p, role: ev.role } : p)));
        } else if (ev.type === 'model' && typeof ev.model === 'string' && ev.model) {
          // 回合中上报的实际模型：fusion 指示器与 pending 展示（done 另有最终值）；
          // 模型真的变了 = 新主导者接管，角色复位 lead（与服务端对齐）。
          const m = ev.model.slice(0, 128);
          setPendings((ps) =>
            ps.map((p) =>
              p.id === pid
                ? { ...p, liveModel: m, role: p.liveModel === m ? p.role : 'lead' }
                : p,
            ),
          );
        } else if (ev.type === 'git' && ev.snapshot) {
          changes = ev.snapshot;
        } else if (ev.type === 'done') {
          finished = true;
          doneSessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null;
          doneModel =
            typeof ev.model === 'string' && ev.model ? ev.model.slice(0, 128) : null;
          durationMs = ev.durationMs;
        } else if (ev.type === 'stopped') {
          stoppedSeen = true;
        } else if (ev.type === 'error') {
          streamErr = ev.message || '发生未知错误';
          resetSession = ev.code === 'session_load_failed';
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      buf += dec.decode();
      if (buf.trim()) handleLine(buf);
      if (streamErr) throw new Error(streamErr);
      if (!finished) throw new Error('连接中断，回答不完整，可以继续提问');
      // 提交完整回合；期间新增的笔记/支线通过函数式更新保留。
      setStore((s) => ({
        ...s,
        conversations: s.conversations.map((c2) => {
          if (c2.id !== convId) return c2;
          const turn = createTurn(question, acc, {
            tools: toolsAcc,
            changes,
            images: thumbs,
            imageUrls,
            model: doneModel,
            durationMs,
          });
          const appended = appendTurn(c2.turns, path, turn);
          // 支线回合的会话 id 写回支线节点（主线仍写会话级 sessionId）
          const newTurns =
            path.length && doneSessionId
              ? setBranchSession(appended, path, doneSessionId)
              : appended;
          return {
            ...c2,
            title:
              !c2.titleCustomized && !path.length && c2.turns.length === 0
                ? titleFromQuestion(question)
                : c2.title,
            sessionId:
              !path.length && doneSessionId ? doneSessionId : c2.sessionId,
            // 本轮实际生效模型持久化到会话（done 未上报时沿用上次值）
            effectiveModel: doneModel || c2.effectiveModel || null,
            effFor: doneModel ? modelAtSend : c2.effFor || '',
            effSpeed: doneModel ? speedAtSend : c2.effSpeed || '',
            turns: newTurns,
          };
        }),
      }));
      setPendings((ps) => ps.filter((p) => p.id !== pid));
      setPerms((ps) => ps.filter((x) => x.pid !== pid));
      setElis((ps) => ps.filter((x) => x.pid !== pid));
    } catch (e) {
      // 传输层断开（EOF/读异常且无终止事件）：回合在服务端多半还在跑，
      // 先按 turnId 精确 attach 重挂；重挂不上才走本地失败收尾。
      const transportLost =
        !streamErr && !finished && !stoppedSeen && !controller?.signal.aborted;
      let replayStatus = null;
      if (!unloadingRef.current && allowReconnect && turnId && transportLost) {
        let replay;
        try {
          replay = await chatTurnRequest('attach', { convId, turnId }, controller?.signal);
        } catch {}
        replayStatus = replay?.status ?? null;
        if (!unloadingRef.current && !controller?.signal.aborted && replay?.ok && replay.body) {
          replaying = true;
          // 重挂流从头重放：清掉本地已累计的流式内容与未决表单，避免重复上屏
          setPendings((ps) =>
            ps.map((p) =>
              p.id === pid
                ? { ...p, text: '', tools: [], role: 'lead', liveModel: '' }
                : p,
            ),
          );
          setPerms((ps) => ps.filter((x) => x.pid !== pid));
          setElis((ps) => ps.filter((x) => x.pid !== pid));
          return await consumeChatStream(replay, { ...ctx, allowReconnect: false });
        }
      }
      // 重挂失败或重挂流又断：回合可能在服务端空跑——尽力停掉它
      // （404 = 服务端已无此回合，免发）。停不到就留 interrupted 标记，
      // 下一次发送前按精确 turnId 再清理，避免旧回合挂起导致 409。
      if (
        !unloadingRef.current &&
        turnId &&
        transportLost &&
        !controller?.signal.aborted &&
        replayStatus !== 404
      ) {
        if (!(await stopChatTurn({ convId, turnId }))) markInterrupted(pid);
      }
      // 页面卸载触发的 abort：一切收尾都跳过——inflight 留给重挂，
      // 不落不完整回合、不回填草稿、不弹提示。
      if (!unloadingRef.current) {
        // 显式停止 = 服务端广播 stopped 或本地 controller abort；
        // 传输丢失产生的裸 AbortError 不算主动停止。
        const aborted = stoppedSeen || controller?.signal.aborted;
        if (aborted) {
          setNotice({ kind: 'info', text: '已停止生成，未保存本轮内容' });
        } else {
          setNotice({ kind: 'error', text: e.message || '请求失败，请重试' });
        }
        setPendings((ps) => ps.filter((p) => p.id !== pid));
        setPerms((ps) => ps.filter((x) => x.pid !== pid));
        setElis((ps) => ps.filter((x) => x.pid !== pid));
        // 非主动停止且已有流出内容：存为不完整回合，避免问答整段丢失
        let savedPartial = false;
        if (!aborted && (acc.trim() || toolsAcc.length)) {
          savedPartial = true;
          const partial = createTurn(
            question,
            acc.trim()
              ? `${acc}\n\n（⚠ 生成中断，回答不完整）`
              : '（⚠ 生成中断，未产生回答内容）',
            { tools: toolsAcc, changes, images: thumbs, imageUrls, model: doneModel },
          );
          setStore((s) => ({
            ...s,
            conversations: s.conversations.map((c2) =>
              c2.id !== convId
                ? c2
                : {
                    ...c2,
                    title:
                      !c2.titleCustomized && !path.length && c2.turns.length === 0
                        ? titleFromQuestion(question)
                        : c2.title,
                    turns: appendTurn(c2.turns, path, partial),
                  },
            ),
          }));
        }
        // 失败/停止且未存部分回合：输入框已清空，回填原文与附图便于修改后重试
        if (!savedPartial && draftKey) {
          setDrafts((d) => (d[draftKey] ? d : { ...d, [draftKey]: question }));
          if (restoreImages?.length) {
            setImgs((d) =>
              d[draftKey]?.length ? d : { ...d, [draftKey]: restoreImages },
            );
          }
        }
        // 服务端报告原生会话失效：清掉存的会话 id（主线字段 / 支线节点），
        // 下次发送回落本地历史续聊，不再撞同一个死会话；不删任何转录内容。
        if (resetSession && requestedSessionId) {
          setStore((s) => ({
            ...s,
            conversations: s.conversations.map((c) => {
              if (c.id !== convId) return c;
              if (!path.length) {
                return c.sessionId === requestedSessionId ? { ...c, sessionId: null } : c;
              }
              return branchSessionAt(c.turns, path) === requestedSessionId
                ? { ...c, turns: setBranchSession(c.turns, path, null) }
                : c;
            }),
          }));
        }
      }
    } finally {
      // 已切到 attach 重挂流时，本轮收尾（aborts/inflight）归重挂调用负责；
      // finishInflight 会保留 interrupted 标记项供下次发送清理。
      if (!replaying) {
        abortsRef.current.delete(pid);
        if (!unloadingRef.current) finishInflight(pid);
      }
    }
  }, []);

  // 刷新/重进后重挂服务端仍在跑的回合：重放缓冲 + 追 live。
  const reattachTurn = useCallback(
    async (en) => {
      if (abortsRef.current.has(en.pid)) return;
      const controller = new AbortController();
      abortsRef.current.set(en.pid, {
        controller,
        convId: en.convId,
        turnId: en.turnId, // 旧 inflight 无此字段 → undefined，attach 不携带
      });
      setPendings((ps) =>
        ps.some((p) => p.id === en.pid)
          ? ps
          : [
              ...ps,
              {
                id: en.pid,
                convId: en.convId,
                path: en.path,
                question: en.question,
                text: '',
                tools: [],
                kind: 'work',
                images: en.images || [],
                imageUrls: en.imageUrls || null,
                modelAtSend: en.modelAtSend || '',
                startedAt: en.startedAt,
              },
            ],
      );
      // attach 必须落地本地状态：abort/失败都不留 pending 与 inflight 残影
      let res;
      try {
        res = await chatTurnRequest('attach', en, controller.signal);
      } catch {}
      if (!res?.ok || !res.body) {
        // attach 不上且原因不明（非 404、非本地 abort）：服务端回合可能
        // 仍在跑——尽力精确停掉；停不到留 interrupted 标记待下次发送清理。
        if (
          !unloadingRef.current &&
          !controller.signal.aborted &&
          en.turnId &&
          res?.status !== 404
        ) {
          if (!(await stopChatTurn(en))) markInterrupted(en.pid);
        }
        abortsRef.current.delete(en.pid);
        if (!unloadingRef.current) {
          setPendings((ps) => ps.filter((p) => p.id !== en.pid));
          setPerms((ps) => ps.filter((x) => x.pid !== en.pid));
          setElis((ps) => ps.filter((x) => x.pid !== en.pid));
          finishInflight(en.pid);
          // 输入框已被清空过才回填；已有新草稿时不覆盖
          if (en.draftKey) {
            setDrafts((d) =>
              d[en.draftKey] ? d : { ...d, [en.draftKey]: en.question },
            );
          }
          setNotice({
            kind: 'info',
            text: controller.signal.aborted
              ? '已停止生成，未保存本轮内容'
              : '未能恢复进行中的回合，可以继续提问',
          });
        }
        return;
      }
      await consumeChatStream(res, {
        pid: en.pid,
        convId: en.convId,
        path: en.path,
        question: en.question,
        thumbs: en.images || [],
        imageUrls: en.imageUrls || null,
        draftKey: en.draftKey || '',
        modelAtSend: en.modelAtSend || '',
        speedAtSend: en.speedAtSend || '',
        turnId: en.turnId,
        sessionId: en.sessionId,
        controller,
      });
    },
    [consumeChatStream],
  );

  // 挂载时恢复：localStorage 里的 inflight 回合逐条重挂
  useEffect(() => {
    const entries = readInflight();
    if (!entries.length) return;
    for (const en of entries) {
      if (!storeRef.current.conversations.some((c) => c.id === en.convId)) {
        removeInflight(en.pid);
        continue;
      }
      // 中断标记项不重挂（部分内容/草稿已落库），留给下次发送精确清理
      if (en.interrupted === true) continue;
      reattachTurn(en);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 发送 ----
  const send = useCallback(async (convId, path, question, quote, draftKey, images = []) => {
    // 同一会话仍串行（一个 Devin 会话不能并发 prompt）；不同会话放行。
    for (const v of abortsRef.current.values()) {
      if (v.convId === convId) {
        setNotice({ kind: 'info', text: '该对话已有进行中的回合，请先停止或等待完成' });
        return;
      }
    }
    const c = storeRef.current.conversations.find((x) => x.id === convId);
    if (!c) return;
    // 支线也走 work：完整 agent 能力（工具/权限/模型配置），但用支线自己的
    // Devin 会话（branch.sessionId），与主线 session 相互隔离。
    const kind = 'work';
    const sessId = path.length ? branchSessionAt(c.turns, path) : c.sessionId;
    let history;
    try {
      // 斜杠命令原文下发：打进 envelope 会让 Devin 认不出 /compact 等命令。
      // 原生续聊（work + 已有 sessionId）不回放主线（Devin 侧已有），
      // 但支线内容原生会话没有——只补支线记录；无支线时仍是空历史。
      history = question.trimStart().startsWith('/')
        ? []
        : sessId
          ? branchContextEntries(c.turns)
          : historyForRequest(c.turns, path);
    } catch {
      setNotice({ kind: 'error', text: '无法定位该支线上下文' });
      return;
    }
    const pid = makeId();
    const controller = new AbortController();
    // turnId = 本回合唯一标识（pid）：attach/stop 据此绑定精确回合
    abortsRef.current.set(pid, { controller, convId, turnId: pid });
    // 上次断网留下的中断回合：先按精确 turnId 清理服务端旧回合再发新
    // 回合，避免旧回合仍挂起（如在等权限）导致并发冲突；停不到则不发。
    for (const en of readInflight()) {
      if (en.convId !== convId || en.interrupted !== true || !en.turnId) continue;
      if (!(await stopChatTurn(en))) {
        abortsRef.current.delete(pid);
        setNotice({
          kind: 'error',
          text: '无法连接服务以清理中断的回合，请恢复连接后重试',
        });
        return;
      }
      removeInflight(en.pid);
    }
    const thumbs = images.map((i) => i.thumb).filter(Boolean);
    const imageUrls = images?.length ? await uploadAttachments(images) : null;
    // 本轮使用的 model 选择快照：done 上报的生效值与"哪次选择"绑定，
    // 选择变了就即时改显选中项，不变就显示真实解析值。
    const modelAtSend =
      typeof c.modelConfig?.model === 'string' ? c.modelConfig.model : '';
    const speedAtSend =
      typeof c.modelConfig?.speed === 'string' ? c.modelConfig.speed : '';
    const startedAt = Date.now();
    setPendings((ps) => [
      ...ps,
      {
        id: pid,
        convId,
        path: [...path],
        question,
        text: '',
        tools: [],
        kind,
        images: thumbs,
        imageUrls,
        modelAtSend,
        startedAt,
      },
    ]);
    // 提交即清空输入框与附图（内容已显示在回合气泡里）；失败时在 catch 回填。
    if (draftKey) {
      setDrafts((d) => ({ ...d, [draftKey]: '' }));
      setImgs((d) => ({ ...d, [draftKey]: [] }));
    }
    // inflight 落盘：刷新页面后可按 convId+turnId 重挂服务端回合；
    // sessionId 一并存：原生会话失效的错误事件需要知道清哪条线
    addInflight({
      pid,
      convId,
      turnId: pid,
      sessionId: sessId,
      path: [...path],
      question,
      images: thumbs,
      imageUrls,
      draftKey: draftKey || '',
      modelAtSend,
      speedAtSend,
      startedAt,
    });
    try {
      const res = await fetchChatHeaders(
        '/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...buildChatBody({
              conv: c,
              kind,
              history,
              question,
              quote,
              images,
              sessionId: sessId,
            }),
            turnId: pid,
          }),
          signal: controller.signal,
        },
        15000,
      ).catch(async (error) => {
        if (unloadingRef.current || controller.signal.aborted) throw error;
        // POST 可能已在服务端启动，先接回同一回合，不重发提问。
        const entry = { convId, turnId: pid };
        const replay = await chatTurnRequest('attach', entry, controller.signal).catch(
          () => null,
        );
        if (unloadingRef.current || controller.signal.aborted) throw error;
        if (replay?.ok && replay.body) return replay;
        if (!(await stopChatTurn(entry))) markInterrupted(pid);
        throw new Error('连接中断，未能恢复本轮，请重试', { cause: error });
      });
      if (!res.ok || !res.body) {
        let msg = `服务返回 ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {}
        throw new Error(msg);
      }
      await consumeChatStream(res, {
        pid,
        convId,
        path,
        question,
        thumbs,
        imageUrls,
        draftKey,
        modelAtSend,
        speedAtSend,
        turnId: pid,
        sessionId: sessId,
        controller,
        restoreImages: images,
      });
    } catch (e) {
      // 未开流且未能恢复（或服务端明确拒绝）；流内错误在 consume 内收尾。
      // 页面卸载中的 abort 一并跳过，保住 inflight。
      if (!unloadingRef.current) {
        setNotice(
          controller.signal.aborted
            ? { kind: 'info', text: '已停止生成，未保存本轮内容' }
            : { kind: 'error', text: e.message || '请求失败，请重试' },
        );
        setPendings((ps) => ps.filter((p) => p.id !== pid));
        setPerms((ps) => ps.filter((x) => x.pid !== pid));
        setElis((ps) => ps.filter((x) => x.pid !== pid));
        if (draftKey) {
          setDrafts((d) => (d[draftKey] ? d : { ...d, [draftKey]: question }));
          setImgs((d) => (d[draftKey]?.length ? d : { ...d, [draftKey]: images }));
        }
        finishInflight(pid);
      }
      abortsRef.current.delete(pid);
    }
  }, [consumeChatStream]);

  const onStop = useCallback((pid) => {
    const entry = abortsRef.current.get(pid);
    if (!entry || entry.stopping) return;
    entry.stopping = true;
    // 有界停止请求：确认送达/已收尾后本地 abort 解锁 UI——过早解锁会让
    // 用户以为已停；超时/断网送不达时保留 interrupted 标记（下次发送
    // 前按精确 turnId 再清理），本地 abort 仍兜底断开本地流。
    void stopChatTurn(entry).then((stopped) => {
      if (!stopped && entry.turnId) markInterrupted(pid);
      entry.controller.abort();
    });
  }, []);

  const decidePerm = useCallback(async (requestId, optionId) => {
    setPerms((ps) => ps.filter((p) => p.requestId !== requestId));
    try {
      const res = await fetch('/api/chat/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, optionId }),
      });
      if (!res.ok && res.status !== 404) {
        setNotice({ kind: 'error', text: '权限决定发送失败，请重试' });
      }
    } catch {
      setNotice({ kind: 'error', text: '权限决定发送失败，请重试' });
    }
  }, []);

  // elicitation 作答：action accept（带 content）/ decline（跳过）。
  // 404 = 回合已收尾，静默丢弃即可。
  const decideEli = useCallback(async (requestId, action, content) => {
    setElis((ps) => ps.filter((p) => p.requestId !== requestId));
    try {
      const res = await fetch('/api/chat/elicitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action, content }),
      });
      if (!res.ok && res.status !== 404) {
        setNotice({ kind: 'error', text: '回答发送失败，请重试' });
      }
    } catch {
      setNotice({ kind: 'error', text: '回答发送失败，请重试' });
    }
  }, []);

  // ---- 标注 / 支线 ----
  const clearSel = () => {
    setSelBar(null);
    liveRangeRef.current = null;
    window.getSelection()?.removeAllRanges();
  };

  // 纯色块：只建高亮标注，不打开编辑器、不展开索引。
  const makeNote = (color) => {
    if (!selBar || !conv) return;
    const note = createNote(selBar.anchor, color);
    mutateActive((c) => ({ ...c, turns: addNoteToTurn(c.turns, selBar.turnId, note) }));
    clearSel();
  };

  // 在右侧索引里打开某条标注的编辑器（移动端自动开抽屉）。
  const openNoteEditor = useCallback((noteId) => {
    setFocusNoteId(noteId);
    setLayout((l) => (l.rightCollapsed ? { ...l, rightCollapsed: false } : l));
    if (window.matchMedia('(max-width: 960px)').matches) setIndexOpen(true);
  }, []);

  // 「添加备注」：选区处已有标注则直接编辑它，否则新建黄色标注再编辑。
  const addNoteWithEditor = () => {
    if (!selBar || !conv) return;
    const a = selBar.anchor;
    const turns = storeRef.current.conversations.find((c) => c.id === conv.id)?.turns || [];
    let existing = null;
    const walk = (list) => {
      for (const t of list) {
        if (t.id === selBar.turnId) {
          existing =
            t.notes.find(
              (n) =>
                n.anchor.startBlock === a.startBlock &&
                n.anchor.startOffset === a.startOffset &&
                n.anchor.endBlock === a.endBlock &&
                n.anchor.endOffset === a.endOffset,
            ) || existing;
          return;
        }
        t.branches.forEach((b) => walk(b.turns));
      }
    };
    walk(turns);
    if (existing) {
      openNoteEditor(existing.id);
      clearSel();
      return;
    }
    const note = createNote(a, 'yellow');
    mutateActive((c) => ({ ...c, turns: addNoteToTurn(c.turns, selBar.turnId, note) }));
    openNoteEditor(note.id);
    clearSel();
  };

  const makeBranch = () => {
    if (!selBar || !conv) return;
    const branch = createBranch(selBar.anchor);
    mutateActive((c) => ({
      ...c,
      turns: addBranchToTurn(c.turns, selBar.turnId, branch),
    }));
    setFocusBranchId(branch.id);
    clearSel();
  };

  const onNoteChange = useCallback(
    (turnId, noteId, text) => {
      mutateActive((c) => ({ ...c, turns: setNoteText(c.turns, turnId, noteId, text) }));
    },
    [mutateActive],
  );
  const onNoteColor = useCallback(
    (turnId, noteId, color) => {
      mutateActive((c) => ({ ...c, turns: setNoteColor(c.turns, turnId, noteId, color) }));
    },
    [mutateActive],
  );
  const onNoteDelete = useCallback(
    (turnId, noteId) => {
      mutateActive((c) => ({ ...c, turns: removeNote(c.turns, turnId, noteId) }));
    },
    [mutateActive],
  );
  const onCollapse = useCallback(
    (branchId, collapsed) => {
      mutateActive((c) => ({ ...c, turns: setBranchCollapsed(c.turns, branchId, collapsed) }));
    },
    [mutateActive],
  );
  const onBranchDelete = useCallback(
    (branchId) => {
      mutateActive((c) => ({ ...c, turns: removeBranch(c.turns, branchId) }));
    },
    [mutateActive],
  );

  // ---- 索引/导航点跳转（展开祖先 → 滚动 → 闪烁） ----
  const jumpTo = (mark) => {
    mutateActive((c) => ({ ...c, turns: expandBranches(c.turns, mark.path || []) }));
    requestAnimationFrame(() =>
      setTimeout(() => {
        const el =
          mark.kind === 'note'
            ? document.querySelector(
                `.source-block[data-msg="${mark.turnId}"][data-block="${mark.note.anchor.endBlock}"]`,
              ) || document.querySelector(`[data-turn="${mark.turnId}"]`)
            : document.querySelector(`[data-branch="${mark.branch.id}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1400);
      }, 30),
    );
    if (narrow) setIndexOpen(false);
  };

  const marks = useMemo(() => (conv ? collectMarks(conv.turns) : []), [conv]);
  // 会话级支线编号/五色（deterministic，转录与索引共用）
  const appearance = useMemo(
    () => (conv ? branchAppearance(conv.turns) : new Map()),
    [conv],
  );
  // 对话导航树（回合 → 标注/支线 → 嵌套）
  const navTree = useMemo(() => (conv ? conversationIndex(conv.turns) : []), [conv]);
  // 导航计数：问=递归回合数；注/追=整树标注/支线数
  const navCounts = useMemo(() => {
    const deepTurns = (ts) =>
      ts.reduce(
        (n, t) => n + 1 + t.branches.reduce((m, b) => m + deepTurns(b.turns), 0),
        0,
      );
    return {
      q: conv ? deepTurns(conv.turns) : 0,
      n: marks.filter((m) => m.kind === 'note').length,
      b: marks.filter((m) => m.kind === 'branch').length,
    };
  }, [conv, marks]);
  const mainPending =
    conv && pendings.find((p) => p.convId === conv.id && p.path.length === 0);
  const mainPendingHere = !!mainPending;
  // 本对话任一 work 回合在跑（主线或支线）→ 设置摘要里联动高亮 fusion 模型名
  const settingsPending = conv && pendings.find((p) => p.convId === conv.id && p.kind === 'work');
  // 待删除工作区的会话数与生成中状态（删除弹窗展示/禁用用）
  const delWsCount = delWs
    ? store.conversations.filter((c) => c.workspace === delWs).length
    : 0;
  const delWsBusy =
    !!delWs &&
    store.conversations.some(
      (c) => c.workspace === delWs && pendings.some((p) => p.convId === c.id),
    );

  // 已注册 + 历史会话引用的工作区（canonical 去重，保序）。
  const effectiveWorkspaces = useMemo(
    () => [
      ...new Set([
        ...(store.workspaces || []),
        ...store.conversations.map((c) => c.workspace).filter(Boolean),
      ]),
    ],
    [store.workspaces, store.conversations],
  );
  const editingMark = useMemo(
    () =>
      focusNoteId
        ? marks.find((m) => m.kind === 'note' && m.note.id === focusNoteId) || null
        : null,
    [focusNoteId, marks],
  );

  // fusion uid → {leadLabel, sideLabel}：优先探测选项里的 "Fusion (A + B)" 显示名，
  // 其次 sku 美化（去思考档/速度后缀）。非 fusion uid 返回 null。
  const fusionNames = useCallback(
    (uid) => {
      const parts = splitFusionUid(uid);
      if (!parts) return null;
      const opts =
        devinOpts.status === 'ok' && Array.isArray(devinOpts.config?.model?.options)
          ? devinOpts.config.model.options
          : [];
      const hit = opts.find((o) => o.value === uid);
      const nm = hit ? /^Fusion \((.*?) \+ (.*?)\)\s*$/.exec(String(hit.name || '')) : null;
      return {
        leadLabel: nm?.[1] || prettifyModelKey(parts.lead),
        sideLabel: nm?.[2] || prettifyModelKey(parts.side),
      };
    },
    [devinOpts],
  );

  const sharedProps = {
    convId: conv?.id,
    pendings,
    busy,
    drafts,
    onDraft,
    imgs,
    onImgs,
    onSend: send,
    onStop,
    onNoteChange,
    onNoteColor,
    onNoteDelete,
    onCollapse,
    onBranchDelete,
    focusNoteId,
    focusBranchId,
    appearance,
    fusionNames,
  };

  return (
    <div className="app">
      <a className="skip" href="#composer-main">
        跳到输入框
      </a>
      <header className="topbar">
        <button
          className="icon-btn nav-toggle"
          aria-label="会话列表"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          ☰
        </button>
        {!narrow && (
          <button
            type="button"
            className="panel-toggle"
            aria-label={layout.leftCollapsed ? '展开左侧面板' : '收起左侧面板'}
            aria-expanded={!layout.leftCollapsed}
            title={layout.leftCollapsed ? '展开左侧面板' : '收起左侧面板'}
            onClick={() =>
              setLayout((l) => ({ ...l, leftCollapsed: !l.leftCollapsed }))
            }
          >
            {layout.leftCollapsed ? '»' : '«'}
          </button>
        )}
        <div className="brand">
          <img className="brand-logo" src="/icon.png" alt="" />
          NewQA<span className="brand-sub">新一代harness</span>
        </div>
        <div
          className={`cli-status cli-${cli}`}
          role="status"
          title={
            cli === 'ok'
              ? '检测到本机 devin 命令；实际问答使用你当前的 Devin 登录态'
              : cli === 'missing'
                ? '未检测到 devin 命令，发送会失败'
                : '检测中'
          }
        >
          <span className="dot" aria-hidden="true" />
          {cli === 'ok'
            ? 'Devin CLI · 本地'
            : cli === 'missing'
              ? '未检测到 Devin CLI'
              : '检测中…'}
        </div>
        <button
          className="theme-toggle"
          aria-label={theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
          title={theme === 'dark' ? '切换为浅色' : '切换为深色'}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        {!narrow && (
          <button
            type="button"
            className="panel-toggle"
            aria-label={layout.rightCollapsed ? '展开右侧导航' : '收起右侧导航'}
            aria-expanded={!layout.rightCollapsed}
            title={layout.rightCollapsed ? '展开右侧导航' : '收起右侧导航'}
            onClick={() =>
              setLayout((l) => ({ ...l, rightCollapsed: !l.rightCollapsed }))
            }
          >
            {layout.rightCollapsed ? '«' : '»'}
          </button>
        )}
        <button
          className="icon-btn nav-toggle nav-toggle-right"
          aria-label="标注与支线索引"
          aria-expanded={indexOpen}
          onClick={() => setIndexOpen((v) => !v)}
        >
          ⌘
        </button>
      </header>

      <div
        className="body"
        style={
          narrow
            ? undefined
            : {
                '--left-size': `${panelPx.left}px`,
                '--right-size': `${panelPx.right}px`,
              }
        }
      >
        {(narrow || !layout.leftCollapsed) && (
          <nav className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="会话列表">
            <Sidebar
              conversations={store.conversations}
              activeId={store.activeId}
              workspaces={effectiveWorkspaces}
              wsNames={store.wsNames || {}}
              wsFolders={store.wsFolders || []}
              wsFolderId={store.wsFolderId || {}}
              collapsedKeys={layout.collapsedWorkspaces}
              onNewChat={newChat}
              onSwitch={switchConv}
              onRename={renameConv}
              onDeleteRequest={setDelConv}
              onBrowseWs={() =>
                setPicker({ initial: '', onPick: pickWorkspace })
              }
              onBrowseWsInFolder={(fid) =>
                // 文件夹内「新建工作区…」：选完目录先注册/开会话，再归入该文件夹
                setPicker({
                  initial: '',
                  onPick: (canonical) => {
                    pickWorkspace(canonical);
                    moveWsToFolder(canonical, fid);
                  },
                })
              }
              busyConvIds={pendings.map((p) => p.convId)}
              onToggleGroup={toggleWsGroup}
              onRenameWs={renameWs}
              onDeleteWsRequest={setDelWs}
              onCreateFolder={createWsFolder}
              onRenameFolder={renameWsFolder}
              onDeleteFolder={deleteWsFolder}
              onMoveWs={moveWsToFolder}
              onMoveFolder={moveWsFolder}
              onCollapse={
                narrow
                  ? () => setSidebarOpen(false)
                  : () => setLayout((l) => ({ ...l, leftCollapsed: true }))
              }
            />
          </nav>
        )}
        {!narrow && !layout.leftCollapsed && (
          <ResizeHandle
            side="left"
            value={panelPx.left}
            min={LEFT_MIN}
            max={LEFT_MAX}
            other={panelPx.right}
            label="左侧面板宽度"
            onResize={(w) => setLayout((l) => ({ ...l, leftWidth: w }))}
          />
        )}
        {narrow && sidebarOpen && (
          <div className="scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
        )}

        <main className="main">
          {(notice || store.loadError || saveError) && (
            <div className="notices">
              {store.loadError && <div className="notice warn">{store.loadError}</div>}
              {saveError && <div className="notice warn">{saveError}</div>}
              {notice && (
                <div className={`notice ${notice.kind}`} role="alert">
                  {notice.text}
                  <button
                    className="notice-x"
                    aria-label="关闭提示"
                    onClick={() => setNotice(null)}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          )}

          <div
            className="transcript"
            role="log"
            aria-label="对话记录"
            ref={transcriptRef}
            onScroll={onTranscriptScroll}
            onClick={onTranscriptClick}
          >
            {!conv && (
              <section className="blank">
                <h1 className="blank-title">NewQA</h1>
                <p className="blank-sub">新一代harness</p>
                <div className="chips">
                  {EXAMPLES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="chip"
                      onClick={() => {
                        // 先写 'main' 种子，newChat 迁移进新会话键
                        setDrafts((d) => ({ ...d, main: t }));
                        if (!conv) newChat();
                        document.getElementById('composer-main')?.focus();
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <p className="blank-tip">点击左侧分组的「＋」开始</p>
              </section>
            )}

            {conv && conv.turns.length === 0 && !mainPendingHere && (
              <section className="blank">
                <h2 className="blank-title small">开始提问</h2>
                <p className="blank-sub">
                  主线交给 Devin（原生会话，含工具与权限）；选中回答文字可标注或开支线追问。
                </p>
                <div className="chips">
                  {EXAMPLES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="chip"
                      onClick={() => {
                        setDrafts((d) => ({ ...d, [`main:${conv.id}`]: t }));
                        document.getElementById('composer-main')?.focus();
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {conv &&
              conv.turns.map((t) => (
                <TurnView {...sharedProps} key={t.id} turn={t} path={[]} />
              ))}
            {mainPendingHere && (
              <PendingView
                pending={mainPending}
                onStop={() => onStop(mainPending.id)}
                fusionNames={fusionNames}
              />
            )}
            <MarkRail marks={marks} transcriptRef={transcriptRef} onJump={jumpTo} />
          </div>

          {selBar && (
            <div
              className="sel-bar markup-ui"
              style={{ top: selBar.top, left: selBar.left }}
              role="toolbar"
              aria-label="选区操作"
            >
              {NOTE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch sw-${c}`}
                  title={`标注：${COLOR_NAMES[c]}`}
                  aria-label={`标注：${COLOR_NAMES[c]}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => makeNote(c)}
                />
              ))}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={addNoteWithEditor}
              >
                ✎ 添加备注
              </button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={makeBranch}>
                ❝ 追问
              </button>
            </div>
          )}

          {(perms.length > 0 || elis.length > 0) && (
            <div className="perm-wrap">
              {perms.length > 0 && (
                <PermDialog
                  key={perms[0].requestId}
                  perm={perms[0]}
                  more={perms.length - 1}
                  onDecide={decidePerm}
                />
              )}
              {elis.length > 0 && (
                <ElicitDialog
                  key={elis[0].requestId}
                  eli={elis[0]}
                  more={elis.length - 1}
                  onDecide={decideEli}
                />
              )}
            </div>
          )}

          {conv && (
            <div className="composer-area">
              {showScrollDown && (
                <button
                  type="button"
                  className="scroll-bottom-btn"
                  aria-label="回到底部"
                  title="回到底部"
                  onClick={scrollToBottom}
                >
                  ↓ 回到底部
                </button>
              )}
              <details className="composer-settings" key={`settings:${conv.id}`}>
                <summary>
                  <span>对话设置</span>
                  {conv.permissionMode === 'bypass' && (
                    <span className="mode-badge">全部放行</span>
                  )}
                  {(() => {
                    const mc = conv.modelConfig || {};
                    const modelVal = mc.model || (devinOpts.status === 'ok' ? devinOpts.config?.model?.currentValue : '') || '';
                    const modelOpts = devinOpts.status === 'ok' && Array.isArray(devinOpts.config?.model?.options) ? devinOpts.config.model.options : [];
                    const modelLabel =
                      modelOpts.find((o) => o.value === modelVal)?.name ||
                      (isFusionValue(modelVal) ? 'Fusion' : modelVal) ||
                      '默认模型';
                    const permLabel =
                      conv.permissionMode === 'smart'
                        ? '智能'
                        : conv.permissionMode === 'bypass'
                          ? '全部放行'
                          : '标准';
                    const wsLabel = conv.workspace
                      ? (store.wsNames || {})[conv.workspace] || baseName(conv.workspace)
                      : '默认工作区';
                    const billable =
                      isBillableModel(modelVal) || isBillableSpeed(mc.speed || '');
                    // 本对话回合在跑且（实时上报/所选）模型为 fusion 配对 →
                    // 摘要里按当前 role 绿色高亮对应一侧；结束/非 fusion 回落原摘要。
                    const liveFusion =
                      settingsPending &&
                      fusionNames(
                        settingsPending.liveModel || settingsPending.modelAtSend || modelVal,
                      );
                    const activeRole = settingsPending?.role === 'sidekick' ? 'sidekick' : 'lead';
                    return (
                      <span
                        className={`settings-summary${billable ? ' warn' : ''}${liveFusion ? ' fusion-running' : ''}`}
                      >
                        {liveFusion ? (
                          <>
                            {'Fusion ('}
                            <span
                              className={
                                activeRole === 'lead' ? 'fusion-model-active' : undefined
                              }
                            >
                              {liveFusion.leadLabel}
                            </span>
                            {' + '}
                            <span
                              className={
                                activeRole === 'sidekick' ? 'fusion-model-active' : undefined
                              }
                            >
                              {liveFusion.sideLabel}
                            </span>
                            {')'}
                          </>
                        ) : (
                          modelLabel
                        )}
                        {' · '}
                        {permLabel}
                        {' · '}
                        {wsLabel}
                      </span>
                    );
                  })()}
                </summary>
                <WorkspaceBar
                  key={`ws:${conv.id}`}
                  conv={conv}
                  defaultCwd={defaultCwd}
                  busy={busy}
                  onApply={(canonical) =>
                    mutateConv(conv.id, (c) => ({ ...c, workspace: canonical }))
                  }
                  onBrowse={() =>
                    setPicker({
                      initial: conv.workspace || '',
                      onPick: (canonical) =>
                        mutateConv(conv.id, (c) => ({ ...c, workspace: canonical })),
                    })
                  }
                />
                <ModelBar
                  conv={conv}
                  opts={convOpts}
                  busy={busy}
                  onSelect={(key, value) =>
                    mutateConv(conv.id, (c) => ({
                      ...c,
                      modelConfig: {
                        ...DEFAULT_MODEL_CONFIG,
                        ...(c.modelConfig || {}),
                        [key]: value,
                      },
                    }))
                  }
                />
                <div className="mode-row markup-ui">
                  <div className="mode-seg" role="radiogroup" aria-label="权限模式">
                    {[
                      { id: 'accept-edits', label: '标准', tip: '编辑自动进行，命令类动作需确认' },
                      { id: 'smart', label: '智能', tip: 'Devin 判断安全的动作自动执行' },
                      { id: 'bypass', label: '全部放行', tip: '所有工具自动批准，不再弹窗确认' },
                    ].map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        aria-checked={conv.permissionMode === m.id}
                        className={`mode-opt ${conv.permissionMode === m.id ? 'on' : ''} ${m.id === 'bypass' ? 'danger' : ''}`}
                        title={m.tip}
                        disabled={busy}
                        onClick={() => selectPermMode(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className={`ws-note markup-ui ${conv.permissionMode === 'bypass' ? 'danger' : ''}`}>
                  {conv.permissionMode === 'smart'
                    ? '智能模式下，Devin 自动执行它判断安全的动作；它认为有风险的仍会弹窗确认。'
                    : conv.permissionMode === 'bypass'
                      ? '全部放行：Devin 可在该工作区执行任意命令、修改文件、访问网络，不会弹窗确认。'
                      : '工作模式下，Devin 可直接编辑工作区内文件；只有 Devin 发出权限请求的动作才会弹窗，不会自动替你批准弹窗。'}
                </p>
              </details>
              <Composer
                key={`composer:${conv.id}`}
                value={drafts[`main:${conv.id}`] || ''}
                images={imgs[`main:${conv.id}`] || []}
                onImages={(list) => onImgs(`main:${conv.id}`, list)}
                onChange={(v) => onDraft(`main:${conv.id}`, v)}
                onSubmit={(q, ims) => send(conv.id, [], q, '', `main:${conv.id}`, ims)}
                disabled={busy}
                placeholder="向 Devin 提问……"
                label="提问输入框"
                inputId="composer-main"
                slashCommands={devinOpts.commands}
                onSlashNeed={ensureDevinOptions}
                fusionPairs={fusionPairs}
                fusionCurrent={conv.modelConfig?.model || ''}
                onFusion={(uid) =>
                  mutateConv(conv.id, (c) => ({
                    ...c,
                    modelConfig: {
                      ...DEFAULT_MODEL_CONFIG,
                      ...(c.modelConfig || {}),
                      model: uid,
                    },
                  }))
                }
                autoFocus
              />
            </div>
          )}
        </main>

        {!narrow && !layout.rightCollapsed && (
          <ResizeHandle
            side="right"
            value={panelPx.right}
            min={RIGHT_MIN}
            max={RIGHT_MAX}
            other={panelPx.left}
            label="右侧导航宽度"
            onResize={(w) => setLayout((l) => ({ ...l, rightWidth: w }))}
          />
        )}
        <aside
          className={`index ${indexOpen ? 'open' : ''} ${!narrow && layout.rightCollapsed ? 'strip' : ''}`}
          aria-label="对话导航"
        >
          <div className="ci-head">
            {!narrow && (
              <button
                type="button"
                className="ci-toggle"
                title={layout.rightCollapsed ? '展开导航' : '收起导航'}
                aria-label={layout.rightCollapsed ? '展开导航' : '收起导航'}
                aria-expanded={!layout.rightCollapsed}
                onClick={() =>
                  setLayout((l) => ({ ...l, rightCollapsed: !l.rightCollapsed }))
                }
              >
                {layout.rightCollapsed ? '⇥' : '⇤'}
              </button>
            )}
            <span className="ci-counts">
              <i>问 {navCounts.q}</i>
              <i>注 {navCounts.n}</i>
              <i>追 {navCounts.b}</i>
            </span>
          </div>
          {!narrow && layout.rightCollapsed ? (
            <CiStrip turns={navTree} onJump={jumpNode} />
          ) : (
            <>
              {editingMark && (
                <NoteEditor
                  note={editingMark.note}
                  turnId={editingMark.turnId}
                  onChange={onNoteChange}
                  onColor={onNoteColor}
                  onDelete={(t, n) => {
                    onNoteDelete(t, n);
                    setFocusNoteId(null);
                  }}
                  autoFocus
                  onClose={() => setFocusNoteId(null)}
                />
              )}
              {!conv || conv.turns.length === 0 ? (
                <p className="index-empty">发送第一条提问后，这里会显示对话结构</p>
              ) : (
                <div className="ci-list tree">
                  <CiGroups
                    turns={navTree}
                    foldIds={foldIds}
                    onToggleFold={toggleFold}
                    onJump={jumpNode}
                    onCtx={onCtx}
                    onCtxKey={onCtxKey}
                    appearance={appearance}
                  />
                </div>
              )}
              {!hlSupported && (
                <p className="index-foot">
                  当前浏览器不支持文本高亮 API，标注以块标记显示。
                </p>
              )}
            </>
          )}
        </aside>
        {narrow && indexOpen && (
          <div className="scrim" onClick={() => setIndexOpen(false)} aria-hidden="true" />
        )}
      </div>

      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} role="menu">
          {ctxMenu.node.kind === 'note' && (
            <>
              <button
                type="button"
                className="ctx-item"
                role="menuitem"
                onClick={() => {
                  const n = ctxMenu.node;
                  setCtxMenu(null);
                  openNoteEditor(n.note.id);
                }}
              >
                编辑备注
              </button>
              <CtxConfirm
                label="删除标注"
                onConfirm={() => {
                  const n = ctxMenu.node;
                  setCtxMenu(null);
                  onNoteDelete(n.turnId, n.note.id);
                }}
              />
            </>
          )}
          {ctxMenu.node.kind === 'branch' && (
            <CtxConfirm
              label="删除追问"
              onConfirm={() => {
                const n = ctxMenu.node;
                setCtxMenu(null);
                onBranchDelete(n.branch.id);
              }}
            />
          )}
        </div>
      )}

      {modeGate && (
        <div
          className="dlg-scrim"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setModeGate(false);
            }
          }}
        >
          <div className="dlg conv-del" role="alertdialog" aria-modal="true" aria-label="全部放行确认">
            <h3>开启「全部放行」？</h3>
            <p className="dlg-hint">
              开启后，Devin 在该工作区可执行任意命令、修改文件、访问网络，
              不会再弹权限确认。只对你信任的任务与工作区开启，可随时切回。
            </p>
            <div className="dlg-foot">
              <button
                type="button"
                className="btn-primary danger"
                onClick={() => {
                  if (conv) {
                    mutateConv(conv.id, (c) => ({ ...c, permissionMode: 'bypass' }));
                  }
                  setModeGate(false);
                }}
              >
                开启全部放行
              </button>
              <button type="button" className="mini-btn" autoFocus onClick={() => setModeGate(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {picker && (
        <FolderPicker
          initial={picker.initial}
          defaultCwd={defaultCwd}
          onPick={picker.onPick}
          onClose={() => setPicker(null)}
        />
      )}

      {delConv && (
        <div
          className="dlg-scrim"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDelConv(null);
            }
          }}
        >
          <div
            className="dlg conv-del"
            role="alertdialog"
            aria-modal="true"
            aria-label="删除对话"
          >
            <h3>删除对话「{delConv.title}」？</h3>
            <p className="dlg-hint">
              只会删除 NewQA 本地的转录、标注与支线；不会删除工作区文件，
              也不会删除 Devin 的原生会话记录。
            </p>
            {pendings.some((p) => p.convId === delConv.id) && (
              <p className="ws-err" role="alert">
                该对话正在生成回答，请先停止再删除。
              </p>
            )}
            <div className="dlg-foot">
              <button
                type="button"
                className="btn-primary danger"
                disabled={pendings.some((p) => p.convId === delConv.id)}
                onClick={confirmDeleteConv}
              >
                删除对话
              </button>
              <button
                type="button"
                className="mini-btn"
                autoFocus
                onClick={() => setDelConv(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {delWs && (
        <div
          className="dlg-scrim"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDelWs(null);
            }
          }}
        >
          <div
            className="dlg conv-del"
            role="alertdialog"
            aria-modal="true"
            aria-label="删除工作区"
          >
            <h3>
              删除工作区「{(store.wsNames || {})[delWs] || baseName(delWs)}」？
            </h3>
            <p className="dlg-hint">
              {delWsCount > 0
                ? `该分组下的 ${delWsCount} 个对话会一并删除（仅 NewQA 本地转录与标注）；`
                : ''}
              不会删除工作区文件，也不会删除 Devin 的原生会话记录。
            </p>
            <p className="dlg-hint">{delWs}</p>
            {delWsBusy && (
              <p className="ws-err" role="alert">
                该工作区有对话正在生成回答，请先停止再删除。
              </p>
            )}
            <div className="dlg-foot">
              <button
                type="button"
                className="btn-primary danger"
                disabled={delWsBusy}
                onClick={confirmDeleteWs}
              >
                删除工作区
              </button>
              <button
                type="button"
                className="mini-btn"
                autoFocus
                onClick={() => setDelWs(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  createRoot(document.getElementById('root')).render(<App />);
}
