import type { HostHealthView, TabInfo } from "./types.ts";

type SessionHealthIdentity = {
  id: string;
  host: string;
  port: number;
};

export function applyConnectionStatusToHostHealth(
  current: Record<string, HostHealthView>,
  session: SessionHealthIdentity,
  status: TabInfo["status"],
  message?: string,
  checkedAt = Date.now()
): Record<string, HostHealthView> {
  const normalizedMessage = message?.trim() ?? "";
  if (status !== "connected" && (status !== "closed" || !normalizedMessage)) {
    return current;
  }

  const next: HostHealthView = {
    sessionId: session.id,
    host: session.host,
    port: session.port,
    status: status === "connected" ? "online" : "offline",
    latencyMs: null,
    message:
      status === "connected"
        ? "SSH 会话已连接"
        : normalizedMessage,
    checkedAt,
  };
  const previous = current[session.id];
  return previous?.status === next.status &&
    previous.host === next.host &&
    previous.port === next.port &&
    previous.latencyMs === next.latencyMs &&
    previous.message === next.message
    ? current
    : { ...current, [session.id]: next };
}
