import assert from "node:assert/strict";
import test from "node:test";

import {
  decideTerminalInput,
  resolveInputTargetForDisplay,
  shouldResetManualOverride,
} from "../src/terminal/inputDecisionModel.ts";

test("raw terminal always keeps input in shell", () => {
  const decision = decideTerminalInput({
    text: "分析当前进程",
    agentAvailable: true,
    manualOverride: "agent",
    rawTerminal: true,
  });

  assert.deepEqual(decision, {
    target: "shell",
    confidence: 1,
    decisionSource: "raw-terminal",
    automatic: false,
  });
});

test("manual override applies to one draft and reports its source", () => {
  assert.deepEqual(
    decideTerminalInput({
      text: "ls -la",
      agentAvailable: true,
      manualOverride: "agent",
    }),
    {
      target: "agent",
      confidence: 1,
      decisionSource: "manual-agent",
      automatic: false,
    }
  );

  assert.equal(
    decideTerminalInput({
      text: "分析服务器",
      agentAvailable: true,
      manualOverride: "shell",
    }).decisionSource,
    "manual-shell"
  );
});

test("manual override resets only when a non-empty draft is cleared", () => {
  assert.equal(shouldResetManualOverride("分析服务器", ""), true);
  assert.equal(shouldResetManualOverride("分析服务器", "   "), true);
  assert.equal(shouldResetManualOverride("", ""), false);
  assert.equal(shouldResetManualOverride("", "分析服务器"), false);
  assert.equal(
    shouldResetManualOverride("分析服务器", "继续分析服务器"),
    false
  );
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
        manualOverride: "shell",
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
