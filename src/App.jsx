import React, {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { renderTimeline } from './markdown.js';
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
  QUOTE_LIMIT,
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
  orderedBranches,
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
  MAX_IMAGES,
  INFLIGHT_KEY,
  THUMB_LIMIT,
} from './model.js';
import { slashToken, filterSlashCommands, acceptSlash } from './slash.js';
import {
  isFusionCommand,
  isFusionValue,
  stripFirstToken,
  parseFusionPairs,
  fusionIndices,
} from './fusion.js';
import './styles.css';

// 探测命令里没有 fusion 时注入的入口（接受后输入变 '/fusion ' → 开选择器）
const FUSION_CMD = Object.freeze({
  name: 'fusion',
  hint: 'Leader+Sidekick',
  description: '选择 Fusion 模型配对（Tab 切列，Enter 确定）',
});

const EXAMPLES = [
  '用三句话解释什么是 Agent Client Protocol',
  '帮我对比一下 TCP 和 UDP 的适用场景',
  'React 里 useEffect 和 useLayoutEffect 有什么区别？',
];
const COLOR_NAMES = { yellow: '黄色', blue: '蓝色', green: '绿色', pink: '粉色' };

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

function shorten(s, n = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---- 粘贴图片 ----
const PASTE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PASTE_FILE_MAX = 15 * 1024 * 1024; // 原始文件硬上限
const REENCODE_BYTES = 1.5 * 1024 * 1024; // 超过则重编码为 jpeg
const SEND_MAX_SIDE = 1920;
// 存档图：尽量大以保证灯箱清晰，超出 THUMB_LIMIT 安全线则降尺寸重试
const THUMB_SIDES = [1400, 1024, 768, 512];
const THUMB_SAFE = Math.floor(THUMB_LIMIT * 0.95);

function fileDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
}

// 粘贴的图片 → { data(base64), mime, thumb(dataURL) }。
// 大图/超宽图重编码为 jpeg 控制请求体大小；gif 保持原样（不动画会丢帧）。
async function readPastedImage(file) {
  if (!file || !PASTE_MIMES.has(file.type) || file.size > PASTE_FILE_MAX) return null;
  const bmp = await createImageBitmap(file);
  const scaled = (maxSide, quality) => {
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  };
  // 存档图取「能存下的最大尺寸」：1400px 起逐级降，jpeg 质量 0.8 保文字清晰
  const thumb =
    THUMB_SIDES.map((s) => scaled(s, 0.8)).find((t) => t.length <= THUMB_SAFE) ||
    scaled(THUMB_SIDES.at(-1), 0.8);
  const needReencode =
    file.size > REENCODE_BYTES || Math.max(bmp.width, bmp.height) > SEND_MAX_SIDE;
  let data;
  let mime = file.type;
  if (needReencode && file.type !== 'image/gif') {
    const url = scaled(SEND_MAX_SIDE, 0.85);
    data = url.slice(url.indexOf(',') + 1);
    mime = 'image/jpeg';
  } else {
    const url = await fileDataUrl(file);
    data = url.slice(url.indexOf(',') + 1);
  }
  bmp.close?.();
  return { data, mime, thumb };
}

// 发送前把附图传服务端落盘：灯箱/历史查看用原图 URL，localStorage 只留缩略图。
// 失败返回 null——不阻断发送，气泡仍显示本地缩略图。
async function uploadAttachments(images) {
  try {
    const r = await fetch('/api/attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: images.map((i) => ({ data: i.data, mime: i.mime })),
      }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const urls = (j.attachments || []).map((a) => a.url);
    return urls.length === images.length ? urls : null;
  } catch {
    return null;
  }
}

// ---------- 选区 → 锚点 ----------

function blockElOf(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el?.closest?.('.source-block') || null;
}

function offsetInBlock(block, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(node, offset);
  return r.toString().length;
}

// 只取本回合自己的 source-block（不含支线 UI 里的块），端点之间按序拼接。
function quoteBetween(startBlock, startOffset, endBlock, endOffset, msgId) {
  const parts = [];
  for (let i = startBlock; i <= endBlock; i++) {
    const block = document.querySelector(
      `.source-block[data-msg="${msgId}"][data-block="${i}"]`,
    );
    if (!block) continue;
    const text = block.textContent || '';
    const s = i === startBlock ? startOffset : 0;
    const e = i === endBlock ? endOffset : text.length;
    parts.push(text.slice(s, e));
  }
  return parts.join('\n').slice(0, QUOTE_LIMIT);
}

function readAnchorFromRange(range) {
  const sb = blockElOf(range.startContainer);
  const eb = blockElOf(range.endContainer);
  if (!sb || !eb) return null;
  const msgId = sb.dataset.msg;
  if (!msgId || msgId !== eb.dataset.msg) return null;
  // 端点落在界面件（引用头、笔记卡、输入框）里时拒绝；
  // 支线回答正文里的 source-block 仍可标注（支持嵌套支线）。
  if (sb.closest('.markup-ui') || eb.closest('.markup-ui')) return null;
  const startBlock = Number(sb.dataset.block);
  const endBlock = Number(eb.dataset.block);
  const startOffset = offsetInBlock(sb, range.startContainer, range.startOffset);
  const endOffset = offsetInBlock(eb, range.endContainer, range.endOffset);
  if (startBlock === endBlock && startOffset === endOffset) return null;
  const quote = quoteBetween(startBlock, startOffset, endBlock, endOffset, msgId);
  if (!quote.trim()) return null;
  return { msgId, anchor: { startBlock, startOffset, endBlock, endOffset, quote } };
}

// 锚点 → DOM Range 列表（按块内 textContent 偏移走文本节点）。
function rangesForAnchor(msgId, anchor) {
  const ranges = [];
  for (let i = anchor.startBlock; i <= anchor.endBlock; i++) {
    const block = document.querySelector(
      `.source-block[data-msg="${msgId}"][data-block="${i}"]`,
    );
    if (!block) continue;
    const segStart = i === anchor.startBlock ? anchor.startOffset : 0;
    const segEnd =
      i === anchor.endBlock ? anchor.endOffset : (block.textContent || '').length;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.data.length;
      const ns = pos;
      const ne = pos + len;
      pos = ne;
      if (ne > segStart && ns < segEnd) {
        const r = document.createRange();
        r.setStart(node, Math.max(0, segStart - ns));
        r.setEnd(node, Math.min(len, segEnd - ns));
        ranges.push(r);
      }
      if (pos >= segEnd) break;
    }
  }
  return ranges;
}

const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 工具事件按 id 合并（tool_call / tool_call_update）。
// textOffset = 事件到达时已生成文本长度，即工具在时间线中的插入点；更新事件保留首现位置。
function mergeTool(list, tool, textOffset) {
  const i = list.findIndex((t) => t.id === tool.id);
  if (i < 0) return [...list, { ...tool, textOffset }];
  return list.map((t, j) =>
    j === i
      ? {
          ...t,
          ...tool,
          textOffset: t.textOffset,
          output: tool.output || t.output,
          command: tool.command || t.command,
        }
      : t,
  );
}

// ---------- 小组件 ----------

// 二次确认按钮：先点「删除」，变成「确认删除」，3 秒内再点才执行。
function ConfirmButton({ label = '删除', confirmLabel = '确认删除', onConfirm, title }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`mini-btn ${armed ? 'danger' : ''}`}
      title={title}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

// 主输入框（slashCommands 提供时启用 '/' 斜杠命令面板，aria-combobox；
// 支线输入框不传 → 无面板）。命令原样发送，由 Devin 自己解析。
// images/onImages：粘贴的附图（{data,mime,thumb}），父组件按 draftKey 持有。
function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  label,
  autoFocus,
  inputId,
  slashCommands, // undefined=无面板；null=探测中/不可用；数组=可用命令
  onSlashNeed,
  images = [],
  onImages,
  fusionPairs = null, // parseFusionPairs 结果；提供时 '/fusion' 开配对选择器
  fusionCurrent = '', // 当前已选 fusion uid（选择器初始焦点）
  onFusion, // (uid) => void：确认配对后写 modelConfig.model
}) {
  const composing = useRef(false);
  const taRef = useRef(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false); // Esc 关闭，直到下次改动
  const [activeIdx, setActiveIdx] = useState(0);
  const caretPending = useRef(null);
  const combo = slashCommands !== undefined;
  // Fusion 选择器：当前焦点列 0=Leader 1=Sidekick，行索引按列各自记录；
  // fDismissed 同 slash 的 dismissed——Esc 后输入变化才重开。
  const [fCol, setFCol] = useState(0);
  const [fLi, setFLi] = useState(0);
  const [fSi, setFSi] = useState(0);
  const [fDismissed, setFDismissed] = useState(false);

  const hasFusion = !!fusionPairs?.leaders?.length;
  const fusionOpen = hasFusion && isFusionCommand(value) && !fDismissed;
  const fSides =
    fusionPairs?.sides?.get(fusionPairs.leaders[Math.min(fLi, fusionPairs.leaders.length - 1)]?.key) ||
    [];
  const fSide = Math.min(fSi, Math.max(0, fSides.length - 1));

  // 每次打开都按当前已选 uid 归位焦点（未选过 fusion → 0,0）
  useEffect(() => {
    if (!fusionOpen) return;
    const { leaderIdx, sideIdx } = fusionIndices(fusionPairs, fusionCurrent);
    setFLi(leaderIdx);
    setFSi(sideIdx);
    setFCol(0);
  }, [fusionOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // token 只看输入与 caret（与命令是否已取回无关，用于触发懒取）；
  // 面板项则等命令数组到手才过滤。探测命令里没有 fusion 时补一条入口。
  const token = combo ? slashToken(value, caret) : null;
  const cmdList =
    hasFusion && Array.isArray(slashCommands) && !slashCommands.some((c) => c?.name === 'fusion')
      ? [...slashCommands, FUSION_CMD]
      : slashCommands;
  const items = token && cmdList ? filterSlashCommands(cmdList, token.prefix) : [];
  const slashOpen = !!token && !dismissed && items.length > 0 && !fusionOpen;
  const active = Math.min(activeIdx, items.length - 1);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }, [value]);

  // 接受候选后，把 caret 放到 `/{name} ` 之后（value 经父组件回流再设置）
  useLayoutEffect(() => {
    if (caretPending.current == null || !taRef.current) return;
    const pos = Math.min(caretPending.current, taRef.current.value.length);
    taRef.current.setSelectionRange(pos, pos);
    setCaret(pos);
    caretPending.current = null;
  }, [value]);

  // 输入 '/' 但命令尚未取回时触发懒加载（onSlashNeed 自带 once 守卫）
  useEffect(() => {
    if (token && slashCommands == null) onSlashNeed?.();
  }, [token, slashCommands, onSlashNeed]);

  const syncCaret = (e) => setCaret(e.target.selectionStart ?? 0);
  // 确认配对：默认取当前列焦点行的 uid；剥掉 '/fusion' 保留其后正文，
  // caret 归零（经 caretPending → useLayoutEffect 应用）。
  const fCommit = (uid) => {
    const pick = uid ?? fSides[fSide]?.uid;
    if (!pick) return;
    caretPending.current = 0;
    onChange(stripFirstToken(value));
    onFusion?.(pick);
  };
  const accept = (cmd) => {
    const next = acceptSlash(value, cmd.name);
    caretPending.current = next.caret;
    setActiveIdx(0);
    setDismissed(false);
    onChange(next.value);
  };
  const submit = () => {
    if (disabled) return;
    const q = value.trim();
    if (q) onSubmit(q, images);
  };
  // Ctrl+V 贴图：clipboardData 只在 handler 内有效，先同步取出 File 再异步解码。
  // 不 preventDefault：文本部分照常粘贴，图片只是附加。
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f) => f && PASTE_MIMES.has(f.type));
    if (!files.length || !onImages) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return;
    (async () => {
      const next = [];
      for (const f of files.slice(0, room)) {
        try {
          const im = await readPastedImage(f);
          if (im) next.push(im);
        } catch {}
      }
      if (next.length) onImages([...images, ...next]);
    })();
  };
  return (
    <form
      className="composer markup-ui"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="composer-box">
        {images.length > 0 && (
          <div className="attach-strip" aria-label="附图预览">
            {images.map((im, i) => (
              <span className="attach-thumb" key={i}>
                <img src={im.thumb} alt={`附图 ${i + 1}`} />
                <button
                  type="button"
                  className="attach-x"
                  aria-label={`移除附图 ${i + 1}`}
                  title="移除"
                  onClick={() => onImages?.(images.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
            {images.length >= MAX_IMAGES && (
              <span className="attach-hint">最多 {MAX_IMAGES} 张</span>
            )}
          </div>
        )}
        <textarea
          ref={taRef}
          id={inputId}
          className="composer-input"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          rows={1}
          role={combo ? 'combobox' : undefined}
          aria-autocomplete={combo ? 'list' : undefined}
          aria-expanded={combo ? slashOpen || fusionOpen : undefined}
          aria-controls={slashOpen ? listId : undefined}
          aria-activedescendant={slashOpen ? `${listId}-opt-${active}` : undefined}
          onChange={(e) => {
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissed(false);
            setFDismissed(false);
            setActiveIdx(0);
            onChange(e.target.value);
          }}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (fusionOpen) {
              const len = fCol === 0 ? fusionPairs.leaders.length : fSides.length;
              const move = (d) =>
                fCol === 0
                  ? setFLi((i) => ((i + d) % len + len) % len)
                  : setFSi((i) => ((i + d) % len + len) % len);
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(e.key === 'ArrowDown' ? 1 : -1);
                return;
              }
              if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                setFCol((c) => (c ^ 1) & 1);
                return;
              }
              if (e.key === 'Enter' && !composing.current && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // Leader 列回车 → 跳到 Sidekick；Sidekick 列回车 → 确认
                if (fCol === 0) setFCol(1);
                else fCommit();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setFDismissed(true);
                return;
              }
            }
            if (slashOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                setActiveIdx(
                  (i) => ((Math.min(i, items.length - 1) + d) % items.length + items.length) % items.length,
                );
                return;
              }
              if (
                (e.key === 'Enter' &&
                  !e.shiftKey &&
                  !composing.current &&
                  !e.nativeEvent.isComposing) ||
                e.key === 'Tab'
              ) {
                e.preventDefault();
                if (items[active]) accept(items[active]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDismissed(true);
                return;
              }
            }
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !composing.current &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {slashOpen && (
          <ul className="slash-menu" id={listId} role="listbox" aria-label="斜杠命令">
            {items.map((c, i) => (
              <li
                key={c.name}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`slash-opt ${i === active ? 'on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => accept(c)}
              >
                <span className="slash-name">/{c.name}</span>
                {c.hint && <span className="slash-hint">{c.hint}</span>}
                {c.description && <span className="slash-desc">{c.description}</span>}
              </li>
            ))}
          </ul>
        )}
        {fusionOpen && (
          <div className="fusion-menu" role="dialog" aria-label="Fusion 模型配对">
            <div className="fusion-cols">
              <div className={`fusion-col ${fCol === 0 ? 'focus' : ''}`}>
                <div className="fusion-head">Leader</div>
                <ul role="listbox" aria-label="Leader 模型">
                  {fusionPairs.leaders.map((l, i) => (
                    <li
                      key={l.key}
                      role="option"
                      aria-selected={i === fLi}
                      className={`fusion-opt ${i === fLi ? 'on' : ''}`}
                      title={l.key}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setFLi(i)}
                      onClick={() => {
                        setFLi(i);
                        setFCol(1);
                      }}
                    >
                      {l.label}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`fusion-col ${fCol === 1 ? 'focus' : ''}`}>
                <div className="fusion-head">Sidekick</div>
                <ul role="listbox" aria-label="Sidekick 模型">
                  {fSides.map((s, i) => (
                    <li
                      key={s.key}
                      role="option"
                      aria-selected={i === fSide}
                      className={`fusion-opt ${i === fSide ? 'on' : ''}`}
                      title={s.uid}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setFSi(i)}
                      onClick={() => fCommit(s.uid)}
                    >
                      {s.label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="fusion-foot">
              ↑↓ 选择 · Tab/←→ 切换 Leader/Sidekick · Enter 确定 · Esc 取消
            </div>
          </div>
        )}
      </div>
      <div className="composer-foot">
        <span className="composer-hint">
          Enter 发送 · Shift+Enter 换行 · Ctrl+V 贴图{combo ? ' · / 命令' : ''}
        </span>
        <button className="btn-primary" type="submit" disabled={disabled || !value.trim()}>
          发送
        </button>
      </div>
    </form>
  );
}

// ACP tool kind → 中文短徽标；'other' 无信息量不显示。
const TOOL_KIND_LABEL = Object.freeze({
  read: '读',
  edit: '改',
  delete: '删',
  move: '移动',
  search: '搜',
  execute: '执行',
  think: '思考',
  fetch: '抓取',
  plan: '计划',
  switch_mode: '切模式',
});

// 工具行的信息文字（priority：真实标题 > 命令 > 关联文件 > 输出首行 > 空）。
// call_*/空 title 视作无标题；输出首行给匿名工具一个内容预览。
function toolTitle(t) {
  if (t.title && !/^call_/i.test(t.title)) return shorten(t.title, 80);
  if (t.command) return `$ ${shorten(t.command, 70)}`;
  if (t.locations?.length) {
    const names = t.locations
      .slice(0, 3)
      .map((l) => String(l.path).split(/[\\/]/).filter(Boolean).pop() || l.path);
    return `${names.join('、')}${t.locations.length > 3 ? ' 等' : ''}`;
  }
  const line = String(t.output || '')
    .split('\n')
    .find((l) => l.trim());
  return line ? shorten(line.trim(), 50) : '';
}

// 工具记录 + git 快照展示（纯文本，不渲染任何 HTML）。
function ToolList({ tools }) {
  if (!tools?.length) return null;
  return (
    <ul className="tool-list markup-ui">
      {tools.map((t) => {
        // 标题已显示命令时，摘要不再重复 `$ cmd`
        const realTitle = !!(t.title && !/^call_/i.test(t.title));
        const txt = toolTitle(t);
        const kl = TOOL_KIND_LABEL[t.kind] ?? (t.kind && t.kind !== 'other' ? t.kind : '');
        return (
          <li key={t.id} className="tool-item">
            <span className={`tool-status st-${t.status}`}>{t.status}</span>
            {kl ? <span className="tool-kind">{kl}</span> : null}
            {txt ? (
              <span className="tool-title" title={t.title || t.command || t.id}>
                {txt}
              </span>
            ) : null}
            {(t.command || t.output) && (
              <details className="tool-detail">
                <summary>
                  {t.command && realTitle ? `$ ${shorten(t.command, 90)}` : '查看输出'}
                </summary>
                {t.command && <pre className="tool-output">{t.command}</pre>}
                {t.output && <pre className="tool-output">{t.output}</pre>}
              </details>
            )}
            {!!t.locations?.length && (
              <span className="tool-loc">{t.locations.map((l) => l.path).join('，')}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GitView({ changes }) {
  if (!changes) return null;
  if (!changes.available) {
    return <p className="git-note">Git 不可用{changes.note ? `（${changes.note}）` : ''}</p>;
  }
  return (
    <div className="git-view">
      <p className="git-note">
        以下为该目录的只读 git 快照；可能包含仓库既有改动，并非全由 Devin 产生。
      </p>
      {changes.status.trim() ? (
        <pre className="git-block">{changes.status}</pre>
      ) : (
        <p className="git-note">工作区干净</p>
      )}
      {!!changes.staged.trim() && (
        <>
          <h4>已暂存 diff</h4>
          <pre className="git-block">{changes.staged}</pre>
        </>
      )}
      {!!changes.unstaged.trim() && (
        <>
          <h4>未暂存 diff</h4>
          <pre className="git-block">{changes.unstaged}</pre>
        </>
      )}
      {changes.truncated && <p className="git-note">（输出过长，已截断）</p>}
    </div>
  );
}

// 提问气泡附图：点击缩略图开灯箱。urls 为服务端原图地址（优先，清晰）；
// 缺失或加载失败回落本地缩略图。←/→ 切换，Esc/点空白关闭。
function QImgs({ srcs, urls }) {
  const [zoom, setZoom] = useState(null);
  const [failedUrls, setFailedUrls] = useState(() => new Set());
  useEffect(() => {
    if (zoom == null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setZoom(null);
      else if (e.key === 'ArrowLeft') setZoom((z) => Math.max(0, z - 1));
      else if (e.key === 'ArrowRight') setZoom((z) => Math.min(srcs.length - 1, z + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, srcs.length]);
  const zoomSrc = (i) => {
    const u = urls?.[i];
    return u && !failedUrls.has(i) ? u : srcs[i];
  };
  return (
    <span className="q-imgs">
      {srcs.map((src, i) => (
        <button
          key={i}
          type="button"
          className="q-img-btn"
          aria-label={`放大查看附图 ${i + 1}`}
          title="点击放大"
          onClick={() => setZoom(i)}
        >
          <img src={src} alt={`附图 ${i + 1}`} />
        </button>
      ))}
      {zoom != null && (
        <span
          className="lb-scrim"
          role="dialog"
          aria-modal="true"
          aria-label="查看图片"
          onClick={() => setZoom(null)}
        >
          <img
            key={zoom}
            className="lb-img"
            src={zoomSrc(zoom)}
            alt={`附图 ${zoom + 1} 大图`}
            onError={() => {
              const u = urls?.[zoom];
              if (u && !failedUrls.has(zoom)) {
                setFailedUrls((s) => new Set(s).add(zoom));
              }
            }}
          />
          {srcs.length > 1 && (
            <>
              <button
                type="button"
                className="lb-nav prev"
                aria-label="上一张"
                disabled={zoom === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom(zoom - 1);
                }}
              >
                ‹
              </button>
              <button
                type="button"
                className="lb-nav next"
                aria-label="下一张"
                disabled={zoom === srcs.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom(zoom + 1);
                }}
              >
                ›
              </button>
            </>
          )}
          <span className="lb-hint">
            {srcs.length > 1 ? '←/→ 切换 · ' : ''}Esc 或点击空白处关闭
          </span>
        </span>
      )}
    </span>
  );
}

function PendingView({ pending, onStop }) {
  const { items } = useMemo(
    () => renderTimeline(pending.text, pending.tools),
    [pending.text, pending.tools],
  );
  return (
    <article className="turn pending" aria-live="polite" aria-label="正在生成回答">
      <div className="turn-q">
        {!!pending.images?.length && (
          <QImgs srcs={pending.images} urls={pending.imageUrls} />
        )}
        {pending.question}
      </div>
      <div className="turn-a">
        {items.length === 0 && <div className="pending-dots">Devin 正在思考</div>}
        {items.map((item) =>
          item.tools ? (
            <ToolList key={`tool:${item.tools[0].id}`} tools={item.tools} />
          ) : (
            <div
              key={item.index}
              className="source-block"
              dangerouslySetInnerHTML={{ __html: item.html }}
            />
          ),
        )}
        {items.at(-1)?.html && <span className="cursor" aria-hidden="true" />}
      </div>
      <button type="button" className="btn-stop markup-ui" onClick={onStop}>
        ■ 停止生成
      </button>
    </article>
  );
}

// 备注编辑器：只出现在右侧索引，正文里不再有内联卡片。
function NoteEditor({ note, turnId, onChange, onColor, onDelete, autoFocus, onClose }) {
  const taRef = useRef(null);
  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);
  return (
    <aside className={`note-card note-editor markup-ui nc-${note.color}`} data-note={note.id}>
      <div className="anchor-quote">
        <q>{shorten(note.anchor.quote, 120) || '（引用为空）'}</q>
      </div>
      <textarea
        ref={taRef}
        className="note-input"
        aria-label="标注笔记（仅保存在本地，不会发送）"
        placeholder="写点笔记……只保存在本机"
        value={note.text}
        onChange={(e) => onChange(turnId, note.id, e.target.value)}
      />
      <div className="note-foot">
        <span className="mark-tag">本地标注 · 不发送</span>
        <span className="swatches" role="group" aria-label="标注颜色">
          {NOTE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch sw-${c} ${note.color === c ? 'on' : ''}`}
              title={`改为${COLOR_NAMES[c]}`}
              aria-label={`标注颜色：${COLOR_NAMES[c]}`}
              onClick={() => onColor(turnId, note.id, c)}
            />
          ))}
        </span>
        <ConfirmButton onConfirm={() => onDelete(turnId, note.id)} title="删除此标注" />
        <button type="button" className="mini-btn" onClick={onClose}>
          完成
        </button>
      </div>
    </aside>
  );
}

function TurnView(props) {
  const { turn, path } = props;
  const { items, olderTools, blockCount } = useMemo(
    () => renderTimeline(turn.answer, turn.tools),
    [turn.answer, turn.tools],
  );
  // 正文只渲染支线（标注的高亮由 CSS Highlight 负责，不再有内联卡片）。
  const after = useMemo(() => {
    const map = new Map();
    for (const b of orderedBranches(turn)) {
      const i = Math.min(b.anchor.endBlock, blockCount - 1);
      if (!map.has(i)) map.set(i, []);
      map.get(i).push(b);
    }
    return map;
  }, [turn.branches, blockCount]);

  return (
    <article className="turn" data-turn={turn.id}>
      <div className="turn-q">
        {!!turn.images?.length && <QImgs srcs={turn.images} urls={turn.imageUrls} />}
        {turn.question}
      </div>
      <div className="turn-a">
        {items.map((item) =>
          item.tools ? (
            <ToolList key={`tool:${item.tools[0].id}`} tools={item.tools} />
          ) : (
            <Fragment key={item.index}>
              <div
                className="source-block"
                data-msg={turn.id}
                data-block={item.index}
                dangerouslySetInnerHTML={{ __html: item.html }}
              />
              {(after.get(item.index) || []).map((b2) => (
                <BranchPanel
                  {...props}
                  key={b2.id}
                  branch={b2}
                  path={path}
                  ap={props.appearance?.get(b2.id)}
                />
              ))}
            </Fragment>
          ),
        )}
      </div>
      {(olderTools.length > 0 || turn.changes) && (
        <details className="changes markup-ui">
          <summary>
            {olderTools.length ? '工具与改动' : '改动快照'}
          </summary>
          <ToolList tools={olderTools} />
          <GitView changes={turn.changes} />
        </details>
      )}
    </article>
  );
}

function BranchPanel(props) {
  const { branch, path, ap } = props;
  const num = ap?.number ?? '·';
  const bp = useMemo(() => [...path, branch.id], [path, branch.id]);
  const pendingHere = props.pendings?.find(
    (p) => p.convId === props.convId && samePath(p.path, bp),
  );
  const draftKey = `b:${branch.id}`;
  const collapsed = !!branch.collapsed;
  return (
    <section
      className={`branch-ui ${collapsed ? 'collapsed' : ''}`}
      data-branch={branch.id}
      data-tone={ap?.tone ?? 0}
    >
      <div className="anchor-quote markup-ui">
        <span className="mark-tag" data-tone={ap?.tone ?? 0}>
          支线 #{num} · 发送给 Devin
        </span>
        <q>{shorten(branch.anchor.quote, 200) || '（引用为空）'}</q>
        <span className="branch-ops">
          <button
            type="button"
            className="mini-btn"
            aria-expanded={!collapsed}
            onClick={() => props.onCollapse(branch.id, !collapsed)}
          >
            {collapsed ? '展开' : '收起'}
          </button>
          <ConfirmButton onConfirm={() => props.onBranchDelete(branch.id)} title="删除此支线" />
        </span>
      </div>
      {!collapsed && (
        <>
          <div className="branch-thread">
            {branch.turns.map((t) => (
              <TurnView {...props} key={t.id} turn={t} path={bp} />
            ))}
            {pendingHere && (
              <PendingView
                pending={pendingHere}
                onStop={() => props.onStop(pendingHere.id)}
              />
            )}
          </div>
          <Composer
            value={props.drafts[draftKey] || ''}
            images={props.imgs[draftKey] || []}
            onImages={(list) => props.onImgs(draftKey, list)}
            onChange={(v) => props.onDraft(draftKey, v)}
            onSubmit={(q, ims) =>
              props.onSend(props.convId, bp, q, branch.anchor.quote, draftKey, ims)
            }
            disabled={props.busy}
            placeholder="围绕这段选文继续追问或交办任务……"
            label="支线追问输入框"
            autoFocus={props.focusBranchId === branch.id}
          />
          <div className="branch-foot">
            <button
              type="button"
              className="mini-btn"
              onClick={() => props.onCollapse(branch.id, true)}
            >
              收起支线 ↑
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function WorkspaceBar({ conv, defaultCwd, busy: running, onApply, onBrowse }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = conv.workspace || defaultCwd || '';

  const apply = async () => {
    const p = input.trim();
    if (!p) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/workspace/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '检查失败');
      onApply(j.path);
      setEditing(false);
    } catch (e) {
      setErr(e.message || '检查失败');
    } finally {
      setBusy(false);
    }
  };

  // 已有回合或回合进行中不提供换目录入口（目录只对空会话可变）。
  if (conv.turns.length > 0 || running) return null;

  return (
    <div className="ws-bar markup-ui">
      {editing ? (
        <span className="ws-edit">
          <input
            className="ws-input"
            aria-label="工作区绝对路径"
            placeholder="/absolute/path"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
          <button type="button" className="mini-btn" disabled={busy} onClick={apply}>
            {busy ? '检查中…' : '检查'}
          </button>
          <button
            type="button"
            className="mini-btn"
            onClick={() => {
              setEditing(false);
              setErr('');
            }}
          >
            取消
          </button>
          {err && <span className="ws-err" role="alert">{err}</span>}
        </span>
      ) : (
        <>
          <button
            type="button"
            className="mini-btn"
            title="更改当前对话的目录"
            onClick={() => {
              setInput(shown);
              setEditing(true);
              setErr('');
            }}
          >
            更改目录
          </button>
          <button
            type="button"
            className="mini-btn ws-browse"
            onClick={onBrowse}
          >
            浏览文件夹
          </button>
        </>
      )}
    </div>
  );
}

// 实际生效模型标签：done 事件上报值 → 探测选项命中时显示名称，否则原始值。
// 只有免费档精确 SKU 不标黄；Fusion（UID 含 sidekick-swe-2）与
// swe-2-*-lightning 等计费变体都会标黄（判定见 model.js isBillableModel）。
// ACP 的 configOption 只报家族值（如 swe-2-high），速度 Fast 实际会被
// Devin 解析成收费的 Lightning 变体，因此 speed=fast 也按计费标黄。
function EffectiveModelTag({ value, opts, speed = '' }) {
  const options =
    opts.status === 'ok' && Array.isArray(opts.config?.model?.options)
      ? opts.config.model.options
      : [];
  const name = options.find((o) => o.value === value)?.name || value;
  const fast = isBillableSpeed(speed);
  const speedName =
    (opts.status === 'ok'
      ? opts.config?.speed?.options?.find((o) => o.value === speed)?.name
      : '') || speed;
  const billable = isBillableModel(value) || fast;
  const reasons = [
    isBillableModel(value) ? '此模型不在免费档（计费）' : '',
    fast
      ? '非 Standard 速度档会解析为收费快速变体（SWE-2 → Lightning），会消耗周额度'
      : '',
  ].filter(Boolean);
  return (
    <span
      className={`model-eff ${billable ? 'warn' : ''}`}
      title={billable ? reasons.join('；') : undefined}
    >
      实际：{name}
      {fast ? `（${speedName} 计费）` : ''}
    </span>
  );
}

// 会话级 模型/思考/速度 下拉（work 会话输入区可见）。
// '' 值 = 默认，跟随 Devin 全局配置；选择对下一回合生效（回合进行中禁用）。
// opts 来自 GET /api/devin/options：error → 整行禁用并标「不可用」。
function ModelBar({ conv, opts, busy, onSelect }) {
  const ready = opts.status === 'ok';
  const loading = opts.status === 'idle' || opts.status === 'loading';
  const cfg = conv.modelConfig || {};
  // 「实际」模型推导：选择与上次生效同源（effFor）→ 显示 done 上报的真实解析值；
  // 刚改过选择 → 实时显示选中项（等下回合 done 再换成真实解析值）。
  const cfgModel = typeof cfg.model === 'string' ? cfg.model : '';
  const effFor = typeof conv.effFor === 'string' ? conv.effFor : '';
  const effValue = conv.effectiveModel || '';
  const curValue = ready ? opts.config?.model?.currentValue : '';
  const resolvedModel =
    cfgModel === effFor
      ? effValue || cfgModel || curValue
      : cfgModel || curValue || effValue;
  const cfgSpeed = typeof cfg.speed === 'string' ? cfg.speed : '';
  const dftSpeed = ready ? opts.config?.speed?.currentValue : '';
  const speedValue = cfgSpeed || dftSpeed || '';
  const fastSpeed = isBillableSpeed(speedValue);
  // 实际模型标签绑定的是上一回合：模型选择未变时用那次的 speed，
  // 选择已变则按当前 speed 预览下一回合。
  const tagSpeed =
    (cfgModel === effFor ? conv.effSpeed || speedValue : speedValue) || '';
  return (
    <div
      className="model-row markup-ui"
      title={opts.status === 'error' ? '不可用' : undefined}
      aria-label="模型与思考配置"
    >
      {[
        { key: 'model', label: '模型' },
        { key: 'thought_level', label: '思考' },
        { key: 'speed', label: '速度' },
      ].map(({ key, label }) => {
        const group = ready ? opts.config?.[key] : null;
        const options = Array.isArray(group?.options) ? group.options : [];
        // fusion-* 配对改由 /fusion 选择器完成，模型下拉只留普通模型；
        // 当前值若是 fusion，fallback 选项显示 "Fusion (A + B)" 友好名。
        const shown =
          key === 'model' ? options.filter((o) => !isFusionValue(o.value)) : options;
        const cur = typeof cfg[key] === 'string' ? cfg[key] : '';
        const dft =
          options.find((o) => o.value === group?.currentValue)?.name ||
          group?.currentValue ||
          '';
        return (
          <span key={key} className="model-sel">
            <em className="model-sel-name">{label}</em>
            <select
              className="model-select"
              aria-label={`会话${label}配置`}
              disabled={busy || !ready}
              value={cur}
              onChange={(e) => onSelect(key, e.target.value)}
            >
              <option value="">
                {ready && dft ? `默认（${shorten(dft, 16)}）` : '默认'}
              </option>
              {shown.map((o) => (
                <option key={o.value} value={o.value} title={o.value}>
                  {o.name || o.value}
                  {key === 'speed' && isBillableSpeed(o.value) ? '（计费）' : ''}
                </option>
              ))}
              {!!cur && !shown.some((o) => o.value === cur) && (
                <option value={cur} title={cur}>
                  {options.find((o) => o.value === cur)?.name || cur}
                </option>
              )}
            </select>
            {key === 'speed' && fastSpeed && (
              <small
                className="model-warn"
                title="非 Standard 速度档会解析为收费快速变体（SWE-2 → Lightning），会消耗周额度；改成 Standard 即可免费"
              >
                {options.find((o) => o.value === speedValue)?.name || speedValue}{' '}
                计费
              </small>
            )}
            {loading && <small className="model-dft">加载中…</small>}
          </span>
        );
      })}
      {!!resolvedModel && (
        <EffectiveModelTag value={resolvedModel} opts={opts} speed={tagSpeed} />
      )}
    </div>
  );
}

// ---------- 文件夹浏览选择器（本机目录浏览，不上传文件） ----------

function FolderPicker({ initial, defaultCwd, onPick, onClose }) {
  const [cur, setCur] = useState(null); // {path,parent,folders,truncated}
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sel, setSel] = useState(''); // 单击选中的子目录路径（空=未选中）
  const [mkOpen, setMkOpen] = useState(false); // 新建文件夹输入行
  const [mkName, setMkName] = useState('');
  const [mkBusy, setMkBusy] = useState(false);
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const browse = useCallback(async (p) => {
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/workspace/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `浏览失败（服务返回 ${r.status}）`);
      if (seq !== seqRef.current) return;
      setCur(j);
      setInput(j.path);
      setSel('');
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (e) {
      if (e.name === 'AbortError' || seq !== seqRef.current) return;
      setErr(e.message || '浏览失败');
    } finally {
      if (seq === seqRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    browse(typeof initial === 'string' ? initial : '');
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, [browse, initial]);

  // 在当前目录下新建文件夹（等效本机 mkdir），完成后直接进入它
  const createFolder = async () => {
    const name = mkName.trim();
    if (!cur || !name || mkBusy) return;
    if (/[/\\]/.test(name)) {
      setErr('文件夹名不能包含路径分隔符');
      return;
    }
    setMkBusy(true);
    setErr('');
    try {
      const r = await fetch('/api/workspace/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: cur.path === '/' ? `/${name}` : `${cur.path}/${name}`,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `创建失败（服务返回 ${r.status}）`);
      setMkOpen(false);
      setMkName('');
      browse(j.path);
    } catch (e) {
      setErr(e.message || '创建失败');
    } finally {
      setMkBusy(false);
    }
  };

  const pick = async () => {
    if (!cur || picking || busy) return;
    setPicking(true);
    setErr('');
    try {
      const r = await fetch('/api/workspace/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sel || cur.path }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `检查失败（${r.status}）`);
      onPick(j.path);
      onClose();
    } catch (e) {
      setErr(e.message || '检查失败');
    } finally {
      setPicking(false);
    }
  };

  return (
    <div
      className="dlg-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="dlg folder-picker"
        role="dialog"
        aria-modal="true"
        aria-label="选择文件夹"
      >
        <div className="dlg-head">
          <h3>选择文件夹</h3>
          <button
            type="button"
            className="mini-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <p className="dlg-hint">
          单击选中 · 双击进入。WSL 下 Windows 盘符在 <code>/mnt</code>（如 E: 盘 →{' '}
          <code>/mnt/e</code>）。
        </p>
        <div className="fp-shortcuts">
          <button type="button" className="mini-btn" onClick={() => browse('')}>
            默认目录{defaultCwd ? `（${baseName(defaultCwd)}）` : ''}
          </button>
          <button type="button" className="mini-btn" onClick={() => browse('/')}>
            /
          </button>
          <button type="button" className="mini-btn" onClick={() => browse('/mnt')}>
            /mnt
          </button>
        </div>
        <div className="fp-crumb">
          <button
            type="button"
            className="mini-btn"
            disabled={!cur?.parent || busy}
            aria-label="进入上级目录"
            onClick={() => cur?.parent && browse(cur.parent)}
          >
            ↑ 上级
          </button>
          <span className="fp-cur" title={cur?.path || ''}>
            {busy ? '读取中…' : cur?.path || '—'}
          </span>
          <button
            type="button"
            className="mini-btn fp-newdir"
            disabled={!cur || busy}
            aria-expanded={mkOpen}
            onClick={() => {
              setMkOpen((v) => !v);
              setMkName('');
              setErr('');
            }}
          >
            新建文件夹
          </button>
        </div>
        {mkOpen && (
          <div className="fp-mkdir">
            <input
              className="ws-input"
              aria-label="新文件夹名称"
              placeholder="新文件夹名称"
              value={mkName}
              autoFocus
              onChange={(e) => setMkName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createFolder();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setMkOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="mini-btn"
              disabled={mkBusy || !mkName.trim()}
              onClick={createFolder}
            >
              {mkBusy ? '创建中…' : '创建'}
            </button>
          </div>
        )}
        <div className="fp-list" ref={listRef} role="listbox" aria-label="子目录列表">
          {cur?.folders?.length
            ? cur.folders.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`fp-dir ${sel === f.path ? 'sel' : ''}`}
                  role="option"
                  aria-selected={sel === f.path}
                  title={`${f.path}（双击进入）`}
                  onClick={() => setSel(sel === f.path ? '' : f.path)}
                  onDoubleClick={() => browse(f.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') browse(f.path);
                  }}
                >
                  📁 {f.name}
                </button>
              ))
            : !busy && <p className="fp-empty">没有子文件夹</p>}
          {cur?.truncated && <p className="fp-empty">目录较多，仅显示前 256 项</p>}
        </div>
        <div className="fp-goto">
          <input
            ref={inputRef}
            className="ws-input"
            aria-label="直接输入绝对路径"
            placeholder="/absolute/path"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) browse(input.trim());
            }}
          />
          <button
            type="button"
            className="mini-btn"
            disabled={busy || !input.trim()}
            onClick={() => browse(input.trim())}
          >
            前往
          </button>
        </div>
        {err && (
          <p className="ws-err" role="alert">
            {err}
          </p>
        )}
        <div className="dlg-foot">
          <button
            type="button"
            className="btn-primary"
            disabled={!cur || busy || picking}
            onClick={pick}
          >
            {picking ? '检查中…' : '选择此文件夹'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function PermDialog({ perm, more = 0, onDecide }) {
  const allow = perm.options.filter((o) => o.kind === 'allow_once');
  const deny = perm.options.filter((o) => o.kind === 'reject_once');
  return (
    <div className="perm-card markup-ui" role="alertdialog" aria-label="工具权限请求">
      <div className="perm-head">
        <strong>工具权限请求</strong>
        {perm.toolKind && <span className="tool-kind">{perm.toolKind}</span>}
        {more > 0 && <span className="perm-more">还有 {more} 个待确认</span>}
      </div>
      <p className="perm-title">{perm.title}</p>
      {perm.command && <pre className="perm-cmd">{perm.command}</pre>}
      <div className="perm-ops">
        {allow.map((o) => (
          <button
            key={o.id}
            type="button"
            className="btn-primary"
            onClick={() => onDecide(perm.requestId, o.id)}
          >
            {o.label || '允许一次'}
          </button>
        ))}
        {deny.map((o) => (
          <button
            key={o.id}
            type="button"
            className="mini-btn"
            onClick={() => onDecide(perm.requestId, o.id)}
          >
            {o.label || '拒绝'}
          </button>
        ))}
        <button type="button" className="mini-btn" onClick={() => onDecide(perm.requestId, null)}>
          取消
        </button>
      </div>
      <p className="perm-note">仅单次生效；不会自动批准、没有「总是允许」。</p>
    </div>
  );
}

// 右缘导航点：按元素在滚动区内的实际位置放置。
function MarkRail({ marks, transcriptRef, onJump }) {
  const [pos, setPos] = useState({});
  useLayoutEffect(() => {
    const wrap = transcriptRef.current;
    if (!wrap) return;
    const update = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const next = {};
      for (const m of marks) {
        const el =
          m.kind === 'note'
            ? document.querySelector(
                `.source-block[data-msg="${m.turnId}"][data-block="${m.note.anchor.startBlock}"]`,
              )
            : document.querySelector(`[data-branch="${m.branch.id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const ratio = (r.top - wrapRect.top + wrap.scrollTop) / Math.max(wrap.scrollHeight, 1);
        next[m.kind === 'note' ? `n-${m.note.id}` : `b-${m.branch.id}`] = Math.min(
          0.985,
          Math.max(0.005, ratio),
        );
      }
      setPos((prev) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(prev).length &&
          keys.every((k) => prev[k] === next[k])
        )
          return prev;
        return next;
      });
    };
    update();
    const t = setTimeout(update, 300);
    window.addEventListener('resize', update);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', update);
    };
  });
  if (!marks.length) return null;
  return (
    <div className="mark-rail markup-ui" aria-label="标注与支线位置导航">
      {marks.map((m) => {
        const key = m.kind === 'note' ? `n-${m.note.id}` : `b-${m.branch.id}`;
        const top = pos[key];
        if (top == null) return null;
        return (
          <button
            key={key}
            type="button"
            className={`rail-dot ${m.kind === 'note' ? `rd-${m.note.color}` : 'rd-branch'}`}
            style={{ top: `${top * 100}%` }}
            title={m.kind === 'note' ? '跳到标注' : '跳到支线'}
            aria-label={m.kind === 'note' ? '跳到标注' : '跳到支线'}
            onClick={() => onJump(m)}
          />
        );
      })}
    </div>
  );
}

// ---------- 左侧：工作区分组会话列表 ----------

const baseName = (p) => p.split('/').filter(Boolean).pop() || p;
const UNGROUPED_KEY = '__ungrouped__';

function FolderIcon() {
  return (
    <svg
      className="ws-ico"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 3.5A1.25 1.25 0 0 1 3 2.25h3.1l1.4 1.5H13A1.25 1.25 0 0 1 14.25 5v7.5A1.25 1.25 0 0 1 13 13.75H3A1.25 1.25 0 0 1 1.75 12.5v-9z" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 3.5A1.25 1.25 0 0 1 3 2.25h3.1l1.4 1.5H13A1.25 1.25 0 0 1 14.25 5v7.5A1.25 1.25 0 0 1 13 13.75H3A1.25 1.25 0 0 1 1.75 12.5v-9z" />
      <path d="M8 7.25v4M6 9.25h4" />
    </svg>
  );
}

function ConvList({
  items,
  activeId,
  onSwitch,
  onRename,
  onDeleteRequest,
  busyConvIds = [],
  openMenu,
  onToggleMenu,
  onCloseMenu,
}) {
  const [renaming, setRenaming] = useState(null);
  const [renameVal, setRenameVal] = useState('');

  const commitRename = (id) => {
    const title = renameVal.trim().slice(0, 80);
    if (!title) return;
    onRename(id, title);
    setRenaming(null);
  };

  return (
    <ul className="conv-list">
      {items.map((c) => {
        const isBusy = busyConvIds.includes(c.id);
        const menuOpen = openMenu?.kind === 'conv' && openMenu.id === c.id;
        return (
          <li key={c.id} className="conv-row">
            {renaming === c.id ? (
              <span className="conv-rename" role="form" aria-label="重命名会话">
                <input
                  className="ws-input"
                  aria-label="新会话名"
                  maxLength={80}
                  value={renameVal}
                  autoFocus
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(c.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!renameVal.trim()}
                  onClick={() => commitRename(c.id)}
                >
                  保存
                </button>
                <button type="button" className="mini-btn" onClick={() => setRenaming(null)}>
                  取消
                </button>
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className={`conv-item ${c.id === activeId ? 'active' : ''}`}
                  onClick={() => onSwitch(c.id)}
                >
                  {isBusy && (
                    <span className="busy-dot" aria-label="生成中" title="正在生成回答" />
                  )}
                  <span className="conv-title">{c.title}</span>
                  <span className="conv-meta">{c.turns.length} 条</span>
                </button>
                <button
                  type="button"
                  className="conv-menu-btn"
                  aria-label={`会话「${c.title}」的操作`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => onToggleMenu('conv', c.id)}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div className="conv-menu" role="menu" aria-label={`会话「${c.title}」`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onCloseMenu();
                        setRenaming(c.id);
                        setRenameVal(c.title);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={isBusy}
                      title={isBusy ? '该对话正在生成回答，请先停止' : undefined}
                      onClick={() => {
                        onCloseMenu();
                        onDeleteRequest(c);
                      }}
                    >
                      删除对话
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        );
      })}
      {items.length === 0 && <li className="conv-empty">暂无对话</li>}
    </ul>
  );
}

function Sidebar(props) {
  const {
    conversations,
    activeId,
    workspaces,
    wsNames = {},
    wsFolders = [],
    wsFolderId = {},
    collapsedKeys,
    onNewChat,
    onSwitch,
    onRename,
    onDeleteRequest,
    onBrowseWs,
    onBrowseWsInFolder,
    busyConvIds,
    onToggleGroup,
    onRenameWs,
    onDeleteWsRequest,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onMoveWs,
    onMoveFolder,
    onCollapse,
  } = props;
  const [query, setQuery] = useState('');
  const [openMenu, setOpenMenu] = useState(null);
  const [renamingWs, setRenamingWs] = useState(null);
  const [wsRenameVal, setWsRenameVal] = useState('');
  const [renamingFolder, setRenamingFolder] = useState(null);
  const [folderRenameVal, setFolderRenameVal] = useState('');
  const [wsMoveFor, setWsMoveFor] = useState(null); // 「移动到文件夹」二级页所在工作区
  const [folderMoveFor, setFolderMoveFor] = useState(null); // 二级页所在文件夹
  const [folderChatFor, setFolderChatFor] = useState(null); // 「新建对话」二级页所在文件夹
  const [dropTarget, setDropTarget] = useState(null); // folderId | 'root' | null
  const wsName = (ws) => wsNames[ws] || baseName(ws);

  const toggleMenu = useCallback((kind, id) => {
    setOpenMenu((cur) => (cur?.kind === kind && cur.id === id ? null : { kind, id }));
  }, []);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  useEffect(() => {
    setWsMoveFor(null);
    setFolderMoveFor(null);
    setFolderChatFor(null);
    if (!openMenu) return;
    const onDown = (e) => {
      if (e.target.closest?.('.conv-menu, .conv-menu-btn')) return;
      setOpenMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const q = query.trim().toLowerCase();
  const ungroupedAll = conversations.filter((c) => !c.workspace);
  const ungrouped = q
    ? ungroupedAll.filter((c) => c.title.toLowerCase().includes(q))
    : ungroupedAll;
  const listProps = {
    activeId,
    onSwitch,
    onRename,
    onDeleteRequest,
    busyConvIds,
    openMenu,
    onToggleMenu: toggleMenu,
    onCloseMenu: closeMenu,
  };

  const commitWsRename = (ws) => {
    onRenameWs(ws, wsRenameVal.trim().slice(0, 80));
    setRenamingWs(null);
  };

  const commitFolderRename = (id) => {
    const name = folderRenameVal.trim().slice(0, 80);
    if (name) onRenameFolder(id, name);
    setRenamingFolder(null);
  };

  let visibleWsCount = 0;

  const folderIdSet = new Set(wsFolders.map((f) => f.id));
  // parentId 悬空一律按顶层处理（双保险，持久层已过滤/断环）。
  const parentOf = (f) =>
    f.parentId && folderIdSet.has(f.parentId) ? f.parentId : null;
  // 归属缺失/悬空的映射一律按顶层工作区处理。
  const topLevelWs = workspaces.filter(
    (w) => !wsFolderId[w] || !folderIdSet.has(wsFolderId[w]),
  );
  const childFolders = (f) => wsFolders.filter((x) => parentOf(x) === f.id);
  const topLevelFolders = wsFolders.filter((f) => !parentOf(f));
  const wsConvs = (ws) => conversations.filter((c) => c.workspace === ws);
  const nameHit = (ws) =>
    wsName(ws).toLowerCase().includes(q) || ws.toLowerCase().includes(q);
  const folderMembers = (f) => workspaces.filter((w) => wsFolderId[w] === f.id);
  const folderHit = (f) => f.name.toLowerCase().includes(q);
  const wsConvHit = (ws) =>
    wsConvs(ws).some((c) => c.title.toLowerCase().includes(q));
  const wsBusy = (ws) => wsConvs(ws).some((c) => busyConvIds.includes(c.id));
  const folderShownMembers = (f) => {
    const members = folderMembers(f);
    return q && !folderHit(f)
      ? members.filter((w) => nameHit(w) || wsConvHit(w))
      : members;
  };
  // 子树命中：本名 / 直属工作区 / 任一后代文件夹命中 → 祖先链保持可见。
  const subtreeHit = (f) =>
    folderHit(f) ||
    folderShownMembers(f).length > 0 ||
    childFolders(f).some(subtreeHit);
  // 子树忙碌：任意后代会话在生成 → 文件夹指示亮。
  const subtreeBusy = (f) =>
    folderMembers(f).some(wsBusy) || childFolders(f).some(subtreeBusy);
  // 子树全部成员工作区（直属 + 各层后代文件夹）——「新建对话」二级页候选。
  const subtreeMembers = (f) => [
    ...folderMembers(f),
    ...childFolders(f).flatMap(subtreeMembers),
  ];
  const visibleFolders = topLevelFolders.filter((f) => !q || subtreeHit(f));
  // 「移动到…」二级页的扁平列表（先序 + 深度缩进）。
  const flatFolders = [];
  const walkFlat = (pid, depth) => {
    for (const f of wsFolders.filter((x) => parentOf(x) === pid)) {
      flatFolders.push({ f, depth });
      walkFlat(f.id, depth + 1);
    }
  };
  walkFlat(null, 0);
  // 文件夹自身 + 后代 id 集（移动目标排除，防环）。
  const subtreeIds = (id) => {
    const out = new Set([id]);
    for (;;) {
      let grew = false;
      for (const f of wsFolders) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
      }
      if (!grew) return out;
    }
  };

  const onWsDragOver = (e, target) => {
    const t = e.dataTransfer.types;
    if (!t.includes('application/x-newqa-ws') && !t.includes('application/x-newqa-folder'))
      return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(target);
  };
  const onWsDrop = (e, folderIdOrNull) => {
    e.preventDefault();
    e.stopPropagation();
    const ws = e.dataTransfer.getData('application/x-newqa-ws');
    const fid = e.dataTransfer.getData('application/x-newqa-folder');
    if (ws) onMoveWs(ws, folderIdOrNull);
    else if (fid && fid !== folderIdOrNull) onMoveFolder(fid, folderIdOrNull);
    setDropTarget(null);
  };
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null);
  };

  // 单个工作区分组（顶层或文件夹内通用）。
  const renderWs = (ws, showAll = false) => {
    const allItems = wsConvs(ws);
    const hit = !q || nameHit(ws) || showAll;
    const items = q && !hit
      ? allItems.filter((c) => c.title.toLowerCase().includes(q))
      : allItems;
    if (q && !hit && items.length === 0) return null;
    visibleWsCount++;
    const collapsed = q ? false : collapsedKeys.includes(ws);
    const hasBusy = wsBusy(ws);
    const wsMenuOpen = openMenu?.kind === 'ws' && openMenu.id === ws;
    return (
      <section className="ws-group" key={ws} data-ws={ws}>
        <div
          className="ws-group-head"
          draggable={renamingWs !== ws}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-newqa-ws', ws);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => setDropTarget(null)}
        >
          {renamingWs === ws ? (
            <span className="conv-rename" role="form" aria-label="重命名工作区">
              <input
                className="ws-input"
                aria-label="工作区显示名（留空恢复目录名）"
                placeholder={baseName(ws)}
                maxLength={80}
                value={wsRenameVal}
                autoFocus
                onChange={(e) => setWsRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitWsRename(ws);
                  if (e.key === 'Escape') setRenamingWs(null);
                }}
              />
              <button
                type="button"
                className="mini-btn"
                onClick={() => commitWsRename(ws)}
              >
                保存
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setRenamingWs(null)}
              >
                取消
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="ws-group-toggle"
                aria-expanded={!collapsed}
                title={ws}
                aria-label={`工作区 ${wsName(ws)}，${allItems.length} 个会话`}
                onClick={() => onToggleGroup(ws)}
              >
                <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                <FolderIcon />
                <span className="ws-group-name">{wsName(ws)}</span>
                {hasBusy && (
                  <span className="busy-dot" aria-label="有会话正在生成" title="有会话正在生成" />
                )}
              </button>
              <button
                type="button"
                className="conv-menu-btn"
                aria-label={`工作区「${wsName(ws)}」的操作`}
                aria-haspopup="menu"
                aria-expanded={wsMenuOpen}
                onClick={() => toggleMenu('ws', ws)}
              >
                ⋯
              </button>
              {wsMenuOpen && (
                <div
                  className="conv-menu"
                  role="menu"
                  aria-label={`工作区「${wsName(ws)}」`}
                >
                  {wsMoveFor === ws ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setWsMoveFor(null)}
                      >
                        ‹ 返回
                      </button>
                      <div className="menu-label">移动到文件夹</div>
                      {flatFolders.map(({ f, depth }) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={f.id}
                          onClick={() => {
                            onMoveWs(ws, f.id);
                            closeMenu();
                          }}
                        >
                          {wsFolderId[ws] === f.id ? '✓ ' : ''}
                          {' '.repeat(depth)}
                          {f.name}
                        </button>
                      ))}
                      {wsFolders.length === 0 && (
                        <span className="menu-empty">还没有文件夹，先在上方新建</span>
                      )}
                      {wsFolderId[ws] && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onMoveWs(ws, null);
                            closeMenu();
                          }}
                        >
                          移出文件夹
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu();
                          onNewChat(ws);
                        }}
                      >
                        新建对话
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu();
                          setRenamingWs(ws);
                          setWsRenameVal(wsNames[ws] || '');
                        }}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setWsMoveFor(ws)}
                      >
                        移动到文件夹…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          closeMenu();
                          onDeleteWsRequest(ws);
                        }}
                      >
                        删除工作区
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!collapsed && <ConvList items={items} {...listProps} />}
      </section>
    );
  };

  // 工作区文件夹分组：可折叠、可重命名/删除（成员上挂一级）、可嵌套、可作拖放目标。
  const renderFolder = (f) => {
    const members = folderShownMembers(f);
    const memberAll = folderMembers(f);
    const kidsAll = childFolders(f);
    const hit = q && folderHit(f);
    const kids = q && !hit ? kidsAll.filter(subtreeHit) : kidsAll;
    const collapsed = q ? false : collapsedKeys.includes(`wf:${f.id}`);
    const anyBusy = subtreeBusy(f);
    const fMenuOpen = openMenu?.kind === 'folder' && openMenu.id === f.id;
    const moveBad = folderMoveFor === f.id ? subtreeIds(f.id) : null;
    return (
      <section
        className={`ws-folder ${dropTarget === f.id ? 'drop' : ''}`}
        key={f.id}
        onDragOver={(e) => onWsDragOver(e, f.id)}
        onDragLeave={onDragLeave}
        onDrop={(e) => onWsDrop(e, f.id)}
      >
        <div
          className="ws-group-head"
          draggable={renamingFolder !== f.id}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-newqa-folder', f.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => setDropTarget(null)}
        >
          {renamingFolder === f.id ? (
            <span className="conv-rename" role="form" aria-label="重命名文件夹">
              <input
                className="ws-input"
                aria-label="文件夹名"
                maxLength={80}
                value={folderRenameVal}
                autoFocus
                onChange={(e) => setFolderRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitFolderRename(f.id);
                  if (e.key === 'Escape') setRenamingFolder(null);
                }}
              />
              <button
                type="button"
                className="mini-btn"
                onClick={() => commitFolderRename(f.id)}
              >
                保存
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setRenamingFolder(null)}
              >
                取消
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="ws-group-toggle folder"
                aria-expanded={!collapsed}
                aria-label={`文件夹 ${f.name}，${memberAll.length} 个工作区`}
                onClick={() => onToggleGroup(`wf:${f.id}`)}
              >
                <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                <FolderIcon />
                <span className="ws-group-name">{f.name}</span>
                {anyBusy && (
                  <span className="busy-dot" aria-label="有会话正在生成" title="有会话正在生成" />
                )}
                <span className="ws-count">{memberAll.length}</span>
              </button>
              <button
                type="button"
                className="conv-menu-btn"
                aria-label={`文件夹「${f.name}」的操作`}
                aria-haspopup="menu"
                aria-expanded={fMenuOpen}
                onClick={() => toggleMenu('folder', f.id)}
              >
                ⋯
              </button>
              {fMenuOpen && (
                <div
                  className="conv-menu"
                  role="menu"
                  aria-label={`文件夹「${f.name}」`}
                >
                  {folderMoveFor === f.id ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setFolderMoveFor(null)}
                      >
                        ‹ 返回
                      </button>
                      <div className="menu-label">移动到文件夹</div>
                      {flatFolders
                        .filter(({ f: t }) => !moveBad.has(t.id))
                        .map(({ f: t, depth }) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={t.id}
                            onClick={() => {
                              onMoveFolder(f.id, t.id);
                              closeMenu();
                            }}
                          >
                            {parentOf(f) === t.id ? '✓ ' : ''}
                            {' '.repeat(depth)}
                            {t.name}
                          </button>
                        ))}
                      {parentOf(f) && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onMoveFolder(f.id, null);
                            closeMenu();
                          }}
                        >
                          移到顶层
                        </button>
                      )}
                    </>
                  ) : folderChatFor === f.id ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setFolderChatFor(null)}
                      >
                        ‹ 返回
                      </button>
                      <div className="menu-label">在哪个工作区新建</div>
                      {subtreeMembers(f).map((w) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={w}
                          title={w}
                          onClick={() => {
                            closeMenu();
                            onNewChat(w);
                          }}
                        >
                          {wsName(w)}
                        </button>
                      ))}
                      {subtreeMembers(f).length === 0 && (
                        <span className="menu-empty">
                          还没有工作区，先用「新建工作区…」添加
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setFolderMoveFor(null);
                          setFolderChatFor(f.id);
                        }}
                      >
                        新建对话…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu();
                          onBrowseWsInFolder?.(f.id);
                        }}
                      >
                        新建工作区…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu();
                          setRenamingFolder(f.id);
                          setFolderRenameVal(f.name);
                        }}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu();
                          const child = onCreateFolder('新文件夹', f.id);
                          if (child) {
                            setRenamingFolder(child.id);
                            setFolderRenameVal(child.name);
                            if (collapsedKeys.includes(`wf:${f.id}`)) {
                              onToggleGroup(`wf:${f.id}`);
                            }
                          }
                        }}
                      >
                        新建子文件夹
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setFolderMoveFor(f.id)}
                      >
                        移动到文件夹…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          closeMenu();
                          onDeleteFolder(f.id);
                        }}
                      >
                        删除文件夹
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!collapsed && (
          <div className="ws-folder-body">
            {kids.map(renderFolder)}
            {members.map((ws) => renderWs(ws, hit))}
            {memberAll.length === 0 && kidsAll.length === 0 && (
              <p className="ws-folder-empty">
                把工作区或文件夹拖到此处，也可经 ⋯ 菜单新建子文件夹
              </p>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <>
      <div className="sidebar-search">
        <input
          type="search"
          className="sidebar-search-input"
          aria-label="搜索工作区或会话"
          placeholder="搜索工作区或会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="sidebar-search-clear"
            aria-label="清空搜索"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </div>

      <div
        className={`ws-groups ${dropTarget === 'root' ? 'drop' : ''}`}
        onDragOver={(e) => onWsDragOver(e, 'root')}
        onDragLeave={onDragLeave}
        onDrop={(e) => onWsDrop(e, null)}
      >
        <div className="ws-groups-head">
          <span className="ws-groups-title">工作区</span>
          <span className="ws-groups-actions">
            <button
              type="button"
              className="mini-btn ws-add"
              aria-label="新建文件夹（归类工作区）"
              title="新建文件夹（归类工作区）"
              onClick={() => {
                const f = onCreateFolder('新文件夹');
                if (f) {
                  setRenamingFolder(f.id);
                  setFolderRenameVal(f.name);
                }
              }}
            >
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              className="mini-btn ws-add"
              aria-label="浏览并添加工作区目录"
              title="浏览并添加工作区目录"
              onClick={onBrowseWs}
            >
              ＋
            </button>
          </span>
        </div>

        {visibleFolders.map(renderFolder)}
        {topLevelWs.map((ws) => renderWs(ws))}

        {(!q || ungrouped.length > 0) && (
          <section className="ws-group" data-ws={UNGROUPED_KEY}>
            <div className="ws-group-head">
              <button
                type="button"
                className="ws-group-toggle"
                aria-expanded={q ? true : !collapsedKeys.includes(UNGROUPED_KEY)}
                aria-label={`未分组会话，${ungroupedAll.length} 个会话`}
                onClick={() => onToggleGroup(UNGROUPED_KEY)}
              >
                <span aria-hidden="true">
                  {(q ? false : collapsedKeys.includes(UNGROUPED_KEY)) ? '▸' : '▾'}
                </span>
                <span className="ws-group-name">未分组</span>
                {ungroupedAll.some((c) => busyConvIds.includes(c.id)) && (
                  <span className="busy-dot" aria-label="有会话正在生成" title="有会话正在生成" />
                )}
              </button>
              <button
                type="button"
                className="conv-menu-btn"
                aria-label="未分组的操作"
                aria-haspopup="menu"
                aria-expanded={openMenu?.kind === 'ug'}
                onClick={() => toggleMenu('ug', 'ungrouped')}
              >
                ⋯
              </button>
              {openMenu?.kind === 'ug' && (
                <div className="conv-menu" role="menu" aria-label="未分组">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      onNewChat();
                    }}
                  >
                    新建对话
                  </button>
                </div>
              )}
            </div>
            {(q || !collapsedKeys.includes(UNGROUPED_KEY)) && (
              <ConvList items={ungrouped} {...listProps} />
            )}
          </section>
        )}

        {q && visibleWsCount === 0 && visibleFolders.length === 0 && ungrouped.length === 0 && (
          <p className="conv-empty">未找到匹配的会话或工作区</p>
        )}
      </div>

      {onCollapse && (
        <div className="sidebar-foot">
          <button
            type="button"
            className="sidebar-collapse"
            onClick={onCollapse}
            title="收起侧栏"
            aria-label="收起侧栏"
          >
            « 收起侧栏
          </button>
        </div>
      )}
    </>
  );
}

// ---------- 右侧：对话导航（CodeSlice 式：收缩图标条 / 按问分组树） ----------

const treeNodeKey = (n) =>
  n.kind === 'turn' ? `t-${n.id}` : n.kind === 'branch' ? `b-${n.branch.id}` : `n-${n.note.id}`;

// 标注/支线行（问的 children）；支线行递归挂自己回合的分组。
function CiChild({ node, foldIds, onToggleFold, onJump, onCtx, onCtxKey, appearance }) {
  if (node.kind === 'note') {
    return (
      <button
        type="button"
        className="ci-trow ci-mark"
        title={node.note.text ? `📝 ${node.note.text}` : node.note.anchor.quote}
        onClick={() => onJump(node)}
        onContextMenu={(e) => onCtx(e, node)}
        onKeyDown={(e) => onCtxKey(e, node)}
      >
        <span className={`ci-m m-${node.note.color}${node.note.text ? ' note' : ''}`} />
        <span className="ci-txt">
          {node.note.text || shorten(node.note.anchor.quote, 30) || '标注'}
        </span>
      </button>
    );
  }
  const ap = appearance.get(node.branch.id);
  const fid = treeNodeKey(node);
  const cl = foldIds.has(fid);
  const kids = node.children || [];
  return (
    <div>
      <div className="ci-trow-wrap">
        {kids.length ? (
          <button
            type="button"
            className="ci-caret"
            aria-expanded={!cl}
            aria-label={cl ? '展开支线' : '收起支线'}
            onClick={() => onToggleFold(fid)}
          >
            {cl ? '▸' : '▾'}
          </button>
        ) : (
          <span className="ci-caret ghost" aria-hidden="true" />
        )}
        <button
          type="button"
          className="ci-trow ci-thr"
          data-tone={ap?.tone ?? 0}
          title={`支线 #${ap?.number ?? '·'} · 追问：${node.branch.anchor.quote}`}
          onClick={() => onJump(node)}
          onContextMenu={(e) => onCtx(e, node)}
          onKeyDown={(e) => onCtxKey(e, node)}
        >
          <span className="ci-th">💬</span>
          <span className="ci-num" data-tone={ap?.tone ?? 0}>
            #{ap?.number ?? '·'}
          </span>
          <span className="ci-txt">追问：{shorten(node.branch.anchor.quote, 26)}</span>
        </button>
      </div>
      {!cl && kids.length > 0 && (
        <div className="ci-children">
          <CiGroups
            turns={kids}
            foldIds={foldIds}
            onToggleFold={onToggleFold}
            onJump={onJump}
            onCtx={onCtx}
            onCtxKey={onCtxKey}
            appearance={appearance}
          />
        </div>
      )}
    </div>
  );
}

// 按「问」分组渲染：组头 问+问题+注/追徽章，children 沿引导线。
function CiGroups({ turns, foldIds, onToggleFold, onJump, onCtx, onCtxKey, appearance }) {
  return turns.map((t) => {
    const gk = `g-${t.id}`;
    const cl = foldIds.has(gk);
    const kids = t.children || [];
    const nNotes = kids.filter((c) => c.kind === 'note').length;
    const nBr = kids.filter((c) => c.kind === 'branch').length;
    return (
      <div key={t.id} className="ci-group">
        <div className="ci-trow-wrap">
          {kids.length ? (
            <button
              type="button"
              className="ci-caret"
              aria-expanded={!cl}
              aria-label={cl ? '展开本轮标注与追问' : '收起本轮标注与追问'}
              onClick={() => onToggleFold(gk)}
            >
              {cl ? '▸' : '▾'}
            </button>
          ) : (
            <span className="ci-caret ghost" aria-hidden="true" />
          )}
          <button
            type="button"
            className="ci-trow ci-qrow"
            title={t.question}
            onClick={() => onJump(t)}
          >
            <span className="ci-q">问</span>
            <span className="ci-txt">{shorten(t.question, 40)}</span>
            {(nNotes > 0 || nBr > 0) && (
              <span className="ci-gbadges">
                {nNotes > 0 && <i>注{nNotes}</i>}
                {nBr > 0 && <i>追{nBr}</i>}
              </span>
            )}
          </button>
        </div>
        {!cl && kids.length > 0 && (
          <div className="ci-children">
            {kids.map((c) => (
              <CiChild
                key={treeNodeKey(c)}
                node={c}
                foldIds={foldIds}
                onToggleFold={onToggleFold}
                onJump={onJump}
                onCtx={onCtx}
                onCtxKey={onCtxKey}
                appearance={appearance}
              />
            ))}
          </div>
        )}
      </div>
    );
  });
}

// 收缩条（34px）：顶层条目按序——问 chip / 标注色点 / 💬。
function CiStrip({ turns, onJump }) {
  const items = [];
  for (const t of turns) {
    items.push({ kind: 'turn', node: t });
    for (const c of t.children || []) items.push({ kind: c.kind, node: c });
  }
  return (
    <div className="ci-list strip" aria-label="对话导航（收缩）">
      {items.map((it, i) => (
        <button
          key={`${treeNodeKey(it.node)}-${i}`}
          type="button"
          className="ci-row"
          title={
            it.kind === 'turn'
              ? it.node.question
              : it.kind === 'note'
                ? it.node.note.text || it.node.note.anchor.quote
                : `追问：${it.node.branch.anchor.quote}`
          }
          aria-label={
            it.kind === 'turn'
              ? `跳到：${shorten(it.node.question, 30)}`
              : it.kind === 'note'
                ? '跳到标注'
                : '跳到追问'
          }
          onClick={() => onJump(it.node)}
        >
          {it.kind === 'turn' ? (
            <span className="ci-q">问</span>
          ) : it.kind === 'note' ? (
            <span
              className={`ci-m m-${it.node.note.color}${it.node.note.text ? ' note' : ''}`}
            />
          ) : (
            <span className="ci-th">💬</span>
          )}
        </button>
      ))}
    </div>
  );
}

// 右键菜单里的两段确认删除项。
function CtxConfirm({ label, onConfirm }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={`ctx-item ${armed ? 'armed danger' : ''}`}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? '确认删除' : label}
    </button>
  );
}

// ---------- 侧栏拖拽分隔条（仅桌面） ----------

function ResizeHandle({ side, value, min, max, other, onResize, label }) {
  const ref = useRef(null);
  const clampNow = (w) => {
    // 中央转录至少留 360px；只在用户调整时钳制，不因视口变化改写偏好
    const byViewport = window.innerWidth - 360 - other;
    return Math.round(Math.min(max, Math.max(min, Math.min(w, Math.max(min, byViewport)))));
  };
  const onPointerDown = (e) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = value;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      onResize(clampNow(side === 'left' ? startW + dx : startW - dx));
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onResize(clampNow(value - 16));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onResize(clampNow(value + 16));
    }
  };
  return (
    <div
      ref={ref}
      className={`resize-handle rh-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label}（拖拽或方向键调整）`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

export default function App() {
  const [store, setStore] = useState(loadStore);
  const [saveError, setSaveError] = useState(null);
  const [drafts, setDrafts] = useState({ main: '' });
  const [imgs, setImgs] = useState({}); // draftKey → [{data,mime,thumb}] 粘贴附图
  const [pendings, setPendings] = useState([]); // 各对话可并行：进行中回合列表
  const [perms, setPerms] = useState([]);
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
  const liveRangeRef = useRef(null);
  const hlRef = useRef({});
  const transcriptRef = useRef(null);
  const storeRef = useRef(store);
  storeRef.current = store;

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

  // ---- 持久化 ----
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: 1,
          conversations: store.conversations,
          activeId: store.activeId,
          workspaces: store.workspaces || [],
          wsNames: store.wsNames || {},
          wsFolders: store.wsFolders || [],
          wsFolderId: store.wsFolderId || {},
        }),
      );
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

  // ---- 高亮标注（CSS Custom Highlight API，不支持时降级为块级标记） ----
  useLayoutEffect(() => {
    const marks = conv ? collectMarks(conv.turns) : [];
    if (!hlSupported) {
      document
        .querySelectorAll('.source-block.marked')
        .forEach((el) =>
          el.classList.remove(
            'marked',
            'marked-note',
            'marked-branch',
            ...NOTE_COLORS.map((c) => `marked-${c}`),
          ),
        );
      for (const m of marks) {
        const anchor = (m.note || m.branch).anchor;
        for (let i = anchor.startBlock; i <= anchor.endBlock; i++) {
          document
            .querySelector(`.source-block[data-msg="${m.turnId}"][data-block="${i}"]`)
            ?.classList.add(
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
    for (const m of marks) {
      const anchor = (m.note || m.branch).anchor;
      const name =
        m.kind === 'note'
          ? `nq-n-${m.note.color}${m.note.text.trim() ? '-u' : ''}`
          : 'nq-branch';
      used.add(name);
      if (!hlRef.current[name]) {
        hlRef.current[name] = new Highlight();
        CSS.highlights.set(name, hlRef.current[name]);
      } else {
        hlRef.current[name].clear();
      }
      for (const r of rangesForAnchor(m.turnId, anchor)) hlRef.current[name].add(r);
    }
    for (const name of Object.keys(hlRef.current)) {
      if (!used.has(name)) {
        hlRef.current[name].clear();
        delete hlRef.current[name];
      }
    }
    // 依赖 conv 而非每次渲染：打字/流式只改 drafts/pendings，
    // DOM 结构不变，不必重算 Range——否则每个按键都阻塞绘制
  }, [conv, hlSupported]);

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
      controller,
      restoreImages = null,
    } = ctx;
    let acc = '';
    let toolsAcc = [];
    let changes = null;
    let doneSessionId = null;
    let doneModel = null; // done 上报的本轮实际生效模型
    let finished = false;
    let streamErr = null;
    let stoppedSeen = false; // 服务端广播的主动停止
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
        } else if (ev.type === 'git' && ev.snapshot) {
          changes = ev.snapshot;
        } else if (ev.type === 'done') {
          finished = true;
          doneSessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null;
          doneModel =
            typeof ev.model === 'string' && ev.model ? ev.model.slice(0, 128) : null;
        } else if (ev.type === 'stopped') {
          stoppedSeen = true;
        } else if (ev.type === 'error') {
          streamErr = ev.message || '发生未知错误';
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
      if (!finished) throw new Error('连接中断，回答不完整，未保存本轮内容');
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
    } catch (e) {
      const aborted = stoppedSeen || e.name === 'AbortError' || controller?.signal.aborted;
      if (aborted) {
        setNotice({ kind: 'info', text: '已停止生成，未保存本轮内容' });
      } else {
        setNotice({ kind: 'error', text: e.message || '请求失败，请重试' });
      }
      setPendings((ps) => ps.filter((p) => p.id !== pid));
      setPerms((ps) => ps.filter((x) => x.pid !== pid));
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
          setImgs((d) => (d[draftKey]?.length ? d : { ...d, [draftKey]: restoreImages }));
        }
      }
    } finally {
      abortsRef.current.delete(pid);
      removeInflight(pid);
    }
  }, []);

  // 刷新/重进后重挂服务端仍在跑的回合：重放缓冲 + 追 live。
  const reattachTurn = useCallback(
    async (en) => {
      if (abortsRef.current.has(en.pid)) return;
      const controller = new AbortController();
      abortsRef.current.set(en.pid, { controller, convId: en.convId });
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
              },
            ],
      );
      let res;
      try {
        res = await fetch('/api/chat/attach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convId: en.convId }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e.name !== 'AbortError') {
          setPendings((ps) => ps.filter((p) => p.id !== en.pid));
          abortsRef.current.delete(en.pid);
          removeInflight(en.pid);
        }
        return;
      }
      if (!res.ok || !res.body) {
        // 404 = 服务端已无此回合（重启/回放过期）→ 丢弃残留标记
        setPendings((ps) => ps.filter((p) => p.id !== en.pid));
        abortsRef.current.delete(en.pid);
        removeInflight(en.pid);
        if (res.status === 404) {
          setNotice({ kind: 'info', text: '有进行中的回合因服务重启未能恢复' });
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
    abortsRef.current.set(pid, { controller, convId });
    const thumbs = images.map((i) => i.thumb).filter(Boolean);
    const imageUrls = images?.length ? await uploadAttachments(images) : null;
    // 本轮使用的 model 选择快照：done 上报的生效值与"哪次选择"绑定，
    // 选择变了就即时改显选中项，不变就显示真实解析值。
    const modelAtSend =
      typeof c.modelConfig?.model === 'string' ? c.modelConfig.model : '';
    const speedAtSend =
      typeof c.modelConfig?.speed === 'string' ? c.modelConfig.speed : '';
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
      },
    ]);
    // 提交即清空输入框与附图（内容已显示在回合气泡里）；失败时在 catch 回填。
    if (draftKey) {
      setDrafts((d) => ({ ...d, [draftKey]: '' }));
      setImgs((d) => ({ ...d, [draftKey]: [] }));
    }
    // inflight 落盘：刷新页面后可按 convId 重挂服务端回合
    addInflight({
      pid,
      convId,
      path: [...path],
      question,
      images: thumbs,
      imageUrls,
      draftKey: draftKey || '',
      modelAtSend,
      speedAtSend,
      startedAt: Date.now(),
    });
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildChatBody({
            conv: c,
            kind,
            history,
            question,
            quote,
            images,
            sessionId: sessId,
          }),
        ),
        signal: controller.signal,
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
        controller,
        restoreImages: images,
      });
    } catch (e) {
      // 仅覆盖发出前的失败（网络错误/4xx 未开流）；流内错误 consume 内部已收尾
      setNotice({ kind: 'error', text: e.message || '请求失败，请重试' });
      setPendings((ps) => ps.filter((p) => p.id !== pid));
      setPerms((ps) => ps.filter((x) => x.pid !== pid));
      if (draftKey) {
        setDrafts((d) => (d[draftKey] ? d : { ...d, [draftKey]: question }));
        setImgs((d) => (d[draftKey]?.length ? d : { ...d, [draftKey]: images }));
      }
      abortsRef.current.delete(pid);
      removeInflight(pid);
    }
  }, [consumeChatStream]);

  const onStop = useCallback((pid) => {
    const entry = abortsRef.current.get(pid);
    if (!entry) return;
    // 通知服务端真正中止回合（kill acp 进程）→ 回合广播 stopped 收尾；
    // 本地 abort 兜底：服务端不可达时至少断开本地流。
    fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: entry.convId }),
    }).catch(() => {});
    entry.controller.abort();
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

  // ---- 标注 / 支线 ----
  const clearSel = () => {
    setSelBar(null);
    liveRangeRef.current = null;
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
              <PendingView pending={mainPending} onStop={() => onStop(mainPending.id)} />
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

          {showScrollDown && conv && (
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

          {perms.length > 0 && (
            <div className="perm-wrap">
              <PermDialog
                key={perms[0].requestId}
                perm={perms[0]}
                more={perms.length - 1}
                onDecide={decidePerm}
              />
            </div>
          )}

          {conv && (
            <div className="composer-area">
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
                    return (
                      <span className={`settings-summary ${billable ? 'warn' : ''}`}>
                        {modelLabel} · {permLabel} · {wsLabel}
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
