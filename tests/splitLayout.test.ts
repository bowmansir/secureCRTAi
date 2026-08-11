import test from "node:test";
import assert from "node:assert/strict";
import {
  planCloseSplitPane,
  type SplitLayout,
} from "../src/terminal/splitLayout.ts";
import type { TabInfo } from "../src/types.ts";

function pane(tabId: string, title: string): TabInfo {
  return {
    tabId,
    title,
    kind: "ssh",
    sessionId: "session-1",
    status: "connected",
  };
}

test("closing a secondary pane restores the original pane without reconnecting it", () => {
  const layout: SplitLayout = {
    direction: "columns",
    panes: [pane("parent", "Log"), pane("secondary", "Log #2")],
  };

  assert.deepEqual(
    planCloseSplitPane(layout, "parent", "secondary", "secondary", "Log"),
    {
      kind: "update",
      paneId: "secondary",
      layout: null,
      nextActivePaneId: "parent",
    }
  );
});

test("closing the original pane promotes the surviving pane in place", () => {
  const layout: SplitLayout = {
    direction: "columns",
    panes: [pane("parent", "Log"), pane("secondary", "Log #2")],
  };

  assert.deepEqual(
    planCloseSplitPane(layout, "parent", "parent", "parent", "Log"),
    {
      kind: "update",
      paneId: "parent",
      layout: {
        direction: "columns",
        panes: [pane("secondary", "Log")],
      },
      nextActivePaneId: "secondary",
      promotedStatus: "connected",
    }
  );
});

test("closing the active middle pane selects its right neighbor", () => {
  const layout: SplitLayout = {
    direction: "columns",
    panes: [
      pane("parent", "Log"),
      pane("middle", "Log #2"),
      pane("right", "Log #3"),
    ],
  };
  const result = planCloseSplitPane(
    layout,
    "parent",
    "middle",
    "middle",
    "Log"
  );

  assert.equal(result?.kind, "update");
  assert.equal(result?.kind === "update" ? result.nextActivePaneId : "", "right");
  assert.deepEqual(
    result?.kind === "update" ? result.layout?.panes.map((item) => item.tabId) : [],
    ["parent", "right"]
  );
});

test("closing an inactive pane preserves the active pane", () => {
  const layout: SplitLayout = {
    direction: "rows",
    panes: [
      pane("parent", "Log"),
      pane("middle", "Log #2"),
      pane("right", "Log #3"),
    ],
  };

  const result = planCloseSplitPane(
    layout,
    "parent",
    "middle",
    "right",
    "Log"
  );
  assert.equal(
    result?.kind === "update" ? result.nextActivePaneId : "",
    "right"
  );
});

test("closing the final promoted pane closes the parent tab", () => {
  const layout: SplitLayout = {
    direction: "columns",
    panes: [pane("secondary", "Log")],
  };

  assert.deepEqual(
    planCloseSplitPane(layout, "parent", "secondary", "secondary", "Log"),
    { kind: "close-tab", paneId: "secondary" }
  );
  assert.equal(
    planCloseSplitPane(layout, "parent", "missing", "secondary", "Log"),
    null
  );
});
