import assert from "node:assert/strict";
import test from "node:test";

import {
  decideTerminalInput,
  getInputModeIndicator,
  resolvePromptInputTarget,
  resolveInputTargetForDisplay,
  toggleFixedInputMode,
} from "../src/terminal/inputDecisionModel.ts";

test("raw terminal always keeps input in shell", () => {
  const decision = decideTerminalInput({
    text: "分析当前进程",
    agentAvailable: true,
    routingMode: "agent",
    rawTerminal: true,
  });

  assert.deepEqual(decision, {
    target: "shell",
    confidence: 1,
    decisionSource: "raw-terminal",
    automatic: false,
  });
});

test("fixed routing mode persists as an explicit decision source", () => {
  assert.deepEqual(
    decideTerminalInput({
      text: "ls -la",
      agentAvailable: true,
      routingMode: "agent",
    }),
    {
      target: "agent",
      confidence: 1,
      decisionSource: "fixed-agent",
      automatic: false,
    }
  );

  assert.equal(
    decideTerminalInput({
      text: "分析服务器",
      agentAvailable: true,
      routingMode: "shell",
    }).decisionSource,
    "fixed-shell"
  );
});

test("automatic and fixed modes expose distinct visual indicators", () => {
  assert.equal(getInputModeIndicator("auto", "shell", "shell"), "automatic");
  assert.equal(getInputModeIndicator("auto", "shell", "agent"), "inactive");
  assert.equal(getInputModeIndicator("agent", "agent", "agent"), "fixed");
  assert.equal(getInputModeIndicator("shell", "shell", "shell"), "fixed");
});

test("click and Ctrl+Shift+I semantics toggle only the requested fixed mode", () => {
  assert.equal(toggleFixedInputMode("auto", "agent"), "agent");
  assert.equal(toggleFixedInputMode("shell", "agent"), "agent");
  assert.equal(toggleFixedInputMode("agent", "agent"), "auto");
  assert.equal(toggleFixedInputMode("auto", "shell"), "shell");
  assert.equal(toggleFixedInputMode("shell", "shell"), "auto");
  assert.equal(toggleFixedInputMode("auto", "agent", false), "auto");
  assert.equal(toggleFixedInputMode("shell", "agent", false), "shell");
});

test("shell prompts preserve a valid fixed Agent target", () => {
  assert.equal(resolvePromptInputTarget("agent", true), "agent");
  assert.equal(resolvePromptInputTarget("agent", false), "shell");
  assert.equal(resolvePromptInputTarget("auto", true), "shell");
  assert.equal(resolvePromptInputTarget("shell", true), "shell");
});

test("empty automatic draft keeps the last semantic target", () => {
  assert.equal(
    resolveInputTargetForDisplay(
      {
        text: "",
        agentAvailable: true,
      },
      "agent"
    ),
    "agent"
  );
  assert.equal(
    resolveInputTargetForDisplay(
      {
        text: "ls -la",
        agentAvailable: true,
      },
      "agent"
    ),
    "shell"
  );
  assert.equal(
    resolveInputTargetForDisplay(
      {
        text: "分析服务器性能",
        agentAvailable: true,
      },
      "shell"
    ),
    "agent"
  );
});

test("manual mode and unavailable Agent override the previous display target", () => {
  assert.equal(
    resolveInputTargetForDisplay(
      {
        text: "",
        agentAvailable: true,
        routingMode: "shell",
      },
      "agent"
    ),
    "shell"
  );
  assert.equal(
    resolveInputTargetForDisplay(
      {
        text: "",
        agentAvailable: false,
      },
      "agent"
    ),
    "shell"
  );
});

test("history and completion results are treated as shell input", () => {
  const history = decideTerminalInput({
    text: "分析服务器",
    agentAvailable: true,
    matchedHistory: true,
  });
  const completion = decideTerminalInput({
    text: "为什么服务失败",
    agentAvailable: true,
    completionAccepted: true,
  });

  assert.equal(history.target, "shell");
  assert.equal(history.decisionSource, "history-match");
  assert.equal(completion.target, "shell");
  assert.equal(completion.decisionSource, "completion");
});

test("natural language follow-up stays in agent with explicit provenance", () => {
  const decision = decideTerminalInput({
    text: "继续分析刚才的 nginx 错误",
    agentAvailable: true,
    agentFollowUp: true,
  });

  assert.equal(decision.target, "agent");
  assert.equal(decision.decisionSource, "agent-follow-up");
  assert.equal(decision.classifierReason, "natural-language");
  assert.equal(decision.automatic, true);
});

test("unavailable agent and unreliable capture safely fall back to shell", () => {
  const unavailable = decideTerminalInput({
    text: "分析服务器",
    agentAvailable: false,
  });
  const unreliable = decideTerminalInput({
    text: "分析服务器",
    agentAvailable: true,
    captureReliable: false,
  });

  assert.equal(unavailable.target, "shell");
  assert.equal(unavailable.decisionSource, "agent-unavailable");
  assert.equal(unreliable.target, "shell");
  assert.equal(unreliable.decisionSource, "unreliable-capture");
});

test("ambiguous input preserves the classifier safe shell fallback", () => {
  const decision = decideTerminalInput({
    text: "foo bar baz",
    agentAvailable: true,
  });

  assert.equal(decision.target, "shell");
  assert.equal(decision.confidence, 0.6);
  assert.equal(decision.decisionSource, "safe-fallback");
  assert.equal(decision.classifierReason, "safe-fallback");
});
