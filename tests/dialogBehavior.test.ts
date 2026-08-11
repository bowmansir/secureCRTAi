import assert from "node:assert/strict";
import test from "node:test";

import { shouldDismissDialogFromBackdrop } from "../src/components/dialogBehavior.ts";

test("approval remains pending when the user clicks outside the dialog", () => {
  assert.equal(shouldDismissDialogFromBackdrop("approval"), false);
});

test("ordinary prompt and confirm dialogs keep their existing backdrop behavior", () => {
  assert.equal(shouldDismissDialogFromBackdrop("prompt"), true);
  assert.equal(shouldDismissDialogFromBackdrop("confirm"), true);
});
