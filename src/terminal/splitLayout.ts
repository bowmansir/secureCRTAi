import type { TabInfo } from "../types";

export type SplitDirection = "columns" | "rows";

export interface SplitLayout {
  direction: SplitDirection;
  panes: TabInfo[];
}

export type CloseSplitPanePlan =
  | {
      kind: "close-tab";
      paneId: string;
    }
  | {
      kind: "update";
      paneId: string;
      layout: SplitLayout | null;
      nextActivePaneId: string;
      promotedStatus?: TabInfo["status"];
    };

export function planCloseSplitPane(
  layout: SplitLayout,
  parentTabId: string,
  paneId: string,
  activePaneId: string,
  parentTitle: string
): CloseSplitPanePlan | null {
  const closingIndex = layout.panes.findIndex((pane) => pane.tabId === paneId);
  if (closingIndex < 0) return null;
  if (layout.panes.length === 1) return { kind: "close-tab", paneId };

  let panes = layout.panes.filter((pane) => pane.tabId !== paneId);
  const activeStillExists = panes.some((pane) => pane.tabId === activePaneId);
  const nextActivePaneId = activeStillExists
    ? activePaneId
    : panes[Math.min(closingIndex, panes.length - 1)].tabId;

  if (panes.length === 1 && panes[0].tabId === parentTabId) {
    return {
      kind: "update",
      paneId,
      layout: null,
      nextActivePaneId: parentTabId,
    };
  }

  let promotedStatus: TabInfo["status"] | undefined;
  if (panes.length === 1) {
    panes = [{ ...panes[0], title: parentTitle }];
    promotedStatus = panes[0].status;
  }
  return {
    kind: "update",
    paneId,
    layout: { ...layout, panes },
    nextActivePaneId,
    promotedStatus,
  };
}
