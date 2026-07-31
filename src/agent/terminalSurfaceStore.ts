import {
  reduceTerminalSurfaceRegistry,
} from "./surfaceModel.ts";
import type {
  TerminalSurfaceAction,
  TerminalSurfaceRegistry,
  TerminalSurfaceState,
} from "./surfaceModel.ts";

export type TerminalSurfaceStore = {
  ensureSurface: (surfaceId: string) => void;
  removeSurface: (surfaceId: string) => void;
  dispatchToSurface: (
    surfaceId: string,
    action: TerminalSurfaceAction
  ) => void;
  getSurface: (surfaceId: string) => TerminalSurfaceState | undefined;
  subscribeSurface: (
    surfaceId: string,
    listener: () => void
  ) => () => void;
};

export function createTerminalSurfaceStore(
  initial: TerminalSurfaceRegistry = {}
): TerminalSurfaceStore {
  let registry = initial;
  const listeners = new Map<string, Set<() => void>>();

  const notify = (surfaceId: string) => {
    for (const listener of listeners.get(surfaceId) ?? []) listener();
  };

  const update = (
    surfaceId: string,
    action:
      | { type: "ensure-surface"; surfaceId: string }
      | { type: "remove-surface"; surfaceId: string }
      | {
          type: "dispatch";
          surfaceId: string;
          action: TerminalSurfaceAction;
        }
  ) => {
    const next = reduceTerminalSurfaceRegistry(registry, action);
    if (next === registry) return;
    registry = next;
    notify(surfaceId);
  };

  return {
    ensureSurface(surfaceId) {
      update(surfaceId, { type: "ensure-surface", surfaceId });
    },
    removeSurface(surfaceId) {
      update(surfaceId, { type: "remove-surface", surfaceId });
    },
    dispatchToSurface(surfaceId, action) {
      update(surfaceId, { type: "dispatch", surfaceId, action });
    },
    getSurface(surfaceId) {
      return registry[surfaceId];
    },
    subscribeSurface(surfaceId, listener) {
      const surfaceListeners =
        listeners.get(surfaceId) ?? new Set<() => void>();
      surfaceListeners.add(listener);
      listeners.set(surfaceId, surfaceListeners);
      return () => {
        surfaceListeners.delete(listener);
        if (surfaceListeners.size === 0) listeners.delete(surfaceId);
      };
    },
  };
}
