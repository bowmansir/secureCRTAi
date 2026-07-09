import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as api from "../api";
import { SEPARATOR, useContextMenu } from "./ContextMenu";
import { useDialogs } from "./Dialogs";
import Icon from "./Icons";
import Resizer from "./Resizer";
import SftpFileTable from "./SftpFileTable";
import type { FileEntry, SessionProfile, TabInfo } from "../types";

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
  /** 已保存会话（用于"传到其他服务器"选目标） */
  sessions: SessionProfile[];
  startRemoteTransfer: (
    srcSftpId: string,
    srcPath: string,
    dstSessionId: string,
    dstPath: string,
    title: string
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
  if (idx <= 2) return cleaned.slice(0, 3); // "C:\" 为根
  return cleaned.slice(0, idx);
}

export default function SftpView({
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
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [remoteCwd, setRemoteCwd] = useState("/");
  const [remoteHome, setRemoteHome] = useState("/");
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [selectedRemoteName, setSelectedRemoteName] = useState<string | null>(null);
  const [localCwd, setLocalCwd] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const openedRef = useRef(false);

  const refreshRemote = useCallback(async (id: string, path: string) => {
    try {
      setRemoteEntries(await api.sftpList(id, path));
      setRemoteCwd(path);
      setSelectedRemoteName(null);
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
    if (openedRef.current) return;
    openedRef.current = true;
    api.localHome().then((home) => refreshLocal(home));
    api.localDrives().then(setDrives).catch(() => {});
    api
      .sftpOpen(tab.sessionId!)
      .then(async ({ id, home }) => {
        setSftpId(id);
        setRemoteHome(home);
        onStatus(tab.tabId, "connected");
        await refreshRemote(id, home);
      })
      .catch((e) => {
        setError(String(e));
        onStatus(tab.tabId, "closed");
      });
    return () => {
      setSftpId((id) => {
        if (id) api.sftpClose(id).catch(() => {});
        return null;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 传输动作（完成后自动刷新目标栏） ----------

  const upload = useCallback(
    (localPath: string, name: string) => {
      if (!sftpId) return;
      startTransfer(sftpId, "upload", localPath, joinRemote(remoteCwd, name), name, () =>
        refreshRemote(sftpId, remoteCwd)
      );
    },
    [sftpId, remoteCwd, refreshRemote, startTransfer]
  );

  const download = useCallback(
    (e: FileEntry) => {
      if (!sftpId || !localCwd) return;
      startTransfer(
        sftpId,
        "download",
        joinLocal(localCwd, e.name),
        joinRemote(remoteCwd, e.name),
        e.name,
        () => refreshLocal(localCwd)
      );
    },
    [sftpId, localCwd, remoteCwd, refreshLocal, startTransfer]
  );

  // 拖拽上传（激活标签页时生效）
  useEffect(() => {
    if (!active || !sftpId) return;
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        for (const p of event.payload.paths) upload(p, baseName(p));
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [active, sftpId, upload]);

  // ---------- 远程操作 ----------

  const remoteMkdir = async () => {
    if (!sftpId) return;
    const name = await prompt({ title: "远程新建目录", placeholder: "目录名称" });
    if (!name?.trim()) return;
    try {
      await api.sftpMkdir(sftpId, joinRemote(remoteCwd, name.trim()));
      await refreshRemote(sftpId, remoteCwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const remoteRename = async (e: FileEntry) => {
    if (!sftpId) return;
    const name = await prompt({ title: "重命名", defaultValue: e.name });
    if (!name?.trim() || name === e.name) return;
    try {
      await api.sftpRename(sftpId, joinRemote(remoteCwd, e.name), joinRemote(remoteCwd, name.trim()));
      await refreshRemote(sftpId, remoteCwd);
    } catch (err) {
      setError(String(err));
    }
  };

  const remoteDelete = async (e: FileEntry) => {
    if (!sftpId) return;
    const ok = await confirm({
      title: "删除远程文件",
      message: `确定删除远程${e.isDir ? "目录" : "文件"}「${e.name}」？`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    try {
      await api.sftpDelete(sftpId, joinRemote(remoteCwd, e.name), e.isDir);
      await refreshRemote(sftpId, remoteCwd);
    } catch (err) {
      setError(String(err));
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

  // ---------- 右键菜单 ----------

  const localDelete = async (f: FileEntry) => {
    const ok = await confirm({
      title: "删除本地文件",
      message: `确定删除本地${f.isDir ? "目录" : "文件"}「${f.name}」？（移入回收站，可恢复）`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    try {
      await api.localDelete(joinLocal(localCwd, f.name));
      await refreshLocal(localCwd);
    } catch (e) {
      setError(String(e));
    }
  };

  const localRowMenu = (e: React.MouseEvent, f: FileEntry) => {
    showMenu(e, [
      { label: f.isDir ? "上传目录" : "上传", onClick: () => upload(joinLocal(localCwd, f.name), f.name) },
      ...(f.isDir ? [{ label: "进入目录", onClick: () => refreshLocal(joinLocal(localCwd, f.name)) }] : []),
      SEPARATOR,
      {
        label: "在资源管理器中显示",
        onClick: () => api.localReveal(joinLocal(localCwd, f.name)).catch((err) => setError(String(err))),
      },
      { label: "删除（回收站）", danger: true, onClick: () => localDelete(f) },
      SEPARATOR,
      { label: "刷新", onClick: () => refreshLocal(localCwd) },
      { label: "新建目录", onClick: localMkdir },
    ]);
  };

  const transferToServer = async (f: FileEntry, target: SessionProfile) => {
    if (!sftpId) return;
    const src = joinRemote(remoteCwd, f.name);
    const dstPath = await prompt({
      title: `传到 ${target.name}`,
      defaultValue: `/root/${f.name}`,
      note: `从 ${tab.title.replace("SFTP: ", "")} 的 ${src} 直传到 ${target.host}，本地不落盘`,
    });
    if (!dstPath?.trim()) return;
    startRemoteTransfer(sftpId, src, target.id, dstPath.trim(), `${f.name} → ${target.name}`);
  };

  const otherSessions = sessions.filter((s) => s.id !== tab.sessionId);
  const selectedRemoteEntry = remoteEntries.find((f) => f.name === selectedRemoteName) ?? null;
  const canTransferSelectedRemote = Boolean(sftpId && selectedRemoteEntry && !selectedRemoteEntry.isDir && otherSessions.length > 0);

  const remoteTransferItems = (f: FileEntry) =>
    otherSessions.slice(0, 8).map((s) => ({
      label: `传到服务器: ${s.name}`,
      onClick: () => transferToServer(f, s),
    }));

  const showTransferTargets = (e: React.MouseEvent, f: FileEntry) => {
    showMenu(e, remoteTransferItems(f));
  };

  const remoteRowMenu = (e: React.MouseEvent, f: FileEntry) => {
    setSelectedRemoteName(f.name);
    showMenu(e, [
      { label: f.isDir ? "下载目录" : "下载", onClick: () => download(f) },
      ...(f.isDir ? [{ label: "进入目录", onClick: () => refreshRemote(sftpId!, joinRemote(remoteCwd, f.name)) }] : []),
      ...(!f.isDir && otherSessions.length > 0
        ? [
            SEPARATOR,
            ...remoteTransferItems(f),
          ]
        : []),
      SEPARATOR,
      { label: "重命名", onClick: () => remoteRename(f) },
      { label: "删除", danger: true, onClick: () => remoteDelete(f) },
      SEPARATOR,
      { label: "刷新", onClick: () => refreshRemote(sftpId!, remoteCwd) },
      { label: "新建目录", onClick: remoteMkdir },
    ]);
  };

  const paneMenu = (e: React.MouseEvent, side: "local" | "remote") => {
    if (side === "local") {
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
    } else {
      showMenu(e, [
        {
          label: "上级目录",
          disabled: !sftpId || remoteCwd === "/",
          onClick: () => sftpId && refreshRemote(sftpId, parentRemote(remoteCwd)),
        },
        { label: "回到起始目录", disabled: !sftpId, onClick: () => sftpId && refreshRemote(sftpId, remoteHome) },
        { label: "刷新", disabled: !sftpId, onClick: () => sftpId && refreshRemote(sftpId, remoteCwd) },
        SEPARATOR,
        { label: "新建目录", disabled: !sftpId, onClick: remoteMkdir },
        { label: "复制当前路径", onClick: () => navigator.clipboard.writeText(remoteCwd).catch(() => {}) },
      ]);
    }
  };

  // ---------- 渲染 ----------

  const renderRows = (
    side: "local" | "remote",
    entries: FileEntry[],
    onEnterDir: (f: FileEntry) => void,
    onFileAction: (f: FileEntry) => void,
    rowMenu: (e: React.MouseEvent, f: FileEntry) => void,
    selectedName?: string | null,
    onSelect?: (f: FileEntry) => void
  ) => (
    <SftpFileTable
      entries={entries}
      selectedName={selectedName}
      onSelect={onSelect}
      onEnterDir={onEnterDir}
      onFileAction={onFileAction}
      onContextMenu={rowMenu}
      titleForEntry={(f) => (f.isDir ? "双击进入目录" : side === "local" ? "双击上传" : "双击下载")}
      actionLabel={(f) => (side === "remote" && !f.isDir && otherSessions.length > 0 ? "传到" : null)}
      actionTitle={() => "传到其他服务器"}
      onAction={(event, f) => {
        setSelectedRemoteName(f.name);
        showTransferTargets(event, f);
      }}
    />
  );

  return (
    <div className="sftp-view" style={{ display: active ? "flex" : "none" }}>
      {error && <div className="sftp-status error">{error}</div>}
      <div className="sftp-dual" ref={dualRef}>
        <div
          className="sftp-pane"
          style={{ flex: `0 0 ${leftPct}%` }}
          onContextMenu={(e) => paneMenu(e, "local")}
        >
          <div className="sftp-pane-title">
            本地
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
            <span className="pane-hint">双击文件上传 · 支持拖拽</span>
          </div>
          <div className="sftp-toolbar">
            <button className="btn mini" onClick={() => refreshLocal(parentLocal(localCwd))}>
              上级
            </button>
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
            (f) => refreshLocal(joinLocal(localCwd, f.name)),
            (f) => upload(joinLocal(localCwd, f.name), f.name),
            localRowMenu
          )}
        </div>
        <Resizer
          direction="col"
          onMove={(d) => {
            const w = dualRef.current?.clientWidth ?? 1;
            setLeftPct((p) => Math.min(80, Math.max(20, p + (d / w) * 100)));
          }}
        />
        <div className="sftp-pane" onContextMenu={(e) => paneMenu(e, "remote")}>
          <div className="sftp-pane-title">
            远程
            <span className="pane-hint">双击下载 · 选中文件可直传服务器</span>
          </div>
          <div className="sftp-toolbar">
            <button
              className="btn mini"
              onClick={() => sftpId && refreshRemote(sftpId, parentRemote(remoteCwd))}
              disabled={!sftpId || remoteCwd === "/"}
            >
              上级
            </button>
            <input
              className="input sftp-path"
              value={remoteCwd}
              onChange={(e) => setRemoteCwd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sftpId && refreshRemote(sftpId, remoteCwd.trim() || "/")}
            />
            <button
              className="btn mini sftp-transfer-btn"
              disabled={!canTransferSelectedRemote}
              onClick={(e) => selectedRemoteEntry && showTransferTargets(e, selectedRemoteEntry)}
              title={
                !selectedRemoteEntry
                  ? "先选中一个远程文件"
                  : selectedRemoteEntry.isDir
                    ? "服务器间传输暂只支持单文件"
                    : otherSessions.length === 0
                      ? "需要至少保存另一个服务器会话"
                      : "从当前服务器直传到另一台服务器"
              }
            >
              <Icon name="transfer" size={13} />
              服务器间传输
            </button>
          </div>
          {renderRows(
            "remote",
            remoteEntries,
            (f) => sftpId && refreshRemote(sftpId, joinRemote(remoteCwd, f.name)),
            (f) => download(f),
            remoteRowMenu,
            selectedRemoteName,
            (f) => setSelectedRemoteName(f.name)
          )}
        </div>
      </div>
    </div>
  );
}
