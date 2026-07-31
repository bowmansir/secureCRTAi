import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { agentChannels } from "./agentChannels";
import { getAgentRuntimeKey } from "./channelRegistry";
import {
  createTerminalSurfaceStore,
} from "./terminalSurfaceStore";
import type { TerminalSurfaceStore } from "./terminalSurfaceStore";
import type {
  TerminalSurfaceAction,
  TerminalSurfaceState,
} from "./surfaceModel";

type TerminalSurfaceContextValue = {
  ensureSurface: (surfaceId: string) => void;
  removeSurface: (surfaceId: string) => void;
  dispatchToSurface: (surfaceId: string, action: TerminalSurfaceAction) => void;
  getSurface: (surfaceId: string) => TerminalSurfaceState | undefined;
  subscribeSurface: TerminalSurfaceStore["subscribeSurface"];
};

const TerminalSurfaceContext = createContext<TerminalSurfaceContextValue | null>(null);

export function TerminalSurfaceProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<TerminalSurfaceStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTerminalSurfaceStore();
  }
  const store = storeRef.current;

  const ensureSurface = useCallback((surfaceId: string) => {
    store.ensureSurface(surfaceId);
  }, [store]);

  const removeSurface = useCallback((surfaceId: string) => {
    void Promise.all([
      agentChannels.close(getAgentRuntimeKey("terminal", surfaceId)),
      agentChannels.close(getAgentRuntimeKey("ai-panel", surfaceId)),
    ]);
    store.removeSurface(surfaceId);
  }, [store]);

  const dispatchToSurface = useCallback(
    (surfaceId: string, action: TerminalSurfaceAction) => {
      store.dispatchToSurface(surfaceId, action);
    },
    [store]
  );

  const value = useMemo<TerminalSurfaceContextValue>(
    () => ({
      ensureSurface,
      removeSurface,
      dispatchToSurface,
      getSurface: store.getSurface,
      subscribeSurface: store.subscribeSurface,
    }),
    [dispatchToSurface, ensureSurface, removeSurface, store]
  );

  return (
    <TerminalSurfaceContext.Provider value={value}>
      {children}
    </TerminalSurfaceContext.Provider>
  );
}

export function useTerminalSurfaces(): TerminalSurfaceContextValue {
  const value = useContext(TerminalSurfaceContext);
  if (!value) {
    throw new Error("useTerminalSurfaces must be used inside TerminalSurfaceProvider");
  }
  return value;
}

export function useTerminalSurface(
  surfaceId: string,
  subscribe = true
): TerminalSurfaceState | undefined {
  const { getSurface, subscribeSurface } = useTerminalSurfaces();
  const subscribeToSurface = useCallback(
    (listener: () => void) =>
      subscribe ? subscribeSurface(surfaceId, listener) : () => {},
    [subscribe, subscribeSurface, surfaceId]
  );
  const getSnapshot = useCallback(
    () => getSurface(surfaceId),
    [getSurface, surfaceId]
  );
  return useSyncExternalStore(
    subscribeToSurface,
    getSnapshot,
    getSnapshot
  );
}
