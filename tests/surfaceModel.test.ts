import assert from "node:assert/strict";
import test from "node:test";

import {
  createTerminalSurfaceState,
  canTransitionAgentControl,
  MAX_CONTEXT_ATTACHMENTS,
  reduceTerminalSurface,
  reduceTerminalSurfaceRegistry,
  updateTerminalBlock,
} from "../src/agent/surfaceModel.ts";
import type {
  AgentMessageBlock,
  TerminalSurfaceRegistry,
} from "../src/agent/surfaceModel.ts";

function message(id: string, content = ""): AgentMessageBlock {
  return {
    id,
    kind: "agent-message",
    content,
    status: "streaming",
    createdAt: 1,
  };
}

test("surface state starts isolated with conservative input defaults", () => {
  const first = createTerminalSurfaceState("terminal-1");
  const second = createTerminalSurfaceState("terminal-2");

  assert.deepEqual(first, {
    surfaceId: "terminal-1",
    inputTarget: "shell",
    manualOverride: null,
    executionPolicy: "safe-auto",
    contextPolicy: "recent",
    contextAttachments: [],
    environment: null,
    draft: "",
    control: "idle",
    blocks: [],
  });
  assert.notEqual(first.blocks, second.blocks);
  assert.notEqual(first.contextAttachments, second.contextAttachments);
});

test("blocks keep insertion order and duplicate ids are ignored", () => {
  let state = createTerminalSurfaceState("terminal-1");
  state = reduceTerminalSurface(state, { type: "append-block", block: message("a", "first") });
  state = reduceTerminalSurface(state, { type: "append-block", block: message("b", "second") });
  const unchanged = reduceTerminalSurface(state, {
    type: "append-block",
    block: message("a", "duplicate"),
  });

  assert.deepEqual(state.blocks.map((block) => block.id), ["a", "b"]);
  assert.equal(unchanged, state);
});

test("streaming updates replace one block without reordering the timeline", () => {
  let state = createTerminalSurfaceState("terminal-1");
  state = reduceTerminalSurface(state, { type: "append-block", block: message("a") });
  state = reduceTerminalSurface(state, { type: "append-block", block: message("b", "later") });
  state = updateTerminalBlock(state, "a", (block) =>
    block.kind === "agent-message"
      ? { ...block, content: "streamed reply", status: "complete" }
      : block
  );

  assert.deepEqual(state.blocks.map((block) => block.id), ["a", "b"]);
  assert.deepEqual(state.blocks[0], {
    ...message("a", "streamed reply"),
    status: "complete",
  });
  assert.equal((state.blocks[0] as AgentMessageBlock).status, "complete");
});

test("control and input decisions stay scoped to their surface", () => {
  const first = reduceTerminalSurface(
    reduceTerminalSurface(
      reduceTerminalSurface(createTerminalSurfaceState("terminal-1"), {
        type: "set-manual-override",
        target: "agent",
      }),
      { type: "set-input-target", target: "agent" }
    ),
    { type: "set-control", control: "executing" }
  );
  const second = createTerminalSurfaceState("terminal-2");

  assert.equal(first.manualOverride, "agent");
  assert.equal(first.inputTarget, "agent");
  assert.equal(first.control, "executing");
  assert.equal(second.manualOverride, null);
  assert.equal(second.inputTarget, "shell");
  assert.equal(second.control, "idle");
});

test("control state machine accepts workflow transitions and rejects impossible jumps", () => {
  assert.equal(canTransitionAgentControl("idle", "streaming"), true);
  assert.equal(canTransitionAgentControl("streaming", "executing"), true);
  assert.equal(canTransitionAgentControl("executing", "waiting-approval"), true);
  assert.equal(canTransitionAgentControl("waiting-approval", "executing"), true);
  assert.equal(canTransitionAgentControl("executing", "streaming"), true);
  assert.equal(canTransitionAgentControl("streaming", "paused"), true);
  assert.equal(canTransitionAgentControl("paused", "executing"), true);
  assert.equal(canTransitionAgentControl("raw-terminal", "idle"), true);
  assert.equal(canTransitionAgentControl("raw-terminal", "streaming"), false);
  assert.equal(canTransitionAgentControl("waiting-approval", "raw-terminal"), false);

  const raw = reduceTerminalSurface(createTerminalSurfaceState("terminal-1"), {
    type: "set-control",
    control: "raw-terminal",
  });
  const unchanged = reduceTerminalSurface(raw, {
    type: "set-control",
    control: "streaming",
  });
  assert.equal(unchanged, raw);
});

test("context policy changes stay scoped to one surface", () => {
  const first = reduceTerminalSurface(
    createTerminalSurfaceState("terminal-1"),
    { type: "set-context-policy", policy: "selected-blocks" }
  );
  const second = createTerminalSurfaceState("terminal-2");

  assert.equal(first.contextPolicy, "selected-blocks");
  assert.equal(second.contextPolicy, "recent");
});

test("clear removes timeline data and returns control to the user", () => {
  let state = createTerminalSurfaceState("terminal-1");
  state = reduceTerminalSurface(state, { type: "append-block", block: message("a") });
  state = reduceTerminalSurface(state, { type: "set-control", control: "streaming" });
  state = reduceTerminalSurface(state, { type: "set-draft", draft: "pending request" });
  state = reduceTerminalSurface(state, {
    type: "set-manual-override",
    target: "agent",
  });
  state = reduceTerminalSurface(state, {
    type: "set-input-target",
    target: "agent",
  });
  state = reduceTerminalSurface(state, {
    type: "set-context-policy",
    policy: "selected-blocks",
  });
  state = reduceTerminalSurface(state, {
    type: "set-conversation",
    conversationId: "conversation-1",
    runtimeId: "runtime-1",
  });
  state = reduceTerminalSurface(state, {
    type: "add-context-attachment",
    attachment: {
      id: "attachment-1",
      kind: "selection",
      label: "selection",
      content: "selected output",
    },
  });
  state = reduceTerminalSurface(state, { type: "clear" });

  assert.deepEqual(state.blocks, []);
  assert.deepEqual(state.contextAttachments, []);
  assert.equal(state.control, "idle");
  assert.equal(state.draft, "");
  assert.equal(state.inputTarget, "shell");
  assert.equal(state.manualOverride, null);
  assert.equal(state.contextPolicy, "recent");
  assert.equal(state.conversationId, undefined);
  assert.equal(state.runtimeId, undefined);
});

test("clear resets empty manual mode and context state instead of returning early", () => {
  let state = createTerminalSurfaceState("terminal-1");
  state = reduceTerminalSurface(state, {
    type: "set-manual-override",
    target: "agent",
  });
  state = reduceTerminalSurface(state, {
    type: "set-input-target",
    target: "agent",
  });
  state = reduceTerminalSurface(state, {
    type: "set-context-policy",
    policy: "selected-blocks",
  });

  state = reduceTerminalSurface(state, { type: "clear" });

  assert.equal(state.inputTarget, "shell");
  assert.equal(state.manualOverride, null);
  assert.equal(state.contextPolicy, "recent");
});

test("context attachments are isolated and duplicate ids are ignored", () => {
  const attachment = {
    id: "attachment-1",
    kind: "block" as const,
    label: "ls output",
    content: "file.txt",
    blockId: "block-1",
  };
  let first = createTerminalSurfaceState("terminal-1");
  first = reduceTerminalSurface(first, {
    type: "add-context-attachment",
    attachment,
  });
  const unchanged = reduceTerminalSurface(first, {
    type: "add-context-attachment",
    attachment: { ...attachment, content: "duplicate" },
  });
  const second = createTerminalSurfaceState("terminal-2");

  assert.equal(unchanged, first);
  assert.deepEqual(first.contextAttachments, [attachment]);
  assert.deepEqual(second.contextAttachments, []);
});

test("context attachments have a per-surface memory bound", () => {
  let state = createTerminalSurfaceState("terminal-1");
  for (let index = 0; index <= MAX_CONTEXT_ATTACHMENTS; index += 1) {
    state = reduceTerminalSurface(state, {
      type: "add-context-attachment",
      attachment: {
        id: `attachment-${index}`,
        kind: "selection",
        label: `selection ${index}`,
        content: "output",
      },
    });
  }

  assert.equal(state.contextAttachments.length, MAX_CONTEXT_ATTACHMENTS);
  assert.equal(
    state.contextAttachments.some(
      (attachment) =>
        attachment.id === `attachment-${MAX_CONTEXT_ATTACHMENTS}`
    ),
    false
  );
});

test("registry isolates twenty surfaces and removes only the closed surface", () => {
  let registry: TerminalSurfaceRegistry = {};
  for (let index = 1; index <= 20; index += 1) {
    registry = reduceTerminalSurfaceRegistry(registry, {
      type: "ensure-surface",
      surfaceId: `terminal-${index}`,
    });
  }

  registry = reduceTerminalSurfaceRegistry(registry, {
    type: "dispatch",
    surfaceId: "terminal-7",
    action: { type: "set-control", control: "executing" },
  });
  registry = reduceTerminalSurfaceRegistry(registry, {
    type: "dispatch",
    surfaceId: "terminal-7",
    action: { type: "set-draft", draft: "diagnose this server" },
  });

  assert.equal(Object.keys(registry).length, 20);
  assert.equal(registry["terminal-7"].control, "executing");
  assert.equal(registry["terminal-7"].draft, "diagnose this server");
  assert.equal(registry["terminal-8"].control, "idle");
  assert.equal(registry["terminal-8"].draft, "");

  registry = reduceTerminalSurfaceRegistry(registry, {
    type: "remove-surface",
    surfaceId: "terminal-7",
  });

  assert.equal(Object.keys(registry).length, 19);
  assert.equal(registry["terminal-7"], undefined);
  assert.ok(registry["terminal-8"]);
});
