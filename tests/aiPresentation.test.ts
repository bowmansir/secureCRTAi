import assert from "node:assert/strict";
import test from "node:test";

import { resolveAiPresentation } from "../src/agent/aiPresentation.ts";

test("inline terminal is the default when legacy AI mode is off", () => {
  assert.deepEqual(resolveAiPresentation(false, "ssh"), {
    legacyPanelMounted: false,
    legacyPanelVisible: false,
    legacyPanelSuppressed: false,
    inlineTerminalEnabled: true,
  });
});

test("legacy AI mode hides the inline composer on terminal tabs", () => {
  assert.deepEqual(resolveAiPresentation(true, "ssh"), {
    legacyPanelMounted: true,
    legacyPanelVisible: true,
    legacyPanelSuppressed: false,
    inlineTerminalEnabled: false,
  });
});

test("SFTP only suppresses legacy AI presentation without changing modes", () => {
  assert.deepEqual(resolveAiPresentation(true, "sftp"), {
    legacyPanelMounted: true,
    legacyPanelVisible: false,
    legacyPanelSuppressed: true,
    inlineTerminalEnabled: false,
  });
});

test("returning from SFTP restores the same legacy mode", () => {
  const hidden = resolveAiPresentation(true, "sftp-cli");
  const restored = resolveAiPresentation(hidden.legacyPanelMounted, "ssh");

  assert.equal(hidden.legacyPanelVisible, false);
  assert.equal(restored.legacyPanelVisible, true);
  assert.equal(restored.inlineTerminalEnabled, false);
});

test("hiding legacy mode keeps an opened panel mounted without blocking inline input", () => {
  assert.deepEqual(resolveAiPresentation(false, "ssh", true), {
    legacyPanelMounted: true,
    legacyPanelVisible: false,
    legacyPanelSuppressed: false,
    inlineTerminalEnabled: true,
  });
});
