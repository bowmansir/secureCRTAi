import {
  assessAgentAction,
} from "./typedActions.ts";
import type {
  AgentActionRisk,
  ShellExecuteAction,
} from "./typedActions.ts";

export type AgentCommandOutput = {
  output: string;
  exitCode: number | null;
};

export type AgentChannelBackend = {
  open: (sessionId: string) => Promise<string>;
  run: (channelId: string, command: string) => Promise<AgentCommandOutput>;
  interrupt: (channelId: string) => Promise<void>;
  close: (channelId: string) => Promise<void>;
};

export type AgentExecutionOutcome =
  | {
      status: "completed";
      action: ShellExecuteAction;
      result: AgentCommandOutput;
    }
  | {
      status: "approval-required";
      action: ShellExecuteAction;
      risk: AgentActionRisk;
    }
  | {
      status: "cancelled";
      action: ShellExecuteAction;
    };

type ChannelEntry = {
  runtimeKey: string;
  surfaceId: string;
  sessionId: string;
  generation: number;
  executing: boolean;
  channelId?: string;
  opening?: Promise<string>;
};

export class AgentChannelRegistry {
  private entries = new Map<string, ChannelEntry>();
  private readonly backend: AgentChannelBackend;

  constructor(backend: AgentChannelBackend) {
    this.backend = backend;
  }

  has(runtimeKey: string): boolean {
    return this.entries.has(runtimeKey);
  }

  isExecuting(runtimeKey: string): boolean {
    return this.entries.get(runtimeKey)?.executing ?? false;
  }

  channelId(runtimeKey: string): string | undefined {
    return this.entries.get(runtimeKey)?.channelId;
  }

  async execute(
    action: ShellExecuteAction,
    options: { approved?: boolean; runtimeKey?: string } = {}
  ): Promise<AgentExecutionOutcome> {
    const risk = assessAgentAction(action);
    if (risk.level === "invalid") {
      throw new Error(risk.reason ?? "Agent action is invalid");
    }
    if (risk.level === "approval-required" && !options.approved) {
      return { status: "approval-required", action, risk };
    }

    const runtimeKey = options.runtimeKey ?? action.surfaceId;
    let entry = this.entries.get(runtimeKey);
    if (entry?.executing) {
      throw new Error("该 Agent Runtime 正在执行另一项操作");
    }
    if (entry && entry.sessionId !== action.sessionId) {
      await this.close(runtimeKey);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        runtimeKey,
        surfaceId: action.surfaceId,
        sessionId: action.sessionId,
        generation: 0,
        executing: false,
      };
      this.entries.set(runtimeKey, entry);
    }

    entry.executing = true;
    const generation = entry.generation;
    try {
      const channelId = await this.ensureOpen(entry);
      if (!this.isCurrent(entry, generation)) {
        return { status: "cancelled", action };
      }
      const result = await this.withTimeout(
        this.backend.run(channelId, action.command),
        action.timeoutMs,
        async () => this.close(runtimeKey)
      );
      if (!this.isCurrent(entry, generation)) {
        return { status: "cancelled", action };
      }
      return { status: "completed", action, result };
    } finally {
      const current = this.entries.get(runtimeKey);
      if (current === entry && current.generation === generation) {
        current.executing = false;
      }
    }
  }

  async interrupt(runtimeKey: string): Promise<void> {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    entry.generation += 1;
    this.entries.delete(runtimeKey);
    const channelId = entry.channelId ?? (await entry.opening?.catch(() => undefined));
    if (!channelId) return;
    await this.backend.interrupt(channelId).catch(() => undefined);
    await this.backend.close(channelId).catch(() => undefined);
  }

  async close(runtimeKey: string): Promise<void> {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    entry.generation += 1;
    this.entries.delete(runtimeKey);
    const channelId = entry.channelId ?? (await entry.opening?.catch(() => undefined));
    if (!channelId) return;
    if (entry.executing) {
      await this.backend.interrupt(channelId).catch(() => undefined);
    }
    await this.backend.close(channelId).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((runtimeKey) => this.close(runtimeKey)));
  }

  private async ensureOpen(entry: ChannelEntry): Promise<string> {
    if (entry.channelId) return entry.channelId;
    if (!entry.opening) {
      const generation = entry.generation;
      entry.opening = this.backend.open(entry.sessionId).then(async (channelId) => {
        if (!this.isCurrent(entry, generation)) {
          await this.backend.close(channelId).catch(() => undefined);
          throw new Error("Agent 通道已取消");
        }
        entry.channelId = channelId;
        entry.opening = undefined;
        return channelId;
      }).catch((error) => {
        if (this.isCurrent(entry, generation)) {
          entry.opening = undefined;
        }
        throw error;
      });
    }
    return entry.opening;
  }

  private isCurrent(entry: ChannelEntry, generation: number): boolean {
    return (
      this.entries.get(entry.runtimeKey) === entry &&
      entry.generation === generation
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => Promise<void>
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Agent 执行超时，执行通道正在关闭"));
        void onTimeout();
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export type AgentRuntimeMode = "terminal" | "ai-panel";

export function getAgentRuntimeKey(
  mode: AgentRuntimeMode,
  surfaceId: string
): string {
  return `${mode}:${surfaceId}`;
}
