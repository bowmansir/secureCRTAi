import { useDesktopUpdate } from "../update/DesktopUpdateContext";

const ERROR_COPY = {
  configuration: "更新签名或服务地址尚未正确配置。",
  network: "暂时无法连接更新服务，请稍后重试。",
  signature: "更新包签名校验失败，已停止安装。",
  generic: "检查或安装更新失败，请稍后重试。",
} as const;

export default function DesktopUpdateDialog() {
  const { state, install, dismiss } = useDesktopUpdate();
  const visible =
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "installing" ||
    (state.phase === "error" && Boolean(state.targetVersion));
  if (!visible) return null;

  const progress = state.totalBytes && state.totalBytes > 0
    ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
    : null;
  const busy = state.phase === "downloading" || state.phase === "installing";

  return (
    <div className="modal-mask desktop-update-mask" role="presentation">
      <div className="modal desktop-update-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-update-title">
        <div className="desktop-update-header">
          <div className="desktop-update-icon" aria-hidden="true">↑</div>
          <div>
            <div className="desktop-update-eyebrow">软件更新</div>
            <h3 id="desktop-update-title">
              {state.phase === "available" ? "发现 Termexa 新版本" : "Termexa 在线更新"}
            </h3>
          </div>
        </div>
        <div className="desktop-update-versions">
          <span>v{state.currentVersion}</span>
          <span className="desktop-update-version-arrow" aria-hidden="true">→</span>
          <strong>v{state.targetVersion}</strong>
        </div>
        {state.releaseDate && (
          <div className="desktop-update-release-date">
            发布时间：{new Date(state.releaseDate).toLocaleString()}
          </div>
        )}
        {state.notes && (
          <section className="desktop-update-notes" aria-labelledby="desktop-update-notes-title">
            <div id="desktop-update-notes-title" className="desktop-update-notes-title">本次更新</div>
            <div className="desktop-update-notes-content">{state.notes}</div>
          </section>
        )}
        {state.phase === "downloading" && (
          <div className="desktop-update-progress">
            <div className="desktop-update-progress-track">
              <span style={{ width: `${progress ?? 35}%` }} className={progress === null ? "indeterminate" : ""} />
            </div>
            <div className="form-note">{progress === null ? "正在下载更新…" : `正在下载 ${progress}%`}</div>
          </div>
        )}
        {state.phase === "installing" && <div className="desktop-update-status">正在安装，完成后将自动重启…</div>}
        {state.phase === "error" && state.errorCode && (
          <div className="form-error">{ERROR_COPY[state.errorCode]}</div>
        )}
        <div className="modal-footer desktop-update-actions">
          <button className="btn" type="button" onClick={dismiss} disabled={busy}>
            稍后处理
          </button>
          <button className="btn primary" type="button" onClick={() => void install()} disabled={busy || state.phase === "error"}>
            {state.phase === "downloading" ? "下载中…" : state.phase === "installing" ? "安装中…" : "下载并安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
