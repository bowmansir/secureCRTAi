import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import type { SessionInput, SessionProfile } from "../types";

interface Props {
  editing: SessionProfile | null;
  groups: string[];
  onSave: (input: SessionInput) => Promise<SessionProfile>;
  onClose: () => void;
}

const NEW_GROUP = "__new__";

function keyLabel(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export default function SessionDialog({ editing, groups, onSave, onClose }: Props) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [newGroupMode, setNewGroupMode] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [detectedKeys, setDetectedKeys] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 扫描本机 ~/.ssh 私钥，供直接选择
    api.listSshKeys().then(setDetectedKeys).catch(() => {});
    hostRef.current?.focus();
  }, []);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setGroup(editing.group);
      setHost(editing.host);
      setPort(editing.port);
      setUsername(editing.username);
      setAuthType(editing.authType);
      setKeyPath(editing.keyPath ?? "");
      // 密码不回显，留空表示不修改
    }
  }, [editing]);

  /** 支持在主机栏直接粘贴 user@host:port，自动拆分填充 */
  const parseHostInput = (v: string) => {
    const m = v.match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    if (m && (m[1] || m[3])) {
      if (m[1]) setUsername(m[1]);
      setHost(m[2]);
      if (m[3]) setPort(Number(m[3]));
    } else {
      setHost(v);
    }
  };

  const browseKey = async () => {
    const picked = await openDialog({
      multiple: false,
      title: "选择 SSH 私钥文件",
      defaultPath: detectedKeys[0]?.replace(/[\\/][^\\/]+$/, ""),
    });
    if (picked) setKeyPath(picked as string);
  };

  const submit = async () => {
    if (!host.trim() || !username.trim()) {
      setError("主机和用户名为必填项（主机栏支持直接粘贴 user@host:port）");
      return;
    }
    if (authType === "key" && !keyPath.trim()) {
      setError("请选择私钥文件");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({
        id: editing?.id,
        name: name.trim() || `${username}@${host}`,
        group: group.trim(),
        host: host.trim(),
        port,
        username: username.trim(),
        authType,
        // 编辑时留空 = 不修改原密码
        password: password === "" && editing ? undefined : password,
        keyPath: keyPath.trim() || undefined,
        keyPassphrase: keyPassphrase === "" && editing ? undefined : keyPassphrase,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !saving) submit();
          if (e.key === "Escape") onClose();
        }}
      >
        <h3>{editing ? "编辑会话" : "新建 SSH 会话"}</h3>
        <div className="form-grid">
          <label>主机</label>
          <input
            ref={hostRef}
            className="input"
            value={host}
            onChange={(e) => parseHostInput(e.target.value)}
            placeholder="root@192.168.1.10:22 一次填好"
          />
          <label>用户名</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          <label>端口</label>
          <input
            className="input"
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 22)}
          />
          <label>认证方式</label>
          <select className="input" value={authType} onChange={(e) => setAuthType(e.target.value as "password" | "key")}>
            <option value="password">密码</option>
            <option value="key">私钥文件</option>
          </select>
          {authType === "password" ? (
            <>
              <label>密码</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={editing ? "留空则保持不变" : ""}
              />
            </>
          ) : (
            <>
              <label>私钥</label>
              <div className="key-picker">
                <select
                  className="input"
                  value={detectedKeys.includes(keyPath) ? keyPath : keyPath ? "__custom__" : ""}
                  onChange={(e) => {
                    if (e.target.value !== "__custom__") setKeyPath(e.target.value);
                  }}
                >
                  <option value="">选择检测到的密钥...</option>
                  {detectedKeys.map((k) => (
                    <option key={k} value={k}>
                      {keyLabel(k)}
                    </option>
                  ))}
                  {keyPath && !detectedKeys.includes(keyPath) && (
                    <option value="__custom__">{keyLabel(keyPath)}（手动选择）</option>
                  )}
                </select>
                <button className="btn" type="button" onClick={browseKey}>
                  浏览...
                </button>
              </div>
              {keyPath && <label />}
              {keyPath && <div className="key-path-hint">{keyPath}</div>}
              <label>密钥口令</label>
              <input
                className="input"
                type="password"
                value={keyPassphrase}
                onChange={(e) => setKeyPassphrase(e.target.value)}
                placeholder={editing ? "留空则保持不变" : "无口令可留空"}
              />
            </>
          )}
          <label>名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={host && username ? `${username}@${host}（自动）` : "留空自动生成"} />
          <label>分组</label>
          {newGroupMode ? (
            <div className="key-picker">
              <input
                className="input"
                autoFocus
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="输入新分组名称"
              />
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setNewGroupMode(false);
                  setGroup("");
                }}
              >
                取消
              </button>
            </div>
          ) : (
            <select
              className="input"
              value={groups.includes(group) ? group : ""}
              onChange={(e) => {
                if (e.target.value === NEW_GROUP) {
                  setNewGroupMode(true);
                  setGroup("");
                } else {
                  setGroup(e.target.value);
                }
              }}
            >
              <option value="">默认分组（未分组）</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value={NEW_GROUP}>+ 新建分组...</option>
            </select>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? "保存中..." : "保存（Enter）"}
          </button>
        </div>
        <div className="form-note">密码与口令使用 AES-256-GCM 加密存储，主密钥托管于系统凭据管理器。</div>
      </div>
    </div>
  );
}
