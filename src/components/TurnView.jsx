import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { renderTimeline } from '../markdown.js';
import { NOTE_COLORS, orderedBranches } from '../model.js';
import { COLOR_NAMES, samePath, shorten } from '../utils/format.js';
import { Composer } from './Composer.jsx';
import { ConfirmButton } from './Dialogs.jsx';

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
export function ToolList({ tools }) {
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

export function GitView({ changes }) {
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
export function QImgs({ srcs, urls }) {
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

function formatTurnDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours) return `${hours} 小时 ${pad(minutes)} 分 ${pad(remainder)} 秒`;
  if (minutes) return `${minutes} 分 ${pad(remainder)} 秒`;
  return `${remainder} 秒`;
}

function TurnTimer({ startedAt }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="turn-duration" role="timer" aria-live="off">
      已用时 {formatTurnDuration(Math.max(0, now - startedAt))}
    </span>
  );
}

export function PendingView({ pending, onStop, fusionNames = null }) {
  const { items } = useMemo(
    () => renderTimeline(pending.text, pending.tools),
    [pending.text, pending.tools],
  );
  // fusion 回合：lead/sidekick 实时指示。role 缺省 lead——回合开始总是 lead 先动；
  // liveModel 未上报时回落发送时的所选模型（modelAtSend）。
  const fusion = fusionNames?.(pending.liveModel || pending.modelAtSend) || null;
  const role = pending.role === 'sidekick' ? 'sidekick' : 'lead';
  return (
    <article className="turn pending" aria-live="polite" aria-label="正在生成回答">
      <div className="turn-q">
        {!!pending.images?.length && (
          <QImgs srcs={pending.images} urls={pending.imageUrls} />
        )}
        {pending.question}
      </div>
      {fusion && (
        <div className="fusion-live" aria-label={`Fusion 配对，当前 ${role === 'sidekick' ? 'Sidekick' : 'Lead'} 在工作中`}>
          <span className={`fusion-pill lead ${role === 'lead' ? 'active' : ''}`}>
            Lead ·{' '}
            <span className={role === 'lead' ? 'fusion-model-active' : undefined}>
              {fusion.leadLabel}
            </span>
          </span>
          <span className={`fusion-pill side ${role === 'sidekick' ? 'active' : ''}`}>
            Sidekick ·{' '}
            <span className={role === 'sidekick' ? 'fusion-model-active' : undefined}>
              {fusion.sideLabel}
            </span>
          </span>
        </div>
      )}
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
      <div className="turn-actions markup-ui">
        <button type="button" className="btn-stop markup-ui" onClick={onStop}>
          ■ 停止生成
        </button>
        {Number.isSafeInteger(pending.startedAt) && pending.startedAt > 0 && (
          <TurnTimer startedAt={pending.startedAt} />
        )}
      </div>
    </article>
  );
}

// 备注编辑器：只出现在右侧索引，正文里不再有内联卡片。
export function NoteEditor({ note, turnId, onChange, onColor, onDelete, autoFocus, onClose }) {
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

export function TurnView(props) {
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
      {Number.isSafeInteger(turn.durationMs) && turn.durationMs >= 0 && (
        <span className="turn-duration turn-duration-final markup-ui">
          用时 {formatTurnDuration(turn.durationMs)}
        </span>
      )}
    </article>
  );
}

export function BranchPanel(props) {
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
                fusionNames={props.fusionNames}
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
