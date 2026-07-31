import assert from "node:assert/strict";
import test from "node:test";

import {
  SHELL_BLOCK_AUTO_COLLAPSE_THRESHOLD,
  SHELL_BLOCK_OUTPUT_LIMIT,
  appendShellBlockOutput,
  completeShellBlock,
  createShellBlock,
  isInteractiveShellCommand,
  stripTerminalControlSequences,
} from "../src/terminal/shellBlocks.ts";

test("creates and completes a structured shell block", () => {
  const running = createShellBlock("shell-1", "df -h", "/root");
  const withOutput = appendShellBlockOutput(
    running,
    "\x1b[32m/dev/sda1  50%\x1b[0m\r\n"
  );
  const completed = completeShellBlock(withOutput, 0, "/opt/app");

  assert.equal(completed.command, "df -h");
  assert.equal(completed.output, "/dev/sda1  50%");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.status, "success");
  assert.equal(completed.cwd, "/root");
  assert.equal(completed.collapsed, false);
});

test("removes the shell-echoed command from completed block output", () => {
  const running = appendShellBlockOutput(
    createShellBlock("shell-echo", "uptime", "/root"),
    "uptime\r\n11:50:13 up 3 days\r\n"
  );

  assert.equal(
    completeShellBlock(running, 0, "/root").output,
    "11:50:13 up 3 days"
  );
});

test("removes repeated prompt redraws before the real command output", () => {
  const running = appendShellBlockOutput(
    createShellBlock("shell-tab", "cat /etc/hostname", "/root"),
    [
      "cat /etc/hostname",
      "[root@proxy_52 ~]# cat /etc/hostname",
      "[root@proxy_52 ~]# cat /etc/hostname",
      "proxy_52",
      "",
    ].join("\r\n")
  );

  assert.equal(completeShellBlock(running, 0, "/root").output, "proxy_52");
});

test("removes wrapped prompt redraws before long command output", () => {
  const command = `echo ${"a".repeat(170)}; cat /etc/hostname`;
  const splitAt = 105;
  const afterEcho = command.indexOf(" ") + 1;
  const wrappedCommand = `${command.slice(0, afterEcho)}\r${command.slice(
    afterEcho,
    splitAt
  )} \r${command.slice(splitAt)}`;
  const running = appendShellBlockOutput(
    createShellBlock("shell-tab-wrapped", command, "/root"),
    [
      wrappedCommand,
      `[root@proxy_52 ~]# ${wrappedCommand}`,
      `[root@proxy_52 ~]# ${wrappedCommand}`,
      "real-output",
      "proxy_52",
      "",
    ].join("\r\n")
  );

  assert.equal(
    completeShellBlock(running, 0, "/root").output,
    "real-output\nproxy_52"
  );
});

test("marks a failed command and uses the prompt cwd when start cwd is unknown", () => {
  const completed = completeShellBlock(
    createShellBlock("shell-2", "false"),
    1,
    "/srv"
  );
  assert.equal(completed.status, "error");
  assert.equal(completed.cwd, "/srv");
});

test("keeps the backend command id through output and completion", () => {
  const running = createShellBlock(
    "shell-command-id",
    "printf ok",
    "/root",
    false,
    "command-42"
  );
  const completed = completeShellBlock(
    appendShellBlockOutput(running, "ok\r\n"),
    0,
    "/root"
  );

  assert.equal(completed.commandId, "command-42");
});

test("strips OSC, CSI, carriage returns, and backspace edits", () => {
  assert.equal(
    stripTerminalControlSequences(
      "abc\bD\r\n\x1b[31mred\x1b[0m\x1b]0;title\x07"
    ),
    "abD\nred"
  );
});

test("bounds retained shell output", () => {
  const output = appendShellBlockOutput(
    createShellBlock("shell-3", "cat large.log"),
    "x".repeat(SHELL_BLOCK_OUTPUT_LIMIT + 20)
  ).output;
  assert.match(output, /^\[较早输出已截断\]\n/);
  assert.equal(
    output.length,
    SHELL_BLOCK_OUTPUT_LIMIT + "[较早输出已截断]\n".length
  );
});

test("auto-collapses large completed output without hiding small output", () => {
  const large = appendShellBlockOutput(
    createShellBlock("shell-large", "cat large.log"),
    "x".repeat(SHELL_BLOCK_AUTO_COLLAPSE_THRESHOLD + 1)
  );
  const small = appendShellBlockOutput(
    createShellBlock("shell-small", "printf ok"),
    "ok"
  );

  assert.equal(completeShellBlock(large, 0, "/root").collapsed, true);
  assert.equal(completeShellBlock(small, 0, "/root").collapsed, false);
});

test("keeps full-screen interactive output in xterm instead of the DOM timeline", () => {
  const running = createShellBlock("shell-top", "top", "/root", true);
  const afterScreenRefresh = appendShellBlockOutput(
    running,
    "\x1b[H\x1b[2Jtop - 20:10:00 up 1 day\r\n"
  );
  const completed = completeShellBlock(afterScreenRefresh, 0, "/root");

  assert.equal(afterScreenRefresh, running);
  assert.equal(completed.interactive, true);
  assert.equal(completed.output, "");
  assert.equal(completed.collapsed, true);
  assert.equal(completed.status, "success");
});

test("detects raw terminal commands without treating scripts as REPLs", () => {
  for (const command of [
    "vim /etc/nginx/nginx.conf",
    "sudo -u app top",
    "sudo systemctl status nginx",
    "env TERM=xterm htop",
    "python3",
    "psql postgresql://localhost/db",
    "bash",
    "zsh -l",
    "pwsh -NoExit",
  ]) {
    assert.equal(isInteractiveShellCommand(command), true, command);
  }
  for (const command of [
    "python3 deploy.py",
    "node script.js",
    "psql -c 'select 1'",
    "mysql --execute 'select 1'",
    "redis-cli ping",
    "bash deploy.sh",
    "bash -c 'echo ok'",
    "pwsh -File deploy.ps1",
  ]) {
    assert.equal(isInteractiveShellCommand(command), false, command);
  }
});
