import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleAgentContext,
  createShellBlockAttachment,
  createRemoteFileAttachment,
  createTerminalSelectionAttachment,
  redactSensitiveContent,
} from "../src/agent/contextAssembler.ts";
import {
  createTerminalSurfaceState,
  reduceTerminalSurface,
} from "../src/agent/surfaceModel.ts";
import type {
  ShellBlock,
  TerminalSurfaceState,
} from "../src/agent/surfaceModel.ts";

function shellBlock(
  id: string,
  command: string,
  output: string,
  createdAt: number
): ShellBlock {
  return {
    id,
    kind: "shell",
    command,
    output,
    cwd: "/opt/app",
    exitCode: 0,
    status: "success",
    collapsed: true,
    createdAt,
  };
}

function withEnvironment(surfaceId = "terminal-a"): TerminalSurfaceState {
  return reduceTerminalSurface(createTerminalSurfaceState(surfaceId), {
    type: "set-environment",
    environment: {
      kind: "ssh",
      sessionId: "internal-session-id",
      host: "server-a.example",
      port: 2222,
      username: "root",
      shell: "bash",
      os: "Linux",
      cwd: "/root",
      connected: true,
    },
  });
}

test("assembles safe environment metadata and the latest completed shell block", () => {
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: shellBlock("old", "pwd", "/root", 1),
  });
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: shellBlock("latest", "df -h", "/dev/sda1 80%", 2),
  });

  const context = assembleAgentContext(state);

  assert.match(context.text, /Host: server-a\.example/);
  assert.match(context.text, /Port: 2222/);
  assert.match(context.text, /Command: df -h/);
  assert.doesNotMatch(context.text, /Command: pwd/);
  assert.doesNotMatch(context.text, /internal-session-id/);
  assert.deepEqual(
    context.sources.map((source) => source.id),
    ["environment:terminal-a", "block:latest"]
  );
});

test("explicitly selected block replaces the duplicate automatic recent block", () => {
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: shellBlock("latest", "journalctl -u nginx", "failed", 1),
  });
  state = reduceTerminalSurface(state, {
    type: "add-context-attachment",
    attachment: {
      id: "selected-latest",
      kind: "block",
      label: "nginx failure",
      content: "journalctl selected output",
      blockId: "latest",
    },
  });

  const context = assembleAgentContext(state);

  assert.equal(context.sources.filter((source) => source.blockId === "latest").length, 1);
  assert.match(context.text, /Attached nginx failure/);
  assert.doesNotMatch(context.text, /Recent shell block/);
});

test("selected block attachment resolves current surface output without copying it", () => {
  const selected = shellBlock("selected", "cat app.log", "real block output", 1);
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: selected,
  });
  const attachment = createShellBlockAttachment(selected);
  state = reduceTerminalSurface(state, {
    type: "add-context-attachment",
    attachment,
  });
  state = reduceTerminalSurface(state, {
    type: "set-context-policy",
    policy: "selected-blocks",
  });

  const context = assembleAgentContext(state);

  assert.equal(attachment.content, "");
  assert.match(context.text, /Command: cat app\.log/);
  assert.match(context.text, /real block output/);
  assert.doesNotMatch(context.text, /Recent shell block/);
});

test("recent block can be excluded without removing explicit attachments", () => {
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: shellBlock("latest", "ls", "file.txt", 1),
  });
  state = reduceTerminalSurface(state, {
    type: "add-context-attachment",
    attachment: {
      id: "file-1",
      kind: "file",
      label: "/etc/nginx/nginx.conf",
      content: "server { listen 80; }",
    },
  });

  const context = assembleAgentContext(state, { includeRecentBlock: false });

  assert.doesNotMatch(context.text, /Command: ls/);
  assert.match(context.text, /server \{ listen 80; \}/);
});

test("none policy keeps attachments locally but excludes them from model context", () => {
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "add-context-attachment",
    attachment: {
      id: "selection-1",
      kind: "selection",
      label: "selected error",
      content: "private terminal selection",
    },
  });
  state = reduceTerminalSurface(state, {
    type: "set-context-policy",
    policy: "none",
  });

  const context = assembleAgentContext(state);

  assert.equal(state.contextAttachments.length, 1);
  assert.doesNotMatch(context.text, /private terminal selection/);
  assert.deepEqual(
    context.sources.map((source) => source.kind),
    ["environment"]
  );
});

test("context budget reports truncation and never exceeds the requested size", () => {
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: shellBlock("large", "cat large.log", "x".repeat(2_000), 1),
  });

  const context = assembleAgentContext(state, { maxChars: 320 });

  assert.equal(context.truncated, true);
  assert.ok(context.charCount <= 320);
  assert.ok(
    context.sources.some((source) => source.truncated) ||
      context.omittedSourceIds.includes("block:large")
  );
});

test("creates a remote file attachment with its path and content", () => {
  const attachment = createRemoteFileAttachment(
    "context-file-1",
    "/etc/nginx/nginx.conf",
    "server { listen 80; }"
  );

  assert.equal(attachment.kind, "file");
  assert.equal(attachment.label, "nginx.conf");
  assert.match(attachment.content, /Remote path: \/etc\/nginx\/nginx\.conf/);
  assert.match(attachment.content, /server \{ listen 80; \}/);
});

test("creates a bounded terminal selection attachment", () => {
  const attachment = createTerminalSelectionAttachment(
    "selection-1",
    `  nginx failed\n${"x".repeat(40_000)}  `
  );

  assert.equal(attachment.kind, "selection");
  assert.equal(attachment.label, "终端选中：nginx failed");
  assert.ok(attachment.content.length <= 32_100);
  assert.match(attachment.content, /selection truncated/);
});

test("redacts common credentials without changing the original block", () => {
  const original = [
    "API_KEY=super-secret-value",
    "Authorization: Bearer abc.def.ghi",
    "token: ghp_1234567890abcdefghijkl",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "private-material",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  let state = withEnvironment();
  state = reduceTerminalSurface(state, {
    type: "append-block",
    block: shellBlock("secret", "cat .env", original, 1),
  });

  const context = assembleAgentContext(state);

  assert.equal(context.redacted, true);
  assert.doesNotMatch(context.text, /super-secret-value/);
  assert.doesNotMatch(context.text, /abc\.def\.ghi/);
  assert.doesNotMatch(context.text, /private-material/);
  assert.match(context.text, /\[REDACTED\]/);
  assert.equal((state.blocks[0] as ShellBlock).output, original);
});

test("redaction helper leaves ordinary output unchanged", () => {
  assert.deepEqual(redactSensitiveContent("nginx is running"), {
    value: "nginx is running",
    redacted: false,
  });
});

test("assembler never reads blocks from another surface", () => {
  let first = withEnvironment("terminal-a");
  let second = withEnvironment("terminal-b");
  first = reduceTerminalSurface(first, {
    type: "append-block",
    block: shellBlock("first", "hostname", "server-a", 1),
  });
  second = reduceTerminalSurface(second, {
    type: "append-block",
    block: shellBlock("second", "hostname", "server-b", 1),
  });

  const context = assembleAgentContext(first);

  assert.match(context.text, /server-a/);
  assert.doesNotMatch(context.text, /server-b/);
});
