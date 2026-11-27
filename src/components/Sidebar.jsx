import React, { useCallback, useEffect, useRef, useState } from 'react';
import { baseName } from '../utils/format.js';

// ---------- 左侧：工作区分组会话列表 ----------

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

export function Sidebar(props) {
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
