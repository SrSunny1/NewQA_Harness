import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MAX_IMAGES } from '../model.js';
import { slashToken, filterSlashCommands, acceptSlash } from '../slash.js';
import { isFusionCommand, stripFirstToken, fusionIndices } from '../fusion.js';
import { readPastedImage } from '../utils/images.js';

// 探测命令里没有 fusion 时注入的入口（接受后输入变 '/fusion ' → 开选择器）
const FUSION_CMD = Object.freeze({
  name: 'fusion',
  hint: 'Leader+Sidekick',
  description: '选择 Fusion 模型配对（Tab 切列，Enter 确定）',
});

const PASTE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// 主输入框（slashCommands 提供时启用 '/' 斜杠命令面板，aria-combobox；
// 支线输入框不传 → 无面板）。命令原样发送，由 Devin 自己解析。
// images/onImages：粘贴的附图（{data,mime,thumb}），父组件按 draftKey 持有。
export function Composer({
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
