import assert from "node:assert/strict";
import test from "node:test";

import {
  createTerminalSurfaceStore,
} from "../src/agent/terminalSurfaceStore.ts";

test("surface store notifies only the changed surface", () => {
  const store = createTerminalSurfaceStore();
  store.ensureSurface("surface-a");
  store.ensureSurface("surface-b");
  let firstNotifications = 0;
  let secondNotifications = 0;
  const unsubscribeFirst = store.subscribeSurface(
    "surface-a",
    () => firstNotifications++
  );
  const unsubscribeSecond = store.subscribeSurface(
    "surface-b",
    () => secondNotifications++
  );

  store.dispatchToSurface("surface-a", {
    type: "set-draft",
    draft: "diagnose server a",
  });

  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 0);
  assert.equal(store.getSurface("surface-a")?.draft, "diagnose server a");
  assert.equal(store.getSurface("surface-b")?.draft, "");
  unsubscribeFirst();
  unsubscribeSecond();
});

test("unsubscribed background surfaces keep current state without rendering", () => {
  const store = createTerminalSurfaceStore();
  store.ensureSurface("surface-a");
  let notifications = 0;
  const unsubscribe = store.subscribeSurface(
    "surface-a",
    () => notifications++
  );
  unsubscribe();

  store.dispatchToSurface("surface-a", {
    type: "set-control",
    control: "streaming",
  });

  assert.equal(notifications, 0);
  assert.equal(store.getSurface("surface-a")?.control, "streaming");
});

test("removing one surface keeps the remaining surface intact", () => {
  const store = createTerminalSurfaceStore();
  store.ensureSurface("surface-a");
  store.ensureSurface("surface-b");
  store.dispatchToSurface("surface-b", {
    type: "set-draft",
    draft: "keep me",
  });

  store.removeSurface("surface-a");

  assert.equal(store.getSurface("surface-a"), undefined);
  assert.equal(store.getSurface("surface-b")?.draft, "keep me");
});
