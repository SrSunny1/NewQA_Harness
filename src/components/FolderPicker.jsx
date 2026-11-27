import React, { useCallback, useEffect, useRef, useState } from 'react';
import { baseName } from '../utils/format.js';

// ---------- 文件夹浏览选择器（本机目录浏览，不上传文件） ----------

export function FolderPicker({ initial, defaultCwd, onPick, onClose }) {
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
