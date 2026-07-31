import assert from "node:assert/strict";
import test from "node:test";

import {
  assessAgentAction,
  parseAgentActionPlan,
  parseLegacyAgentActions,
  stripTypedActionEnvelopeForDisplay,
} from "../src/agent/typedActions.ts";
import type {
  AgentTypedAction,
  ShellExecuteAction,
} from "../src/agent/typedActions.ts";

function shell(command: string): ShellExecuteAction {
  return {
    type: "shell.execute",
    actionId: "action-1",
    surfaceId: "surface-1",
    sessionId: "session-1",
    command,
    timeoutMs: 35_000,
  };
}

test("legacy markdown commands become bounded typed shell actions", () => {
  const actions = parseLegacyAgentActions(
    [
      "先检查系统。",
      "```bash",
      "uptime",
      "```",
      "```",
      "df -h",
      "```",
      "```bash",
      "free -h",
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-1",
      sessionId: "session-1",
      cwd: "/root",
      maxActions: 2,
    }
  );

  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], {
    type: "shell.execute",
    actionId: "legacy-shell-1",
    surfaceId: "surface-1",
    sessionId: "session-1",
    cwd: "/root",
    command: "uptime",
    timeoutMs: 35_000,
  });
  assert.equal(actions[1].command, "df -h");
});

test("agent command cards accept CRLF, tilde fences and shell prompts", () => {
  const actions = parseLegacyAgentActions(
    [
      "先并行采集只读证据。\r",
      "```shell\r",
      "$ uptime\r",
      "```\r",
      "~~~bash\r",
      "df -h\r",
      "~~~\r",
      "```json\r",
      '{"not":"a shell action"}\r',
      "```\r",
    ].join("\n"),
    {
      surfaceId: "surface-1",
      sessionId: "session-1",
    }
  );

  assert.deepEqual(
    actions.map((action) => action.command),
    ["uptime", "df -h"]
  );
});

test("typed action envelopes are validated and bound to the current surface", () => {
  const plan = parseAgentActionPlan(
    [
      "先读取已有证据，再等待服务稳定。",
      "```termai-actions",
      JSON.stringify({
        actions: [
          {
            type: "terminal.readBlocks",
            surfaceId: "forged-surface",
            blockIds: ["block-2", "block-2", "block-1"],
          },
          {
            type: "terminal.wait",
            durationMs: 500,
            reason: "等待服务启动",
          },
          {
            type: "shell.execute",
            sessionId: "forged-session",
            command: "systemctl status nginx",
            timeoutMs: 999_999,
          },
        ],
      }),
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-1",
      sessionId: "session-1",
      cwd: "/opt/app",
      timeoutMs: 35_000,
    }
  );

  assert.equal(plan.source, "typed");
  assert.equal(plan.displayText, "先读取已有证据，再等待服务稳定。");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.actions, [
    {
      type: "terminal.readBlocks",
      actionId: "typed-action-1",
      surfaceId: "surface-1",
      blockIds: ["block-2", "block-1"],
    },
    {
      type: "terminal.wait",
      actionId: "typed-action-2",
      surfaceId: "surface-1",
      durationMs: 500,
      reason: "等待服务启动",
    },
    {
      type: "shell.execute",
      actionId: "typed-action-3",
      surfaceId: "surface-1",
      sessionId: "session-1",
      cwd: "/opt/app",
      command: "systemctl status nginx",
      timeoutMs: 120_000,
    },
  ]);
});

test("typed action plans keep the first safe batch when the model exceeds the limit", () => {
  const plan = parseAgentActionPlan(
    [
      "执行一轮诊断。",
      "```termai-actions",
      JSON.stringify({
        actions: Array.from({ length: 7 }, (_, index) => ({
          type: "shell.execute",
          command: `echo ${index + 1}`,
        })),
      }),
      "```",
    ].join("\n"),
    {
      surfaceId: "surface-a",
      sessionId: "session-a",
      maxActions: 5,
    }
  );

  assert.equal(plan.actions.length, 5);
  assert.deepEqual(
    plan.actions.map((action) =>
      action.type === "shell.execute" ? action.command : action.type
    ),
    ["echo 1", "echo 2", "echo 3", "echo 4", "echo 5"]
  );
  assert.deepEqual(plan.errors, []);
  assert.match(plan.warnings.join("\n"), /动作数量超过上限 5/);
  assert.equal(plan.displayText, "执行一轮诊断。");
});

test("malformed typed envelopes fail closed instead of executing markdown guesses", () => {
  const text = [
    "准备执行。",
    "```termai-actions",
    '{"actions":[{"type":"shell.execute","command":42}]}',
    "```",
    "```sh",
    "rm -rf /tmp/should-not-run",
    "```",
  ].join("\n");
  const plan = parseAgentActionPlan(text, {
    surfaceId: "surface-1",
    sessionId: "session-1",
  });

  assert.equal(plan.source, "typed");
  assert.deepEqual(plan.actions, []);
  assert.match(plan.errors.join("\n"), /shell\.execute/);
  assert.doesNotMatch(plan.displayText, /termai-actions/);
});

test("typed action metadata is hidden while the assistant response streams", () => {
  const visible = stripTypedActionEnvelopeForDisplay(
    [
      "正在检查服务状态。",
      "```termai-actions",
      '{"actions":[{"type":"shell.execute","command":"systemctl status nginx"}',
    ].join("\n"),
    true
  );

  assert.equal(visible, "正在检查服务状态。");
});

test("read-only diagnostics remain safe for automatic execution", () => {
  const commands = [
    "uptime",
    "df -h",
    "free -h",
    "ss -tulpn",
    "journalctl -u nginx -n 100 --no-pager",
    "systemctl status nginx",
    "iostat -x 1 1 2>&1 || vmstat 1 2 2>&1 || cat /proc/diskstats | head -20",
    "command 2>/dev/null",
    "command 1>&2",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("filesystem, service, package, permission and port changes require approval", () => {
  const commands = [
    "rm /tmp/file.txt",
    "cp app.conf /etc/app.conf",
    "systemctl restart nginx",
    "apt install nginx",
    "chmod 600 /etc/app.conf",
    "ufw allow 8080/tcp",
    "docker run -p 8080:80 nginx",
    "echo value > /etc/app.conf",
    "echo error 2> errors.log",
  ];

  for (const command of commands) {
    const risk = assessAgentAction(shell(command));
    assert.equal(risk.level, "approval-required", command);
    assert.ok(risk.reason, command);
  }
});

test("shell wrappers and lesser-known write primitives cannot bypass safe-auto", () => {
  const commands = [
    "bash -c 'rm -rf /tmp/example'",
    "find /tmp -type f -delete",
    "find /tmp -type f -exec rm {} \\;",
    "sed -i 's/old/new/' /etc/app.conf",
    "python -c \"open('/tmp/example', 'w').write('x')\"",
    "sh -c 'systemctl restart nginx'",
    "docker exec app touch /tmp/example",
    "ip link set eth0 down",
    "sysctl -w net.ipv4.ip_forward=1",
    "echo $(rm -rf /tmp/example)",
    "sort -o /tmp/result input.txt",
    "dmesg -c",
    "journalctl --vacuum-time=1s",
    "ip netns exec ns rm /tmp/probe",
    "ss -K dst 192.0.2.1",
    "date --set='2030-01-01'",
    "hostname new-hostname",
    "mount /dev/sdb1 /mnt",
    "uptime & touch /tmp/termai-owned",
    "uptime & sh -c 'touch /tmp/termai-owned'",
    "uptime & nc -l 4444",
    "sort -o/tmp/termai-owned /etc/hosts",
    "sar -o /tmp/termai-sar 1 1",
    "sar -o/tmp/termai-sar 1 1",
    "env --split-string='touch /tmp/termai-owned'",
    "(rm -rf /tmp/termai-owned)",
    "{ systemctl restart nginx; }",
  ];

  for (const command of commands) {
    const risk = assessAgentAction(shell(command));
    assert.equal(risk.level, "approval-required", command);
    assert.ok(risk.reason, command);
  }
});

test("compound read-only diagnostics remain eligible for safe-auto", () => {
  const commands = [
    "if command -v iostat >/dev/null 2>&1; then iostat -x 1 1; else vmstat 1 2; fi",
    "echo '=== IO ==='; if command -v iostat &>/dev/null; then iostat -x 1 1; else echo 'iostat not installed'; fi; echo '=== MEMORY ==='; free -h",
    "test -d /var/log && echo EXISTS || echo MISSING",
    "ps aux --sort=-%cpu | head -20",
    "ss -tuan | column -t",
    "uptime; echo '---MEM---'; free -m; echo '---TOP---'; top -b -n1 -o %CPU | head -30; echo '---DISK---'; df -h; echo '---IO---'; iostat -x 1 2 2>/dev/null || (echo 'iostat not found, using /proc/diskstats'; cat /proc/diskstats | head -20)",
    "timeout 8s tail -f /var/log/messages",
    "systemctl show nginx --property=ActiveState",
    "docker ps --format '{{.Names}}'",
    "ip addr show",
    "find /var/log -maxdepth 1 -type f",
  ];

  for (const command of commands) {
    assert.equal(assessAgentAction(shell(command)).level, "safe", command);
  }
});

test("empty and malformed shell actions are rejected", () => {
  assert.equal(assessAgentAction(shell("   ")).level, "invalid");
  assert.equal(assessAgentAction(shell("echo ok\0rm file")).level, "invalid");
});

test("non-shell typed actions are safe control and context operations", () => {
  const actions: AgentTypedAction[] = [
    {
      type: "terminal.readBlocks",
      actionId: "read-1",
      surfaceId: "surface-1",
      blockIds: ["block-1"],
    },
    {
      type: "terminal.wait",
      actionId: "wait-1",
      surfaceId: "surface-1",
      durationMs: 1000,
      reason: "等待服务启动",
    },
    {
      type: "terminal.interrupt",
      actionId: "interrupt-1",
      surfaceId: "surface-1",
      runtimeId: "runtime-1",
    },
  ];

  for (const action of actions) {
    assert.equal(assessAgentAction(action).level, "safe");
  }
});
