import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as api from "../api";
import { checkDangerous } from "../dangerous";
import { useDialogs } from "./Dialogs";
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
  externalRequest?: { text: string; nonce: number } | null;
  closeAgentRequest?: { keys: string[]; nonce: number } | null;
}

type AgentExecMeta = {
  kind: "agent-exec";
  command: string;
  commandCount?: number;
  exitCode: number | null;
  output: string;
  outputChars: number;
  truncated: boolean;
};

type UiChatMessage = ChatMessage & {
  meta?: AgentExecMeta;
};

type AgentStepOptions = {
  key?: string;
  sessionId?: string;
  auto?: boolean;
};

type SendOptions = {
  key?: string;
  sessionId?: string;
};

const AGENT_RUN_TIMEOUT_MS = 35_000;
const AGENT_MAX_AUTO_STEPS = 12;
const AGENT_MAX_COMMANDS_PER_BATCH = 5;
const AGENT_OUTPUT_PER_COMMAND_LIMIT = 2600;
const AGENT_EXEC_DETAIL_LIMIT = 4200;

const AGENT_SYSTEM_PROMPT = `你是 TermAI 的运维 Agent，在用户的真实服务器上分步执行任务。
核心原则：
1. 不要把自己当聊天问答助手，要像资深运维一样先收集证据、再判断、再行动。
2. 用户目标即使比较宽泛，也优先执行安全的只读探测命令，不要一上来要求用户细化。只有会修改系统、会部署/删除/重启、或确实无法确定目标对象时才追问。
3. 每轮先给出一句执行意图，然后输出 1 到 5 个 \`\`\` 代码块；每个代码块只放一条命令。安全、只读、互相独立的探测命令应放在同一轮执行，不要机械地一条条请求。
4. 命令必须非交互、可自动结束；实时/全屏命令要改成有限运行形式，例如 top -b -n 1、timeout 8s tail -f ...。需要进入目录时，用 cd /path && command 这类自包含命令，不要依赖上一条命令的隐藏状态。
5. 安全命令会自动批量执行；危险操作（删除/重启/权限变更/安装软件/覆盖配置）不要混进批量探测里，必须单独给出并先明确警告，系统会要求用户确认。
6. 命令执行后其"退出码 + 输出"会作为下一条消息发回给你，你要继续基于证据推进。不要重复执行已经有结论的 uptime/free/top/df 等同类探测。
7. 如果一轮批量探测已经足够判断，直接以"任务完成"开头给出结论；目标达成时【不要】再输出任何命令代码块。

常见任务策略：
- 性能/卡顿/负载问题：先组合一轮只读诊断批次，覆盖 uptime、CPU/内存/top、磁盘空间、磁盘 IO、网络连接、关键错误日志；不要拆成多个重复小步骤。
- 部署服务：先发现当前目录、常见项目文件、systemd 服务、Docker/Compose、运行进程和监听端口；若用户说"所有"，理解为"把当前机器上可识别的服务都盘点出来"，先只读盘点，再让用户确认要部署哪些。
- 日志/报错：先定位服务、最近日志、错误关键词和时间范围；输出证据后再建议修复。
用中文，简洁。`;

const SYSTEM_PROMPT = `你是 TermAI 内置的运维终端助手。用户正在使用一个远程终端（SSH 或本地 PowerShell）。
规则：
1. 回答务必简洁、面向命令行操作。
2. 需要给出可执行命令时，用 \`\`\` 代码块单独给出，一个代码块只放一条命令，方便用户一键插入终端。
3. 危险操作（删除、格式化、重启、权限变更）必须先警告。
4. 用中文回答。`;

// ---------- 轻量 markdown 渲染 ----------

/** 按 ``` 代码块切开 */
function splitBlocks(text: string): { code: boolean; content: string }[] {
  const parts: { code: boolean; content: string }[] = [];
  const re = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)(```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ code: false, content: text.slice(last, m.index) });
    parts.push({ code: true, content: m[1].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ code: false, content: text.slice(last) });
  return parts;
}

function extractAgentCommands(text: string): string[] {
  return splitBlocks(text)
    .filter((b) => b.code && b.content.trim())
    .map((b) => b.content.trim())
    .slice(0, AGENT_MAX_COMMANDS_PER_BATCH);
}

/** 行内 markdown：**粗体** 与 `行内代码` */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[2]}</strong>);
    else if (m[3] !== undefined)
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="inline-code">
          {m[3]}
        </code>
      );
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 非代码块文本渲染为段落/列表；空行转为段距（不与块级换行叠加） */
function renderProse(text: string, keyPrefix: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  let pendingGap = false;
  let listGap = false;
  const flushList = () => {
    if (list.length) {
      out.push(
        <ul key={`${keyPrefix}-ul${out.length}`} className={`ai-list${listGap ? " para-gap" : ""}`}>
          {list}
        </ul>
      );
      list = [];
      listGap = false;
    }
  };
  lines.forEach((line, idx) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      if (list.length === 0 && pendingGap) listGap = true;
      list.push(<li key={`${keyPrefix}-li${idx}`}>{renderInline((bullet ?? numbered)![1], `${keyPrefix}-li${idx}`)}</li>);
      pendingGap = false;
    } else if (line.trim() === "") {
      flushList();
      pendingGap = true;
    } else {
      flushList();
      out.push(
        <div key={`${keyPrefix}-p${idx}`} className={`ai-line${pendingGap ? " para-gap" : ""}`}>
          {renderInline(line, `${keyPrefix}-p${idx}`)}
        </div>
      );
      pendingGap = false;
    }
  });
  flushList();
  return out;
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

function clipText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n...[输出已截断]`, truncated: true };
}

function normalizeAgentCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

type AgentCommandResult = {
  command: string;
  note?: string;
  exitCode: number | null;
  output: string;
  outputChars: number;
  truncated: boolean;
};

function buildAgentFeedback(goal: string | undefined, results: AgentCommandResult[]): string {
  const sections = results
    .map((r, idx) => {
      const out = r.output || "(无输出)";
      return `【命令 ${idx + 1}/${results.length}】\n\`\`\`\n${r.command}\n\`\`\`\n${
        r.note ? `执行说明：${r.note}\n` : ""
      }退出码 ${r.exitCode ?? "?"}，输出：\n${out}`;
    })
    .join("\n\n");
  return `${goal ? `【原始任务】\n${goal}\n\n` : ""}【Agent 执行批次结果】\n${sections}\n\n请基于以上真实输出继续推进：如果目标尚未达成，给出下一批 1 到 ${AGENT_MAX_COMMANDS_PER_BATCH} 条安全、必要、非重复的命令；如果已经足够判断，以"任务完成"开头给出结论，不要再输出命令代码块。`;
}

function buildAgentExecDetail(results: AgentCommandResult[]): { output: string; outputChars: number; truncated: boolean } {
  const raw = results
    .map((r, idx) => `# ${idx + 1}. ${r.command}\n退出码 ${r.exitCode ?? "?"}\n${r.output || "(无输出)"}`)
    .join("\n\n");
  const clipped = clipText(raw, AGENT_EXEC_DETAIL_LIMIT);
  return {
    output: clipped.text,
    outputChars: results.reduce((sum, r) => sum + r.outputChars, 0),
    truncated: clipped.truncated || results.some((r) => r.truncated),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer = 0;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function prepareAgentCommand(command: string): { command: string; note?: string } {
  const line = command.trim();
  if (/^top\b/.test(line) && !/(^|\s)-b(\s|$)/.test(line)) {
    const rest = line.replace(/^top\b/, "").trim();
    return {
      command: `top -b -n 1${rest ? ` ${rest}` : ""}`,
      note: "已将 top 调整为单次批处理模式，执行后自动退出。",
    };
  }
  if (/^htop\b/.test(line)) {
    return {
      command: "top -b -n 1",
      note: "htop 是交互界面，已用 top 单次批处理模式替代。",
    };
  }
  const needsTimeout =
    /^(watch|less|more)\b/.test(line) ||
    /^tail\b[\s\S]*\s-f\b/.test(line) ||
    /^journalctl\b[\s\S]*\s-f\b/.test(line);
  if (needsTimeout && !/^timeout\b/.test(line)) {
    return {
      command: `timeout 8s ${line}`,
      note: "已为常驻/翻页命令加 8 秒自动退出。",
    };
  }
  return { command: line };
}

function AgentExecSummary({ meta }: { meta: AgentExecMeta }) {
  const [expanded, setExpanded] = useState(false);
  const ok = meta.exitCode === 0;
  const outputText = meta.output || "(无输出)";
  const outputLabel = formatOutputLabel(meta.outputChars, meta.truncated);
  const commandCount = meta.commandCount ?? 1;
  const stateLabel = commandCount > 1 ? `已执行 ${commandCount} 条` : "已执行";
  const commandTitle = commandCount > 1 ? meta.command.split("\n")[0] : meta.command;

  return (
    <div className={`agent-exec ${ok ? "ok" : "warn"}${expanded ? " open" : ""}`}>
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
        <span className="agent-exec-meta">
          退出码 {formatExitCode(meta.exitCode)} · {outputLabel}
        </span>
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
  const { confirm } = useDialogs();
  // 每个终端标签一份对话历史，按 conversationKey 存取
  const [convos, setConvos] = useState<Record<string, UiChatMessage[]>>({});
  const convosRef = useRef<Record<string, UiChatMessage[]>>({});
  const messages = convos[conversationKey] ?? [];
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [agentMode, setAgentMode] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const streamingRef = useRef(false);
  const agentBusyRef = useRef(false);
  const agentModeRef = useRef(false);
  const activeSessionIdRef = useRef<string | undefined>(activeSessionId);
  // 每个会话一条常驻 Agent 通道
  const agentIds = useRef<Record<string, string>>({});
  const agentAutoSteps = useRef<Record<string, number>>({});
  const agentGoals = useRef<Record<string, string>>({});
  const agentExecutedCommands = useRef<Record<string, Set<string>>>({});
  const agentRunSeq = useRef(0);
  const runningAgentKey = useRef<string | null>(null);
  const handledCloseNonce = useRef<number | null>(null);

  const setMessagesFor = (key: string, updater: (prev: UiChatMessage[]) => UiChatMessage[]) =>
    setConvos((prev) => {
      const next = { ...prev, [key]: updater(prev[key] ?? []) };
      convosRef.current = next;
      return next;
    });

  const setStreamingState = (value: boolean) => {
    streamingRef.current = value;
    setStreaming(value);
  };

  const setAgentBusyState = (value: boolean) => {
    agentBusyRef.current = value;
    setAgentBusy(value);
  };

  useEffect(() => {
    agentModeRef.current = agentMode;
  }, [agentMode]);

  useEffect(() => {
    convosRef.current = convos;
  }, [convos]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const closeAgentChannel = (key: string) => {
    const aid = agentIds.current[key];
    if (aid) {
      api.agentClose(aid).catch(() => {});
      delete agentIds.current[key];
    }
  };

  const resetAgentChannel = (key: string) => {
    agentRunSeq.current += 1;
    if (runningAgentKey.current === key) runningAgentKey.current = null;
    closeAgentChannel(key);
    agentAutoSteps.current[key] = 0;
    delete agentGoals.current[key];
    delete agentExecutedCommands.current[key];
    setAgentBusyState(false);
  };

  const disposeConversationKeys = (keys: string[]) => {
    const keySet = new Set(keys.filter(Boolean));
    if (keySet.size === 0) return;
    if (runningAgentKey.current && keySet.has(runningAgentKey.current)) {
      agentRunSeq.current += 1;
      runningAgentKey.current = null;
      setAgentBusyState(false);
    }
    keySet.forEach(closeAgentChannel);
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
        delete agentExecutedCommands.current[key];
      });
      if (changed) convosRef.current = next;
      return changed ? next : prev;
    });
  };

  useEffect(() => {
    if (!closeAgentRequest || handledCloseNonce.current === closeAgentRequest.nonce) return;
    handledCloseNonce.current = closeAgentRequest.nonce;
    disposeConversationKeys(closeAgentRequest.keys);
  }, [closeAgentRequest]);

  useEffect(
    () => () => {
      Object.keys(agentIds.current).forEach(closeAgentChannel);
    },
    []
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const stop = () => {
    abortRef.current = true;
    agentRunSeq.current += 1;
    runningAgentKey.current = null;
    setAgentBusyState(false);
    setStreamingState(false);
  };

  const send = async (userText: string, meta?: AgentExecMeta, options?: SendOptions) => {
    if (!userText.trim() || streamingRef.current || agentBusyRef.current) return;
    const key = options?.key ?? conversationKey; // 锁定发起时的归属，流式中切标签也写回原会话
    const sessionId = options?.sessionId ?? activeSessionId ?? activeSessionIdRef.current;
    const useAgent = agentModeRef.current && Boolean(sessionId);
    if (useAgent && !meta) {
      agentAutoSteps.current[key] = 0;
      agentGoals.current[key] = userText.trim();
      agentExecutedCommands.current[key] = new Set();
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
      ...(convosRef.current[key] ?? []).map(toChatMessage),
      { role: "user", content: question },
    ];
    setMessagesFor(key, (prev) => [
      ...prev,
      { role: "user", content: userText.trim(), meta },
      { role: "assistant", content: "" },
    ]);
    setInput("");
    abortRef.current = false;
    setStreamingState(true);

    // 环境信息注入 system prompt；Agent 模式用 Agent 提示词
    const env = getEnv().trim();
    const base = useAgent ? AGENT_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const sys = env ? `${base}\n\n【当前服务器环境】\n${env}` : base;
    let assistantText = "";

    const appendToLast = (extra: string) =>
      setMessagesFor(key, (prev) => {
        const next = [...prev];
        if (next.length) next[next.length - 1] = { role: "assistant", content: next[next.length - 1].content + extra };
        return next;
      });

    try {
      await api.aiChat(sys, history, (e) => {
        if (abortRef.current) return;
        if (e.type === "delta") {
          assistantText += e.text;
          appendToLast(e.text);
        }
        else if (e.type === "error") {
          appendToLast(`\n[错误] ${e.message}`);
          setStreamingState(false);
        } else if (e.type === "done") {
          setStreamingState(false);
          const commands = useAgent ? extractAgentCommands(assistantText) : [];
          if (commands.length > 0 && agentModeRef.current && sessionId) {
            window.setTimeout(() => {
              void runAgentBatch(commands, { key, sessionId, auto: true });
            }, 0);
          }
        }
      });
    } catch (err) {
      appendToLast(`\n[错误] ${String(err)}`);
      setStreamingState(false);
    }
  };

  const lastNonce = useRef(0);
  useEffect(() => {
    if (externalRequest && externalRequest.nonce !== lastNonce.current && hasProvider) {
      lastNonce.current = externalRequest.nonce;
      send(externalRequest.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRequest]);

  const diagnose = () => {
    if (!getRecentOutput().trim()) return;
    send("请分析终端最近输出中的报错原因，并给出修复命令。");
  };

  const clearConversation = () => {
    if (streamingRef.current || agentBusyRef.current) return;
    const key = conversationKey;
    resetAgentChannel(key);
    setConvos((prev) => {
      const next = { ...prev, [key]: [] };
      convosRef.current = next;
      return next;
    });
  };

  /** Agent 模式：执行 AI 给出的一批命令，把结果汇总喂回 AI 决定下一步 */
  const runAgentBatch = async (commandInput: string[] | string, options?: AgentStepOptions) => {
    if (streamingRef.current || agentBusyRef.current) return;
    const commands = (Array.isArray(commandInput) ? commandInput : [commandInput])
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, AGENT_MAX_COMMANDS_PER_BATCH);
    if (commands.length === 0) return;
    const key = options?.key ?? conversationKey;
    const sessionId = options?.sessionId ?? activeSessionId ?? activeSessionIdRef.current;
    if (!sessionId) {
      setMessagesFor(key, (prev) => [
        ...prev,
        { role: "assistant", content: "[Agent] 需要在一个 SSH 会话标签下才能执行命令。" },
      ]);
      return;
    }
    if (options?.auto) {
      const steps = (agentAutoSteps.current[key] ?? 0) + 1;
      agentAutoSteps.current[key] = steps;
      if (steps > AGENT_MAX_AUTO_STEPS) {
        setMessagesFor(key, (prev) => [
          ...prev,
          { role: "assistant", content: `[Agent] 已连续执行 ${AGENT_MAX_AUTO_STEPS} 轮，为避免误操作已暂停。需要继续请重新发送任务或关闭后再开启 Agent。` },
        ]);
        return;
      }
    }
    const runSeq = ++agentRunSeq.current;
    runningAgentKey.current = key;
    setAgentBusyState(true);
    try {
      let aid = agentIds.current[key];
      if (!aid) {
        aid = await withTimeout(
          api.agentOpen(sessionId),
          AGENT_RUN_TIMEOUT_MS,
          "Agent 连接超时，已取消本次执行。"
        );
        if (runSeq !== agentRunSeq.current) {
          api.agentClose(aid).catch(() => {});
          if (runningAgentKey.current === key) runningAgentKey.current = null;
          return;
        }
        agentIds.current[key] = aid;
      }
      const results: AgentCommandResult[] = [];
      const executedCommands = agentExecutedCommands.current[key] ?? new Set<string>();
      agentExecutedCommands.current[key] = executedCommands;
      for (const rawCommand of commands) {
        const prepared = prepareAgentCommand(rawCommand);
        const commandToRun = prepared.command;
        const signature = normalizeAgentCommand(commandToRun);
        if (executedCommands.has(signature)) {
          results.push({
            command: commandToRun,
            note: "该命令在当前任务中已经执行过，已跳过以避免重复探测。",
            exitCode: 0,
            output: "已跳过重复命令。",
            outputChars: 0,
            truncated: false,
          });
          continue;
        }
        const verdict = checkDangerous(commandToRun);
        if (verdict.danger) {
          const ok = await confirm({
            title: "⚠ Agent 危险命令确认",
            message: `Agent 准备执行：\n\n${commandToRun}\n\n风险：${verdict.reason}\n\n确认让它执行吗？`,
            danger: true,
            okText: "确认执行",
          });
          if (!ok) {
            results.push({
              command: commandToRun,
              note: "用户取消了危险命令，本批次后续命令未执行。",
              exitCode: null,
              output: "已取消执行。",
              outputChars: 0,
              truncated: false,
            });
            break;
          }
        }
        try {
          const result = await withTimeout(
            api.agentRun(aid, commandToRun),
            AGENT_RUN_TIMEOUT_MS,
            "Agent 执行超时，已重置执行通道。请确认命令会自动结束后再重试。"
          );
          if (runSeq !== agentRunSeq.current) {
            if (runningAgentKey.current === key) runningAgentKey.current = null;
            return;
          }
          const rawOutput = result.output;
          const clipped = clipText(rawOutput || "(无输出)", AGENT_OUTPUT_PER_COMMAND_LIMIT);
          executedCommands.add(signature);
          results.push({
            command: commandToRun,
            note: prepared.note,
            exitCode: result.exitCode,
            output: clipped.text,
            outputChars: rawOutput.length,
            truncated: clipped.truncated,
          });
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
      const feedback = buildAgentFeedback(agentGoals.current[key], results);
      const detail = buildAgentExecDetail(results);
      const firstProblem = results.find((r) => r.exitCode !== 0);
      const worstExitCode = firstProblem ? firstProblem.exitCode : 0;
      setAgentBusyState(false);
      if (runningAgentKey.current === key) runningAgentKey.current = null;
      await send(feedback, {
        kind: "agent-exec",
        command: results.map((r) => r.command).join("\n"),
        commandCount: results.length,
        exitCode: worstExitCode,
        output: detail.output,
        outputChars: detail.outputChars,
        truncated: detail.truncated,
      }, { key, sessionId }); // 结果喂回 AI，产生下一步
    } catch (e) {
      if (runSeq !== agentRunSeq.current) {
        if (runningAgentKey.current === key) runningAgentKey.current = null;
        return;
      }
      closeAgentChannel(key);
      setAgentBusyState(false);
      if (runningAgentKey.current === key) runningAgentKey.current = null;
      setMessagesFor(key, (prev) => [
        ...prev,
        { role: "assistant", content: `[Agent 执行失败] ${String(e)}` },
      ]);
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
                  agentModeRef.current = e.target.checked;
                  resetAgentChannel(conversationKey);
                  setAgentMode(e.target.checked);
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
          return (
            <div
              key={i}
              className={`ai-msg ${m.role}${m.role === "assistant" ? " structured" : ""}${
                agentMeta ? " agent-exec-msg" : ""
              }`}
            >
              {agentMeta ? (
                <AgentExecSummary meta={agentMeta} />
              ) : m.role === "user" ? (
                m.content
              ) : (
                splitBlocks(m.content).map((b, j) =>
                  b.code ? (
                      <div key={j} className={`code-block${agentMode ? " agent-code" : ""}`}>
                        <pre>{b.content}</pre>
                        {!agentMode && (
                          <button
                            className="btn mini"
                            onClick={() => insertCommand(b.content)}
                            title="插入到当前终端（需自行按回车执行）"
                          >
                            插入
                          </button>
                        )}
                      </div>
                    ) : (
                      <div key={j} className="ai-prose">
                        {renderProse(b.content, `${i}-${j}`)}
                      </div>
                    )
                )
              )}
              {m.role === "assistant" && streaming && i === messages.length - 1 && (
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
          className="ai-input"
          rows={2}
          placeholder="描述任务或提问，例如：查看占用 8080 端口的进程"
          value={input}
          disabled={streaming || agentBusy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="ai-input-bar">
          <span className="ai-input-hint">Enter 发送 · Shift+Enter 换行</span>
          {streaming ? (
            <button className="btn stop-btn" onClick={stop} title="停止生成">
              ■ 停止
            </button>
          ) : (
            <button className="btn primary send-btn" onClick={() => send(input)} disabled={!input.trim() || agentBusy}>
              发送 ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
