import assert from "node:assert/strict";
import test from "node:test";

import { isAiPanelAgentModeEnabled } from "../src/agent/aiPanelMode.ts";

test("SSH conversations enable the AI panel Agent mode by default", () => {
  assert.equal(isAiPanelAgentModeEnabled("session-1", undefined), true);
});

test("an explicit user override can disable and re-enable Agent mode", () => {
  assert.equal(isAiPanelAgentModeEnabled("session-1", false), false);
  assert.equal(isAiPanelAgentModeEnabled("session-1", true), true);
});

test("non-SSH conversations never expose Agent mode", () => {
  assert.equal(isAiPanelAgentModeEnabled(undefined, true), false);
  assert.equal(isAiPanelAgentModeEnabled(undefined, undefined), false);
});
