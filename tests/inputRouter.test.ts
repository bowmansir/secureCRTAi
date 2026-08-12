import assert from "node:assert/strict";
import test from "node:test";

import {
  canRouteTerminalSubmission,
  classifyTerminalInput,
  extractTerminalPromptInput,
  isLikelyShellPrompt,
  splitTerminalSubmissionData,
  updateTerminalInputCapture,
} from "../src/terminal/inputRouter.ts";

test("high-confidence Agent input survives an unreliable IME capture", () => {
  const naturalLanguage = classifyTerminalInput(
    "访问提示的证书还是旧证书",
    "auto",
    true
  );
  assert.equal(
    canRouteTerminalSubmission({
      submittedText: "访问提示的证书还是旧证书",
      inputStartedAtPrompt: true,
      captureReliable: false,
      recoveredFromTerminal: false,
      decision: naturalLanguage,
    }),
    true
  );

  const shellCommand = classifyTerminalInput("nginx -t", "auto", true);
  assert.equal(
    canRouteTerminalSubmission({
      submittedText: "nginx -t",
      inputStartedAtPrompt: true,
      captureReliable: false,
      recoveredFromTerminal: false,
      decision: shellCommand,
    }),
    false
  );

  assert.equal(
    canRouteTerminalSubmission({
      submittedText: "访问提示的证书还是旧证书",
      inputStartedAtPrompt: false,
      captureReliable: false,
      recoveredFromTerminal: false,
      decision: naturalLanguage,
    }),
    false
  );
});

test("auto mode keeps explicit commands in shell", () => {
  const inputs = [
    "ls -la",
    "sudo systemctl status nginx",
    "echo 你好",
    "cat 中文配置.yaml",
    "cd /opt/app && docker compose ps",
    "./deploy.sh",
    "C:\\Windows\\System32",
    "FOO=bar node app.js",
    "FOO=bar echo 你好",
    "rg 错误 src",
    "make 生产",
    "foo 中文",
    "foo 中文 | cat",
    "Get-ChildItem -Force",
    "Get-Service nginx",
    "my_hysteria2_config.yaml",
  ];

  for (const input of inputs) {
    assert.equal(classifyTerminalInput(input, "auto", true).target, "shell", input);
  }
});

test("auto mode routes high-confidence Chinese and English requests to agent", () => {
  const inputs = [
    "分析下服务器的性能问题",
    "帮我看看哪个进程占用内存最多",
    "为什么 nginx 启动失败",
    "哈哈",
    "列目录",
    "直接执行命令 ps aux --sort=-%cpu | head -3，不要预检查",
    "请运行 df -h && free -h，然后总结结果",
    "check why nginx failed",
    "how can I inspect disk usage",
    "please run ps aux | head and summarize it",
  ];

  for (const input of inputs) {
    assert.equal(classifyTerminalInput(input, "auto", true).target, "agent", input);
  }
});

test("unknown and single-token input safely falls back to shell", () => {
  assert.equal(classifyTerminalInput("custom-tool", "auto", true).target, "shell");
  assert.equal(classifyTerminalInput("foo bar baz", "auto", true).target, "shell");
});

test("manual modes and availability override auto detection", () => {
  assert.equal(classifyTerminalInput("分析服务器", "shell", true).target, "shell");
  assert.equal(classifyTerminalInput("分析服务器", "agent", true).target, "agent");
  assert.equal(classifyTerminalInput("分析服务器", "agent", false).target, "shell");
});

test("explicit commands stay in shell even when Agent is fixed", () => {
  const inputs = [
    "htop",
    "ls -la",
    "./deploy.sh",
    "custom-tool status",
    "FOO=bar node app.js",
    "check --version",
    "do-release-upgrade",
    "where.exe nginx",
    "timeout 5s htop",
  ];

  for (const input of inputs) {
    assert.equal(classifyTerminalInput(input, "agent", true).target, "shell", input);
  }
});

test("natural requests that mention commands still go to Agent", () => {
  const inputs = [
    "检查 nginx 为什么失败",
    "请运行 htop 并分析结果",
    "check why nginx failed",
    "how can I run do-release-upgrade safely",
    "please explain ls -la output",
  ];

  for (const input of inputs) {
    assert.equal(classifyTerminalInput(input, "auto", true).target, "agent", input);
    assert.equal(classifyTerminalInput(input, "agent", true).target, "agent", input);
  }
});

test("recognizes common Linux and PowerShell prompts with ANSI styling", () => {
  assert.equal(isLikelyShellPrompt("\x1b[32m[root@host ~]# \x1b[0m"), true);
  assert.equal(isLikelyShellPrompt("root@host:/opt/app$ "), true);
  assert.equal(isLikelyShellPrompt("PS C:\\Users\\tester> "), true);
  assert.equal(isLikelyShellPrompt("service output: ready"), false);
  assert.equal(isLikelyShellPrompt("password: "), false);
});

test("recovers Chinese natural language from the visible prompt line", () => {
  assert.equal(
    extractTerminalPromptInput("[root@proxy_52 ~]# 服务器性能如何了", ""),
    "服务器性能如何了"
  );
  assert.equal(
    extractTerminalPromptInput(
      "root@host:/opt/app$ cat /etc/hostname",
      "cat"
    ),
    "cat /etc/hostname"
  );
  assert.equal(
    extractTerminalPromptInput("PS C:\\Users\\tester> Get-ChildItem", ""),
    "Get-ChildItem"
  );
  assert.equal(extractTerminalPromptInput("service output: ready", ""), "");
});

test("input capture handles editing and marks completion navigation unreliable", () => {
  let capture = { text: "", reliable: true };
  capture = updateTerminalInputCapture(capture, "分析服务");
  capture = updateTerminalInputCapture(capture, "\x7f");
  capture = updateTerminalInputCapture(capture, "器");
  assert.deepEqual(capture, { text: "分析服器", reliable: true });

  capture = updateTerminalInputCapture(capture, "\t");
  assert.equal(capture.reliable, false);

  capture = updateTerminalInputCapture(capture, "\x15");
  assert.equal(capture.text, "");
});

test("input capture keeps bracketed paste text but rejects multi-line routing", () => {
  const singleLine = updateTerminalInputCapture(
    { text: "", reliable: true },
    "\x1b[200~分析服务器性能\x1b[201~"
  );
  assert.deepEqual(singleLine, { text: "分析服务器性能", reliable: true });

  const multiLine = updateTerminalInputCapture(
    { text: "", reliable: true },
    "\x1b[200~第一行\n第二行\x1b[201~"
  );
  assert.equal(multiLine.reliable, false);
});

test("recognizes IME text and Enter delivered in one terminal input event", () => {
  const naturalLanguage = splitTerminalSubmissionData("哈哈哈\r");
  assert.deepEqual(naturalLanguage, {
    input: "哈哈哈",
    submit: "\r",
  });
  assert.deepEqual(splitTerminalSubmissionData("分析服务器\r\n"), {
    input: "分析服务器",
    submit: "\r\n",
  });
  assert.deepEqual(splitTerminalSubmissionData("\r"), {
    input: "",
    submit: "\r",
  });
  assert.equal(splitTerminalSubmissionData("哈哈哈"), null);

  const capture = updateTerminalInputCapture(
    { text: "", reliable: true },
    naturalLanguage?.input ?? ""
  );
  assert.equal(capture.reliable, true);
  assert.equal(classifyTerminalInput(capture.text, "auto", true).target, "agent");

  const shellCommand = splitTerminalSubmissionData("ls -la\r");
  assert.equal(
    classifyTerminalInput(shellCommand?.input ?? "", "auto", true).target,
    "shell"
  );

  const multiline = splitTerminalSubmissionData("echo one\necho two\r");
  assert.equal(
    updateTerminalInputCapture(
      { text: "", reliable: true },
      multiline?.input ?? ""
    ).reliable,
    false
  );
});

test("empty input and unavailable agent always stay in shell", () => {
  assert.equal(classifyTerminalInput("   ", "auto", true).target, "shell");
  assert.equal(classifyTerminalInput("分析服务器", "auto", false).target, "shell");
  assert.equal(classifyTerminalInput("分析服务器", "agent", false).target, "shell");
});
