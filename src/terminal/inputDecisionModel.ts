import {
  classifyTerminalInput,
} from "./inputRouter.ts";
import type {
  TerminalInputDecision,
  TerminalInputTarget,
} from "./inputRouter.ts";

export type InputDecisionSource =
  | "raw-terminal"
  | "manual-shell"
  | "manual-agent"
  | "agent-unavailable"
  | "unreliable-capture"
  | "history-match"
  | "completion"
  | "agent-follow-up"
  | TerminalInputDecision["reason"];

export type InputDecisionContext = {
  text: string;
  agentAvailable: boolean;
  manualOverride?: TerminalInputTarget | null;
  rawTerminal?: boolean;
  captureReliable?: boolean;
  matchedHistory?: boolean;
  completionAccepted?: boolean;
  agentFollowUp?: boolean;
};

export type InputDecision = {
  target: TerminalInputTarget;
  confidence: number;
  decisionSource: InputDecisionSource;
  automatic: boolean;
  classifierReason?: TerminalInputDecision["reason"];
};

export function resolveInputTargetForDisplay(
  context: InputDecisionContext,
  previousTarget: TerminalInputTarget
): TerminalInputTarget {
  if (
    !context.text.trim() &&
    !context.manualOverride &&
    context.agentAvailable &&
    context.captureReliable !== false &&
    !context.rawTerminal
  ) {
    return previousTarget;
  }
  return decideTerminalInput(context).target;
}

export function shouldResetManualOverride(
  previousDraft: string,
  currentDraft: string
): boolean {
  return Boolean(previousDraft.trim()) && !currentDraft.trim();
}

function shellDecision(
  decisionSource: InputDecisionSource,
  confidence = 1,
  automatic = true
): InputDecision {
  return {
    target: "shell",
    confidence,
    decisionSource,
    automatic,
  };
}

export function decideTerminalInput(context: InputDecisionContext): InputDecision {
  if (context.rawTerminal) {
    return shellDecision("raw-terminal", 1, false);
  }

  if (context.manualOverride === "shell") {
    return shellDecision("manual-shell", 1, false);
  }

  if (context.manualOverride === "agent") {
    if (!context.agentAvailable) {
      return shellDecision("agent-unavailable", 1, false);
    }
    return {
      target: "agent",
      confidence: 1,
      decisionSource: "manual-agent",
      automatic: false,
    };
  }

  if (!context.agentAvailable) {
    return shellDecision("agent-unavailable");
  }

  if (context.captureReliable === false) {
    return shellDecision("unreliable-capture");
  }

  if (context.matchedHistory) {
    return shellDecision("history-match");
  }

  if (context.completionAccepted) {
    return shellDecision("completion");
  }

  const classified = classifyTerminalInput(context.text, "auto", true);
  return {
    target: classified.target,
    confidence: classified.confidence,
    decisionSource:
      classified.target === "agent" && context.agentFollowUp
        ? "agent-follow-up"
        : classified.reason,
    automatic: true,
    classifierReason: classified.reason,
  };
}
