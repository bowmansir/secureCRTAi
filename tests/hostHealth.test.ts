import assert from "node:assert/strict";
import test from "node:test";

import { applyConnectionStatusToHostHealth } from "../src/hostHealth.ts";

const online = {
  "session-a": {
    sessionId: "session-a",
    host: "server.example.com",
    port: 22,
    status: "online" as const,
    latencyMs: 12,
    message: "SSH handshake and authentication succeeded",
    checkedAt: 100,
  },
};

test("a failed SSH tab immediately overrides stale online health", () => {
  const next = applyConnectionStatusToHostHealth(
    online,
    { id: "session-a", host: "server.example.com", port: 22 },
    "closed",
    "Disconnected",
    200
  );

  assert.equal(next["session-a"]?.status, "offline");
  assert.equal(next["session-a"]?.latencyMs, null);
  assert.equal(next["session-a"]?.message, "Disconnected");
  assert.equal(next["session-a"]?.checkedAt, 200);
});

test("an authenticated SSH tab is authoritative online evidence", () => {
  const next = applyConnectionStatusToHostHealth(
    {},
    { id: "session-a", host: "server.example.com", port: 22 },
    "connected",
    undefined,
    300
  );

  assert.equal(next["session-a"]?.status, "online");
  assert.equal(next["session-a"]?.message, "SSH 会话已连接");
});

test("connecting and reconnecting do not overwrite the last completed check", () => {
  assert.equal(
    applyConnectionStatusToHostHealth(
      online,
      { id: "session-a", host: "server.example.com", port: 22 },
      "reconnecting",
      undefined,
      400
    ),
    online
  );
});

test("closing a tab by user does not mark the host offline", () => {
  assert.equal(
    applyConnectionStatusToHostHealth(
      online,
      { id: "session-a", host: "server.example.com", port: 22 },
      "closed",
      undefined,
      500
    ),
    online
  );
});
