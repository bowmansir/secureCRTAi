import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/components/DesktopUpdateDialog.tsx", import.meta.url),
  "utf8"
);
const styles = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

test("desktop updater reuses the application modal surface", () => {
  assert.match(component, /className="modal desktop-update-dialog"/);
});

test("desktop updater keeps release notes and actions in distinct visual regions", () => {
  assert.match(component, /desktop-update-notes-title/);
  assert.match(component, /desktop-update-actions/);
  assert.match(styles, /\.desktop-update-notes-title\s*\{/);
  assert.match(styles, /\.desktop-update-actions\s*\{/);
});
