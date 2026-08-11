import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyUpdateError,
  createDesktopUpdateController,
  startupDelayMs,
  type DesktopUpdateAdapter,
  type DesktopUpdateCandidate,
  type UpdateProbeEvent,
} from "../src/update/desktopUpdateController.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidate(): DesktopUpdateCandidate<string> {
  return {
    handle: "release-1",
    version: "0.2.0",
    date: "2026-08-11T10:00:00Z",
    notes: "新增在线升级",
  };
}

test("automatic and manual checks share one in-flight request", async () => {
  const pending = deferred<DesktopUpdateCandidate<string> | null>();
  let checks = 0;
  const adapter: DesktopUpdateAdapter<string> = {
    check: () => {
      checks += 1;
      return pending.promise;
    },
    downloadAndInstall: async () => {},
    relaunch: async () => {},
  };
  const controller = createDesktopUpdateController("0.1.0", adapter);

  const automatic = controller.check("automatic");
  const manual = controller.check("manual");
  assert.equal(automatic, manual);
  assert.equal(checks, 1);
  assert.equal(controller.getState().phase, "checking");

  pending.resolve(candidate());
  await automatic;
  assert.equal(controller.getState().phase, "available");
  assert.equal(controller.getState().targetVersion, "0.2.0");
});

test("up-to-date and available results retain the current version", async () => {
  const results = [null, candidate()] as Array<DesktopUpdateCandidate<string> | null>;
  const adapter: DesktopUpdateAdapter<string> = {
    check: async () => results.shift() ?? null,
    downloadAndInstall: async () => {},
    relaunch: async () => {},
  };
  const controller = createDesktopUpdateController("0.1.0", adapter);

  await controller.check("manual");
  assert.equal(controller.getState().phase, "upToDate");
  assert.equal(controller.getState().currentVersion, "0.1.0");
  assert.equal(controller.getState().targetVersion, undefined);

  await controller.check("manual");
  assert.equal(controller.getState().phase, "available");
  assert.equal(controller.getState().currentVersion, "0.1.0");
});

test("download progress leads to install and relaunch", async () => {
  let relaunched = false;
  const events: UpdateProbeEvent[] = [];
  const successfulInstallReport = deferred<void>();
  const adapter: DesktopUpdateAdapter<string> = {
    check: async () => candidate(),
    downloadAndInstall: async (_handle, onEvent) => {
      onEvent({ event: "Started", contentLength: 100 });
      onEvent({ event: "Progress", chunkLength: 40 });
      onEvent({ event: "Progress", chunkLength: 60 });
      onEvent({ event: "Finished" });
    },
    relaunch: async () => {
      relaunched = true;
    },
  };
  const controller = createDesktopUpdateController("0.1.0", adapter, async (event) => {
    events.push(event);
    if (event.event === "update_install" && event.status === "succeeded") {
      await successfulInstallReport.promise;
    }
  });

  await controller.check("manual");
  const installing = controller.install();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState().phase, "installing");
  assert.equal(controller.getState().downloadedBytes, 100);
  assert.equal(relaunched, false);
  successfulInstallReport.resolve(undefined);
  await installing;
  assert.equal(relaunched, true);
  assert.ok(events.some((event) => event.event === "update_available"));
  assert.ok(events.some((event) => event.event === "update_install" && event.status === "succeeded"));
});

test("probe failures never change a successful update result", async () => {
  const adapter: DesktopUpdateAdapter<string> = {
    check: async () => null,
    downloadAndInstall: async () => {},
    relaunch: async () => {},
  };
  const controller = createDesktopUpdateController("0.1.0", adapter, async () => {
    throw new Error("probe offline");
  });

  await controller.check("automatic");
  assert.equal(controller.getState().phase, "upToDate");
});

test("a new failed check releases and clears the previous candidate", async () => {
  let released = false;
  let checkCount = 0;
  const previous = candidate();
  previous.release = async () => {
    released = true;
  };
  const adapter: DesktopUpdateAdapter<string> = {
    check: async () => {
      checkCount += 1;
      if (checkCount === 1) return previous;
      throw new Error("network offline");
    },
    downloadAndInstall: async () => {},
    relaunch: async () => {},
  };
  const controller = createDesktopUpdateController("0.1.0", adapter);

  await controller.check("manual");
  await controller.check("manual");
  assert.equal(released, true);
  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().targetVersion, undefined);
});

test("configuration, network and signature failures are classified without raw details", () => {
  assert.equal(classifyUpdateError(new Error("updater pubkey is missing")), "configuration");
  assert.equal(classifyUpdateError(new Error("request timed out while connecting")), "network");
  assert.equal(classifyUpdateError(new Error("signature verification failed")), "signature");
  assert.equal(classifyUpdateError(new Error("unexpected failure at C:\\secret")), "generic");
});

test("startup delays stay inside the required windows", () => {
  assert.equal(startupDelayMs(0, 8, 15), 8_000);
  assert.equal(startupDelayMs(0.999999, 8, 15), 14_999);
  assert.equal(startupDelayMs(0, 18, 30), 18_000);
  assert.equal(startupDelayMs(1, 18, 30), 29_999);
});
