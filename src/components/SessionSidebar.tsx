import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { SEPARATOR, useContextMenu } from "./ContextMenu";
import { useDialogs } from "./Dialogs";
import Icon from "./Icons";
import type { HostHealthView, SessionProfile, Snippet } from "../types";

const DEFAULT_GROUP = "默认分组";
const COLLAPSED_GROUPS_KEY = "termai.collapsedGroups";
const DRAG_THRESHOLD = 5;

interface DragSessionState {
  sessionId: string;
  sessionName: string;
  sourceGroup: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
}

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.filter((v) => typeof v === "string"));
    }
  } catch {
    /* 使用默认折叠状态 */
  }
  return new Set([DEFAULT_GROUP]);
}

interface Props {
  width: number;
  collapsed: boolean;
  sessions: SessionProfile[];
  groups: string[];
  snippets: Snippet[];
  highlightedSessionId?: string | null;
  connectedSessionIds?: string[];
  hostHealth: Record<string, HostHealthView>;
  healthChecking: boolean;
  hasActiveTerminal: boolean;
  onConnect: (s: SessionProfile) => void;
  onSftp: (s: SessionProfile) => void;
  onEdit: (s: SessionProfile) => void;
  onDelete: (s: SessionProfile) => void;
  onCreate: () => void;
  onOpenLocal: () => void;
  onGroupsChanged: () => void;
  onRunSnippet: (command: string) => void;
  onSnippetsChanged: () => void;
  onOpenSettings: () => void;
  onToggleCollapsed: () => void;
  onOpenCommandPalette: () => void;
  onHealthCheck: () => void;
}

export default function SessionSidebar({
  width,
  collapsed,
  sessions,
  groups,
  snippets,
  highlightedSessionId,
  connectedSessionIds,
  hostHealth,
  healthChecking,
  hasActiveTerminal,
  onConnect,
  onSftp,
  onEdit,
  onDelete,
  onCreate,
  onOpenLocal,
  onGroupsChanged,
  onRunSnippet,
  onSnippetsChanged,
  onOpenSettings,
  onToggleCollapsed,
  onOpenCommandPalette,
  onHealthCheck,
}: Props) {
  const [filter, setFilter] = useState("");
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [dragSession, setDragSession] = useState<DragSessionState | null>(null);
  const dragSessionRef = useRef<DragSessionState | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const { showMenu } = useContextMenu();
  const { prompt, confirm } = useDialogs();

  const setCurrentDragSession = useCallback((next: DragSessionState | null) => {
    dragSessionRef.current = next;
    setDragSession(next);
  }, []);

  useEffect(() => {
    if (highlightedSessionId) setFilter("");
  }, [highlightedSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups]));
    } catch {
      /* 忽略偏好持久化失败 */
    }
  }, [collapsedGroups]);

  useEffect(() => {
    const validGroups = new Set([DEFAULT_GROUP, ...groups]);
    setCollapsedGroups((prev) => {
      const next = new Set([...prev].filter((g) => validGroups.has(g)));
      return next.size === prev.size ? prev : next;
    });
  }, [groups]);

  const addSnippet = async () => {
    const name = await prompt({ title: "新建命令片段", placeholder: "显示名称，如：查看磁盘" });
    if (!name?.trim()) return;
    const command = await prompt({ title: "命令内容", placeholder: "如：df -h" });
    if (!command?.trim()) return;
    await api.snippetSave({ name: name.trim(), command: command.trim() });
    onSnippetsChanged();
  };

  const snippetMenu = (e: React.MouseEvent, s: Snippet) => {
    showMenu(e, [
      { label: `执行: ${s.command.slice(0, 40)}`, onClick: () => onRunSnippet(s.command) },
      SEPARATOR,
      {
        label: "编辑",
        onClick: async () => {
          const command = await prompt({ title: `编辑「${s.name}」`, defaultValue: s.command });
          if (command?.trim()) {
            await api.snippetSave({ id: s.id, name: s.name, command: command.trim() });
            onSnippetsChanged();
          }
        },
      },
      {
        label: "删除",
        danger: true,
        onClick: async () => {
          await api.snippetDelete(s.id);
          onSnippetsChanged();
        },
      },
    ]);
  };

  const createGroup = async () => {
    const name = await prompt({ title: "新建分组", placeholder: "分组名称" });
    if (!name?.trim()) return;
    await api.groupAdd(name.trim());
    onGroupsChanged();
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const moveToGroup = useCallback(async (s: SessionProfile, group: string) => {
    await api.sessionSetGroup(s.id, group);
    onGroupsChanged();
  }, [onGroupsChanged]);

  const groupFromPoint = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    if (!(el instanceof HTMLElement)) return null;
    return el.closest<HTMLElement>("[data-group-name]")?.dataset.groupName ?? null;
  }, []);

  const startSessionDrag = (event: React.PointerEvent<HTMLDivElement>, session: SessionProfile, sourceGroup: string) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".session-ops")) return;
    setCurrentDragSession({
      sessionId: session.id,
      sessionName: session.name,
      sourceGroup,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    });
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const current = dragSessionRef.current;
      if (!current) return;
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      const active = current.active || distance >= DRAG_THRESHOLD;
      const overGroup = active ? groupFromPoint(event.clientX, event.clientY) : null;
      const next = { ...current, x: event.clientX, y: event.clientY, active };
      dragSessionRef.current = next;
      setDragSession(next);
      setDragOverGroup(overGroup);
    };

    const finishDrag = (event: PointerEvent) => {
      const current = dragSessionRef.current;
      if (!current) return;
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      const active = current.active || distance >= DRAG_THRESHOLD;
      const targetGroup = active ? groupFromPoint(event.clientX, event.clientY) : null;
      setCurrentDragSession(null);
      setDragOverGroup(null);
      if (!targetGroup || targetGroup === current.sourceGroup) return;
      const target = targetGroup === DEFAULT_GROUP ? "" : targetGroup;
      void moveToGroup({ id: current.sessionId } as SessionProfile, target);
    };

    const cancelDrag = () => {
      setCurrentDragSession(null);
      setDragOverGroup(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelDrag);
    };
  }, [groupFromPoint, moveToGroup, setCurrentDragSession]);

  const sessionMenu = (e: React.MouseEvent, s: SessionProfile) => {
    showMenu(e, [
      { label: "连接", onClick: () => onConnect(s) },
      { label: "打开 SFTP（双栏）", onClick: () => onSftp(s) },
      SEPARATOR,
      ...groups
        .filter((g) => g !== s.group)
        .map((g) => ({ label: `移动到: ${g}`, onClick: () => moveToGroup(s, g) })),
      {
        label: "移动到新分组...",
        onClick: async () => {
          const name = await prompt({ title: "移动到新分组", placeholder: "分组名称" });
          if (name?.trim()) await moveToGroup(s, name.trim());
        },
      },
      ...(s.group ? [{ label: "移出分组", onClick: () => moveToGroup(s, "") }] : []),
      SEPARATOR,
      { label: "编辑", onClick: () => onEdit(s) },
      { label: "删除", danger: true, onClick: () => onDelete(s) },
    ]);
  };

  const groupMenu = (e: React.MouseEvent, group: string) => {
    const collapseItem = {
      label: collapsedGroups.has(group) ? "展开分组" : "折叠分组",
      onClick: () => toggleGroup(group),
    };
    if (group === DEFAULT_GROUP) {
      showMenu(e, [collapseItem, SEPARATOR, { label: "新建分组", onClick: createGroup }]);
      return;
    }
    showMenu(e, [
      collapseItem,
      SEPARATOR,
      { label: "新建分组", onClick: createGroup },
      {
        label: "重命名分组",
        onClick: async () => {
          const name = await prompt({ title: "重命名分组", defaultValue: group });
          if (!name?.trim() || name === group) return;
          await api.groupRename(group, name.trim());
          onGroupsChanged();
        },
      },
      {
        label: "删除分组（会话移回未分组）",
        danger: true,
        onClick: async () => {
          const ok = await confirm({
            title: "删除分组",
            message: `确定删除分组「${group}」？其中会话将移回未分组。`,
            danger: true,
            okText: "删除",
          });
          if (!ok) return;
          await api.groupDelete(group);
          onGroupsChanged();
        },
      },
    ]);
  };

  const blankMenu = (e: React.MouseEvent) => {
    showMenu(e, [
      { label: "新建分组", onClick: createGroup },
      { label: "新建会话", onClick: onCreate },
      { label: "打开本地终端", onClick: onOpenLocal },
    ]);
  };

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.host.toLowerCase().includes(q) ||
            s.username.toLowerCase().includes(q)
        )
      : sessions;
    const map = new Map<string, SessionProfile[]>();
    // 空分组也显示，便于拖入会话
    if (!q) for (const g of groups) map.set(g, []);
    for (const s of filtered) {
      const g = s.group || DEFAULT_GROUP;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === DEFAULT_GROUP) return -1;
      if (b[0] === DEFAULT_GROUP) return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [sessions, groups, filter]);

  const isSessionOpen = (session: SessionProfile) => connectedSessionIds?.includes(session.id) ?? false;
  const sessionDotClass = (session: SessionProfile) => {
    if (isSessionOpen(session)) return " connected";
    const health = hostHealth[session.id];
    return health ? ` health-${health.status}` : "";
  };
  const sessionHealthTitle = (session: SessionProfile) => {
    if (isSessionOpen(session)) return "已打开";
    const health = hostHealth[session.id];
    if (!health) return "未检查";
    if (health.status === "checking") return "健康检查中";
    if (health.status === "online") return `在线${health.latencyMs === null ? "" : ` · ${health.latencyMs}ms`}`;
    return `离线 · ${health.message}`;
  };

  if (collapsed) {
    return (
      <aside className="sidebar collapsed" aria-label="主机列表已折叠">
        <button className="rail-btn" onClick={onToggleCollapsed} title="展开主机列表">
          <Icon name="chevronRight" size={16} />
        </button>
        <button className="rail-btn" onClick={onOpenCommandPalette} title="命令面板 Ctrl+P">
          <Icon name="command" size={16} />
        </button>
        <button className="rail-btn" onClick={onCreate} title="新建连接">
          <Icon name="plus" size={16} />
        </button>
        <button className="rail-btn" onClick={onOpenLocal} title="本地终端">
          <Icon name="local" size={16} />
        </button>
        <button className="rail-btn" onClick={onHealthCheck} title="检查主机健康" disabled={healthChecking}>
          <Icon name="activity" size={16} />
        </button>
        <div className="rail-spacer" />
        <button className="rail-btn" onClick={onOpenSettings} title="设置">
          <Icon name="settings" size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" style={{ width, minWidth: width }}>
      <div className="sidebar-topbar">
        <button className="icon-btn sidebar-health-btn" onClick={onHealthCheck} title="检查主机健康" disabled={healthChecking}>
          <Icon name="activity" size={14} />
        </button>
        <span className="sidebar-title">主机</span>
        <button className="icon-btn" onClick={onToggleCollapsed} title="折叠主机列表">
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <input
        className="input search sidebar-search"
        placeholder="搜索会话..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className={`session-list${dragSession?.active ? " dragging-groups" : ""}`} onContextMenu={blankMenu}>
        {grouped.length === 0 && (
          <div className="empty-hint">
            还没有保存的会话
            <br />
            点击「新建会话」添加 SSH 主机
          </div>
        )}
        {grouped.map(([group, items]) => {
          const isCollapsed = !filter.trim() && collapsedGroups.has(group);
          return (
            <div
              key={group}
              data-group-name={group}
              className={`group-block${dragOverGroup === group ? " group-drop-over" : ""}`}
            >
              <div
                className={`group-title${isCollapsed ? " collapsed" : ""}`}
                role="button"
                tabIndex={0}
                title="点击展开/折叠，右键管理分组"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleGroup(group);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleGroup(group);
                  }
                }}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  groupMenu(e, group);
                }}
              >
                <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={13} />
                <span className="group-name">{group}</span>
                <span className="group-count">{items.length}</span>
              </div>
              {!isCollapsed && items.map((s) => (
                <div
                  key={s.id}
                  className={`session-item${highlightedSessionId === s.id ? " highlight" : ""}${
                    dragSession?.active && dragSession.sessionId === s.id ? " dragging" : ""
                  }`}
                  onPointerDown={(e) => startSessionDrag(e, s, group)}
                  onDoubleClick={() => onConnect(s)}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    sessionMenu(e, s);
                  }}
                  title={`${s.username}@${s.host}:${s.port}（双击连接，按住拖到分组，右键更多）`}
                >
                <span
                  className={`session-dot${sessionDotClass(s)}`}
                  title={sessionHealthTitle(s)}
                />
                <div className="session-meta">
                  <div className="session-name">{s.name}</div>
                  <div className="session-host">
                    {s.username}@{s.host}
                  </div>
                </div>
                <div
                  className="session-ops"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <button className="icon-btn" onClick={() => onConnect(s)} title="连接">
                    <Icon name="connect" size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => onSftp(s)} title="SFTP 文件">
                    <Icon name="folderSync" size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => onEdit(s)} title="编辑">
                    <Icon name="edit" size={14} />
                  </button>
                  <button className="icon-btn danger" onClick={() => onDelete(s)} title="删除">
                    <Icon name="close" size={14} />
                  </button>
                </div>
                </div>
              ))}
            </div>
          );
        })}
        {dragSession?.active && (
          <div
            className="session-drag-ghost"
            style={{ transform: `translate(${dragSession.x + 12}px, ${dragSession.y + 12}px)` }}
          >
            {dragSession.sessionName}
          </div>
        )}
      </div>

      <div className={`snippets-section${snippetsOpen ? " open" : ""}`}>
        <div className="snippets-header">
          <button className="snippets-toggle" onClick={() => setSnippetsOpen((v) => !v)}>
            <Icon name={snippetsOpen ? "chevronDown" : "chevronRight"} size={13} />
            <span>命令片段</span>
            <span className="snippet-count">{snippets.length}</span>
          </button>
          <button className="icon-btn" title="新建命令片段" onClick={addSnippet}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {snippetsOpen && (
          <div className="snippets-list">
            {snippets.length === 0 && <span className="snippets-empty">点 + 添加常用命令</span>}
            {snippets.map((s) => (
              <button
                key={s.id}
                className="snippet-chip"
                disabled={!hasActiveTerminal}
                title={hasActiveTerminal ? `执行: ${s.command}` : "先打开一个终端"}
                onClick={() => onRunSnippet(s.command)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  snippetMenu(e, s);
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-footer-btn" onClick={onOpenSettings} title="设置">
          <Icon name="settings" size={15} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
