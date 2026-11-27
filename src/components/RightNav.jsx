import React, { useLayoutEffect, useRef, useState } from 'react';
import { shorten } from '../utils/format.js';

// 右缘导航点：按元素在滚动区内的实际位置放置。
export function MarkRail({ marks, transcriptRef, onJump }) {
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

// ---------- 右侧：对话导航（CodeSlice 式：收缩图标条 / 按问分组树） ----------

export const treeNodeKey = (n) =>
  n.kind === 'turn' ? `t-${n.id}` : n.kind === 'branch' ? `b-${n.branch.id}` : `n-${n.note.id}`;

// 标注/支线行（问的 children）；支线行递归挂自己回合的分组。
export function CiChild({ node, foldIds, onToggleFold, onJump, onCtx, onCtxKey, appearance }) {
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
export function CiGroups({ turns, foldIds, onToggleFold, onJump, onCtx, onCtxKey, appearance }) {
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
export function CiStrip({ turns, onJump }) {
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

// ---------- 侧栏拖拽分隔条（仅桌面） ----------

export function ResizeHandle({ side, value, min, max, other, onResize, label }) {
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
    const up = () => {
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
