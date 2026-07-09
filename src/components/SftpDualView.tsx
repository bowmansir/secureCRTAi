import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as api from "../api";
import { SEPARATOR, useContextMenu } from "./ContextMenu";
import { useDialogs } from "./Dialogs";
import Resizer from "./Resizer";
import SftpFileTable from "./SftpFileTable";
import type { FileEntry, SessionProfile, TabInfo } from "../types";

type LeftMode = "local" | "server";
type RemoteSide = "source" | "target";
type RowSide = "local" | RemoteSide;

interface Props {
  tab: TabInfo;
  active: boolean;
  onStatus: (tabId: string, status: TabInfo["status"]) => void;
  startTransfer: (
    sftpId: string,
    kind: "upload" | "download",
    local: string,
    remote: string,
    title: string,
    onDone?: () => void
  ) => void;
  sessions: SessionProfile[];
  startRemoteTransfer: (
    srcSftpId: string,
    srcPath: string,
    dstSessionId: string,
    dstPath: string,
    title: string,
    onDone?: () => void
  ) => void;
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function joinLocal(dir: string, name: string): string {
  return dir.endsWith("\\") || dir.endsWith("/") ? dir + name : `${dir}\\${name}`;
}

function parentRemote(p: string): string {
  return p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
}

function parentLocal(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  if (idx <= 2) return cleaned.slice(0, 3);
  return cleaned.slice(0, idx);
}

function matchSession(s: SessionProfile, q: string): boolean {
  const text = `${s.name} ${s.username}@${s.host}:${s.port} ${s.group}`.toLowerCase();
  return text.includes(q.trim().toLowerCase());
}

export default function SftpDualView({
  tab,
  active,
  onStatus,
  startTransfer,
  sessions,
  startRemoteTransfer,
}: Props) {
  const { showMenu } = useContextMenu();
  const { prompt, confirm } = useDialogs();
  const [leftPct, setLeftPct] = useState(50);
  const dualRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  const [leftMode, setLeftMode] = useState<LeftMode>("local");
  const [targetFilter, setTargetFilter] = useState("");
  const [targetSessionId, setTargetSessionId] = useState("");

  const [sourceSftpId, setSourceSftpId] = useState<string | null>(null);
  const sourceSftpRef = useRef<string | null>(null);
  const [sourceHome, setSourceHome] = useState("/");
  const [sourceCwd, setSourceCwd] = useState("/");
  const [sourceEntries, setSourceEntries] = useState<FileEntry[]>([]);
  const [selectedSourceName, setSelectedSourceName] = useState<string | null>(null);

  const [targetSftpId, setTargetSftpId] = useState<string | null>(null);
  const targetSftpRef = useRef<string | null>(null);
  const [targetHome, setTargetHome] = useState("/");
  const [targetCwd, setTargetCwd] = useState("/");
  const [targetEntries, setTargetEntries] = useState<FileEntry[]>([]);
  const [selectedTargetName, setSelectedTargetName] = useState<string | null>(null);
  const [targetOpening, setTargetOpening] = useState(false);

  const [localCwd, setLocalCwd] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);

  const sourceSession = useMemo(
    () => sessions.find((s) => s.id === tab.sessionId) ?? null,
    [sessions, tab.sessionId]
  );
  const targetSessions = useMemo(
    () => sessions.filter((s) => s.id !== tab.sessionId),
    [sessions, tab.sessionId]
  );
  const filteredTargetSessions = useMemo(() => {
    const q = targetFilter.trim();
    return q ? targetSessions.filter((s) => matchSession(s, q)) : targetSessions;
  }, [targetFilter, targetSessions]);
  const targetSession = targetSessions.find((s) => s.id === targetSessionId) ?? null;
  const sourceName = sourceSession?.name ?? tab.title.replace(/^SFTP:\s*/, "");

  const refreshSource = useCallback(async (id: string, path: string) => {
    try {
      setSourceEntries(await api.sftpList(id, path));
      setSourceCwd(path);
      setSelectedSourceName(null);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshTarget = useCallback(async (id: string, path: string) => {
    try {
      setTargetEntries(await api.sftpList(id, path));
      setTargetCwd(path);
      setSelectedTargetName(null);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshLocal = useCallback(async (path: string) => {
    try {
      setLocalEntries(await api.localList(path));
      setLocalCwd(path);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    api.localHome().then((home) => refreshLocal(home));
    api.localDrives().then(setDrives).catch(() => {});
  }, [refreshLocal]);

  useEffect(() => {
    let cancelled = false;
    let openedId: string | null = null;
    api
      .sftpOpen(tab.sessionId!)
      .then(async ({ id, home }) => {
        if (cancelled) {
          api.sftpClose(id).catch(() => {});
          return;
        }
        openedId = id;
        sourceSftpRef.current = id;
        setSourceSftpId(id);
        setSourceHome(home);
        onStatus(tab.tabId, "connected");
        await refreshSource(id, home);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          onStatus(tab.tabId, "closed");
        }
      });
    return () => {
      cancelled = true;
      const id = openedId ?? sourceSftpRef.current;
      if (id) api.sftpClose(id).catch(() => {});
      sourceSftpRef.current = null;
    };
  }, [onStatus, refreshSource, tab.sessionId, tab.tabId]);

  useEffect(() => {
    if (!targetSessionId && targetSessions.length > 0) setTargetSessionId(targetSessions[0].id);
    if (targetSessionId && !targetSessions.some((s) => s.id === targetSessionId)) {
      setTargetSessionId(targetSessions[0]?.id ?? "");
    }
  }, [targetSessionId, targetSessions]);

  useEffect(() => {
    const previous = targetSftpRef.current;
    if (previous) {
      api.sftpClose(previous).catch(() => {});
      targetSftpRef.current = null;
    }
    setTargetSftpId(null);
    setTargetEntries([]);
    setSelectedTargetName(null);
    if (leftMode !== "server" || !targetSessionId) {
      setTargetOpening(false);
      return;
    }

    let cancelled = false;
    let openedId: string | null = null;
    setTargetOpening(true);
    api
      .sftpOpen(targetSessionId)
      .then(async ({ id, home }) => {
        if (cancelled) {
          api.sftpClose(id).catch(() => {});
          return;
        }
        openedId = id;
        targetSftpRef.current = id;
        setTargetSftpId(id);
        setTargetHome(home);
        await refreshTarget(id, home);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setTargetOpening(false);
      });

    return () => {
      cancelled = true;
      const id = openedId ?? targetSftpRef.current;
      if (id) api.sftpClose(id).catch(() => {});
      if (targetSftpRef.current === id) targetSftpRef.current = null;
    };
  }, [leftMode, refreshTarget, targetSessionId]);

  const uploadLocalToSource = useCallback(
    (localPath: string, name: string) => {
      if (!sourceSftpId) return;
      startTransfer(sourceSftpId, "upload", localPath, joinRemote(sourceCwd, name), name, () =>
        refreshSource(sourceSftpId, sourceCwd)
      );
    },
    [refreshSource, sourceCwd, sourceSftpId, startTransfer]
  );

  const downloadSourceToLocal = useCallback(
    (entry: FileEntry) => {
      if (!sourceSftpId || !localCwd) return;
      startTransfer(
        sourceSftpId,
        "download",
        joinLocal(localCwd, entry.name),
        joinRemote(sourceCwd, entry.name),
        entry.name,
        () => refreshLocal(localCwd)
      );
    },
    [localCwd, refreshLocal, sourceCwd, sourceSftpId, startTransfer]
  );

  const transferSourceToTarget = useCallback(
    (entry: FileEntry) => {
      if (!sourceSftpId || !targetSftpId || !targetSession) return;
      startRemoteTransfer(
        sourceSftpId,
        joinRemote(sourceCwd, entry.name),
        targetSession.id,
        joinRemote(targetCwd, entry.name),
        `${sourceName} -> ${targetSession.name}: ${entry.name}`,
        () => refreshTarget(targetSftpId, targetCwd)
      );
    },
    [
      refreshTarget,
      sourceCwd,
      sourceName,
      sourceSftpId,
      startRemoteTransfer,
      targetCwd,
      targetSession,
      targetSftpId,
    ]
  );

  const transferTargetToSource = useCallback(
    (entry: FileEntry) => {
      if (!targetSftpId || !tab.sessionId) return;
      startRemoteTransfer(
        targetSftpId,
        joinRemote(targetCwd, entry.name),
        tab.sessionId,
        joinRemote(sourceCwd, entry.name),
        `${targetSession?.name ?? "目标服务器"} -> ${sourceName}: ${entry.name}`,
        () => sourceSftpId && refreshSource(sourceSftpId, sourceCwd)
      );
    },
    [
      refreshSource,
      sourceCwd,
      sourceName,
      sourceSftpId,
      startRemoteTransfer,
      tab.sessionId,
      targetCwd,
      targetSession?.name,
      targetSftpId,
    ]
  );

  useEffect(() => {
    if (!active || !sourceSftpId || leftMode !== "local") return;
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        for (const p of event.payload.paths) uploadLocalToSource(p, baseName(p));
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [active, leftMode, sourceSftpId, uploadLocalToSource]);

  const refreshRemoteSide = (side: RemoteSide, path: string) => {
    if (side === "source" && sourceSftpId) refreshSource(sourceSftpId, path);
    if (side === "target" && targetSftpId) refreshTarget(targetSftpId, path);
  };

  const remoteContext = (side: RemoteSide) =>
    side === "source"
      ? { id: sourceSftpId, cwd: sourceCwd, home: sourceHome, refresh: refreshSource }
      : { id: targetSftpId, cwd: targetCwd, home: targetHome, refresh: refreshTarget };

  const remoteMkdir = async (side: RemoteSide) => {
    const ctx = remoteContext(side);
    if (!ctx.id) return;
    const name = await prompt({ title: "远程新建目录", placeholder: "目录名称" });
    if (!name?.trim()) return;
    try {
      await api.sftpMkdir(ctx.id, joinRemote(ctx.cwd, name.trim()));
      await ctx.refresh(ctx.id, ctx.cwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const remoteRename = async (side: RemoteSide, entry: FileEntry) => {
    const ctx = remoteContext(side);
    if (!ctx.id) return;
    const name = await prompt({ title: "重命名", defaultValue: entry.name });
    if (!name?.trim() || name === entry.name) return;
    try {
      await api.sftpRename(ctx.id, joinRemote(ctx.cwd, entry.name), joinRemote(ctx.cwd, name.trim()));
      await ctx.refresh(ctx.id, ctx.cwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const remoteDelete = async (side: RemoteSide, entry: FileEntry) => {
    const ctx = remoteContext(side);
    if (!ctx.id) return;
    const ok = await confirm({
      title: "删除远程文件",
      message: `确定删除远程${entry.isDir ? "目录" : "文件"}「${entry.name}」？`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    try {
      await api.sftpDelete(ctx.id, joinRemote(ctx.cwd, entry.name), entry.isDir);
      await ctx.refresh(ctx.id, ctx.cwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const localMkdir = async () => {
    if (!localCwd) return;
    const name = await prompt({ title: "本地新建目录", placeholder: "目录名称" });
    if (!name?.trim()) return;
    try {
      await api.localMkdir(joinLocal(localCwd, name.trim()));
      await refreshLocal(localCwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const localDelete = async (entry: FileEntry) => {
    const ok = await confirm({
      title: "删除本地文件",
      message: `确定删除本地${entry.isDir ? "目录" : "文件"}「${entry.name}」？（移入回收站，可恢复）`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    try {
      await api.localDelete(joinLocal(localCwd, entry.name));
      await refreshLocal(localCwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const localRowMenu = (e: React.MouseEvent, entry: FileEntry) => {
    showMenu(e, [
      {
        label: entry.isDir ? "上传目录" : "上传到右侧服务器",
        onClick: () => uploadLocalToSource(joinLocal(localCwd, entry.name), entry.name),
      },
      ...(entry.isDir
        ? [{ label: "进入目录", onClick: () => refreshLocal(joinLocal(localCwd, entry.name)) }]
        : []),
      SEPARATOR,
      {
        label: "在资源管理器中显示",
        onClick: () => api.localReveal(joinLocal(localCwd, entry.name)).catch((err) => setError(String(err))),
      },
      { label: "删除（回收站）", danger: true, onClick: () => localDelete(entry) },
      SEPARATOR,
      { label: "刷新", onClick: () => refreshLocal(localCwd) },
      { label: "新建目录", onClick: localMkdir },
    ]);
  };

  const sourceRowMenu = (e: React.MouseEvent, entry: FileEntry) => {
    const fileAction =
      leftMode === "local"
        ? { label: entry.isDir ? "下载目录" : "下载到本地", onClick: () => downloadSourceToLocal(entry) }
        : { label: "传到左侧目标服务器", onClick: () => transferSourceToTarget(entry) };
    showMenu(e, [
      fileAction,
      ...(entry.isDir
        ? [{ label: "进入目录", onClick: () => refreshRemoteSide("source", joinRemote(sourceCwd, entry.name)) }]
        : []),
      SEPARATOR,
      { label: "重命名", onClick: () => remoteRename("source", entry) },
      { label: "删除", danger: true, onClick: () => remoteDelete("source", entry) },
      SEPARATOR,
      { label: "刷新", onClick: () => sourceSftpId && refreshSource(sourceSftpId, sourceCwd) },
      { label: "新建目录", onClick: () => remoteMkdir("source") },
    ]);
  };

  const targetRowMenu = (e: React.MouseEvent, entry: FileEntry) => {
    showMenu(e, [
      { label: "传到右侧当前服务器", onClick: () => transferTargetToSource(entry) },
      ...(entry.isDir
        ? [{ label: "进入目录", onClick: () => refreshRemoteSide("target", joinRemote(targetCwd, entry.name)) }]
        : []),
      SEPARATOR,
      { label: "重命名", onClick: () => remoteRename("target", entry) },
      { label: "删除", danger: true, onClick: () => remoteDelete("target", entry) },
      SEPARATOR,
      { label: "刷新", onClick: () => targetSftpId && refreshTarget(targetSftpId, targetCwd) },
      { label: "新建目录", onClick: () => remoteMkdir("target") },
    ]);
  };

  const localPaneMenu = (e: React.MouseEvent) => {
    showMenu(e, [
      { label: "上级目录", onClick: () => refreshLocal(parentLocal(localCwd)) },
      { label: "回到主目录", onClick: () => api.localHome().then((h) => refreshLocal(h)) },
      { label: "刷新", onClick: () => refreshLocal(localCwd) },
      SEPARATOR,
      { label: "新建目录", onClick: localMkdir },
      {
        label: "在资源管理器中打开",
        onClick: () => api.localReveal(localCwd).catch((err) => setError(String(err))),
      },
      { label: "复制当前路径", onClick: () => navigator.clipboard.writeText(localCwd).catch(() => {}) },
    ]);
  };

  const remotePaneMenu = (e: React.MouseEvent, side: RemoteSide) => {
    const ctx = remoteContext(side);
    showMenu(e, [
      {
        label: "上级目录",
        disabled: !ctx.id || ctx.cwd === "/",
        onClick: () => ctx.id && ctx.refresh(ctx.id, parentRemote(ctx.cwd)),
      },
      { label: "回到起始目录", disabled: !ctx.id, onClick: () => ctx.id && ctx.refresh(ctx.id, ctx.home) },
      { label: "刷新", disabled: !ctx.id, onClick: () => ctx.id && ctx.refresh(ctx.id, ctx.cwd) },
      SEPARATOR,
      { label: "新建目录", disabled: !ctx.id, onClick: () => remoteMkdir(side) },
      { label: "复制当前路径", onClick: () => navigator.clipboard.writeText(ctx.cwd).catch(() => {}) },
    ]);
  };

  const rowActionLabel = (side: RowSide, entry: FileEntry): string | null => {
    if (side === "local") return entry.isDir ? "上传目录" : "上传";
    if (side === "target") return entry.isDir ? "传目录" : "传到右侧";
    if (leftMode === "local") return entry.isDir ? "下载目录" : "下载";
    return entry.isDir ? "传目录" : "传到左侧";
  };

  const renderRows = (
    side: RowSide,
    entries: FileEntry[],
    onEnterDir: (entry: FileEntry) => void,
    onFileAction: (entry: FileEntry) => void,
    rowMenu: (e: React.MouseEvent, entry: FileEntry) => void,
    selectedName?: string | null,
    onSelect?: (entry: FileEntry) => void
  ) => (
    <SftpFileTable
      entries={entries}
      selectedName={selectedName}
      onSelect={onSelect}
      onEnterDir={onEnterDir}
      onFileAction={onFileAction}
      onContextMenu={rowMenu}
      titleForEntry={(entry) => (entry.isDir ? "双击进入目录" : "双击执行传输")}
      actionLabel={(entry) => rowActionLabel(side, entry)}
      actionTitle={(entry) => rowActionLabel(side, entry) ?? undefined}
      onAction={(_, entry) => {
        onSelect?.(entry);
        onFileAction(entry);
      }}
    />
  );

  const renderLeftPane = () => {
    if (leftMode === "server") {
      return (
        <div
          className="sftp-pane"
          style={{ flex: `0 0 ${leftPct}%` }}
          onContextMenu={(e) => remotePaneMenu(e, "target")}
        >
          <div className="sftp-pane-title stacked">
            <div className="sftp-pane-title-main">
              <div className="sftp-mode-toggle">
                <button className="mode-btn" onClick={() => setLeftMode("local")}>
                  本地
                </button>
                <button className="mode-btn active">服务器</button>
              </div>
              <span className="pane-hint">双击文件传到右侧当前服务器</span>
            </div>
            <div className="sftp-target-picker">
              <input
                className="input sftp-target-filter"
                value={targetFilter}
                onChange={(e) => setTargetFilter(e.target.value)}
                placeholder="搜索目标服务器..."
              />
              <select
                className="input sftp-target-select"
                value={targetSessionId}
                onChange={(e) => setTargetSessionId(e.target.value)}
              >
                {filteredTargetSessions.length === 0 && <option value="">无匹配服务器</option>}
                {filteredTargetSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.username}@{s.host})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="sftp-toolbar">
            <button
              className="btn mini"
              onClick={() => targetSftpId && refreshTarget(targetSftpId, parentRemote(targetCwd))}
              disabled={!targetSftpId || targetCwd === "/"}
            >
              上级
            </button>
            <input
              className="input sftp-path"
              value={targetCwd}
              onChange={(e) => setTargetCwd(e.target.value)}
              disabled={!targetSftpId}
              onKeyDown={(e) => e.key === "Enter" && targetSftpId && refreshTarget(targetSftpId, targetCwd.trim() || "/")}
            />
          </div>
          {targetOpening ? (
            <div className="empty-hint">正在连接目标服务器...</div>
          ) : !targetSession ? (
            <div className="empty-hint">请选择目标服务器</div>
          ) : (
            renderRows(
              "target",
              targetEntries,
              (entry) => refreshRemoteSide("target", joinRemote(targetCwd, entry.name)),
              transferTargetToSource,
              targetRowMenu,
              selectedTargetName,
              (entry) => setSelectedTargetName(entry.name)
            )
          )}
        </div>
      );
    }

    return (
      <div
        className="sftp-pane"
        style={{ flex: `0 0 ${leftPct}%` }}
        onContextMenu={localPaneMenu}
      >
        <div className="sftp-pane-title stacked">
          <div className="sftp-pane-title-main">
            <div className="sftp-mode-toggle">
              <button className="mode-btn active">本地</button>
              <button
                className="mode-btn"
                onClick={() => setLeftMode("server")}
                disabled={targetSessions.length === 0}
                title={targetSessions.length === 0 ? "需要至少保存另一台服务器" : "切换到目标服务器"}
              >
                服务器
              </button>
            </div>
            <span className="pane-hint">双击文件上传到右侧当前服务器</span>
          </div>
        </div>
        <div className="sftp-toolbar">
          <button className="btn mini" onClick={() => refreshLocal(parentLocal(localCwd))}>
            上级
          </button>
          {drives.length > 0 && (
            <select
              className="input drive-select"
              value={drives.find((d) => localCwd.toUpperCase().startsWith(d.toUpperCase().slice(0, 2))) ?? ""}
              onChange={(e) => e.target.value && refreshLocal(e.target.value)}
            >
              {drives.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
          <input
            className="input sftp-path"
            value={localCwd}
            onChange={(e) => setLocalCwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && refreshLocal(localCwd.trim())}
          />
        </div>
        {renderRows(
          "local",
          localEntries,
          (entry) => refreshLocal(joinLocal(localCwd, entry.name)),
          (entry) => uploadLocalToSource(joinLocal(localCwd, entry.name), entry.name),
          localRowMenu
        )}
      </div>
    );
  };

  return (
    <div className="sftp-view" style={{ display: active ? "flex" : "none" }}>
      {error && <div className="sftp-status error">{error}</div>}
      <div className="sftp-dual" ref={dualRef}>
        {renderLeftPane()}
        <Resizer
          direction="col"
          onMove={(d) => {
            const w = dualRef.current?.clientWidth ?? 1;
            setLeftPct((p) => Math.min(80, Math.max(20, p + (d / w) * 100)));
          }}
        />
        <div className="sftp-pane" onContextMenu={(e) => remotePaneMenu(e, "source")}>
          <div className="sftp-pane-title stacked">
            <div className="sftp-pane-title-main">
              <span>当前服务器</span>
              <span className="sftp-server-pill">{sourceName}</span>
              <span className="pane-hint">
                {leftMode === "local" ? "双击文件下载到本地" : "双击文件传到左侧目标服务器"}
              </span>
            </div>
          </div>
          <div className="sftp-toolbar">
            <button
              className="btn mini"
              onClick={() => sourceSftpId && refreshSource(sourceSftpId, parentRemote(sourceCwd))}
              disabled={!sourceSftpId || sourceCwd === "/"}
            >
              上级
            </button>
            <input
              className="input sftp-path"
              value={sourceCwd}
              onChange={(e) => setSourceCwd(e.target.value)}
              disabled={!sourceSftpId}
              onKeyDown={(e) => e.key === "Enter" && sourceSftpId && refreshSource(sourceSftpId, sourceCwd.trim() || "/")}
            />
          </div>
          {renderRows(
            "source",
            sourceEntries,
            (entry) => refreshRemoteSide("source", joinRemote(sourceCwd, entry.name)),
            leftMode === "local" ? downloadSourceToLocal : transferSourceToTarget,
            sourceRowMenu,
            selectedSourceName,
            (entry) => setSelectedSourceName(entry.name)
          )}
        </div>
      </div>
    </div>
  );
}
