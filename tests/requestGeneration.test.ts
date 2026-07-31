import assert from "node:assert/strict";
import test from "node:test";
import { ScopedRequestGate } from "../src/agent/requestGeneration.ts";

test("a stopped request cannot mutate a newer request for the same conversation", () => {
  const gate = new ScopedRequestGate();
  const first = gate.begin("agent:surface-1");

  gate.invalidate("agent:surface-1");
  const second = gate.begin("agent:surface-1");

  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("invalidating a request without restarting keeps late events stale", () => {
  const gate = new ScopedRequestGate();
  const request = gate.begin("chat:surface-1");

  gate.invalidate("chat:surface-1");

  assert.equal(gate.isCurrent(request), false);
});

test("request generations are isolated between terminal surfaces", () => {
  const gate = new ScopedRequestGate();
  const firstSurface = gate.begin("agent:surface-1");
  const secondSurface = gate.begin("agent:surface-2");

  gate.invalidate("agent:surface-1");

  assert.equal(gate.isCurrent(firstSurface), false);
  assert.equal(gate.isCurrent(secondSurface), true);
});
