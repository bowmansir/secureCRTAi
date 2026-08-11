export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export type UpdateErrorCode = "configuration" | "network" | "signature" | "generic";
export type UpdateCheckSource = "automatic" | "manual";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  targetVersion?: string;
  releaseDate?: string;
  notes?: string;
  downloadedBytes: number;
  totalBytes: number | null;
  errorCode?: UpdateErrorCode;
}

export interface DesktopUpdateCandidate<THandle> {
  handle: THandle;
  version: string;
  date?: string;
  notes?: string;
  release?: () => Promise<void>;
}

export type DesktopDownloadEvent =
  | { event: "Started"; contentLength?: number }
  | { event: "Progress"; chunkLength: number }
  | { event: "Finished" };

export interface DesktopUpdateAdapter<THandle> {
  check: () => Promise<DesktopUpdateCandidate<THandle> | null>;
  downloadAndInstall: (
    handle: THandle,
    onEvent: (event: DesktopDownloadEvent) => void
  ) => Promise<void>;
  relaunch: () => Promise<void>;
}

export interface UpdateProbeEvent {
  event:
    | "update_check"
    | "update_available"
    | "update_up_to_date"
    | "update_install"
    | "update_error";
  status: "started" | "succeeded" | "failed";
  targetVersion?: string;
  errorCode?: UpdateErrorCode;
}

export type UpdateProbeReporter = (event: UpdateProbeEvent) => Promise<void>;

export interface DesktopUpdateController {
  getState: () => DesktopUpdateState;
  subscribe: (listener: (state: DesktopUpdateState) => void) => () => void;
  check: (source: UpdateCheckSource) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export function classifyUpdateError(error: unknown): UpdateErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/pubkey|public key|endpoint|configuration|config/.test(message)) return "configuration";
  if (/network|connect|dns|offline|timeout|timed out|fetch|http/.test(message)) return "network";
  if (/signature|verify|verification|minisign/.test(message)) return "signature";
  return "generic";
}

export function startupDelayMs(random: number, minSeconds: number, maxSeconds: number): number {
  const normalized = Math.min(Math.max(random, 0), 0.999999999);
  return Math.floor((minSeconds + normalized * (maxSeconds - minSeconds)) * 1000);
}

export function createDesktopUpdateController<THandle>(
  currentVersion: string,
  adapter: DesktopUpdateAdapter<THandle>,
  reportProbe?: UpdateProbeReporter
): DesktopUpdateController {
  let state: DesktopUpdateState = {
    phase: "idle",
    currentVersion,
    downloadedBytes: 0,
    totalBytes: null,
  };
  let available: DesktopUpdateCandidate<THandle> | null = null;
  let activeCheck: Promise<void> | null = null;
  let activeInstall: Promise<void> | null = null;
  const listeners = new Set<(next: DesktopUpdateState) => void>();

  const publish = (patch: Partial<DesktopUpdateState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  };

  const safeReport = async (event: UpdateProbeEvent): Promise<void> => {
    if (!reportProbe) return;
    try {
      await reportProbe(event);
    } catch {
      // 探针永远不能改变更新状态。
    }
  };

  const reportDetached = (event: UpdateProbeEvent) => {
    void safeReport(event);
  };

  const check = (_source: UpdateCheckSource): Promise<void> => {
    if (activeCheck) return activeCheck;
    activeCheck = (async () => {
      if (available?.release) void available.release().catch(() => {});
      available = null;
      publish({
        phase: "checking",
        errorCode: undefined,
        targetVersion: undefined,
        releaseDate: undefined,
        notes: undefined,
        downloadedBytes: 0,
        totalBytes: null,
      });
      reportDetached({ event: "update_check", status: "started" });
      try {
        available = await adapter.check();
        if (!available) {
          publish({
            phase: "upToDate",
            targetVersion: undefined,
            releaseDate: undefined,
            notes: undefined,
          });
          reportDetached({ event: "update_up_to_date", status: "succeeded" });
          return;
        }
        publish({
          phase: "available",
          targetVersion: available.version,
          releaseDate: available.date,
          notes: available.notes,
        });
        reportDetached({
          event: "update_available",
          status: "succeeded",
          targetVersion: available.version,
        });
      } catch (error) {
        available = null;
        const errorCode = classifyUpdateError(error);
        publish({ phase: "error", errorCode });
        reportDetached({ event: "update_error", status: "failed", errorCode });
      }
    })().finally(() => {
      activeCheck = null;
    });
    return activeCheck;
  };

  const install = (): Promise<void> => {
    if (activeInstall) return activeInstall;
    if (!available) return Promise.resolve();
    const selected = available;
    activeInstall = (async () => {
      publish({
        phase: "downloading",
        downloadedBytes: 0,
        totalBytes: null,
        errorCode: undefined,
      });
      reportDetached({
        event: "update_install",
        status: "started",
        targetVersion: selected.version,
      });
      try {
        await adapter.downloadAndInstall(selected.handle, (event) => {
          if (event.event === "Started") {
            publish({
              phase: "downloading",
              totalBytes: event.contentLength ?? null,
              downloadedBytes: 0,
            });
          } else if (event.event === "Progress") {
            publish({ downloadedBytes: state.downloadedBytes + event.chunkLength });
          } else {
            publish({ phase: "installing" });
          }
        });
        publish({ phase: "installing" });
        await safeReport({
          event: "update_install",
          status: "succeeded",
          targetVersion: selected.version,
        });
        await adapter.relaunch();
      } catch (error) {
        const errorCode = classifyUpdateError(error);
        publish({ phase: "error", errorCode });
        reportDetached({
          event: "update_error",
          status: "failed",
          targetVersion: selected.version,
          errorCode,
        });
      }
    })().finally(() => {
      activeInstall = null;
    });
    return activeInstall;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    check,
    install,
    dismiss: () => {
      if (state.phase === "downloading" || state.phase === "installing") return;
      if (available?.release) void available.release().catch(() => {});
      available = null;
      publish({ phase: "idle", errorCode: undefined });
    },
  };
}
