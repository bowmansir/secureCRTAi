import type { HostHealthSummary, SessionProfile, TabInfo } from "../types";

interface Props {
  activeTab: TabInfo | null;
  sessions: SessionProfile[];
  terminalCount: number;
  transferActive: number;
  transferRateBps: number;
  termSize: { cols: number; rows: number } | null;
  healthSummary: HostHealthSummary;
}

const STATUS_TEXT: Record<TabInfo["status"], string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  closed: "已断开",
};

function fmtRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "";
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
}

export default function StatusBar({
  activeTab,
  sessions,
  terminalCount,
  transferActive,
  transferRateBps,
  termSize,
  healthSummary,
}: Props) {
  let address = "";
  let protocol = "";
  const isTerminal = activeTab?.kind === "local" || activeTab?.kind === "ssh";
  const transferRate = fmtRate(transferRateBps);
  if (activeTab) {
    if (activeTab.kind === "local") {
      address = "本地终端";
      protocol = "Shell";
    } else {
      const s = sessions.find((x) => x.id === activeTab.sessionId);
      if (s) address = `${s.username}@${s.host}:${s.port}`;
      protocol =
        activeTab.kind === "sftp" || activeTab.kind === "sftp-cli" ? "SFTP" : "SSH2";
    }
  }

  return (
    <div className="status-bar">
      <div className="status-left">
        {activeTab ? (
          <>
            <span className={`sb-dot ${activeTab.status}`} />
            <span className="sb-status">{STATUS_TEXT[activeTab.status]}</span>
            {protocol && <span className="sb-proto">{protocol}</span>}
            {address && <span className="sb-addr">{address}</span>}
          </>
        ) : (
          <span className="sb-idle">就绪</span>
        )}
      </div>
      <div className="status-right">
        {healthSummary.total > 0 && (
          <span className={`sb-health${healthSummary.offline > 0 ? " has-offline" : ""}`}>
            {healthSummary.checking
              ? "健康检查中"
              : healthSummary.checked > 0
                ? `健康 ${healthSummary.online}/${healthSummary.checked} 在线`
                : "健康未检查"}
          </span>
        )}
        {transferActive > 0 && (
          <span className="sb-transfer">
            传输 {transferActive}
            {transferRate && ` · ${transferRate}`}
          </span>
        )}
        {isTerminal && termSize && (
          <span className="sb-item">
            {termSize.cols}×{termSize.rows}
          </span>
        )}
        <span className="sb-item">终端 {terminalCount}</span>
        <span className="sb-item">UTF-8</span>
        <span className="sb-brand">TermAI</span>
      </div>
    </div>
  );
}
