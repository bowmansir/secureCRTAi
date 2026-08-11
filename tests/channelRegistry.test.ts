import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentChannelRegistry,
  getAgentRuntimeKey,
} from "../src/agent/channelRegistry.ts";
import type {
  AgentChannelBackend,
  AgentCommandOutput,
} from "../src/agent/channelRegistry.ts";
import type {
  ShellExecuteAction,
} from "../src/agent/typedActions.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function action(
  surfaceId: string,
  sessionId: string,
  command = "uptime"
): ShellExecuteAction {
  return {
    type: "shell.execute",
    actionId: `${surfaceId}:${command}`,
    surfaceId,
    sessionId,
    command,
    timeoutMs: 5_000,
  };
}

function fakeBackend() {
  const calls = {
    open: [] as string[],
    run: [] as Array<{ channelId: string; command: string }>,
    interrupt: [] as string[],
    close: [] as string[],
  };
  let nextChannel = 0;
  const pending = new Map<string, Deferred<AgentCommandOutput>>();
  const backend: AgentChannelBackend = {
    async open(sessionId) {
      calls.open.push(sessionId);
      nextChannel += 1;
      return `channel-${nextChannel}`;
    },
    async run(channelId, command) {
      calls.run.push({ channelId, command });
      const key = `${channelId}:${command}`;
      const current = pending.get(key);
      return current ? current.promise : { output: command, exitCode: 0 };
    },
    async interrupt(channelId) {
      calls.interrupt.push(channelId);
    },
    async close(channelId) {
      calls.close.push(channelId);
    },
  };
  return { backend, calls, pending };
}

test("same surface reuses one channel while different surfaces stay isolated", async () => {
  const fake = fakeBackend();
  const registry = new AgentChannelRegistry(fake.backend);

  await registry.execute(action("surface-a", "session-a", "uptime"));
  await registry.execute(action("surface-a", "session-a", "df -h"));
  await registry.execute(action("surface-b", "session-b", "free -h"));

  assert.deepEqual(fake.calls.open, ["session-a", "session-b"]);
  assert.deepEqual(fake.calls.run, [
    { channelId: "channel-1", command: "uptime" },
    { channelId: "channel-1", command: "df -h" },
    { channelId: "channel-2", command: "free -h" },
  ]);
});

test("terminal and AI panel runtimes on the same surface use separate channels", async () => {
  const fake = fakeBackend();
  const registry = new AgentChannelRegistry(fake.backend);
  const shellAction = action("surface-a", "session-a", "uptime");
  const terminalKey = getAgentRuntimeKey("terminal", "surface-a");
  const aiPanelKey = getAgentRuntimeKey("ai-panel", "surface-a");

  await registry.execute(shellAction, { runtimeKey: terminalKey });
  await registry.execute(action("surface-a", "session-a", "df -h"), {
    runtimeKey: aiPanelKey,
  });

  assert.deepEqual(fake.calls.open, ["session-a", "session-a"]);
  assert.equal(registry.channelId(terminalKey), "channel-1");
  assert.equal(registry.channelId(aiPanelKey), "channel-2");

  await registry.close(aiPanelKey);

  assert.equal(registry.has(aiPanelKey), false);
  assert.equal(registry.has(terminalKey), true);
  assert.deepEqual(fake.calls.close, ["channel-2"]);
});

test("dangerous action is held for approval before a channel opens", async () => {
  const fake = fakeBackend();
  const registry = new AgentChannelRegistry(fake.backend);
  const dangerous = action("surface-a", "session-a", "systemctl restart nginx");

  const held = await registry.execute(dangerous);
  assert.equal(held.status, "approval-required");
  assert.deepEqual(fake.calls.open, []);

  const completed = await registry.execute(dangerous, { approved: true });
  assert.equal(completed.status, "completed");
  assert.deepEqual(fake.calls.open, ["session-a"]);
});

test("closing one surface leaves another surface channel alive", async () => {
  const fake = fakeBackend();
  const registry = new AgentChannelRegistry(fake.backend);
  await registry.execute(action("surface-a", "session-a"));
  await registry.execute(action("surface-b", "session-b"));

  await registry.close("surface-a");

  assert.equal(registry.has("surface-a"), false);
  assert.equal(registry.has("surface-b"), true);
  assert.deepEqual(fake.calls.close, ["channel-1"]);
});

test("changing the SSH session closes the old channel before opening a new one", async () => {
  const fake = fakeBackend();
  const registry = new AgentChannelRegistry(fake.backend);
  await registry.execute(action("surface-a", "session-a"));
  await registry.execute(action("surface-a", "session-b"));

  assert.deepEqual(fake.calls.open, ["session-a", "session-b"]);
  assert.deepEqual(fake.calls.close, ["channel-1"]);
  assert.equal(registry.channelId("surface-a"), "channel-2");
});

test("interrupt cancels stale execution and does not affect another surface", async () => {
  const fake = fakeBackend();
  const registry = new AgentChannelRegistry(fake.backend);
  const slow = deferred<AgentCommandOutput>();
  fake.pending.set("channel-1:uptime", slow);

  const running = registry.execute(action("surface-a", "session-a", "uptime"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await registry.execute(action("surface-b", "session-b", "uptime"));
  await registry.interrupt("surface-a");
  slow.resolve({ output: "late output", exitCode: 0 });

  const outcome = await running;
  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(fake.calls.interrupt, ["channel-1"]);
  assert.ok(fake.calls.close.includes("channel-1"));
  assert.equal(registry.has("surface-b"), true);
});

test("a failed channel open is cleared so the next execution can retry", async () => {
  let attempts = 0;
  const registry = new AgentChannelRegistry({
    async open() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary connection failure");
      return "channel-retry";
    },
    async run(_channelId, command) {
      return { output: command, exitCode: 0 };
    },
    async interrupt() {},
    async close() {},
  }, { watchdogGraceMs: 50 });

  await assert.rejects(
    registry.execute(action("surface-a", "session-a", "uptime")),
    /temporary connection failure/
  );
  const outcome = await registry.execute(
    action("surface-a", "session-a", "uptime")
  );

  assert.equal(attempts, 2);
  assert.equal(outcome.status, "completed");
});

test("backend cleanup can finish before the frontend watchdog takes over", async () => {
  const calls = { close: [] as string[] };
  const registry = new AgentChannelRegistry({
    async open() {
      return "channel-cleanup";
    },
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { output: "已由后端中断", exitCode: null };
    },
    async interrupt() {},
    async close(channelId) {
      calls.close.push(channelId);
    },
  }, { watchdogGraceMs: 20 });

  const outcome = await registry.execute({
    ...action("surface-a", "session-a", "uptime"),
    timeoutMs: 20,
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(calls.close, []);
});

test("execution watchdog rejects without waiting indefinitely for cleanup", async () => {
  const never = new Promise<AgentCommandOutput>(() => {});
  const registry = new AgentChannelRegistry({
    async open() {
      return "channel-timeout";
    },
    async run() {
      return never;
    },
    async interrupt() {
      await new Promise(() => {});
    },
    async close() {
      await new Promise(() => {});
    },
  }, { watchdogGraceMs: 20, interruptWaitMs: 20 });

  const started = Date.now();
  await assert.rejects(
    registry.execute({
      ...action("surface-a", "session-a", "uptime"),
      timeoutMs: 20,
    }),
    /响应超时/
  );
  assert.ok(Date.now() - started < 500);
});

test("closing a running channel still reaches close when interrupt hangs", async () => {
  const slow = deferred<AgentCommandOutput>();
  const calls = { close: [] as string[] };
  const registry = new AgentChannelRegistry({
    async open() {
      return "channel-stuck-interrupt";
    },
    async run() {
      return slow.promise;
    },
    async interrupt() {
      await new Promise(() => {});
    },
    async close(channelId) {
      calls.close.push(channelId);
    },
  }, { interruptWaitMs: 20 });

  const running = registry
    .execute(action("surface-a", "session-a", "uptime"))
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.race([
    registry.close("surface-a"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("close remained blocked")), 500)
    ),
  ]);
  slow.resolve({ output: "stopped", exitCode: null });
  await running;

  assert.deepEqual(calls.close, ["channel-stuck-interrupt"]);
});

test("a failed run invalidates the stale backend channel", async () => {
  const calls = { open: 0, run: [] as string[] };
  const registry = new AgentChannelRegistry({
    async open() {
      calls.open += 1;
      return `channel-${calls.open}`;
    },
    async run(channelId) {
      calls.run.push(channelId);
      if (channelId === "channel-1") throw new Error("backend reset channel");
      return { output: "ok", exitCode: 0 };
    },
    async interrupt() {},
    async close() {},
  });

  await assert.rejects(
    registry.execute(action("surface-a", "session-a", "uptime")),
    /backend reset channel/
  );
  const outcome = await registry.execute(
    action("surface-a", "session-a", "uptime")
  );

  assert.equal(outcome.status, "completed");
  assert.deepEqual(calls.run, ["channel-1", "channel-2"]);
});
