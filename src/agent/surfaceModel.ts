export type TerminalInputTarget = "shell" | "agent";
export type TerminalManualOverride = TerminalInputTarget | null;
export type AgentExecutionPolicy = "safe-auto";
export type AgentContextPolicy = "none" | "recent" | "selected-blocks";
export const MAX_CONTEXT_ATTACHMENTS = 20;

export type AgentControlState =
  | "idle"
  | "streaming"
  | "executing"
  | "waiting-approval"
  | "paused"
  | "raw-terminal";

const AGENT_CONTROL_TRANSITIONS: Record<
  AgentControlState,
  ReadonlySet<AgentControlState>
> = {
  idle: new Set(["idle", "streaming", "executing", "raw-terminal"]),
  streaming: new Set(["streaming", "executing", "paused", "idle"]),
  executing: new Set([
    "executing",
    "streaming",
    "waiting-approval",
    "paused",
    "idle",
  ]),
  "waiting-approval": new Set([
    "waiting-approval",
    "executing",
    "streaming",
    "idle",
  ]),
  paused: new Set(["paused", "streaming", "executing", "idle"]),
  "raw-terminal": new Set(["raw-terminal", "idle"]),
};

export function canTransitionAgentControl(
  current: AgentControlState,
  next: AgentControlState
): boolean {
  return AGENT_CONTROL_TRANSITIONS[current].has(next);
}

export type TerminalBlockStatus =
  | "running"
  | "success"
  | "warning"
  | "error"
  | "cancelled"
  | "rejected";

type TerminalBlockBase = {
  id: string;
  createdAt: number;
};

export type ShellBlock = TerminalBlockBase & {
  kind: "shell";
  commandId?: string;
  command: string;
  output: string;
  cwd?: string;
  /** 全屏 TUI/REPL 只在 xterm 中渲染，不把 ANSI 屏幕刷新复制进时间线。 */
  interactive?: boolean;
  exitCode: number | null;
  status: TerminalBlockStatus;
  collapsed: boolean;
};

export type AgentUserBlock = TerminalBlockBase & {
  kind: "agent-user";
  content: string;
  queued: boolean;
  cancelled?: boolean;
};

export type AgentMessageBlock = TerminalBlockBase & {
  kind: "agent-message";
  content: string;
  status: "streaming" | "complete" | "error";
};

export type AgentExecutionBlock = TerminalBlockBase & {
  kind: "agent-execution";
  commands: string[];
  output: string;
  exitCode: number | null;
  status: TerminalBlockStatus;
  collapsed: boolean;
};

export type AgentLimitBlock = TerminalBlockBase & {
  kind: "agent-limit";
  rounds: number;
  status: "paused" | "continued" | "ended";
};

export type ContextAttachment = {
  id: string;
  kind: "block" | "selection" | "file";
  label: string;
  content: string;
  blockId?: string;
};

export type TerminalSurfaceEnvironment = {
  kind: "local" | "ssh";
  sessionId?: string;
  host?: string;
  port?: number;
  username?: string;
  shell?: string;
  os?: string;
  cwd?: string;
  connected: boolean;
};

export type TerminalBlock =
  | ShellBlock
  | AgentUserBlock
  | AgentMessageBlock
  | AgentExecutionBlock
  | AgentLimitBlock;

export type TerminalSurfaceState = {
  surfaceId: string;
  inputTarget: TerminalInputTarget;
  manualOverride: TerminalManualOverride;
  executionPolicy: AgentExecutionPolicy;
  contextPolicy: AgentContextPolicy;
  contextAttachments: ContextAttachment[];
  environment: TerminalSurfaceEnvironment | null;
  draft: string;
  conversationId?: string;
  runtimeId?: string;
  control: AgentControlState;
  blocks: TerminalBlock[];
};

export type TerminalSurfaceAction =
  | { type: "set-input-target"; target: TerminalInputTarget }
  | { type: "set-manual-override"; target: TerminalManualOverride }
  | { type: "set-context-policy"; policy: AgentContextPolicy }
  | { type: "set-draft"; draft: string }
  | { type: "set-environment"; environment: TerminalSurfaceEnvironment | null }
  | { type: "set-conversation"; conversationId?: string; runtimeId?: string }
  | { type: "add-context-attachment"; attachment: ContextAttachment }
  | { type: "remove-context-attachment"; attachmentId: string }
  | { type: "clear-context-attachments" }
  | { type: "set-control"; control: AgentControlState }
  | { type: "append-block"; block: TerminalBlock }
  | { type: "replace-block"; block: TerminalBlock }
  | { type: "remove-block"; blockId: string }
  | { type: "clear" };

export function createTerminalSurfaceState(surfaceId: string): TerminalSurfaceState {
  return {
    surfaceId,
    inputTarget: "shell",
    manualOverride: null,
    executionPolicy: "safe-auto",
    contextPolicy: "recent",
    contextAttachments: [],
    environment: null,
    draft: "",
    control: "idle",
    blocks: [],
  };
}

export function reduceTerminalSurface(
  state: TerminalSurfaceState,
  action: TerminalSurfaceAction
): TerminalSurfaceState {
  switch (action.type) {
    case "set-input-target":
      return state.inputTarget === action.target ? state : { ...state, inputTarget: action.target };
    case "set-manual-override":
      return state.manualOverride === action.target
        ? state
        : { ...state, manualOverride: action.target };
    case "set-context-policy":
      return state.contextPolicy === action.policy
        ? state
        : { ...state, contextPolicy: action.policy };
    case "set-draft":
      return state.draft === action.draft ? state : { ...state, draft: action.draft };
    case "set-environment":
      return state.environment === action.environment
        ? state
        : { ...state, environment: action.environment };
    case "set-conversation":
      return state.conversationId === action.conversationId && state.runtimeId === action.runtimeId
        ? state
        : {
            ...state,
            conversationId: action.conversationId,
            runtimeId: action.runtimeId,
          };
    case "add-context-attachment":
      if (
        state.contextAttachments.length >= MAX_CONTEXT_ATTACHMENTS ||
        state.contextAttachments.some((item) => item.id === action.attachment.id)
      ) {
        return state;
      }
      return {
        ...state,
        contextAttachments: [...state.contextAttachments, action.attachment],
      };
    case "remove-context-attachment": {
      const contextAttachments = state.contextAttachments.filter(
        (item) => item.id !== action.attachmentId
      );
      return contextAttachments.length === state.contextAttachments.length
        ? state
        : { ...state, contextAttachments };
    }
    case "clear-context-attachments":
      return state.contextAttachments.length === 0
        ? state
        : { ...state, contextAttachments: [] };
    case "set-control":
      return state.control === action.control ||
        !canTransitionAgentControl(state.control, action.control)
        ? state
        : { ...state, control: action.control };
    case "append-block":
      if (state.blocks.some((block) => block.id === action.block.id)) return state;
      return { ...state, blocks: [...state.blocks, action.block] };
    case "replace-block": {
      const index = state.blocks.findIndex((block) => block.id === action.block.id);
      if (index < 0) return state;
      const blocks = [...state.blocks];
      blocks[index] = action.block;
      return { ...state, blocks };
    }
    case "remove-block": {
      const blocks = state.blocks.filter((block) => block.id !== action.blockId);
      return blocks.length === state.blocks.length ? state : { ...state, blocks };
    }
    case "clear":
      return state.blocks.length === 0 &&
        state.contextAttachments.length === 0 &&
        state.control === "idle" &&
        state.draft === "" &&
        state.inputTarget === "shell" &&
        state.manualOverride === null &&
        state.contextPolicy === "recent" &&
        !state.conversationId &&
        !state.runtimeId
        ? state
        : {
            ...state,
            inputTarget: "shell",
            manualOverride: null,
            contextPolicy: "recent",
            control: "idle",
            blocks: [],
            contextAttachments: [],
            draft: "",
            conversationId: undefined,
            runtimeId: undefined,
          };
  }
}

export type TerminalSurfaceRegistry = Record<string, TerminalSurfaceState>;

export type TerminalSurfaceRegistryAction =
  | { type: "ensure-surface"; surfaceId: string }
  | { type: "remove-surface"; surfaceId: string }
  | { type: "dispatch"; surfaceId: string; action: TerminalSurfaceAction };

export function reduceTerminalSurfaceRegistry(
  registry: TerminalSurfaceRegistry,
  action: TerminalSurfaceRegistryAction
): TerminalSurfaceRegistry {
  switch (action.type) {
    case "ensure-surface":
      return registry[action.surfaceId]
        ? registry
        : {
            ...registry,
            [action.surfaceId]: createTerminalSurfaceState(action.surfaceId),
          };
    case "remove-surface": {
      if (!registry[action.surfaceId]) return registry;
      const next = { ...registry };
      delete next[action.surfaceId];
      return next;
    }
    case "dispatch": {
      const current = registry[action.surfaceId];
      if (!current) return registry;
      const nextSurface = reduceTerminalSurface(current, action.action);
      return nextSurface === current
        ? registry
        : { ...registry, [action.surfaceId]: nextSurface };
    }
  }
}

export function updateTerminalBlock(
  state: TerminalSurfaceState,
  blockId: string,
  update: (block: TerminalBlock) => TerminalBlock
): TerminalSurfaceState {
  const block = state.blocks.find((item) => item.id === blockId);
  if (!block) return state;
  return reduceTerminalSurface(state, {
    type: "replace-block",
    block: update(block),
  });
}
