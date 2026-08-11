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

export class AgentCommandExecutionError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "AgentCommandExecutionError";
  }
}

export type AgentChannelBackend = {
  open: (sessionId: string) => Promise<string>;
  run: (
    channelId: string,
    command: string,
    timeoutMs: number
  ) => Promise<AgentCommandOutput>;
  interrupt: (channelId: string) => Promise<void>;
  close: (channelId: string) => Promise<void>;
};

type AgentChannelRegistryOptions = {
  watchdogGraceMs?: number;
  interruptWaitMs?: number;
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
  private readonly watchdogGraceMs: number;
  private readonly interruptWaitMs: number;

  constructor(
    backend: AgentChannelBackend,
    options: AgentChannelRegistryOptions = {}
  ) {
    this.backend = backend;
    this.watchdogGraceMs = options.watchdogGraceMs ?? 8_000;
    this.interruptWaitMs = options.interruptWaitMs ?? 250;
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
      let result: AgentCommandOutput;
      try {
        result = await this.withTimeout(
          this.backend.run(channelId, action.command, action.timeoutMs),
          action.timeoutMs + this.watchdogGraceMs,
          async () => this.close(runtimeKey)
        );
      } catch (error) {
        if (this.isCurrent(entry, generation)) {
          await this.close(runtimeKey);
        }
        throw new AgentCommandExecutionError(error);
      }
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
    await this.releaseChannel(channelId, true);
  }

  async close(runtimeKey: string): Promise<void> {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    entry.generation += 1;
    this.entries.delete(runtimeKey);
    const channelId = entry.channelId ?? (await entry.opening?.catch(() => undefined));
    if (!channelId) return;
    await this.releaseChannel(channelId, entry.executing);
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

  private async releaseChannel(
    channelId: string,
    shouldInterrupt: boolean
  ): Promise<void> {
    if (shouldInterrupt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.backend.interrupt(channelId).catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.interruptWaitMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await this.backend.close(channelId).catch(() => undefined);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => Promise<void>
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Agent 响应超时，旧执行通道已隔离，请重试"));
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
