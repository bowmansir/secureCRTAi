import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import AiPanel from "./components/AiPanel";
import CommandPalette from "./components/CommandPalette";
import type { CommandPaletteItem } from "./components/CommandPalette";
import { ContextMenuProvider, SEPARATOR, useContextMenu } from "./components/ContextMenu";
import { DialogProvider, useDialogs } from "./components/Dialogs";
import { checkDangerous } from "./dangerous";
import Icon from "./components/Icons";
import Resizer from "./components/Resizer";
import SessionDialog from "./components/SessionDialog";
import SessionSidebar from "./components/SessionSidebar";
import SettingsDialog from "./components/SettingsDialog";
import SftpCliView from "./components/SftpCliView";
import SftpDualView from "./components/SftpDualView";
import ToolsDialog from "./components/ToolsDialog";
import StatusBar from "./components/StatusBar";
import TerminalView from "./components/TerminalView";
import TransferPanel from "./components/TransferPanel";
import type {
  HostHealthSummary,
  HostHealthView,
  SessionInput,
  SessionProfile,
  Snippet,
  TabInfo,
  TransferItem,
} from "./types";
import "./App.css";

const MAX_CONTEXT_CHARS = 8000;
const MAX_OPEN_TABS = 20;
type SplitDirection = "columns" | "rows";
type AppTheme = "dark" | "midnight" | "light";

interface SplitLayout {
  direction: SplitDirection;
  panes: TabInfo[];
}

export default function App() {
  return (
    <ContextMenuProvider>
      <DialogProvider>
        <AppInner />
      </DialogProvider>
    </ContextMenuProvider>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// UI 偏好持久化（面板尺寸、AI 显隐）——纯前端，存 localStorage
const loadPref = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(`termai.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const savePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(`termai.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
};

function AppInner() {
  const { showMenu } = useContextMenu();
  const { confirm } = useDialogs();

  // 可拖拽面板尺寸（持久化）
  const [sidebarWidth, setSidebarWidth] = useState(() => loadPref("sidebarWidth", 240));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadPref("sidebarCollapsed", false));
  const [aiWidth, setAiWidth] = useState(() => loadPref("aiWidth", 340));
  const [transferHeight, setTransferHeight] = useState(() => loadPref("transferHeight", 180));
  const [theme, setTheme] = useState<AppTheme>(() => loadPref<AppTheme>("theme", "dark"));
  const [sessions, setSessions] = useState<SessionProfile[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [splitLayouts, setSplitLayouts] = useState<Record<string, SplitLayout>>({});
  const [activePaneByTab, setActivePaneByTab] = useState<Record<string, string>>({});
  const [closeAgentRequest, setCloseAgentRequest] = useState<{ keys: string[]; nonce: number } | null>(null);
  const [terminalSizes, setTerminalSizes] = useState<Record<string, { cols: number; rows: number }>>({});
  const [dialog, setDialog] = useState<"none" | "session" | "settings" | "tools">("none");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionProfile | null>(null);
  const [highlightSessionId, setHighlightSessionId] = useState<string | null>(null);
  const [hostHealth, setHostHealth] = useState<Record<string, HostHealthView>>({});
  const [healthChecking, setHealthChecking] = useState(false);
  const [hasProvider, setHasProvider] = useState(false);
  const [aiVisible, setAiVisible] = useState(() => loadPref("aiVisible", true));
  const [aiRequest, setAiRequest] = useState<{ text: string; nonce: number } | null>(null);

  // 尺寸/显隐变化时持久化
  useEffect(() => savePref("sidebarWidth", sidebarWidth), [sidebarWidth]);
  useEffect(() => savePref("sidebarCollapsed", sidebarCollapsed), [sidebarCollapsed]);
  useEffect(() => savePref("aiWidth", aiWidth), [aiWidth]);
  useEffect(() => savePref("transferHeight", transferHeight), [transferHeight]);
  useEffect(() => savePref("theme", theme), [theme]);
  useEffect(() => savePref("aiVisible", aiVisible), [aiVisible]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const askAi = useCallback((text: string) => {
    setAiVisible(true);
    setAiRequest({ text, nonce: Date.now() });
  }, []);

  // 每个标签页的最近输出（AI 上下文）与后端终端 id
  const outputBuffers = useRef(new Map<string, string>());
  const termIds = useRef(new Map<string, string>());

  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const runtimeTabs = useMemo(
    () => tabs.flatMap((tab) => splitLayouts[tab.tabId]?.panes ?? [tab]),
    [splitLayouts, tabs]
  );
  const activeRuntimeTabId = activeTab ? activePaneByTab[activeTab] ?? activeTab : null;

  // 有打开中的终端/SFTP 的会话 id，用于侧栏亮绿点。
  // 连接事件偶尔会晚于终端首屏输出；这里按“存在未关闭标签”表示会话正在使用。
  const connectedSessionIds = useMemo(() => {
    const s = new Set<string>();
    runtimeTabs.forEach((t) => {
      if (t.sessionId && t.status !== "closed") s.add(t.sessionId);
    });
    return [...s];
  }, [runtimeTabs]);

  /** 发起一次传输并把事件流映射到传输面板条目 */
  const startTransfer = useCallback(
    (
      sftpId: string,
      kind: "upload" | "download",
      local: string,
      remote: string,
      title: string,
      onDone?: () => void
    ) => {
      const localId = crypto.randomUUID();
      setTransfers((prev) => [
        {
          id: localId,
          title,
          kind,
          status: "running",
          totalBytes: 0,
          transferred: 0,
          doneFiles: 0,
          rateBps: 0,
          currentFile: "",
        },
        ...prev,
      ]);
      const patch = (p: Partial<TransferItem>) =>
        setTransfers((prev) => prev.map((t) => (t.id === localId ? { ...t, ...p } : t)));

      api
        .transferStart(sftpId, kind, local, remote, (e) => {
          if (e.type === "started") patch({ totalBytes: e.totalBytes });
          else if (e.type === "file") patch({ currentFile: e.name });
          else if (e.type === "progress") patch({ transferred: e.transferred, rateBps: e.rateBps });
          else if (e.type === "done") {
            patch({ status: "done", transferred: e.transferred, doneFiles: e.files, rateBps: 0 });
            onDone?.();
          }
          else if (e.type === "cancelled") patch({ status: "cancelled", rateBps: 0 });
          else if (e.type === "error") patch({ status: "error", message: e.message, rateBps: 0 });
        })
        .then((backendId) => patch({ backendId }))
        .catch((err) => patch({ status: "error", message: String(err) }));
    },
    []
  );

  // 服务器间传输 A→B，事件流映射到传输面板
  const startRemoteTransfer = useCallback(
    (
      srcSftpId: string,
      srcPath: string,
      dstSessionId: string,
      dstPath: string,
      title: string,
      onDone?: () => void
    ) => {
      const localId = crypto.randomUUID();
      setTransfers((prev) => [
        {
          id: localId,
          title,
          kind: "upload",
          status: "running",
          totalBytes: 0,
          transferred: 0,
          doneFiles: 0,
          rateBps: 0,
          currentFile: "",
        },
        ...prev,
      ]);
      const patch = (p: Partial<TransferItem>) =>
        setTransfers((prev) => prev.map((t) => (t.id === localId ? { ...t, ...p } : t)));
      api
        .transferRemote(srcSftpId, srcPath, dstSessionId, dstPath, (e) => {
          if (e.type === "started") patch({ totalBytes: e.totalBytes });
          else if (e.type === "file") patch({ currentFile: e.name });
          else if (e.type === "progress") patch({ transferred: e.transferred, rateBps: e.rateBps });
          else if (e.type === "done") {
            patch({ status: "done", transferred: e.transferred, doneFiles: e.files, rateBps: 0 });
            onDone?.();
          }
          else if (e.type === "cancelled") patch({ status: "cancelled", rateBps: 0 });
          else if (e.type === "error") patch({ status: "error", message: e.message, rateBps: 0 });
        })
        .then((backendId) => patch({ backendId }))
        .catch((err) => patch({ status: "error", message: String(err) }));
    },
    []
  );

  const reloadSessions = useCallback(async () => {
    setSessions(await api.sessionsList());
    setGroups(await api.groupsList());
    setSnippets(await api.snippetsList());
  }, []);

  const runHealthCheck = useCallback(
    async (sessionIds?: string[]) => {
      const targets = (sessionIds?.length ? sessionIds : sessions.map((s) => s.id)).filter(Boolean);
      if (targets.length === 0 || healthChecking) return;
      const sessionMap = new Map(sessions.map((s) => [s.id, s]));
      const startedAt = Date.now();
      setHealthChecking(true);
      setHostHealth((prev) => {
        const next = { ...prev };
        targets.forEach((id) => {
          const session = sessionMap.get(id);
          if (!session) return;
          next[id] = {
            sessionId: id,
            host: session.host,
            port: session.port,
            status: "checking",
            latencyMs: null,
            message: "checking",
            checkedAt: startedAt,
          };
        });
        return next;
      });

      try {
        const results = await api.healthCheckSessions(targets, 2500);
        const checkedAt = Date.now();
        setHostHealth((prev) => {
          const next = { ...prev };
          results.forEach((result) => {
            next[result.sessionId] = {
              sessionId: result.sessionId,
              host: result.host,
              port: result.port,
              status: result.ok ? "online" : "offline",
              latencyMs: result.latencyMs,
              message: result.message,
              checkedAt,
            };
          });
          return next;
        });
      } catch (e) {
        const checkedAt = Date.now();
        const message = String(e);
        setHostHealth((prev) => {
          const next = { ...prev };
          targets.forEach((id) => {
            const session = sessionMap.get(id);
            if (!session) return;
            next[id] = {
              sessionId: id,
              host: session.host,
              port: session.port,
              status: "offline",
              latencyMs: null,
              message,
              checkedAt,
            };
          });
          return next;
        });
        void confirm({ title: "健康检查失败", message, okText: "知道了" });
      } finally {
        setHealthChecking(false);
      }
    },
    [confirm, healthChecking, sessions]
  );

  // 会话广播：一条命令发到所有打开的终端
  const broadcast = useCallback(
    async (cmd: string) => {
      const targets = runtimeTabs.filter((t) => t.kind === "local" || t.kind === "ssh");
      if (targets.length === 0 || !cmd.trim()) return;
      const verdict = checkDangerous(cmd);
      if (verdict.danger) {
        const ok = await confirm({
          title: "⚠ 广播危险命令",
          message: `即将向 ${targets.length} 个终端广播：\n\n${cmd}\n\n风险：${verdict.reason}\n\n确认广播执行吗？`,
          danger: true,
          okText: "广播执行",
        });
        if (!ok) return;
      }
      for (const t of targets) {
        const termId = termIds.current.get(t.tabId);
        if (termId) api.termWrite(termId, cmd + "\r").catch(() => {});
      }
      setBroadcastText("");
    },
    [confirm, runtimeTabs]
  );

  const sendSnippet = useCallback(
    async (cmd: string) => {
      if (!activeRuntimeTabId) return;
      const termId = termIds.current.get(activeRuntimeTabId);
      if (!termId) return;
      const verdict = checkDangerous(cmd);
      if (verdict.danger) {
        const ok = await confirm({
          title: "⚠ 危险命令确认",
          message: `即将执行命令片段：\n\n${cmd}\n\n风险：${verdict.reason}\n\n确认执行吗？`,
          danger: true,
          okText: "仍然执行",
        });
        if (!ok) return;
      }
      // 片段一键执行：命令 + 回车
      api.termWrite(termId, cmd + "\r").catch(() => {});
    },
    [activeRuntimeTabId, confirm]
  );

  const reloadAiConfig = useCallback(async () => {
    const cfg = await api.aiGetConfig();
    setHasProvider(cfg.providers.length > 0 && cfg.activeProvider != null);
  }, []);

  useEffect(() => {
    reloadSessions();
    reloadAiConfig();
  }, [reloadSessions, reloadAiConfig]);

  const requestCloseAgentKeys = (keys: Iterable<string>) => {
    const uniqueKeys = [...new Set(keys)].filter(Boolean);
    if (uniqueKeys.length > 0) {
      setCloseAgentRequest({ keys: uniqueKeys, nonce: Date.now() + Math.random() });
    }
  };

  const addTab = (tab: TabInfo) => {
    if (tabs.length >= MAX_OPEN_TABS) {
      void confirm({
        title: "标签过多",
        message: `最多同时打开 ${MAX_OPEN_TABS} 个标签，请先关闭一些不使用的标签。`,
        okText: "知道了",
      });
      return;
    }
    setTabs((prev) => [...prev, tab]);
    setActiveTab(tab.tabId);
  };

  const openLocal = () => {
    addTab({
      tabId: crypto.randomUUID(),
      title: "本地终端",
      kind: "local",
      status: "connecting",
    });
  };

  const connectSession = (s: SessionProfile) => {
    addTab({
      tabId: crypto.randomUUID(),
      title: s.name,
      kind: "ssh",
      sessionId: s.id,
      status: "connecting",
    });
  };

  const openSftp = (s: SessionProfile) => {
    addTab({
      tabId: crypto.randomUUID(),
      title: `SFTP: ${s.name}`,
      kind: "sftp",
      sessionId: s.id,
      status: "connecting",
    });
  };

  const openSftpCli = (s: SessionProfile) => {
    addTab({
      tabId: crypto.randomUUID(),
      title: `sftp> ${s.name}`,
      kind: "sftp-cli",
      sessionId: s.id,
      status: "connecting",
    });
  };

  /** 克隆会话：以相同配置再开一条独立连接 */
  const cloneTab = (t: TabInfo) => {
    addTab({
      tabId: crypto.randomUUID(),
      title: t.title,
      kind: t.kind,
      sessionId: t.sessionId,
      status: "connecting",
    });
  };

  const closeTabs = (ids: string[]) => {
    const idSet = new Set(ids);
    const cleanupIds = new Set(ids);
    for (const id of ids) {
      splitLayouts[id]?.panes.forEach((pane) => cleanupIds.add(pane.tabId));
    }
    setTabs((prev) => {
      const next = prev.filter((t) => !idSet.has(t.tabId));
      setActiveTab((cur) =>
        cur && idSet.has(cur) ? next[next.length - 1]?.tabId ?? null : cur
      );
      return next;
    });
    for (const id of cleanupIds) {
      outputBuffers.current.delete(id);
      termIds.current.delete(id);
    }
    requestCloseAgentKeys(cleanupIds);
    setTerminalSizes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of cleanupIds) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setSplitLayouts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setActivePaneByTab((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  const closeTab = (tabId: string) => closeTabs([tabId]);

  const tabMenu = (e: React.MouseEvent, t: TabInfo) => {
    const idx = tabs.findIndex((x) => x.tabId === t.tabId);
    showMenu(e, [
      { label: "克隆会话", onClick: () => cloneTab(t) },
      ...(t.kind === "ssh" && t.sessionId
        ? [
            {
              label: "打开 SFTP（双栏）",
              onClick: () => {
                const s = sessions.find((x) => x.id === t.sessionId);
                if (s) openSftp(s);
              },
            },
            {
              label: "打开 SFTP 命令行",
              onClick: () => {
                const s = sessions.find((x) => x.id === t.sessionId);
                if (s) openSftpCli(s);
              },
            },
          ]
        : []),
      ...(t.kind === "local" || t.kind === "ssh"
        ? [
            {
              label: "左右分屏",
              onClick: () => {
                splitTerminalTab(t, "columns");
              },
            },
            {
              label: "上下分屏",
              onClick: () => {
                splitTerminalTab(t, "rows");
              },
            },
            ...(splitLayouts[t.tabId]
              ? [
                  {
                    label: "关闭分屏",
                    onClick: () => {
                      closeSplitTab(t.tabId);
                    },
                  },
                ]
              : []),
          ]
        : []),
      SEPARATOR,
      { label: "关闭", onClick: () => closeTab(t.tabId) },
      {
        label: "关闭其他标签页",
        disabled: tabs.length <= 1,
        onClick: () => closeTabs(tabs.filter((x) => x.tabId !== t.tabId).map((x) => x.tabId)),
      },
      {
        label: "关闭右侧标签页",
        disabled: idx === tabs.length - 1,
        onClick: () => closeTabs(tabs.slice(idx + 1).map((x) => x.tabId)),
      },
    ]);
  };

  const onStatus = useCallback((tabId: string, status: TabInfo["status"]) => {
    setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, status } : t)));
    setSplitLayouts((prev) => {
      let changed = false;
      const next: Record<string, SplitLayout> = {};
      for (const [parentId, layout] of Object.entries(prev)) {
        const panes = layout.panes.map((pane) => {
          if (pane.tabId !== tabId) return pane;
          changed = true;
          return { ...pane, status };
        });
        next[parentId] = changed ? { ...layout, panes } : layout;
      }
      return changed ? next : prev;
    });
  }, []);

  const onOutput = useCallback((tabId: string, text: string) => {
    const cur = outputBuffers.current.get(tabId) ?? "";
    outputBuffers.current.set(tabId, (cur + text).slice(-MAX_CONTEXT_CHARS));
  }, []);

  const registerTermId = useCallback((tabId: string, termId: string) => {
    termIds.current.set(tabId, termId);
  }, []);

  const onTerminalSize = useCallback((tabId: string, cols: number, rows: number) => {
    setTerminalSizes((prev) => {
      const cur = prev[tabId];
      if (cur?.cols === cols && cur.rows === rows) return prev;
      return { ...prev, [tabId]: { cols, rows } };
    });
  }, []);

  const getRecentOutput = useCallback(() => {
    if (!activeRuntimeTabId) return "";
    return outputBuffers.current.get(activeRuntimeTabId) ?? "";
  }, [activeRuntimeTabId]);

  // 每标签服务器环境信息（AI 常驻上下文），SSH 连上后台采集一次
  const envs = useRef(new Map<string, string>());
  const envProbing = useRef(new Set<string>());
  useEffect(() => {
    runtimeTabs.forEach((t) => {
      if (
        t.kind === "ssh" &&
        t.status === "connected" &&
        t.sessionId &&
        !envs.current.has(t.tabId) &&
        !envProbing.current.has(t.tabId)
      ) {
        envProbing.current.add(t.tabId);
        api
          .sshProbeEnv(t.sessionId)
          .then((env) => {
            if (env) envs.current.set(t.tabId, env);
          })
          .catch(() => {})
          .finally(() => envProbing.current.delete(t.tabId));
      }
    });
  }, [runtimeTabs]);

  const getEnv = useCallback(() => {
    if (!activeRuntimeTabId) return "";
    return envs.current.get(activeRuntimeTabId) ?? "";
  }, [activeRuntimeTabId]);

  const insertCommand = useCallback(
    async (cmd: string) => {
      if (!activeRuntimeTabId) return;
      const termId = termIds.current.get(activeRuntimeTabId);
      if (!termId) return;
      // 危险命令插入前二次确认
      const verdict = checkDangerous(cmd);
      if (verdict.danger) {
        const ok = await confirm({
          title: "⚠ 危险命令确认",
          message: `即将插入可能有破坏性的命令：\n\n${cmd}\n\n风险：${verdict.reason}\n\n确认要插入到终端吗？（插入后仍需你自己按回车执行）`,
          danger: true,
          okText: "仍然插入",
        });
        if (!ok) return;
      }
      api.termWrite(termId, cmd).catch(() => {});
    },
    [activeRuntimeTabId, confirm]
  );

  const saveSession = async (input: SessionInput): Promise<SessionProfile> => {
    const saved = await api.sessionSave(input);
    await reloadSessions();
    setHighlightSessionId(saved.id);
    window.setTimeout(() => setHighlightSessionId((cur) => (cur === saved.id ? null : cur)), 2400);
    return saved;
  };

  const deleteSession = async (s: SessionProfile) => {
    if (!(await confirm({ title: "删除会话", message: `确定删除会话「${s.name}」？`, danger: true, okText: "删除" })))
      return;
    await api.sessionDelete(s.id);
    await reloadSessions();
  };

  const activeTabInfo = tabs.find((t) => t.tabId === activeTab) ?? null;
  const activeRuntimeTabInfo =
    activeRuntimeTabId ? runtimeTabs.find((t) => t.tabId === activeRuntimeTabId) ?? activeTabInfo : activeTabInfo;
  const aiSuppressedBySftp = activeRuntimeTabInfo?.kind === "sftp" || activeRuntimeTabInfo?.kind === "sftp-cli";
  const aiPanelVisible = aiVisible && !aiSuppressedBySftp;

  useEffect(() => {
    if (!aiSuppressedBySftp) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest(".ai-panel")) {
      activeElement.blur();
    }
  }, [aiSuppressedBySftp]);

  const terminalCount = runtimeTabs.filter((t) => t.kind === "local" || t.kind === "ssh").length;
  const transferActive = transfers.filter((t) => t.status === "running").length;
  const transferRateBps = transfers
    .filter((t) => t.status === "running")
    .reduce((sum, t) => sum + t.rateBps, 0);
  const activeTermSize = activeRuntimeTabId ? terminalSizes[activeRuntimeTabId] ?? null : null;
  const healthSummary = useMemo<HostHealthSummary>(() => {
    const sessionIds = new Set(sessions.map((s) => s.id));
    let checked = 0;
    let online = 0;
    let offline = 0;
    let checking = healthChecking;
    let checkedAt: number | null = null;
    Object.values(hostHealth).forEach((health) => {
      if (!sessionIds.has(health.sessionId)) return;
      if (health.status === "checking") {
        checking = true;
        return;
      }
      checked += 1;
      if (health.status === "online") online += 1;
      if (health.status === "offline") offline += 1;
      checkedAt = Math.max(checkedAt ?? 0, health.checkedAt);
    });
    return {
      total: sessions.length,
      checked,
      online,
      offline,
      checking,
      checkedAt,
    };
  }, [healthChecking, hostHealth, sessions]);

  const activatePane = (parentTabId: string, paneTabId: string) => {
    setActiveTab(parentTabId);
    setActivePaneByTab((prev) => ({ ...prev, [parentTabId]: paneTabId }));
  };

  const splitTerminalTab = (parentTab: TabInfo, direction: SplitDirection) => {
    if (parentTab.kind !== "local" && parentTab.kind !== "ssh") return;
    const currentLayout = splitLayouts[parentTab.tabId];
    const panes = currentLayout?.panes ?? [parentTab];
    const activePaneId = activePaneByTab[parentTab.tabId] ?? parentTab.tabId;
    const activePane = panes.find((pane) => pane.tabId === activePaneId);
    const source = activePane && (activePane.kind === "local" || activePane.kind === "ssh") ? activePane : parentTab;
    const newPane: TabInfo = {
      ...source,
      tabId: crypto.randomUUID(),
      title: `${source.title} #${panes.length + 1}`,
      status: "connecting",
    };
    setSplitLayouts((prev) => ({
      ...prev,
      [parentTab.tabId]: {
        direction,
        panes: [...panes, newPane],
      },
    }));
    activatePane(parentTab.tabId, newPane.tabId);
  };

  const closeSplitTab = (parentTabId: string) => {
    const layout = splitLayouts[parentTabId];
    if (!layout) return;
    const cleanupIds = layout.panes.slice(1).map((pane) => pane.tabId);
    setSplitLayouts((prev) => {
      const next = { ...prev };
      delete next[parentTabId];
      return next;
    });
    setActivePaneByTab((prev) => {
      const next = { ...prev };
      delete next[parentTabId];
      return next;
    });
    for (const id of cleanupIds) {
      outputBuffers.current.delete(id);
      termIds.current.delete(id);
    }
    requestCloseAgentKeys(cleanupIds);
    setTerminalSizes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of cleanupIds) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  const commandItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: "new-session",
        title: "新建 SSH 会话",
        section: "基础",
        subtitle: "保存一个新的服务器连接配置",
        icon: "plus",
        keywords: ["ssh", "server", "connect"],
        onRun: () => {
          setEditingSession(null);
          setDialog("session");
        },
      },
      {
        id: "open-local",
        title: "打开本地终端",
        section: "基础",
        subtitle: "新建一个本机 Shell 标签",
        icon: "local",
        keywords: ["terminal", "shell", "powershell"],
        onRun: openLocal,
      },
      {
        id: "check-host-health",
        title: healthChecking ? "主机健康检查中" : "检查所有主机健康",
        section: "基础",
        subtitle: "TCP 连通性和端口延迟，不执行登录",
        icon: "activity",
        keywords: ["health", "check", "ping", "latency", "server"],
        disabled: sessions.length === 0 || healthChecking,
        onRun: () => runHealthCheck(),
      },
      {
        id: "toggle-ai",
        title: aiSuppressedBySftp ? "AI 面板已因 SFTP 自动折叠" : aiVisible ? "隐藏 AI 面板" : "打开 AI 面板",
        section: "视图",
        subtitle: aiSuppressedBySftp
          ? "切回 SSH 或本地终端标签后恢复"
          : hasProvider
            ? "切换右侧 AI 助手"
            : "尚未配置 Provider，可先进入设置",
        icon: "ai",
        keywords: ["agent", "assistant", "provider"],
        disabled: aiSuppressedBySftp,
        onRun: () => setAiVisible((v) => !v),
      },
      {
        id: "settings",
        title: "打开设置",
        section: "视图",
        subtitle: "AI Provider、配置导入导出",
        icon: "settings",
        keywords: ["ai", "provider", "config"],
        onRun: () => setDialog("settings"),
      },
      {
        id: "tools",
        title: "运维工具",
        section: "视图",
        subtitle: "端口转发（-L）、SSH 密钥生成与部署",
        icon: "tools",
        keywords: ["forward", "tunnel", "port", "key", "keygen", "deploy", "转发", "密钥"],
        onRun: () => setDialog("tools"),
      },
      {
        id: "new-window",
        title: "打开新窗口",
        section: "视图",
        subtitle: "创建一个新的 TermAI 桌面窗口",
        icon: "window",
        keywords: ["window"],
        onRun: () => api.openNewWindow(),
      },
      {
        id: "toggle-broadcast",
        title: broadcastOpen ? "关闭广播输入栏" : "打开广播输入栏",
        section: "终端",
        subtitle: "向当前已打开的终端批量发送命令",
        icon: "broadcast",
        keywords: ["broadcast", "multi"],
        onRun: () => setBroadcastOpen((v) => !v),
      },
    ];

    if (activeTabInfo) {
      items.push(
        {
          id: `clone-tab-${activeTabInfo.tabId}`,
          title: "克隆当前标签",
          section: "标签",
          subtitle: activeTabInfo.title,
          icon: "clone",
          keywords: ["tab", "duplicate"],
          onRun: () => cloneTab(activeTabInfo),
        },
        {
          id: `close-tab-${activeTabInfo.tabId}`,
          title: "关闭当前标签",
          section: "标签",
          subtitle: activeTabInfo.title,
          icon: "close",
          keywords: ["tab"],
          onRun: () => closeTab(activeTabInfo.tabId),
        }
      );
    }

    sessions.forEach((session) => {
      const subtitle = `${session.username}@${session.host}:${session.port}`;
      items.push(
        {
          id: `connect-${session.id}`,
          title: `连接 ${session.name}`,
          section: "会话",
          subtitle,
          icon: "connect",
          keywords: ["ssh", session.host, session.group],
          onRun: () => connectSession(session),
        }
      );
    });

    snippets.forEach((snippet) => {
      items.push({
        id: `snippet-${snippet.id}`,
        title: `执行命令片段：${snippet.name}`,
        section: "命令片段",
        subtitle: snippet.command,
        icon: "command",
        keywords: ["snippet", "command"],
        disabled: !activeTab,
        onRun: () => sendSnippet(snippet.command),
      });
    });

    return items;
  }, [
    activeTab,
    activeTabInfo,
    aiSuppressedBySftp,
    aiVisible,
    broadcastOpen,
    healthChecking,
    hasProvider,
    runHealthCheck,
    sessions,
    snippets,
  ]);

  return (
    <div className="app-shell" data-theme={theme}>
      <div className="app-toolbar">
        <div className="toolbar-group">
          <button className="toolbar-btn command-trigger" onClick={() => setPaletteOpen(true)} title="命令面板 Ctrl+P">
            <Icon name="command" />
            命令
          </button>
          <button
            className="toolbar-btn primary"
            onClick={() => {
              setEditingSession(null);
              setDialog("session");
            }}
            title="新建 SSH 会话"
          >
            <Icon name="plus" />
            新建连接
          </button>
          <button className="toolbar-btn" onClick={openLocal} title="打开本地终端">
            <Icon name="local" />
            本地
          </button>
          <button
            className={`toolbar-btn${broadcastOpen ? " active" : ""}`}
            onClick={() => setBroadcastOpen((v) => !v)}
            title="向所有打开的终端广播同一条命令"
          >
            <Icon name="broadcast" />
            广播
          </button>
          <button className="toolbar-btn" onClick={() => api.openNewWindow()} title="打开新窗口">
            <Icon name="window" />
            新窗口
          </button>
          <button className="toolbar-btn" onClick={() => setDialog("tools")} title="端口转发 / 密钥部署">
            <Icon name="tools" />
            工具
          </button>
        </div>
        <div className="toolbar-spacer" />
        <div className="toolbar-group ai-toolbar-group">
          <button
            className={`toolbar-btn${aiPanelVisible ? " active" : ""}`}
            onClick={() => setAiVisible((v) => !v)}
            disabled={aiSuppressedBySftp}
            title={aiSuppressedBySftp ? "SFTP 页面自动折叠 AI，切回终端后恢复" : "切换 AI 面板"}
          >
            <Icon name="ai" />
            AI
          </button>
        </div>
      </div>
      <div className="app">
      <SessionSidebar
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        sessions={sessions}
        groups={groups}
        snippets={snippets}
        highlightedSessionId={highlightSessionId}
        connectedSessionIds={connectedSessionIds}
        hostHealth={hostHealth}
        healthChecking={healthChecking}
        hasActiveTerminal={!!activeTab}
        onConnect={connectSession}
        onSftp={openSftp}
        onGroupsChanged={reloadSessions}
        onRunSnippet={sendSnippet}
        onSnippetsChanged={async () => setSnippets(await api.snippetsList())}
        onEdit={(s) => {
          setEditingSession(s);
          setDialog("session");
        }}
        onDelete={deleteSession}
        onCreate={() => {
          setEditingSession(null);
          setDialog("session");
        }}
        onOpenLocal={openLocal}
        onOpenSettings={() => setDialog("settings")}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onHealthCheck={() => runHealthCheck()}
      />
      {!sidebarCollapsed && (
        <Resizer direction="col" onMove={(d) => setSidebarWidth((w) => clamp(w + d, 160, 480))} />
      )}

      <main className="main">
        {tabs.length > 0 && (
          <div className="tabbar">
            <div className="tabs">
              {tabs.map((t) => (
                <div
                  key={t.tabId}
                  className={`tab ${t.tabId === activeTab ? "active" : ""}`}
                  onClick={() => setActiveTab(t.tabId)}
                  onContextMenu={(e) => tabMenu(e, t)}
                >
                  <span className={`status-dot ${t.status}`} />
                  <span className="tab-title">{t.title}</span>
                  <button
                    className="icon-btn"
                  title="克隆会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      cloneTab(t);
                    }}
                  >
                    <Icon name="clone" size={14} />
                  </button>
                  <button
                    className="icon-btn"
                  title="关闭"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.tabId);
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="workspace">
          <div className="terminals">
            {tabs.length === 0 && (
              <div className="welcome">
                <h2>TermAI</h2>
                <p>AI 原生的现代化远程终端</p>
                <div className="welcome-actions">
                  <button className="btn primary" onClick={openLocal}>
                    打开本地终端
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setEditingSession(null);
                      setDialog("session");
                    }}
                  >
                    新建 SSH 会话
                  </button>
                </div>
              </div>
            )}
            {tabs.map((t) =>
              t.kind === "sftp" ? (
                <SftpDualView
                  key={t.tabId}
                  tab={t}
                  active={t.tabId === activeTab}
                  onStatus={onStatus}
                  startTransfer={startTransfer}
                  sessions={sessions}
                  startRemoteTransfer={startRemoteTransfer}
                />
              ) : t.kind === "sftp-cli" ? (
                <SftpCliView
                  key={t.tabId}
                  tab={t}
                  active={t.tabId === activeTab}
                  theme={theme}
                  onStatus={onStatus}
                  startTransfer={startTransfer}
                />
              ) : (
                <div
                  key={t.tabId}
                  className={`split-group ${splitLayouts[t.tabId]?.direction ?? "columns"}`}
                  style={{ display: t.tabId === activeTab ? "flex" : "none" }}
                >
                  {(splitLayouts[t.tabId]?.panes ?? [t]).map((pane) => {
                    const activePaneId = activePaneByTab[t.tabId] ?? t.tabId;
                    const paneActive = t.tabId === activeTab && pane.tabId === activePaneId;
                    return (
                      <div
                        key={pane.tabId}
                        className={`split-pane${paneActive ? " active" : ""}`}
                        onMouseDown={() => activatePane(t.tabId, pane.tabId)}
                      >
                        {(splitLayouts[t.tabId]?.panes.length ?? 1) > 1 && (
                          <div className="split-pane-label">
                            <span className={`status-dot ${pane.status}`} />
                            <span>{pane.title}</span>
                          </div>
                        )}
                        <TerminalView
                          tab={pane}
                          visible={t.tabId === activeTab}
                          active={paneActive}
                          theme={theme}
                          onStatus={onStatus}
                          onOutput={onOutput}
                          registerTermId={registerTermId}
                          onSize={onTerminalSize}
                          onAskAi={askAi}
                          onOpenSftp={
                            pane.kind === "ssh" && pane.sessionId
                              ? () => {
                                  const s = sessions.find((x) => x.id === pane.sessionId);
                                  if (s) openSftp(s);
                                }
                              : undefined
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              )
            )}
            {broadcastOpen && (
              <div className="broadcast-bar">
                <span className="broadcast-label" title="发送到所有打开的终端">
                  广播 → {terminalCount} 个终端
                </span>
                <input
                  className="input"
                  placeholder="输入命令，回车广播到所有终端"
                  value={broadcastText}
                  onChange={(e) => setBroadcastText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") broadcast(broadcastText);
                    if (e.key === "Escape") setBroadcastOpen(false);
                  }}
                />
                <button
                  className="btn primary"
                  onClick={() => broadcast(broadcastText)}
                  disabled={!broadcastText.trim()}
                >
                  广播
                </button>
                <button className="icon-btn" title="关闭" onClick={() => setBroadcastOpen(false)}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
          </div>
          {aiPanelVisible && (
            <Resizer direction="col" onMove={(d) => setAiWidth((w) => clamp(w - d, 260, 720))} />
          )}
          {aiVisible && (
            <div
              className={`ai-panel-shell${aiPanelVisible ? "" : " suppressed"}`}
              style={{
                width: aiPanelVisible ? aiWidth : 0,
                minWidth: aiPanelVisible ? aiWidth : 0,
              }}
              aria-hidden={!aiPanelVisible}
            >
              <AiPanel
                width={aiWidth}
                hasProvider={hasProvider}
                conversationKey={activeRuntimeTabId ?? activeTab ?? "global"}
                activeSessionId={
                  activeRuntimeTabInfo?.kind === "ssh" ? activeRuntimeTabInfo.sessionId : undefined
                }
                getRecentOutput={getRecentOutput}
                getEnv={getEnv}
                insertCommand={insertCommand}
                openSettings={() => setDialog("settings")}
                externalRequest={aiRequest}
                closeAgentRequest={closeAgentRequest}
              />
            </div>
          )}
        </div>
        {transfers.length > 0 && (
          <Resizer direction="row" onMove={(d) => setTransferHeight((h) => clamp(h - d, 80, 480))} />
        )}
        <TransferPanel
          height={transferHeight}
          items={transfers}
          onClear={() => setTransfers((prev) => prev.filter((t) => t.status === "running"))}
        />
      </main>
      </div>
      <StatusBar
        activeTab={activeTabInfo}
        sessions={sessions}
        terminalCount={terminalCount}
        transferActive={transferActive}
        transferRateBps={transferRateBps}
        termSize={activeTermSize}
        healthSummary={healthSummary}
      />

      <CommandPalette
        open={paletteOpen}
        items={commandItems}
        onClose={() => setPaletteOpen(false)}
      />

      {dialog === "session" && (
        <SessionDialog
          editing={editingSession}
          groups={groups}
          onSave={saveSession}
          onClose={() => setDialog("none")}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setDialog("none")}
          onChanged={reloadAiConfig}
          onImported={reloadSessions}
        />
      )}
      {dialog === "tools" && (
        <ToolsDialog
          sessions={sessions}
          activeSessionId={activeRuntimeTabInfo?.sessionId ?? activeTabInfo?.sessionId}
          onClose={() => setDialog("none")}
        />
      )}
    </div>
  );
}
