import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import Icon from "./Icons";
import type { ForwardTestResult, ForwardView, PubKeyEntry, SessionProfile } from "../types";

interface Props {
  sessions: SessionProfile[];
  activeSessionId?: string | null;
  onClose: () => void;
}

type Tab = "forward" | "key" | "cert";
type ForwardMode = "local" | "dynamic" | "remote";

const pickActiveSessionId = (sessions: SessionProfile[], activeSessionId?: string | null) =>
  activeSessionId && sessions.some((s) => s.id === activeSessionId) ? activeSessionId : "";

const sessionLabel = (s: SessionProfile) => `${s.name}（${s.username}@${s.host}:${s.port}）`;

const localEndpoint = (f: Pick<ForwardView, "localBind" | "localPort">) => {
  const host = f.localBind === "0.0.0.0" || f.localBind === "::" ? "127.0.0.1" : f.localBind;
  return `${host}:${f.localPort}`;
};

const httpUrlFor = (f: ForwardView) => {
  if (f.kind !== "local") return null;
  const endpoint = localEndpoint(f);
  if (f.remotePort === 443) return `https://${endpoint}`;
  if ([80, 3000, 5000, 5173, 8000, 8080, 9000].includes(f.remotePort)) return `http://${endpoint}`;
  return null;
};

const proxyEndpoint = (f: Pick<ForwardView, "localBind" | "localPort">) => `socks5://${localEndpoint(f)}`;

const remoteEndpoint = (f: Pick<ForwardView, "remoteHost" | "remotePort">) => `${f.remoteHost}:${f.remotePort}`;

const forwardUseEndpoint = (f: ForwardView) => {
  if (f.kind === "dynamic") return proxyEndpoint(f);
  if (f.kind === "remote") return remoteEndpoint(f);
  return localEndpoint(f);
};

const forwardUseLabel = (f: ForwardView) => {
  if (f.kind === "dynamic") return "代理地址";
  if (f.kind === "remote") return "远端入口";
  return "本机入口";
};

const forwardTestText = (result: ForwardTestResult) =>
  `${result.ok ? "测试通过" : "测试失败"} · ${result.latencyMs}ms · ${result.message}`;

export default function ToolsDialog({ sessions, activeSessionId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("forward");

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <h3>运维工具</h3>
        <div className="dlg-tabs">
          <button className={`dlg-tab${tab === "forward" ? " active" : ""}`} onClick={() => setTab("forward")}>
            端口转发
          </button>
          <button className={`dlg-tab${tab === "key" ? " active" : ""}`} onClick={() => setTab("key")}>
            密钥部署
          </button>
          <button className={`dlg-tab${tab === "cert" ? " active" : ""}`} onClick={() => setTab("cert")}>
            证书转换
          </button>
        </div>
        {tab === "forward" && <ForwardPanel sessions={sessions} activeSessionId={activeSessionId} />}
        {tab === "key" && <KeyPanel sessions={sessions} activeSessionId={activeSessionId} />}
        {tab === "cert" && <CertificateConvertPanel />}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 端口转发 ----------

function ForwardPanel({ sessions, activeSessionId }: { sessions: SessionProfile[]; activeSessionId?: string | null }) {
  const [forwards, setForwards] = useState<ForwardView[]>([]);
  const [mode, setMode] = useState<ForwardMode>("local");
  const [sessionId, setSessionId] = useState(() => pickActiveSessionId(sessions, activeSessionId));
  const [localBind, setLocalBind] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lastCreated, setLastCreated] = useState<ForwardView | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testTargetHost, setTestTargetHost] = useState("example.com");
  const [testTargetPort, setTestTargetPort] = useState("80");
  const [testResults, setTestResults] = useState<Record<string, ForwardTestResult>>({});
  const selectedSession = sessions.find((s) => s.id === sessionId) ?? null;

  const reload = async () => {
    try {
      setForwards(await api.forwardList());
    } catch {
      /* 忽略刷新错误 */
    }
  };

  useEffect(() => {
    reload();
    // 活跃连接数会变化，开着面板时轻量轮询
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (sessionId && sessions.some((s) => s.id === sessionId)) return;
    setSessionId(pickActiveSessionId(sessions, activeSessionId));
  }, [activeSessionId, sessionId, sessions]);

  useEffect(() => {
    if (mode === "dynamic" && !localPort) setLocalPort("1080");
  }, [localPort, mode]);

  const copyText = async (text: string, okText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(okText);
      window.setTimeout(() => setMessage(""), 1800);
    } catch (e) {
      setError(`复制失败：${String(e)}`);
    }
  };

  const start = async () => {
    if (busy) return;
    const lp = Number(localPort);
    const rp = Number(remotePort);
    if (!sessionId) return setError("请选择用于建立隧道的服务器");
    if (!localBind.trim()) return setError(mode === "remote" ? "本机目标主机必填" : "本地绑定地址必填");
    if (!Number.isInteger(lp) || lp < 1 || lp > 65535) {
      return setError(mode === "remote" ? "本机目标端口需为 1-65535" : "本地端口需为 1-65535");
    }
    if (mode !== "dynamic" && !remoteHost.trim()) return setError(mode === "remote" ? "远端监听地址必填" : "目标主机必填");
    if (mode !== "dynamic" && (!Number.isInteger(rp) || rp < 1 || rp > 65535)) {
      return setError(mode === "remote" ? "远端监听端口需为 1-65535" : "目标端口需为 1-65535");
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const created =
        mode === "dynamic"
          ? await api.forwardStartDynamic({
              sessionId,
              localBind: localBind.trim() || "127.0.0.1",
              localPort: lp,
            })
          : mode === "remote"
          ? await api.forwardStartRemote({
              sessionId,
              remoteBind: remoteHost.trim() || "127.0.0.1",
              remotePort: rp,
              targetHost: localBind.trim() || "127.0.0.1",
              targetPort: lp,
            })
          : await api.forwardStart({
              sessionId,
              localBind: localBind.trim() || "127.0.0.1",
              localPort: lp,
              remoteHost: remoteHost.trim(),
              remotePort: rp,
            });
      setLastCreated(created);
      setMessage(
        mode === "dynamic"
          ? "SOCKS5 代理已建立，可直接使用代理地址"
          : mode === "remote"
          ? "远程转发已建立，可从远端入口访问本机目标服务"
          : "转发已建立，可直接使用本机入口"
      );
      setLocalPort("");
      if (mode !== "dynamic") setRemotePort("");
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    await api.forwardStop(id);
    if (lastCreated?.id === id) setLastCreated(null);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await reload();
  };

  const runForwardTest = async (f: ForwardView) => {
    if (testingId) return;
    setTestingId(f.id);
    setError("");
    setMessage("");
    try {
      let targetHost: string | undefined;
      let targetPort: number | undefined;
      if (f.kind === "dynamic") {
        targetHost = testTargetHost.trim() || undefined;
        const parsed = Number(testTargetPort);
        if (targetHost && (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)) {
          setError("SOCKS5 测试目标端口需要为 1-65535");
          return;
        }
        targetPort = targetHost ? parsed : undefined;
      }
      const result = await api.forwardTest({ id: f.id, targetHost, targetPort });
      setTestResults((prev) => ({ ...prev, [f.id]: result }));
      setMessage(forwardTestText(result));
    } catch (e) {
      setError(String(e));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <>
      <div className="forward-context">
        {selectedSession ? (
          <>
            <span className={`tag ${selectedSession.id === activeSessionId ? "ok" : ""}`}>
              {selectedSession.id === activeSessionId ? "当前标签" : "手动选择"}
            </span>
            <div>
              <strong>{selectedSession.name}</strong>
              <span>{selectedSession.username}@{selectedSession.host}:{selectedSession.port}</span>
            </div>
          </>
        ) : (
          <div className="forward-context-empty">没有绑定当前服务器标签，请先选择一台服务器作为跳板。</div>
        )}
      </div>
      <div className="form-note">
        转发会在后台建立隧道，不会新开终端标签。创建后，把本机应用连接到下方生成的入口即可。
      </div>
      <div className="forward-form">
        <div className="forward-mode-switch" role="group" aria-label="转发模式">
          <button className={`seg-btn${mode === "local" ? " active" : ""}`} onClick={() => setMode("local")}>
            本地端口
          </button>
          <button className={`seg-btn${mode === "dynamic" ? " active" : ""}`} onClick={() => setMode("dynamic")}>
            SOCKS5 代理
          </button>
          <button className={`seg-btn${mode === "remote" ? " active" : ""}`} onClick={() => setMode("remote")}>
            远程端口
          </button>
        </div>
        <select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)} title="跳板会话">
          <option value="">{sessions.length === 0 ? "无可用服务器" : "选择跳板服务器..."}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        <div className="forward-guide">
          {mode === "local" ? (
            <span>目标地址是从这台服务器视角能访问的地址，例如 127.0.0.1:3306 或 10.0.0.8:8080。</span>
          ) : mode === "dynamic" ? (
            <span>SOCKS5 适合浏览器、代理客户端或命令行工具访问多个内网地址，目标由客户端请求决定。</span>
          ) : (
            <span>远程端口会在服务器上监听端口，把远端访问转回本机目标服务。远端监听 0.0.0.0 可能暴露到服务器所在网络。</span>
          )}
        </div>
        <div className="forward-row">
          <input
            className="input"
            value={localBind}
            onChange={(e) => setLocalBind(e.target.value)}
            placeholder={mode === "remote" ? "本机目标 127.0.0.1" : "本地绑定 127.0.0.1"}
            title={mode === "remote" ? "从本机视角能访问的目标主机" : "本地绑定地址，默认 127.0.0.1；填 0.0.0.0 可供局域网访问"}
          />
          <input
            className="input"
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
            placeholder={mode === "remote" ? "目标端口" : "本地端口"}
            inputMode="numeric"
          />
          {mode !== "dynamic" && (
            <>
              <span className="forward-arrow">→</span>
              <input
                className="input"
                value={remoteHost}
                onChange={(e) => setRemoteHost(e.target.value)}
                placeholder={mode === "remote" ? "远端监听 127.0.0.1" : "目标主机"}
                title={mode === "remote" ? "服务器上监听的地址；0.0.0.0 可能暴露给外部网络" : "从服务器视角能访问的目标主机"}
              />
              <input
                className="input"
                value={remotePort}
                onChange={(e) => setRemotePort(e.target.value)}
                placeholder={mode === "remote" ? "远端端口" : "目标端口"}
                inputMode="numeric"
              />
            </>
          )}
          <button className="btn primary" onClick={start} disabled={busy || sessions.length === 0}>
            {busy ? "建立中..." : "启动"}
          </button>
        </div>
        {mode === "remote" && ["0.0.0.0", "::"].includes(remoteHost.trim()) && (
          <div className="form-warning">远端入口可能被服务器所在网络访问，请确认防火墙和业务暴露范围。</div>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {message && <div className="io-message">{message}</div>}
      {lastCreated && (
        <div className="forward-created">
          <div className="forward-created-head">
            <span className="forward-dot" />
            <strong>
              {lastCreated.kind === "dynamic"
                ? "已建立 SOCKS5 代理"
                : lastCreated.kind === "remote"
                ? "已建立远程转发"
                : "已建立后台隧道"}
            </strong>
          </div>
          <div className="forward-use">
            <span>{forwardUseLabel(lastCreated)}</span>
            <code>{forwardUseEndpoint(lastCreated)}</code>
            <button
              className="btn"
              onClick={() =>
                copyText(
                  forwardUseEndpoint(lastCreated),
                  `已复制${forwardUseLabel(lastCreated)}`
                )
              }
            >
              复制
            </button>
            {httpUrlFor(lastCreated) && (
              <button className="btn" onClick={() => window.open(httpUrlFor(lastCreated)!, "_blank", "noopener,noreferrer")}>
                打开
              </button>
            )}
            <button className="btn" onClick={() => runForwardTest(lastCreated)} disabled={testingId === lastCreated.id}>
              {testingId === lastCreated.id ? "测试中..." : "测试"}
            </button>
          </div>
          {testResults[lastCreated.id] && (
            <div className={`forward-test-result ${testResults[lastCreated.id].ok ? "ok" : "fail"}`}>
              <span>{forwardTestText(testResults[lastCreated.id])}</span>
              <code>{testResults[lastCreated.id].target}</code>
            </div>
          )}
          <div className="form-note">
            {lastCreated.kind === "dynamic"
              ? `流量路径：本机应用 → ${proxyEndpoint(lastCreated)} → ${lastCreated.sessionName} → 目标网站 / 内网服务`
              : lastCreated.kind === "remote"
              ? `流量路径：远端客户端 → ${remoteEndpoint(lastCreated)} → ${lastCreated.sessionName} → 本机 ${localEndpoint(lastCreated)}`
              : `流量路径：本机客户端 → ${localEndpoint(lastCreated)} → ${lastCreated.sessionName} → ${lastCreated.remoteHost}:${lastCreated.remotePort}`}
          </div>
        </div>
      )}
      {(mode === "dynamic" || forwards.some((f) => f.kind === "dynamic")) && (
        <div className="forward-test-config">
          <span>SOCKS5 测试目标</span>
          <input
            className="input"
            value={testTargetHost}
            onChange={(e) => setTestTargetHost(e.target.value)}
            placeholder="example.com"
          />
          <input
            className="input"
            value={testTargetPort}
            onChange={(e) => setTestTargetPort(e.target.value)}
            placeholder="80"
            inputMode="numeric"
          />
        </div>
      )}
      <div className="settings-section-title">活跃转发</div>
      <div className="forward-list">
        {forwards.length === 0 && <div className="empty-hint">暂无端口转发</div>}
        {forwards.map((f) => (
          <div key={f.id} className="forward-item">
            <span className="forward-dot" />
            <div className="session-meta">
              <div className="session-name">
                {f.kind === "dynamic"
                  ? proxyEndpoint(f)
                  : f.kind === "remote"
                  ? `${remoteEndpoint(f)} → ${localEndpoint(f)}`
                  : `${f.localBind}:${f.localPort} → ${f.remoteHost}:${f.remotePort}`}
                <span className="tag">{f.active} 活跃</span>
              </div>
              <div className="session-host">
                {f.kind === "dynamic"
                  ? `经 ${f.sessionName}，浏览器或代理客户端使用 ${proxyEndpoint(f)}`
                  : f.kind === "remote"
                  ? `经 ${f.sessionName}，远端访问 ${remoteEndpoint(f)} 转回本机 ${localEndpoint(f)}`
                  : `经 ${f.sessionName}，本机使用 ${localEndpoint(f)}`}
              </div>
              {testResults[f.id] && (
                <div className={`forward-test-result compact ${testResults[f.id].ok ? "ok" : "fail"}`}>
                  <span>{forwardTestText(testResults[f.id])}</span>
                  <code>{testResults[f.id].target}</code>
                </div>
              )}
            </div>
            <div className="session-ops">
              <button
                className="icon-btn"
                onClick={() => runForwardTest(f)}
                disabled={testingId === f.id}
                title="测试转发连通性"
              >
                <Icon name="activity" size={14} />
              </button>
              <button
                className="icon-btn"
                onClick={() =>
                  copyText(
                    forwardUseEndpoint(f),
                    `已复制${forwardUseLabel(f)}`
                  )
                }
                title={`复制${forwardUseLabel(f)}`}
              >
                <Icon name="clone" size={14} />
              </button>
              <button className="icon-btn danger" onClick={() => stop(f.id)} title="停止转发">
                <Icon name="close" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- 密钥生成 / 部署 ----------

function KeyPanel({ sessions, activeSessionId }: { sessions: SessionProfile[]; activeSessionId?: string | null }) {
  const [pubkeys, setPubkeys] = useState<PubKeyEntry[]>([]);
  const [sessionId, setSessionId] = useState(() => pickActiveSessionId(sessions, activeSessionId));
  const [publicKey, setPublicKey] = useState("");
  const [deployMsg, setDeployMsg] = useState("");
  const [deployErr, setDeployErr] = useState("");
  const [deploying, setDeploying] = useState(false);

  const [genName, setGenName] = useState("id_termai");
  const [genComment, setGenComment] = useState("");
  const [genErr, setGenErr] = useState("");
  const [genMsg, setGenMsg] = useState("");
  const [generating, setGenerating] = useState(false);
  const pubkeyRef = useRef<HTMLTextAreaElement>(null);

  const reloadPubkeys = async () => {
    try {
      const list = await api.listSshPubkeys();
      setPubkeys(list);
      if (list[0] && !publicKey) setPublicKey(list[0].content);
    } catch {
      /* 忽略 */
    }
  };

  useEffect(() => {
    reloadPubkeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sessionId && sessions.some((s) => s.id === sessionId)) return;
    setSessionId(pickActiveSessionId(sessions, activeSessionId));
  }, [activeSessionId, sessionId, sessions]);

  const deploy = async () => {
    if (deploying) return;
    if (!sessionId) return setDeployErr("请选择目标会话");
    if (!publicKey.trim()) return setDeployErr("请选择或粘贴公钥");
    setDeploying(true);
    setDeployErr("");
    setDeployMsg("");
    try {
      const msg = await api.sshDeployKey(sessionId, publicKey.trim());
      setDeployMsg(msg);
    } catch (e) {
      setDeployErr(String(e));
    } finally {
      setDeploying(false);
    }
  };

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setGenErr("");
    setGenMsg("");
    try {
      const key = await api.sshGenerateKey(genName.trim(), genComment.trim());
      setGenMsg(`已生成：${key.privatePath}（指纹 ${key.fingerprint}）`);
      setPublicKey(key.publicKey);
      await reloadPubkeys();
    } catch (e) {
      setGenErr(String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <div className="settings-section-title">部署公钥到远端</div>
      <div className="form-note">把公钥追加到目标服务器 ~/.ssh/authorized_keys，之后即可用私钥免密登录（幂等，不会重复添加）。</div>
      <div className="form-grid">
        <label>目标会话</label>
        <select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          <option value="">{sessions.length === 0 ? "无可用服务器" : "选择目标服务器..."}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        <label>选择公钥</label>
        <select
          className="input"
          value={pubkeys.find((k) => k.content === publicKey)?.path ?? ""}
          onChange={(e) => {
            const k = pubkeys.find((x) => x.path === e.target.value);
            if (k) setPublicKey(k.content);
          }}
        >
          <option value="">— 手动粘贴 / 生成结果 —</option>
          {pubkeys.map((k) => (
            <option key={k.path} value={k.path}>
              {k.path}
            </option>
          ))}
        </select>
        <label>公钥内容</label>
        <textarea
          ref={pubkeyRef}
          className="input"
          rows={3}
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          placeholder="ssh-ed25519 AAAA... comment"
          spellCheck={false}
        />
      </div>
      {deployErr && <div className="form-error">{deployErr}</div>}
      {deployMsg && <div className="io-message">{deployMsg}</div>}
      <div className="key-actions">
        <button className="btn primary" onClick={deploy} disabled={deploying || sessions.length === 0}>
          {deploying ? "部署中..." : "部署公钥"}
        </button>
      </div>

      <div className="settings-section-title">生成新密钥（ed25519）</div>
      <div className="form-grid">
        <label>文件名</label>
        <input className="input" value={genName} onChange={(e) => setGenName(e.target.value)} placeholder="id_termai" />
        <label>备注</label>
        <input
          className="input"
          value={genComment}
          onChange={(e) => setGenComment(e.target.value)}
          placeholder="可选，如 termai@laptop"
        />
      </div>
      {genErr && <div className="form-error">{genErr}</div>}
      {genMsg && <div className="io-message">{genMsg}</div>}
      <div className="key-actions">
        <button className="btn" onClick={generate} disabled={generating}>
          {generating ? "生成中..." : "生成到 ~/.ssh"}
        </button>
      </div>
      <div className="form-note">生成后公钥会自动填入上方内容框，可直接部署。私钥仅保存在本机 ~/.ssh。</div>
    </>
  );
}

// ---------- 证书转换 ----------

function CertificateConvertPanel() {
  const [name, setName] = useState("id_imported");
  const [pem, setPem] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [busy, setBusy] = useState(false);

  const convert = async () => {
    if (busy) return;
    if (!name.trim()) return setError("请输入保存文件名");
    if (!pem.trim()) return setError("请粘贴 OpenSSH 私钥 PEM");
    setBusy(true);
    setError("");
    setMessage("");
    setPublicKey("");
    try {
      const key = await api.sshImportOpenSshKey(name.trim(), pem.trim(), passphrase);
      setMessage(`已生成：${key.privatePath} 和 ${key.publicPath}（指纹 ${key.fingerprint}）`);
      setPublicKey(key.publicKey);
      setPem("");
      setPassphrase("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyPublicKey = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setMessage("公钥已复制");
    } catch (e) {
      setError(`复制失败：${String(e)}`);
    }
  };

  return (
    <>
      <div className="settings-section-title">PEM 私钥转 OpenSSH 私钥 + .pub</div>
      <div className="form-note">
        粘贴 <code>BEGIN OPENSSH PRIVATE KEY</code> 私钥后，会保存为本机 <code>~/.ssh/&lt;文件名&gt;</code> 和对应 <code>.pub</code>。X.509 证书只包含公钥，不能反推出私钥。
      </div>
      <div className="form-grid">
        <label>保存文件名</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="id_imported" />
        <label>Passphrase</label>
        <input
          className="input"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="私钥已加密时填写"
        />
        <label>PEM 内容</label>
        <textarea
          className="input"
          rows={8}
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
          spellCheck={false}
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      {message && <div className="io-message">{message}</div>}
      {publicKey && (
        <textarea className="input cert-output" rows={3} value={publicKey} readOnly spellCheck={false} />
      )}
      <div className="key-actions">
        {publicKey && (
          <button className="btn" onClick={copyPublicKey}>
            复制公钥
          </button>
        )}
        <button className="btn primary" onClick={convert} disabled={busy}>
          {busy ? "转换中..." : "转换并生成 .pub"}
        </button>
      </div>
    </>
  );
}
