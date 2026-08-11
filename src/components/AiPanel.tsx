import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { agentChannels } from "../agent/agentChannels";
import {
  AGENT_AUTO_STEP_CHUNK,
  AGENT_MAX_COMMANDS_PER_BATCH,
  AGENT_OUTPUT_PER_COMMAND_LIMIT,
  AGENT_RUN_TIMEOUT_MS,
  AGENT_SYSTEM_PROMPT,
  ASSISTANT_SYSTEM_PROMPT,
  buildAgentExecDetail,
  buildAgentFeedback,
  clipAgentText,
  getAgentBatchDisposition,
  normalizeAgentCommand,
  prepareAgentCommand,
} from "../agent/agentProtocol";
import type { AgentCommandResult } from "../agent/agentProtocol";
import { getAgentRuntimeKey } from "../agent/channelRegistry";
import { isAiPanelAgentModeEnabled } from "../agent/aiPanelMode";
import {
  parseAgentActionPlan,
  stripTypedActionEnvelopeForDisplay,
} from "../agent/typedActions";
import type { ShellExecuteAction } from "../agent/typedActions";
import { ScopedRequestGate } from "../agent/requestGeneration";
import { useDialogs } from "./Dialogs";
import AgentMarkdown from "./AgentMarkdown";
import Icon from "./Icons";
import type { ChatMessage } from "../types";

interface Props {
  width: number;
  hasProvider: boolean;
  /** 当前对话归属键（激活的终端标签 id；无则 "global"）——实现"每标签独立对话" */
  conversationKey: string;
  /** 当前激活标签对应的 SSH 会话 id（Agent 模式需要，非 SSH 时 undefined） */
  activeSessionId?: string;
  /** 取当前激活终端最近的输出（AI 上下文） */
  getRecentOutput: () => string;
  /** 取当前会话服务器环境信息（发行版/内核），作常驻上下文 */
  getEnv: () => string;
  /** 把命令插入当前激活终端（内部已含危险命令拦截） */
  insertCommand: (cmd: string) => void;
  openSettings: () => void;
  /** 外部触发的提问（右键菜单等），nonce 变化即发送 */
  externalRequest?: {
    text: string;
    nonce: number;
    useAgent?: boolean;
    focusOnly?: boolean;
  } | null;
  closeAgentRequest?: { keys: string[]; nonce: number } | null;
}

type AgentExecMeta = {
  kind: "agent-exec";
  status: "running" | "completed" | "failed" | "cancelled" | "rejected";
  command: string;
  commandCount?: number;
  exitCode: number | null;
  output: string;
  outputChars: number;
  truncated: boolean;
};

type AgentLimitMeta = {
  kind: "agent-limit";
  rounds: number;
  status: "paused" | "continued" | "ended";
};

type AgentQueuedMeta = {
  kind: "agent-queued";
  status: "queued" | "applied" | "cancelled";
};

type UiChatMessage = ChatMessage & {
  id?: string;
  meta?: AgentExecMeta | AgentLimitMeta | AgentQueuedMeta;
};

type AgentStepOptions = {
  key?: string;
  surfaceId?: string;
  sessionId?: string;
  auto?: boolean;
};

type AgentLimitPause = {
  actions: ShellExecuteAction[];
  sessionId: string;
  surfaceId: string;
};

type SendOptions = {
  key?: string;
  sessionId?: string;
  useAgent?: boolean;
  env?: string;
  appendUserMessage?: boolean;
  resetAgentTask?: boolean;
};

function getScopedConversationKey(key: string, useAgent: boolean): string {
  return `${useAgent ? "agent" : "chat"}:${key}`;
}

function getSurfaceIdFromConversationKey(key: string): string {
  return key.startsWith("agent:") ? key.slice("agent:".length) : key;
}

function getAiPanelRuntimeKey(key: string): string {
  return getAgentRuntimeKey("ai-panel", getSurfaceIdFromConversationKey(key));
}

function toChatMessage(message: UiChatMessage): ChatMessage {
  return { role: message.role, content: message.content };
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "未知" : String(exitCode);
}

function formatOutputLabel(chars: number, truncated: boolean): string {
  if (chars <= 0) return "无输出";
  return `输出 ${chars}${truncated ? "+" : ""} 字符`;
}

function AgentExecSummary({ meta }: { meta: AgentExecMeta }) {
  const [expanded, setExpanded] = useState(false);
  const ok = meta.status === "completed" && meta.exitCode === 0;
  const outputText = meta.output || "(无输出)";
  const outputLabel = formatOutputLabel(meta.outputChars, meta.truncated);
  const commandCount = meta.commandCount ?? 1;
  const stateLabel =
    meta.status === "running"
      ? commandCount > 1
        ? `执行中 ${commandCount} 条`
        : "执行中"
      : meta.status === "cancelled"
        ? commandCount > 1
          ? `已停止 ${commandCount} 条`
          : "已停止"
        : meta.status === "rejected"
          ? "已拒绝，任务停止"
        : meta.status === "failed"
          ? commandCount > 1
            ? `执行失败 ${commandCount} 条`
            : "执行失败"
          : commandCount > 1
            ? `已执行 ${commandCount} 条`
            : "已执行";
  const commandTitle = commandCount > 1 ? meta.command.split("\n")[0] : meta.command;
  const metaLabel =
    meta.status === "running"
      ? "等待结果"
      : meta.status === "cancelled"
        ? "已中断"
        : meta.status === "rejected"
          ? "未执行"
        : `退出码 ${formatExitCode(meta.exitCode)} · ${outputLabel}`;

  return (
    <div
      className={`agent-exec ${ok ? "ok" : meta.status}${expanded ? " open" : ""}`}
    >
      <button
        type="button"
        className="agent-exec-row"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "收起执行详情" : "展开执行详情"}
      >
        <span className="agent-exec-state">
          <span className="agent-exec-dot" />
          {stateLabel}
        </span>
        <code className="agent-exec-command">{commandTitle}</code>
        <span className="agent-exec-meta">{metaLabel}</span>
        <span className="agent-exec-action">{expanded ? "收起" : "展开"}</span>
      </button>
      {expanded && (
        <div className="agent-exec-detail">
          <div className="agent-exec-label">命令</div>
          <pre>{meta.command}</pre>
          <div className="agent-exec-label">输出</div>
          <pre>{outputText}</pre>
        </div>
      )}
    </div>
  );
}

function AgentLimitNotice({
  meta,
  onContinue,
  onEnd,
}: {
  meta: AgentLimitMeta;
  onContinue: () => void;
  onEnd: () => void;
}) {
  const paused = meta.status === "paused";
  return (
    <div className={`agent-limit-notice ${meta.status}`}>
      <div>
        <strong>
          {paused
            ? `已连续执行 ${meta.rounds} 轮，任务尚未完成`
            : meta.status === "continued"
              ? `已确认继续，执行预算增加 ${AGENT_AUTO_STEP_CHUNK} 轮`
              : "任务已由用户结束"}
        </strong>
        {paused && <span>为避免 Agent 无限制执行，需要你确认后继续。</span>}
      </div>
      {paused && (
        <div className="agent-limit-actions">
          <button className="btn mini primary" onClick={onContinue}>
            继续 {AGENT_AUTO_STEP_CHUNK} 轮
          </button>
          <button className="btn mini" onClick={onEnd}>
            结束任务
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- 组件 ----------

export default function AiPanel({
  width,
  hasProvider,
  conversationKey,
  activeSessionId,
  getRecentOutput,
  getEnv,
  insertCommand,
  openSettings,
  externalRequest,
  closeAgentRequest,
}: Props) {
  const { approval, prompt } = useDialogs();
  // 每个终端标签的普通对话与 Agent 对话分别存储，避免执行结果污染普通上下文。
  const [convos, setConvos] = useState<Record<string, UiChatMessage[]>>({});
  const convosRef = useRef<Record<string, UiChatMessage[]>>({});
  const [includeContext, setIncludeContext] = useState(true);
  const [agentModes, setAgentModes] = useState<Record<string, boolean>>({});
  const agentModesRef = useRef<Record<string, boolean>>({});
  const agentMode = isAiPanelAgentModeEnabled(
    activeSessionId,
    agentModes[conversationKey]
  );
  const activeConversationKey = getScopedConversationKey(conversationKey, agentMode);
  const messages = convos[activeConversationKey] ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = drafts[activeConversationKey] ?? "";
  const [streamingKeys, setStreamingKeys] = useState<Set<string>>(() => new Set());
  const streamingKeysRef = useRef<Set<string>>(new Set());
  const [agentBusyKeys, setAgentBusyKeys] = useState<Set<string>>(() => new Set());
  const agentBusyKeysRef = useRef<Set<string>>(new Set());
  const streaming = streamingKeys.has(activeConversationKey);
  const agentBusy = agentBusyKeys.has(activeConversationKey);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requestGate = useRef(new ScopedRequestGate());
  const aiRequestControllers = useRef<Record<string, AbortController>>({});
  const streamingAssistantIds = useRef<Record<string, string>>({});
  const activeExecMessageIds = useRef<Record<string, string>>({});
  const activeSessionIdRef = useRef<string | undefined>(activeSessionId);
  const agentAutoSteps = useRef<Record<string, number>>({});
  const agentStepLimits = useRef<Record<string, number>>({});
  const agentGoals = useRef<Record<string, string>>({});
  const agentExecutedCommands = useRef<Record<string, Set<string>>>({});
  const agentApprovedCommands = useRef<Record<string, Set<string>>>({});
  const [agentLimitPauses, setAgentLimitPauses] = useState<Record<string, AgentLimitPause>>({});
  const agentLimitPausesRef = useRef<Record<string, AgentLimitPause>>({});
  const pendingAgentInstructions = useRef<Record<string, string[]>>({});
  const agentRunSeq = useRef<Record<string, number>>({});
  const conversationEnvs = useRef<Record<string, string>>({});
  const handledCloseNonce = useRef<number | null>(null);
  const agentLimitPaused = Boolean(agentLimitPauses[activeConversationKey]);
  const agentCanQueue = agentMode && (streaming || agentBusy || agentLimitPaused);

  const setMessagesFor = (key: string, updater: (prev: UiChatMessage[]) => UiChatMessage[]) =>
    setConvos((prev) => {
      const next = { ...prev, [key]: updater(prev[key] ?? []) };
      convosRef.current = next;
      return next;
    });

  const setStreamingFor = (key: string, value: boolean) => {
    const next = new Set(streamingKeysRef.current);
    if (value) next.add(key);
    else next.delete(key);
    streamingKeysRef.current = next;
    setStreamingKeys(next);
  };

  const setAgentBusyFor = (key: string, value: boolean) => {
    const next = new Set(agentBusyKeysRef.current);
    if (value) next.add(key);
    else next.delete(key);
    agentBusyKeysRef.current = next;
    setAgentBusyKeys(next);
  };

  const setAgentModeFor = (key: string, value: boolean) => {
    const next = { ...agentModesRef.current, [key]: value };
    agentModesRef.current = next;
    setAgentModes(next);
  };

  const bumpAgentRunSeq = (key: string): number => {
    const next = (agentRunSeq.current[key] ?? 0) + 1;
    agentRunSeq.current[key] = next;
    return next;
  };

  const setAgentLimitPauseFor = (key: string, pause: AgentLimitPause | null) => {
    const next = { ...agentLimitPausesRef.current };
    if (pause) next[key] = pause;
    else delete next[key];
    agentLimitPausesRef.current = next;
    setAgentLimitPauses(next);
  };

  const updateAgentLimitMessage = (key: string, status: AgentLimitMeta["status"]) => {
    setMessagesFor(key, (prev) =>
      prev.map((message) =>
        message.meta?.kind === "agent-limit" && message.meta.status === "paused"
          ? { ...message, meta: { ...message.meta, status } }
          : message
      )
    );
  };

  const updateQueuedAgentMessages = (key: string, status: AgentQueuedMeta["status"]) => {
    setMessagesFor(key, (prev) =>
      prev.map((message) =>
        message.meta?.kind === "agent-queued" && message.meta.status === "queued"
          ? { ...message, meta: { ...message.meta, status } }
          : message
      )
    );
  };

  const clearPendingAgentInstructions = (
    key: string,
    status: AgentQueuedMeta["status"] = "cancelled"
  ) => {
    if (pendingAgentInstructions.current[key]?.length) {
      updateQueuedAgentMessages(key, status);
    }
    delete pendingAgentInstructions.current[key];
  };

  useEffect(() => {
    convosRef.current = convos;
  }, [convos]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const closeAgentChannel = (key: string) => {
    void agentChannels.close(getAiPanelRuntimeKey(key));
  };

  useEffect(
    () => () => {
      const keys = new Set([
        ...Object.keys(convosRef.current),
        ...Object.keys(aiRequestControllers.current),
        ...Object.keys(agentRunSeq.current),
      ]);
      keys.forEach((key) => {
        requestGate.current.invalidate(key);
        aiRequestControllers.current[key]?.abort();
        if (key.startsWith("agent:")) closeAgentChannel(key);
      });
    },
    []
  );

  const resetAgentChannel = (key: string) => {
    requestGate.current.invalidate(key);
    aiRequestControllers.current[key]?.abort();
    delete aiRequestControllers.current[key];
    bumpAgentRunSeq(key);
    closeAgentChannel(key);
    delete streamingAssistantIds.current[key];
    delete activeExecMessageIds.current[key];
    agentAutoSteps.current[key] = 0;
    delete agentStepLimits.current[key];
    delete agentGoals.current[key];
    delete agentExecutedCommands.current[key];
    delete agentApprovedCommands.current[key];
    clearPendingAgentInstructions(key);
    if (agentLimitPausesRef.current[key]) {
      updateAgentLimitMessage(key, "ended");
    }
    setAgentLimitPauseFor(key, null);
    setAgentBusyFor(key, false);
    setStreamingFor(key, false);
  };

  const disposeConversationKeys = (keys: string[]) => {
    const keySet = new Set(
      keys.filter(Boolean).flatMap((key) => [
        getScopedConversationKey(key, false),
        getScopedConversationKey(key, true),
      ])
    );
    if (keySet.size === 0) return;
    keySet.forEach((key) => {
      requestGate.current.invalidate(key);
      aiRequestControllers.current[key]?.abort();
      delete aiRequestControllers.current[key];
      bumpAgentRunSeq(key);
      setAgentBusyFor(key, false);
      setStreamingFor(key, false);
      closeAgentChannel(key);
    });
    const nextLimitPauses = { ...agentLimitPausesRef.current };
    keySet.forEach((key) => delete nextLimitPauses[key]);
    agentLimitPausesRef.current = nextLimitPauses;
    setAgentLimitPauses(nextLimitPauses);
    setConvos((prev) => {
      let changed = false;
      const next = { ...prev };
      keySet.forEach((key) => {
        if (key in next) {
          delete next[key];
          changed = true;
        }
        delete agentGoals.current[key];
        delete agentAutoSteps.current[key];
        delete agentStepLimits.current[key];
        delete agentExecutedCommands.current[key];
        delete agentApprovedCommands.current[key];
        delete pendingAgentInstructions.current[key];
        delete streamingAssistantIds.current[key];
        delete activeExecMessageIds.current[key];
        delete conversationEnvs.current[key];
      });
      if (changed) convosRef.current = next;
      return changed ? next : prev;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      keySet.forEach((key) => delete next[key]);
      return next;
    });
    setAgentModes((prev) => {
      const next = { ...prev };
      keys.forEach((key) => delete next[key]);
      agentModesRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    if (!closeAgentRequest || handledCloseNonce.current === closeAgentRequest.nonce) return;
    handledCloseNonce.current = closeAgentRequest.nonce;
    disposeConversationKeys(closeAgentRequest.keys);
  }, [closeAgentRequest]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const stop = () => {
    const key = activeConversationKey;
    requestGate.current.invalidate(key);
    aiRequestControllers.current[key]?.abort();
    delete aiRequestControllers.current[key];
    bumpAgentRunSeq(key);
    void agentChannels.interrupt(getAiPanelRuntimeKey(key));
    const assistantMessageId = streamingAssistantIds.current[key];
    const execMessageId = activeExecMessageIds.current[key];
    setMessagesFor(key, (prev) => {
      let stopNoticeApplied = false;
      const next = prev.map((message) => {
        if (message.id === execMessageId && message.meta?.kind === "agent-exec") {
          stopNoticeApplied = true;
          const output = "Agent 命令已由用户停止。";
          return {
            ...message,
            content: output,
            meta: {
              ...message.meta,
              status: "cancelled" as const,
              exitCode: null,
              output,
              outputChars: output.length,
              truncated: false,
            },
          };
        }
        if (message.id === assistantMessageId) {
          stopNoticeApplied = true;
          return {
            ...message,
            content: message.content.trim()
              ? `${message.content.trim()}\n\n已停止。`
              : "已停止。",
          };
        }
        return message;
      });
      if (!stopNoticeApplied) {
        next.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "已停止。",
        });
      }
      return next;
    });
    delete streamingAssistantIds.current[key];
    delete activeExecMessageIds.current[key];
    clearPendingAgentInstructions(key);
    setAgentLimitPauseFor(key, null);
    setAgentBusyFor(key, false);
    setStreamingFor(key, false);
  };

  const send = async (userText: string, meta?: AgentExecMeta, options?: SendOptions) => {
    const sessionId = options?.sessionId ?? activeSessionId ?? activeSessionIdRef.current;
    const useAgent =
      options?.useAgent ??
      isAiPanelAgentModeEnabled(
        sessionId,
        agentModesRef.current[conversationKey]
      );
    const key = options?.key ?? getScopedConversationKey(conversationKey, useAgent);
    const appendUserMessage = options?.appendUserMessage ?? true;
    const resetAgentTask = options?.resetAgentTask ?? (useAgent && !meta && appendUserMessage);
    if (
      !userText.trim() ||
      streamingKeysRef.current.has(key) ||
      agentBusyKeysRef.current.has(key)
    ) return;
    if (resetAgentTask) {
      agentAutoSteps.current[key] = 0;
      agentStepLimits.current[key] = AGENT_AUTO_STEP_CHUNK;
      agentGoals.current[key] = userText.trim();
      agentExecutedCommands.current[key] = new Set();
      clearPendingAgentInstructions(key);
      setAgentLimitPauseFor(key, null);
    }
    let question = userText.trim();
    // Agent 模式不附带终端上下文（Agent 有自己的执行通道）
    if (!useAgent && includeContext) {
      const ctx = getRecentOutput().trim();
      if (ctx) {
        question = `【终端最近输出，供参考】\n${ctx.slice(-4000)}\n\n【用户问题】\n${userText.trim()}`;
      }
    }
    const history: ChatMessage[] = [
      ...(convosRef.current[key] ?? [])
        .filter(
          (message) =>
            message.meta?.kind !== "agent-limit" &&
            message.meta?.kind !== "agent-queued"
        )
        .map(toChatMessage),
      { role: "user", content: question },
    ];
    const assistantMessageId = crypto.randomUUID();
    streamingAssistantIds.current[key] = assistantMessageId;
    setMessagesFor(key, (prev) => [
      ...prev,
      ...(appendUserMessage
        ? [{ id: crypto.randomUUID(), role: "user" as const, content: userText.trim(), meta }]
        : []),
      { id: assistantMessageId, role: "assistant", content: "" },
    ]);
    if (appendUserMessage && !meta) setDrafts((prev) => ({ ...prev, [key]: "" }));
    const requestToken = requestGate.current.begin(key);
    setStreamingFor(key, true);

    // 环境信息注入 system prompt；Agent 模式用 Agent 提示词
    const env = options?.env ?? (meta ? conversationEnvs.current[key] ?? "" : getEnv().trim());
    conversationEnvs.current[key] = env;
    const base = useAgent ? AGENT_SYSTEM_PROMPT : ASSISTANT_SYSTEM_PROMPT;
    const sys = env ? `${base}\n\n【当前服务器环境】\n${env}` : base;
    let assistantText = "";
    const requestController = new AbortController();
    aiRequestControllers.current[key] = requestController;

    const replaceAssistantMessage = (content: string) =>
      setMessagesFor(key, (prev) => {
        const next = [...prev];
        const index = next.findIndex((message) => message.id === assistantMessageId);
        if (index >= 0) next[index] = { ...next[index], content };
        return next;
      });

    try {
      await api.aiChat(sys, history, (e) => {
        if (!requestGate.current.isCurrent(requestToken)) return;
        if (e.type === "delta") {
          assistantText += e.text;
          replaceAssistantMessage(
            useAgent
              ? stripTypedActionEnvelopeForDisplay(assistantText, true)
              : assistantText
          );
        }
        else if (e.type === "error") {
          replaceAssistantMessage(
            `${stripTypedActionEnvelopeForDisplay(assistantText, true)}\n[错误] ${
              e.message
            }`.trim()
          );
          delete streamingAssistantIds.current[key];
          setStreamingFor(key, false);
          if (useAgent && sessionId && pendingAgentInstructions.current[key]?.length) {
            window.setTimeout(() => {
              void processPendingAgentInstructions(key, sessionId);
            }, 0);
          }
        } else if (e.type === "done") {
          delete streamingAssistantIds.current[key];
          setStreamingFor(key, false);
          if (useAgent && sessionId && pendingAgentInstructions.current[key]?.length) {
            window.setTimeout(() => {
              void processPendingAgentInstructions(key, sessionId);
            }, 0);
            return;
          }
          const surfaceId = getSurfaceIdFromConversationKey(key);
          const plan =
            useAgent && sessionId
              ? parseAgentActionPlan(assistantText, {
                  surfaceId,
                  sessionId,
                  timeoutMs: AGENT_RUN_TIMEOUT_MS,
                  maxActions: AGENT_MAX_COMMANDS_PER_BATCH,
                })
              : null;
          const actions =
            plan?.actions.filter(
              (action): action is ShellExecuteAction =>
                action.type === "shell.execute"
            ) ?? [];
          if (plan) {
            const unsupportedActions =
              plan.actions.length - actions.length;
            const planNotice = [
              plan.displayText,
              plan.errors.length > 0 && actions.length > 0
                ? `动作计划已按安全上限处理：${plan.errors.join("；")}`
                : "",
              unsupportedActions > 0
                ? `右侧 AI 模式暂不执行 ${unsupportedActions} 个非 Shell 动作。`
                : "",
              plan.source === "typed" &&
              actions.length === 0 &&
              plan.errors.length > 0
                ? `动作计划无效，本轮未执行：${plan.errors.join("；")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n");
            replaceAssistantMessage(planNotice);
          }
          if (actions.length > 0 && sessionId) {
            const scheduledRunSeq = agentRunSeq.current[key] ?? 0;
            window.setTimeout(() => {
              if (
                !requestGate.current.isCurrent(requestToken) ||
                scheduledRunSeq !== (agentRunSeq.current[key] ?? 0)
              ) {
                return;
              }
              void runAgentBatch(actions, {
                key,
                surfaceId,
                sessionId,
                auto: true,
              });
            }, 0);
          }
        }
      }, requestController.signal);
    } catch (err) {
      if (!requestGate.current.isCurrent(requestToken)) return;
      replaceAssistantMessage(
        `${stripTypedActionEnvelopeForDisplay(assistantText, true)}\n[错误] ${String(
          err
        )}`.trim()
      );
      delete streamingAssistantIds.current[key];
      setStreamingFor(key, false);
      if (useAgent && sessionId && pendingAgentInstructions.current[key]?.length) {
        window.setTimeout(() => {
          void processPendingAgentInstructions(key, sessionId);
        }, 0);
      }
    } finally {
      if (aiRequestControllers.current[key] === requestController) {
        delete aiRequestControllers.current[key];
      }
    }
  };

  function queueAgentInstruction(key: string, text: string) {
    const instruction = text.trim();
    if (!instruction) return;
    pendingAgentInstructions.current[key] = [
      ...(pendingAgentInstructions.current[key] ?? []),
      instruction,
    ];
    setMessagesFor(key, (prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: instruction,
        meta: { kind: "agent-queued", status: "queued" },
      },
    ]);
    setDrafts((prev) => ({ ...prev, [key]: "" }));
  }

  async function processPendingAgentInstructions(
    key: string,
    sessionId: string,
    executionFeedback?: string
  ): Promise<boolean> {
    const instructions = pendingAgentInstructions.current[key];
    if (!instructions?.length) return false;
    delete pendingAgentInstructions.current[key];
    updateQueuedAgentMessages(key, "applied");
    const addition = instructions
      .map((instruction, index) => `${index + 1}. ${instruction}`)
      .join("\n");
    const currentGoal = agentGoals.current[key]?.trim();
    agentGoals.current[key] = currentGoal
      ? `${currentGoal}\n\n【用户追加要求】\n${addition}`
      : addition;
    const prompt = `${executionFeedback ? `${executionFeedback}\n\n` : ""}【用户执行中追加要求】\n${addition}\n\n请立即结合追加要求重新规划。此前尚未执行的命令计划已经失效，不要直接沿用；先判断目标是否变化，再给出下一批必要命令或最终结论。`;
    await send(prompt, undefined, {
      key,
      sessionId,
      useAgent: true,
      env: conversationEnvs.current[key] ?? "",
      appendUserMessage: false,
      resetAgentTask: false,
    });
    return true;
  }

  const lastNonce = useRef(0);
  useEffect(() => {
    if (externalRequest && externalRequest.nonce !== lastNonce.current && hasProvider) {
      lastNonce.current = externalRequest.nonce;
      if (externalRequest.focusOnly) {
        setAgentModeFor(conversationKey, false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      const useAgent = Boolean(externalRequest.useAgent && activeSessionId);
      if (useAgent) {
        setAgentModeFor(conversationKey, true);
        const key = getScopedConversationKey(conversationKey, true);
        if (
          streamingKeysRef.current.has(key) ||
          agentBusyKeysRef.current.has(key) ||
          agentLimitPausesRef.current[key]
        ) {
          queueAgentInstruction(key, externalRequest.text);
        } else {
          void send(externalRequest.text, undefined, {
            key,
            sessionId: activeSessionId,
            useAgent: true,
          });
        }
      } else {
        void send(externalRequest.text, undefined, { useAgent: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRequest]);

  const diagnose = () => {
    if (!getRecentOutput().trim()) return;
    send("请分析终端最近输出中的报错原因，并给出修复命令。");
  };

  const clearConversation = () => {
    if (
      streamingKeysRef.current.has(activeConversationKey) ||
      agentBusyKeysRef.current.has(activeConversationKey)
    ) return;
    const key = activeConversationKey;
    if (agentMode) resetAgentChannel(key);
    setConvos((prev) => {
      const next = { ...prev, [key]: [] };
      convosRef.current = next;
      return next;
    });
  };

  const continueAgentAfterLimit = (key: string) => {
    const pause = agentLimitPausesRef.current[key];
    if (!pause) return;
    agentStepLimits.current[key] =
      (agentStepLimits.current[key] ?? AGENT_AUTO_STEP_CHUNK) + AGENT_AUTO_STEP_CHUNK;
    setAgentLimitPauseFor(key, null);
    updateAgentLimitMessage(key, "continued");
    if (pendingAgentInstructions.current[key]?.length) {
      void processPendingAgentInstructions(key, pause.sessionId);
      return;
    }
    void runAgentBatch(pause.actions, {
      key,
      surfaceId: pause.surfaceId,
      sessionId: pause.sessionId,
      auto: true,
    });
  };

  const endAgentAtLimit = (key: string) => {
    if (!agentLimitPausesRef.current[key]) return;
    updateAgentLimitMessage(key, "ended");
    resetAgentChannel(key);
  };

  const submitInput = () => {
    if (agentCanQueue) {
      queueAgentInstruction(activeConversationKey, input);
      return;
    }
    void send(input);
  };

  /** Agent 模式：执行 AI 给出的一批命令，把结果汇总喂回 AI 决定下一步 */
  const runAgentBatch = async (
    commandInput: ShellExecuteAction[] | string[] | string,
    options?: AgentStepOptions
  ) => {
    const key = options?.key ?? getScopedConversationKey(conversationKey, true);
    if (streamingKeysRef.current.has(key) || agentBusyKeysRef.current.has(key)) return;
    const sessionId = options?.sessionId ?? activeSessionId ?? activeSessionIdRef.current;
    if (!sessionId) {
      setMessagesFor(key, (prev) => [
        ...prev,
        { role: "assistant", content: "[Agent] 需要在一个 SSH 会话标签下才能执行命令。" },
      ]);
      return;
    }
    const surfaceId = options?.surfaceId ?? getSurfaceIdFromConversationKey(key);
    const inputs = Array.isArray(commandInput) ? commandInput : [commandInput];
    const actions: ShellExecuteAction[] = inputs
      .map((item, index) =>
        typeof item === "string"
          ? {
              type: "shell.execute" as const,
              actionId: `manual-shell-${index + 1}`,
              surfaceId,
              sessionId,
              command: item.trim(),
              timeoutMs: AGENT_RUN_TIMEOUT_MS,
            }
          : item
      )
      .filter((action) => action.command.trim())
      .slice(0, AGENT_MAX_COMMANDS_PER_BATCH);
    if (actions.length === 0) return;
    let nextAutoStep: number | undefined;
    if (options?.auto) {
      const nextStep = (agentAutoSteps.current[key] ?? 0) + 1;
      const stepLimit = agentStepLimits.current[key] ?? AGENT_AUTO_STEP_CHUNK;
      if (nextStep > stepLimit) {
        if (!agentLimitPausesRef.current[key]) {
          setAgentLimitPauseFor(key, { actions, sessionId, surfaceId });
          setMessagesFor(key, (prev) => [
            ...prev,
            {
              role: "assistant",
              content: `已连续执行 ${stepLimit} 轮，任务尚未完成。`,
              meta: { kind: "agent-limit", rounds: stepLimit, status: "paused" },
            },
          ]);
        }
        return;
      }
      nextAutoStep = nextStep;
    }
    const runSeq = bumpAgentRunSeq(key);
    const execMessageId = crypto.randomUUID();
    activeExecMessageIds.current[key] = execMessageId;
    const commandList = actions.map((action) => action.command).join("\n");
    setMessagesFor(key, (prev) => [
      ...prev,
      {
        id: execMessageId,
        role: "user",
        content: "",
        meta: {
          kind: "agent-exec",
          status: "running",
          command: commandList,
          commandCount: actions.length,
          exitCode: null,
          output: "",
          outputChars: 0,
          truncated: false,
        },
      },
    ]);
    setAgentBusyFor(key, true);
    try {
      if (pendingAgentInstructions.current[key]?.length) {
        setAgentBusyFor(key, false);
        delete activeExecMessageIds.current[key];
        setMessagesFor(key, (prev) =>
          prev.filter((message) => message.id !== execMessageId)
        );
        await processPendingAgentInstructions(key, sessionId);
        return;
      }
      if (nextAutoStep !== undefined) {
        agentAutoSteps.current[key] = nextAutoStep;
      }
      const results: AgentCommandResult[] = [];
      let rejected = false;
      const executedCommands = agentExecutedCommands.current[key] ?? new Set<string>();
      agentExecutedCommands.current[key] = executedCommands;
      const shouldReplan = () => Boolean(pendingAgentInstructions.current[key]?.length);
      const markReplanBoundary = () => {
        const lastResult = results[results.length - 1];
        if (!lastResult) return;
        lastResult.note = [
          lastResult.note,
          "收到用户追加要求，本批次后续命令未执行。",
        ]
          .filter(Boolean)
          .join(" ");
      };
      for (const action of actions) {
        let prepared = prepareAgentCommand(action.command);
        let commandToRun = prepared.command;
        let actionToRun: ShellExecuteAction = {
          ...action,
          surfaceId,
          sessionId,
          command: commandToRun,
        };
        let signature = normalizeAgentCommand(commandToRun);
        if (executedCommands.has(signature)) {
          results.push({
            command: commandToRun,
            note: "该命令在当前任务中已经执行过，已跳过以避免重复探测。",
            exitCode: 0,
            output: "已跳过重复命令。",
            outputChars: 0,
            truncated: false,
          });
          if (shouldReplan()) {
            markReplanBoundary();
            break;
          }
          continue;
        }
        try {
          const runtimeKey = getAiPanelRuntimeKey(key);
          const approvedCommands =
            agentApprovedCommands.current[key] ?? new Set<string>();
          agentApprovedCommands.current[key] = approvedCommands;
          const getApprovalKey = () =>
            `${actionToRun.cwd ?? ""}\0${actionToRun.command.trim()}`;
          let isApproved = approvedCommands.has(getApprovalKey());
          let outcome = await agentChannels.execute(actionToRun, {
            approved: isApproved,
            runtimeKey,
          });
          while (outcome.status === "approval-required") {
            const choice = await approval({
              title: "Agent 命令确认",
              command: commandToRun,
              riskLevel: outcome.risk.riskLevel,
              reason: outcome.risk.reason,
            });
            if (choice === "reject") {
              rejected = true;
              results.push({
                command: commandToRun,
                note: "用户拒绝了需确认命令，本批次后续命令未执行。",
                exitCode: null,
                output: "已拒绝执行。",
                outputChars: 0,
                truncated: false,
              });
              break;
            }
            if (choice === "modify") {
              const modified = await prompt({
                title: "修改 Agent 命令",
                defaultValue: commandToRun,
                note: "修改后的命令会重新经过风险检查。",
              });
              if (!modified?.trim()) continue;
              prepared = prepareAgentCommand(modified.trim());
              commandToRun = prepared.command;
              actionToRun = { ...actionToRun, command: commandToRun };
              signature = normalizeAgentCommand(commandToRun);
              isApproved = approvedCommands.has(getApprovalKey());
            } else {
              isApproved = true;
              approvedCommands.add(getApprovalKey());
            }
            outcome = await agentChannels.execute(actionToRun, {
              approved: isApproved,
              runtimeKey,
            });
          }
          if (rejected) break;
          if (outcome.status === "cancelled") {
            if (runSeq === agentRunSeq.current[key]) {
              const output = "Agent 命令已停止。";
              setAgentBusyFor(key, false);
              delete activeExecMessageIds.current[key];
              setMessagesFor(key, (prev) =>
                prev.map((message) =>
                  message.id === execMessageId &&
                  message.meta?.kind === "agent-exec"
                    ? {
                        ...message,
                        content: output,
                        meta: {
                          ...message.meta,
                          status: "cancelled" as const,
                          exitCode: null,
                          output,
                          outputChars: output.length,
                          truncated: false,
                        },
                      }
                    : message
                )
              );
            }
            return;
          }
          if (outcome.status !== "completed") {
            throw new Error("Agent 动作未完成");
          }
          if (runSeq !== agentRunSeq.current[key]) {
            return;
          }
          const result = outcome.result;
          const rawOutput = result.output;
          const clipped = clipAgentText(
            rawOutput || "(无输出)",
            AGENT_OUTPUT_PER_COMMAND_LIMIT
          );
          executedCommands.add(signature);
          results.push({
            command: commandToRun,
            note: prepared.note,
            exitCode: result.exitCode,
            output: clipped.text,
            outputChars: rawOutput.length,
            truncated: clipped.truncated,
          });
          if (shouldReplan()) {
            markReplanBoundary();
            break;
          }
        } catch (err) {
          executedCommands.add(signature);
          closeAgentChannel(key);
          results.push({
            command: commandToRun,
            note: "命令执行失败，本批次后续命令未执行；Agent 通道已重置。",
            exitCode: null,
            output: String(err),
            outputChars: String(err).length,
            truncated: false,
          });
          break;
        }
      }
      const disposition = getAgentBatchDisposition(results, rejected);
      const feedback = rejected
        ? "用户拒绝了需确认命令，当前 Agent 任务已停止。"
        : buildAgentFeedback(agentGoals.current[key], results);
      const detail = buildAgentExecDetail(results);
      if (runSeq !== agentRunSeq.current[key]) return;
      setAgentBusyFor(key, false);
      const execMeta: AgentExecMeta = {
        kind: "agent-exec",
        status: disposition.status,
        command: results.map((r) => r.command).join("\n"),
        commandCount: results.length,
        exitCode: disposition.exitCode,
        output: detail.output,
        outputChars: detail.outputChars,
        truncated: detail.truncated,
      };
      setMessagesFor(key, (prev) =>
        prev.map((message) =>
          message.id === execMessageId
            ? { ...message, content: feedback, meta: execMeta }
            : message
        )
      );
      delete activeExecMessageIds.current[key];
      if (!disposition.shouldContinue) {
        clearPendingAgentInstructions(key);
        return;
      }
      if (pendingAgentInstructions.current[key]?.length) {
        await processPendingAgentInstructions(key, sessionId);
        return;
      }
      await send(feedback, execMeta, {
        key,
        sessionId,
        useAgent: true,
        env: conversationEnvs.current[key] ?? "",
        appendUserMessage: false,
      }); // 结果喂回 AI，产生下一步
    } catch (e) {
      if (runSeq !== agentRunSeq.current[key]) return;
      closeAgentChannel(key);
      setAgentBusyFor(key, false);
      const output = String(e);
      setMessagesFor(key, (prev) => {
        const next = prev.map((message) =>
          message.id === execMessageId && message.meta?.kind === "agent-exec"
            ? {
                ...message,
                content: output,
                meta: {
                  ...message.meta,
                  status: "failed" as const,
                  exitCode: null,
                  output,
                  outputChars: output.length,
                  truncated: false,
                },
              }
            : message
        );
        next.push({ role: "assistant", content: `[Agent 执行失败] ${output}` });
        return next;
      });
      delete activeExecMessageIds.current[key];
    }
  };

  if (!hasProvider) {
    return (
      <div className="ai-panel" style={{ width, minWidth: width }}>
        <div className="ai-header">AI 助手</div>
        <div className="empty-hint" style={{ marginTop: 40 }}>
          尚未配置 AI 模型
          <br />
          <button className="btn primary" style={{ marginTop: 12 }} onClick={openSettings}>
            去配置
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel" style={{ width, minWidth: width }}>
      <div className="ai-header">
        <span>AI 助手</span>
        <div className="ai-header-right">
          <label
            className={`ctx-toggle agent-toggle${agentMode ? " on" : ""}`}
            title={
              activeSessionId
                ? "Agent 模式：点一次发送后智能连续执行，危险命令会二次确认"
                : "Agent 模式需要在 SSH 会话标签下使用"
            }
          >
              <input
                type="checkbox"
                checked={agentMode}
                disabled={!activeSessionId}
                onChange={(e) => {
                  const nextAgentMode = e.target.checked;
                  resetAgentChannel(getScopedConversationKey(conversationKey, true));
                  setAgentModeFor(conversationKey, nextAgentMode);
                }}
              />
            Agent
          </label>
          {!agentMode && (
            <label className="ctx-toggle" title="提问时附带当前终端最近输出">
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} />
              上下文
            </label>
          )}
          <button className="icon-btn" title="清空当前会话对话" onClick={clearConversation} disabled={streaming || agentBusy}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-hint" style={{ marginTop: 30 }}>
            用自然语言描述你想做的事
            <br />
            例如：查看占用 8080 端口的进程
          </div>
        )}
        {messages.map((m, i) => {
          const agentMeta = m.meta?.kind === "agent-exec" ? m.meta : null;
          const limitMeta = m.meta?.kind === "agent-limit" ? m.meta : null;
          const queuedMeta = m.meta?.kind === "agent-queued" ? m.meta : null;
          return (
            <div
              key={i}
              className={`ai-msg ${m.role}${m.role === "assistant" ? " structured" : ""}${
                agentMeta || limitMeta ? " agent-exec-msg" : ""
              }${queuedMeta ? " agent-queued-msg" : ""}`}
            >
              {agentMeta ? (
                <AgentExecSummary meta={agentMeta} />
              ) : limitMeta ? (
                <AgentLimitNotice
                  meta={limitMeta}
                  onContinue={() => continueAgentAfterLimit(activeConversationKey)}
                  onEnd={() => endAgentAtLimit(activeConversationKey)}
                />
              ) : m.role === "user" ? (
                queuedMeta ? (
                  <>
                    <div>{m.content}</div>
                    <span className={`agent-queued-status ${queuedMeta.status}`}>
                      {queuedMeta.status === "queued"
                        ? "等待当前步骤结束后处理"
                        : queuedMeta.status === "applied"
                          ? "已纳入后续计划"
                          : "已取消"}
                    </span>
                  </>
                ) : (
                  m.content
                )
              ) : (
                <AgentMarkdown
                  content={m.content}
                  codeClassName={agentMode ? "agent-code" : undefined}
                  onInsertCommand={agentMode ? undefined : insertCommand}
                />
              )}
              {m.role === "assistant" &&
                streaming &&
                m.id === streamingAssistantIds.current[activeConversationKey] && (
                <span className="cursor-blink">▌</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="ai-quick">
        <button className="btn mini" onClick={diagnose} disabled={streaming || agentBusy}>
          诊断最近报错
        </button>
        <button className="btn mini" onClick={() => send("解释终端最近输出的含义。")} disabled={streaming || agentBusy}>
          解释输出
        </button>
      </div>
      <div className="ai-input-box">
        <textarea
          ref={inputRef}
          className="ai-input"
          rows={2}
          placeholder={
            agentCanQueue
              ? "追加要求，将在当前步骤结束后处理"
              : "描述任务或提问，例如：查看占用 8080 端口的进程"
          }
          value={input}
          disabled={!agentMode && (streaming || agentBusy)}
          onChange={(e) =>
            setDrafts((prev) => ({ ...prev, [activeConversationKey]: e.target.value }))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitInput();
            }
          }}
        />
        <div className="ai-input-bar">
          <span className="ai-input-hint">
            {agentCanQueue ? "Enter 追加 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行"}
          </span>
          {agentCanQueue ? (
            <div className="agent-input-actions">
              {(streaming || agentBusy) && (
                <button className="btn stop-btn" onClick={stop} title="停止当前 Agent 任务">
                  ■ 停止
                </button>
              )}
              <button className="btn primary send-btn" onClick={submitInput} disabled={!input.trim()}>
                追加 ➤
              </button>
            </div>
          ) : streaming ? (
            <button className="btn stop-btn" onClick={stop} title="停止生成">
              ■ 停止
            </button>
          ) : (
            <button className="btn primary send-btn" onClick={submitInput} disabled={!input.trim() || agentBusy}>
              发送 ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
