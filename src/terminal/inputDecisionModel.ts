import {
  classifyTerminalInput,
} from "./inputRouter.ts";
import type {
  TerminalInputDecision,
  TerminalInputMode,
  TerminalInputTarget,
} from "./inputRouter.ts";

export type InputDecisionSource =
  | "raw-terminal"
  | "fixed-shell"
  | "fixed-agent"
  | "agent-unavailable"
  | "unreliable-capture"
  | "history-match"
  | "completion"
  | "agent-follow-up"
  | TerminalInputDecision["reason"];

export type InputDecisionContext = {
  text: string;
  agentAvailable: boolean;
  routingMode?: TerminalInputMode;
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

export type InputModeIndicator = "inactive" | "automatic" | "fixed";

export function getInputModeIndicator(
  routingMode: TerminalInputMode,
  activeTarget: TerminalInputTarget,
  option: TerminalInputTarget
): InputModeIndicator {
  if (routingMode === option && activeTarget === option) return "fixed";
  if (routingMode === "auto" && activeTarget === option) return "automatic";
  return "inactive";
}

export function toggleFixedInputMode(
  routingMode: TerminalInputMode,
  target: TerminalInputTarget,
  targetAvailable = true
): TerminalInputMode {
  if (!targetAvailable) return routingMode;
  return routingMode === target ? "auto" : target;
}

export function resolvePromptInputTarget(
  routingMode: TerminalInputMode,
  agentAvailable: boolean
): TerminalInputTarget {
  return routingMode === "agent" && agentAvailable ? "agent" : "shell";
}

export function resolveInputTargetForDisplay(
  context: InputDecisionContext,
  previousTarget: TerminalInputTarget
): TerminalInputTarget {
  if (
    !context.text.trim() &&
    (context.routingMode ?? "auto") === "auto" &&
    context.agentAvailable &&
    context.captureReliable !== false &&
    !context.rawTerminal
  ) {
    return previousTarget;
  }
  return decideTerminalInput(context).target;
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

  if (context.routingMode === "shell") {
    return shellDecision("fixed-shell", 1, false);
  }

  if (context.routingMode === "agent") {
    if (!context.agentAvailable) {
      return shellDecision("agent-unavailable", 1, false);
    }
    return {
      target: "agent",
      confidence: 1,
      decisionSource: "fixed-agent",
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
