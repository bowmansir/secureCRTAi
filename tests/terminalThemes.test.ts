import assert from "node:assert/strict";
import test from "node:test";

import { getTerminalTheme } from "../src/terminal/terminalThemes.ts";

test("terminal theme stays opaque without a picture background", () => {
  assert.equal(getTerminalTheme("dark", false).background, "#0d1117");
  assert.equal(getTerminalTheme("midnight", false).background, "#060a10");
  assert.equal(getTerminalTheme("light", false).background, "#fbfdff");
});

test("terminal theme uses a readable translucent overlay over picture backgrounds", () => {
  const dark = getTerminalTheme("dark", true);
  const light = getTerminalTheme("light", true);

  assert.match(String(dark.background), /^rgba\(.+, 0\.\d+\)$/);
  assert.match(String(light.background), /^rgba\(.+, 0\.\d+\)$/);
  assert.equal(dark.foreground, "#e6edf3");
  assert.equal(light.foreground, "#172033");
});

test("terminal theme returns a new object for runtime option updates", () => {
  assert.notEqual(getTerminalTheme("dark", true), getTerminalTheme("dark", true));
});
