import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import * as api from "../api";
import {
  createDesktopUpdateController,
  startupDelayMs,
  type DesktopUpdateController,
  type DesktopUpdateState,
  type UpdateProbeEvent,
} from "./desktopUpdateController";

interface DesktopUpdateContextValue {
  state: DesktopUpdateState;
  runtimeAvailable: boolean;
  automaticChecks: boolean;
  setAutomaticChecks: (enabled: boolean) => void;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

const INITIAL_STATE: DesktopUpdateState = {
  phase: "idle",
  currentVersion: "",
  downloadedBytes: 0,
  totalBytes: null,
};

const DesktopUpdateContext = createContext<DesktopUpdateContextValue | null>(null);

function loadAutomaticChecks(): boolean {
  try {
    const value = localStorage.getItem("termexa.automaticUpdateChecks");
    return value === null ? true : JSON.parse(value) !== false;
  } catch {
    return true;
  }
}

async function reportProbe(event: UpdateProbeEvent | { event: "startup"; status: "succeeded" }) {
  try {
    await api.desktopProbeReport(event);
  } catch {
    // 探针始终是 best-effort，不能改变启动或更新结果。
  }
}

export function DesktopUpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopUpdateState>(INITIAL_STATE);
  const [runtimeAvailable, setRuntimeAvailable] = useState(false);
  const [automaticChecks, setAutomaticChecksState] = useState(loadAutomaticChecks);
  const controllerRef = useRef<DesktopUpdateController | null>(null);
  const automaticChecksRef = useRef(automaticChecks);
  automaticChecksRef.current = automaticChecks;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;

    void Promise.all([
      import("@tauri-apps/api/app"),
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]).then(async ([appModule, updaterModule, processModule]) => {
      const currentVersion = await appModule.getVersion();
      if (disposed) return;
      const controller = createDesktopUpdateController(
        currentVersion,
        {
          check: async () => {
            const update = await updaterModule.check({ timeout: 15_000 });
            return update
              ? {
                  handle: update,
                  version: update.version,
                  date: update.date,
                  notes: update.body,
                  release: () => update.close(),
                }
              : null;
          },
          downloadAndInstall: (update, onEvent) =>
            update.downloadAndInstall((event) => {
              if (event.event === "Started") {
                onEvent({ event: "Started", contentLength: event.data.contentLength });
              } else if (event.event === "Progress") {
                onEvent({ event: "Progress", chunkLength: event.data.chunkLength });
              } else {
                onEvent({ event: "Finished" });
              }
            }, { timeout: 10 * 60_000 }),
          relaunch: processModule.relaunch,
        },
        reportProbe
      );
      controllerRef.current = controller;
      unsubscribe = controller.subscribe(setState);
      setRuntimeAvailable(true);

      startupTimer = setTimeout(() => {
        void reportProbe({ event: "startup", status: "succeeded" });
      }, startupDelayMs(Math.random(), 8, 15));

      updateTimer = setTimeout(() => {
        if (automaticChecksRef.current) void controller.check("automatic");
      }, startupDelayMs(Math.random(), 18, 30));
    }).catch(() => {
      if (!disposed) {
        setRuntimeAvailable(false);
        setState((current) => ({ ...current, phase: "error", errorCode: "configuration" }));
      }
    });

    return () => {
      disposed = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (updateTimer) clearTimeout(updateTimer);
      unsubscribe?.();
      controllerRef.current = null;
    };
  }, []);

  const setAutomaticChecks = useCallback((enabled: boolean) => {
    automaticChecksRef.current = enabled;
    setAutomaticChecksState(enabled);
    try {
      localStorage.setItem("termexa.automaticUpdateChecks", JSON.stringify(enabled));
    } catch {
      // 偏好写入失败不影响手动检查。
    }
  }, []);

  const value = useMemo<DesktopUpdateContextValue>(() => ({
    state,
    runtimeAvailable,
    automaticChecks,
    setAutomaticChecks,
    checkNow: () => controllerRef.current?.check("manual") ?? Promise.resolve(),
    install: () => controllerRef.current?.install() ?? Promise.resolve(),
    dismiss: () => controllerRef.current?.dismiss(),
  }), [automaticChecks, runtimeAvailable, setAutomaticChecks, state]);

  return <DesktopUpdateContext.Provider value={value}>{children}</DesktopUpdateContext.Provider>;
}

export function useDesktopUpdate(): DesktopUpdateContextValue {
  const value = useContext(DesktopUpdateContext);
  if (!value) throw new Error("useDesktopUpdate must be used inside DesktopUpdateProvider");
  return value;
}
