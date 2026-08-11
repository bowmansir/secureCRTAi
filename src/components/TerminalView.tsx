import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import * as api from "../api";
import { agentChannels } from "../agent/agentChannels";
import { TerminalAgentRuntime } from "../agent/terminalAgentRuntime";
import {
  useTerminalSurface,
  useTerminalSurfaces,
} from "../agent/TerminalSurfaceProvider";
import { SEPARATOR, useContextMenu } from "./ContextMenu";
import { useDialogs } from "./Dialogs";
import Icon from "./Icons";
import InlineAgentTimeline from "./InlineAgentTimeline";
import type { SessionProfile, TabInfo, TermEvent } from "../types";
import {
  canRouteTerminalSubmission,
  classifyTerminalInput,
  extractTerminalPromptInput,
  isLikelyShellPrompt,
  splitTerminalSubmissionData,
  stripTerminalControlSequences,
  updateTerminalInputCapture,
} from "../terminal/inputRouter";
import {
  decideTerminalInput,
  getInputModeIndicator,
  resolvePromptInputTarget,
  resolveInputTargetForDisplay,
  toggleFixedInputMode,
} from "../terminal/inputDecisionModel";
import {
  createShellBlockAttachment,
  createTerminalSelectionAttachment,
} from "../agent/contextAssembler";
import { MAX_CONTEXT_ATTACHMENTS } from "../agent/surfaceModel";
import {
  SHELL_BLOCK_OUTPUT_LIMIT,
  appendShellBlockOutput,
  completeShellBlock,
  createShellBlock,
  getRunningShellCommandLabel,
  isInteractiveShellCommand,
} from "../terminal/shellBlocks";
import type {
  AgentContextPolicy,
  ContextAttachment,
  ShellBlock,
} from "../agent/surfaceModel";
import type {
  TerminalInputCapture,
  TerminalInputMode,
  TerminalInputTarget,
} from "../terminal/inputRouter";
import {
  getTerminalTheme,
  type AppTheme,
} from "../terminal/terminalThemes";

interface Props {
  tab: TabInfo;
  active: boolean;
  visible?: boolean;
  theme: AppTheme;
  backgroundActive: boolean;
  onStatus: (tabId: string, status: TabInfo["status"], message?: string) => void;
  /** 终端输出回调，用于 AI 上下文缓冲 */
  onOutput: (tabId: string, text: string) => void;
  /** 把后端终端 id 注册回来，供 AI 面板插入命令 */
  registerTermId: (tabId: string, termId: string) => void;
  /** 回报当前终端行列，用于底部状态栏 */
  onSize?: (tabId: string, cols: number, rows: number) => void;
  /** SSH 会话右键可直接打开对应 SFTP */
  onOpenSftp?: () => void;
  /** 把选中文本交给 AI 面板解释 */
  onAskAi: (question: string) => void;
  /** 打开传统命令助手并聚焦输入框 */
  onOpenCommandAssistant: () => void;
  /** 当前是否已配置可用的 AI Provider */
  agentAvailable: boolean;
  /** 顶部 AI 面板打开时隐藏终端内联 Agent 入口和时间线 */
  inlineAgentEnabled: boolean;
  sessionProfile?: SessionProfile;
}

function readCompletedCommandFromTerminal(
  terminal: Terminal,
  partialCommand: string
): string {
  const partial = partialCommand.trim();

  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  let firstRow = cursorRow;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow--;

  let logicalLine = "";
  for (let row = firstRow; row <= cursorRow; row++) {
    logicalLine += buffer.getLine(row)?.translateToString(false) ?? "";
  }
  return extractTerminalPromptInput(logicalLine, partial);
}

function preferCompletedCommand(markerCommand: string, terminalCommand: string) {
  const marker = markerCommand.trim();
  const completed = terminalCommand.trim();
  if (completed && marker && completed.startsWith(marker)) return completed;
  return marker || completed;
}

function fallbackPrompt(
  tab: TabInfo,
  sessionProfile?: SessionProfile,
  cwd?: string
): string {
  if (tab.kind === "local") return "PS>";
  const username = sessionProfile?.username || "user";
  const host = sessionProfile?.host || tab.title || "host";
  const home = username === "root" ? "/root" : `/home/${username}`;
  const displayCwd = !cwd || cwd === home ? "~" : cwd;
  return `[${username}@${host} ${displayCwd}]${username === "root" ? "#" : "$"}`;
}

export default function TerminalView({
  tab,
  active,
  visible,
  theme,
  backgroundActive,
  onStatus,
  onOutput,
  registerTermId,
  onSize,
  onOpenSftp,
  onAskAi,
  onOpenCommandAssistant,
  agentAvailable,
  inlineAgentEnabled,
  sessionProfile,
}: Props) {
  const { showMenu } = useContextMenu();
  const dialogs = useDialogs();
  const { dispatchToSurface, getSurface } = useTerminalSurfaces();
  const isVisible = visible ?? active;
  const surface = useTerminalSurface(tab.tabId, isVisible);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const dialogsRef = useRef(dialogs);
  dialogsRef.current = dialogs;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const termIdRef = useRef<string | null>(null);
  const decoder = useRef(new TextDecoder());
  const openedRef = useRef(false);
  // 自动重连
  const wasConnectedRef = useRef(false);
  const disposedRef = useRef(false);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const inputModeRef = useRef<TerminalInputMode>("auto");
  const agentAvailableRef = useRef(agentAvailable);
  const inlineAgentEnabledRef = useRef(inlineAgentEnabled);
  const shellIntegrationReadyRef = useRef(false);
  const activeShellBlockRef = useRef<ShellBlock | null>(null);
  const activeShellCommandIdRef = useRef<string | null>(null);
  const rawTerminalRef = useRef(false);
  const deferComposerFocusRef = useRef(false);
  const writeToPtyRef = useRef<(data: string) => void>(() => {});
  const submitComposerRef = useRef<() => void>(() => {});
  const handoffToTerminalRef = useRef<(data: string) => Promise<void>>(
    async () => {}
  );
  const composerActiveRef = useRef(false);
  const promptReadyRef = useRef(false);
  const inputStartedAtPromptRef = useRef(false);
  const inputCaptureRef = useRef<TerminalInputCapture>({ text: "", reliable: true });
  const outputTailRef = useRef("");
  const rawCommandOutputRef = useRef("");
  const rawCommandFallbackRef = useRef("");
  // 搜索
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [integrationState, setIntegrationState] = useState<
    "pending" | "ready" | "raw"
  >(tab.kind === "ssh" ? "pending" : "raw");
  const integrationStateRef = useRef<"pending" | "ready" | "raw">(
    tab.kind === "ssh" ? "pending" : "raw"
  );
  const [composerDraft, setComposerDraft] = useState(surface?.draft ?? "");
  const [promptLabel, setPromptLabel] = useState(() =>
    fallbackPrompt(tab, sessionProfile, surface?.environment?.cwd)
  );
  const composerDraftRef = useRef(surface?.draft ?? "");
  composerDraftRef.current = composerDraft;
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const composerHistoryRef = useRef<string[]>([]);
  const composerHistoryIndexRef = useRef(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const MAX_RECONNECT = 6;
  const runtimeRef = useRef<TerminalAgentRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = new TerminalAgentRuntime({
      chat: api.aiChat,
      channels: agentChannels,
      getSurface: () => getSurface(tab.tabId),
      dispatch: dispatchToSurface,
      requestApproval: async (action, risk) => {
        const choice = await dialogsRef.current.approval({
          title: "Agent 命令确认",
          command: action.command,
          riskLevel: risk.riskLevel,
          reason: risk.reason,
        });
        if (choice !== "modify") return { decision: choice };
        const command = await dialogsRef.current.prompt({
          title: "修改 Agent 命令",
          defaultValue: action.command,
          note: "修改后的命令会重新经过风险检查。",
        });
        return command?.trim()
          ? { decision: "modify", command: command.trim() }
          : { decision: "reject" };
      },
    });
  }
  const inputMode: TerminalInputMode = surface?.routingMode ?? "auto";
  const detectedTarget: TerminalInputTarget =
    surface?.inputTarget ?? "shell";
  inputModeRef.current = inputMode;

  const hasAgentConversation =
    surface?.blocks.some((block) => block.kind !== "shell") ?? false;
  const runningShellBlock = surface?.blocks.find(
    (block): block is ShellBlock =>
      block.kind === "shell" && block.status === "running"
  );
  const shellBusy = Boolean(runningShellBlock);
  const inlineTimelineVisible =
    inlineAgentEnabled &&
    integrationState === "ready" &&
    surface?.control !== "raw-terminal" &&
    hasAgentConversation;
  const composerActive = inlineTimelineVisible && !shellBusy;
  composerActiveRef.current = composerActive;

  const activeInputTarget = composerActive
    ? resolveInputTargetForDisplay(
        {
          text: composerDraft,
          agentAvailable,
          routingMode: inputMode,
          captureReliable: true,
          agentFollowUp: hasAgentConversation,
        },
        detectedTarget
      )
    : detectedTarget;
  const agentActive =
    surface?.control === "streaming" ||
    surface?.control === "executing" ||
    surface?.control === "waiting-approval" ||
    surface?.control === "paused";
  const contextAttachments = surface?.contextAttachments ?? [];
  const attachedBlockIds = contextAttachments.flatMap((attachment) =>
    attachment.blockId ? [attachment.blockId] : []
  );

  const setContextPolicy = (policy: AgentContextPolicy) => {
    dispatchToSurface(tab.tabId, { type: "set-context-policy", policy });
  };

  const removeContextAttachment = (attachment: ContextAttachment) => {
    const current = surfaceRef.current;
    dispatchToSurface(tab.tabId, {
      type: "remove-context-attachment",
      attachmentId: attachment.id,
    });
    if (
      current?.contextPolicy === "selected-blocks" &&
      current.contextAttachments.length === 1
    ) {
      setContextPolicy("none");
    }
  };

  const toggleBlockContext = (block: ShellBlock) => {
    const existing = surfaceRef.current?.contextAttachments.find(
      (attachment) => attachment.blockId === block.id
    );
    if (existing) {
      removeContextAttachment(existing);
      return;
    }
    dispatchToSurface(tab.tabId, {
      type: "add-context-attachment",
      attachment: createShellBlockAttachment(block),
    });
    if (surfaceRef.current?.contextPolicy === "none") {
      setContextPolicy("selected-blocks");
    }
  };

  const attachTerminalSelection = (selection: string) => {
    const content = selection.trim();
    if (!content) return;
    const current = surfaceRef.current;
    const existing = current?.contextAttachments.find(
      (attachment) =>
        attachment.kind === "selection" && attachment.content === content
    );
    if (existing) {
      if (current?.contextPolicy === "none") {
        setContextPolicy("selected-blocks");
      }
      return;
    }
    if (
      (current?.contextAttachments.length ?? 0) >= MAX_CONTEXT_ATTACHMENTS
    ) {
      void dialogs.confirm({
        title: "上下文附件已满",
        message: `当前终端最多保留 ${MAX_CONTEXT_ATTACHMENTS} 个上下文附件，请先移除不再需要的内容。`,
        okText: "关闭",
        hideCancel: true,
      });
      return;
    }
    dispatchToSurface(tab.tabId, {
      type: "add-context-attachment",
      attachment: createTerminalSelectionAttachment(
        `context-selection:${tab.tabId}:${Date.now()}`,
        content
      ),
    });
    if (current?.contextPolicy === "none") {
      setContextPolicy("selected-blocks");
    }
  };

  const showContextAttachment = (attachment: ContextAttachment) => {
    const block = attachment.blockId
      ? surfaceRef.current?.blocks.find((item) => item.id === attachment.blockId)
      : undefined;
    const content =
      block?.kind === "shell"
        ? [
            `命令：${block.command}`,
            block.cwd ? `目录：${block.cwd}` : "",
            `退出码：${block.exitCode ?? "未知"}`,
            "",
            block.output || "(无输出)",
          ]
            .filter((line) => line !== "")
            .join("\n")
        : attachment.content || "(无内容)";
    void dialogs.confirm({
      title: attachment.label,
      message: content,
      okText: "关闭",
      hideCancel: true,
    });
  };

  const beginShellCommand = (command: string) => {
    const interactive = isInteractiveShellCommand(command);
    const block = createShellBlock(
      `shell-${tab.tabId}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      command,
      surfaceRef.current?.environment?.cwd,
      interactive
    );
    activeShellBlockRef.current = block;
    dispatchToSurface(tab.tabId, { type: "append-block", block });
    if (interactive) {
      rawTerminalRef.current = true;
      dispatchToSurface(tab.tabId, {
        type: "set-control",
        control: "raw-terminal",
      });
    }
    writeToPtyRef.current(`${command}\r`);
  };

  const submitComposer = async () => {
    const text = composerDraft.trim();
    if (!text || shellBusy || !composerActive) return;
    const submitDecision = decideTerminalInput({
      text,
      agentAvailable:
        agentAvailableRef.current && integrationStateRef.current !== "raw",
      routingMode: inputModeRef.current,
      captureReliable: true,
      agentFollowUp:
        surfaceRef.current?.blocks.some((block) => block.kind !== "shell") ??
        false,
    });

    composerDraftRef.current = "";
    setComposerDraft("");
    dispatchToSurface(tab.tabId, { type: "set-draft", draft: "" });
    composerHistoryIndexRef.current = -1;
    dispatchToSurface(tab.tabId, {
      type: "set-input-target",
      target: submitDecision.target,
    });

    if (submitDecision.target === "agent" && tab.sessionId) {
      await runtimeRef.current?.submit({
        surfaceId: tab.tabId,
        sessionId: tab.sessionId,
        prompt: text,
      });
      return;
    }

    if (agentActive) await runtimeRef.current?.stop(tab.tabId);
    composerHistoryRef.current = [
      text,
      ...composerHistoryRef.current.filter((item) => item !== text),
    ].slice(0, 100);
    beginShellCommand(text);
  };
  submitComposerRef.current = () => {
    void submitComposer();
  };

  const handoffToTerminal = async (data: string) => {
    if (!composerActive) return;
    const draft = composerDraftRef.current;
    if (agentActive) {
      await runtimeRef.current?.stop(tab.tabId);
      if (disposedRef.current) return;
    }
    composerDraftRef.current = "";
    setComposerDraft("");
    dispatchToSurface(tab.tabId, { type: "set-draft", draft: "" });
    dispatchToSurface(tab.tabId, {
      type: "set-control",
      control: "raw-terminal",
    });
    rawTerminalRef.current = true;
    inputStartedAtPromptRef.current = true;
    inputCaptureRef.current = { text: draft, reliable: false };
    rawCommandOutputRef.current = "";
    rawCommandFallbackRef.current = draft.trim();
    writeToPtyRef.current(`${draft}${data}`);
    window.setTimeout(() => termRef.current?.focus(), 0);
  };
  handoffToTerminalRef.current = handoffToTerminal;

  const setInputMode = (mode: TerminalInputMode) => {
    inputModeRef.current = mode;
    const inputText = composerActiveRef.current
      ? composerDraftRef.current
      : inputCaptureRef.current.text;
    const target = resolveInputTargetForDisplay(
      {
        text: inputText,
        agentAvailable:
          agentAvailableRef.current && integrationStateRef.current !== "raw",
        routingMode: mode,
        captureReliable: composerActiveRef.current
          ? true
          : inputCaptureRef.current.reliable,
        agentFollowUp:
          surfaceRef.current?.blocks.some((block) => block.kind !== "shell") ??
          false,
      },
      surfaceRef.current?.inputTarget ?? "shell"
    );
    dispatchToSurface(tab.tabId, {
      type: "set-routing-mode",
      mode,
    });
    dispatchToSurface(tab.tabId, { type: "set-input-target", target });
    if (composerActiveRef.current) {
      window.setTimeout(() => composerInputRef.current?.focus(), 0);
    } else {
      termRef.current?.focus();
    }
  };

  const updateComposerDraft = (nextDraft: string) => {
    composerDraftRef.current = nextDraft;
    setComposerDraft(nextDraft);
  };

  useEffect(() => {
    agentAvailableRef.current = agentAvailable;
    if (!agentAvailable) {
      if (inputModeRef.current === "agent") {
        setInputMode("auto");
      } else {
        dispatchToSurface(tab.tabId, {
          type: "set-input-target",
          target: resolvePromptInputTarget(
            inputModeRef.current,
            agentAvailableRef.current
          ),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentAvailable, dispatchToSurface, tab.tabId]);

  useEffect(() => {
    inlineAgentEnabledRef.current = inlineAgentEnabled;
    if (!inlineAgentEnabled) termRef.current?.focus();
  }, [inlineAgentEnabled]);

  useEffect(() => {
    dispatchToSurface(tab.tabId, {
      type: "set-input-target",
      target: activeInputTarget,
    });
  }, [activeInputTarget, dispatchToSurface, tab.tabId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      dispatchToSurface(tab.tabId, {
        type: "set-draft",
        draft: composerDraft,
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [composerDraft, dispatchToSurface, tab.tabId]);

  useEffect(() => {
    if (!active) return;
    const delay = composerActive && deferComposerFocusRef.current ? 100 : 0;
    if (composerActive) deferComposerFocusRef.current = false;
    const timer = window.setTimeout(() => {
      if (composerActive) composerInputRef.current?.focus();
      else termRef.current?.focus();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, composerActive]);

  useEffect(() => {
    if (!isVisible || !shellBusy) return;
    const interrupt = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "c") return;
      event.preventDefault();
      event.stopPropagation();
      writeToPtyRef.current("\x03");
      termRef.current?.focus();
    };
    window.addEventListener("keydown", interrupt, true);
    return () => window.removeEventListener("keydown", interrupt, true);
  }, [isVisible, shellBusy]);

  useEffect(() => {
    dispatchToSurface(tab.tabId, {
      type: "set-environment",
      environment: {
        kind: tab.kind === "ssh" ? "ssh" : "local",
        sessionId: tab.sessionId,
        host: sessionProfile?.host,
        port: sessionProfile?.port,
        username: sessionProfile?.username,
        connected: tab.status === "connected",
      },
    });
  }, [
    dispatchToSurface,
    sessionProfile?.host,
    sessionProfile?.port,
    sessionProfile?.username,
    tab.kind,
    tab.sessionId,
    tab.status,
    tab.tabId,
  ]);

  useEffect(() => {
    if (!containerRef.current || openedRef.current) return;
    openedRef.current = true;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      theme: getTerminalTheme(theme, backgroundActive),
      cursorBlink: true,
      allowTransparency: true,
      allowProposedApi: true,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(search);
    term.open(containerRef.current);
    const fitAndReport = () => {
      fit.fit();
      onSize?.(tab.tabId, term.cols, term.rows);
    };
    fitAndReport();
    // 保险：容器若在挂载瞬间还是 0×0（布局未定），rAF/延迟后再 fit 一次
    requestAnimationFrame(fitAndReport);
    setTimeout(fitAndReport, 60);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // 函数声明相互引用（hoisting）：handleEvent → scheduleReconnect → connect
    function handleEvent(e: TermEvent) {
      if (e.type === "data") {
        const bytes = new Uint8Array(e.bytes);
        term.write(bytes);
        const text = decoder.current.decode(bytes, { stream: true });
        onOutput(tab.tabId, text);
        const activeShellBlock = activeShellBlockRef.current;
        if (
          activeShellBlock &&
          e.commandId &&
          e.commandId === activeShellCommandIdRef.current
        ) {
          const nextBlock = appendShellBlockOutput(activeShellBlock, text);
          if (nextBlock !== activeShellBlock) {
            activeShellBlockRef.current = nextBlock;
            dispatchToSurface(tab.tabId, {
              type: "replace-block",
              block: nextBlock,
            });
          }
        } else if (rawTerminalRef.current && !e.commandId) {
          const combined = rawCommandOutputRef.current + text;
          rawCommandOutputRef.current =
            combined.length <= SHELL_BLOCK_OUTPUT_LIMIT
              ? combined
              : combined.slice(-SHELL_BLOCK_OUTPUT_LIMIT);
        }
        outputTailRef.current = (outputTailRef.current + text).slice(-1200);
        if (!inputStartedAtPromptRef.current) {
          promptReadyRef.current = isLikelyShellPrompt(outputTailRef.current);
          if (promptReadyRef.current) {
            const cleanTail = stripTerminalControlSequences(outputTailRef.current);
            const promptLines = cleanTail.split("\n");
            const nextPrompt = promptLines[promptLines.length - 1]?.trimEnd();
            if (nextPrompt) setPromptLabel(nextPrompt);
          }
        }
      } else if (e.type === "connected") {
        const reconnected = wasConnectedRef.current;
        wasConnectedRef.current = true;
        attemptsRef.current = 0;
        onStatus(tab.tabId, "connected");
        if (reconnected) term.write("\r\n\x1b[32m[已重新连接]\x1b[0m\r\n");
      } else if (e.type === "shellIntegration") {
        shellIntegrationReadyRef.current = e.available;
        integrationStateRef.current = e.available ? "ready" : "raw";
        setIntegrationState(e.available ? "ready" : "raw");
        if (!e.available && inputModeRef.current === "agent") {
          setInputMode("auto");
        }
        const currentEnvironment = surfaceRef.current?.environment;
        dispatchToSurface(tab.tabId, {
          type: "set-environment",
          environment: {
            kind: "ssh",
            sessionId: tab.sessionId,
            host: sessionProfile?.host,
            port: sessionProfile?.port,
            username: sessionProfile?.username,
            connected: true,
            cwd: currentEnvironment?.cwd,
            shell: e.shell ?? currentEnvironment?.shell,
            os: currentEnvironment?.os,
          },
        });
      } else if (e.type === "shellCommand") {
        const command = preferCompletedCommand(
          e.command,
          rawCommandFallbackRef.current
        );
        if (command) {
          let existingBlock = activeShellBlockRef.current;
          const currentCommandId = activeShellCommandIdRef.current;
          if (
            existingBlock &&
            currentCommandId &&
            currentCommandId !== e.commandId
          ) {
            dispatchToSurface(tab.tabId, {
              type: "replace-block",
              block: {
                ...existingBlock,
                status: "error",
                output: `${existingBlock.output}\n[未收到命令完成事件]`.trim(),
              },
            });
            existingBlock = null;
          }
          const interactive = isInteractiveShellCommand(command);
          const block = existingBlock
            ? {
                ...existingBlock,
                commandId: e.commandId,
                command,
                output: "",
                interactive,
                collapsed: interactive,
              }
            : createShellBlock(
                `shell-${tab.tabId}-${e.commandId}`,
                command,
                surfaceRef.current?.environment?.cwd,
                interactive,
                e.commandId
              );
          rawCommandOutputRef.current = "";
          rawCommandFallbackRef.current = command;
          activeShellBlockRef.current = block;
          activeShellCommandIdRef.current = e.commandId;
          dispatchToSurface(tab.tabId, {
            type: existingBlock ? "replace-block" : "append-block",
            block,
          });
          if (interactive) {
            rawTerminalRef.current = true;
            dispatchToSurface(tab.tabId, {
              type: "set-control",
              control: "raw-terminal",
            });
          }
        }
      } else if (e.type === "shellPrompt") {
        shellIntegrationReadyRef.current = true;
        integrationStateRef.current = "ready";
        setIntegrationState("ready");
        promptReadyRef.current = true;
        inputStartedAtPromptRef.current = false;
        inputCaptureRef.current = { text: "", reliable: true };
        dispatchToSurface(tab.tabId, {
          type: "set-input-target",
          target: "shell",
        });

        const promptMatchesActiveCommand =
          activeShellCommandIdRef.current === null
            ? !e.commandId
            : e.commandId === activeShellCommandIdRef.current;
        const activeShellBlock = promptMatchesActiveCommand
          ? activeShellBlockRef.current
          : null;
        const completedRawCommand =
          e.command?.trim() || rawCommandFallbackRef.current;
        const shouldRestoreInlineSurface =
          rawTerminalRef.current ||
          activeShellBlock?.interactive === true ||
          surfaceRef.current?.control === "raw-terminal";
        rawTerminalRef.current = false;
        if (shouldRestoreInlineSurface) deferComposerFocusRef.current = true;
        if (activeShellBlock) {
          const completed = completeShellBlock(
            activeShellBlock,
            e.exitCode,
            e.cwd
          );
          activeShellBlockRef.current = null;
          activeShellCommandIdRef.current = null;
          dispatchToSurface(tab.tabId, {
            type: "replace-block",
            block: completed,
          });
        } else if (shouldRestoreInlineSurface && completedRawCommand) {
          const interactive = isInteractiveShellCommand(completedRawCommand);
          const started = createShellBlock(
            `shell-${tab.tabId}-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            completedRawCommand,
            surfaceRef.current?.environment?.cwd,
            interactive
          );
          const withOutput = appendShellBlockOutput(
            started,
            rawCommandOutputRef.current
          );
          dispatchToSurface(tab.tabId, {
            type: "append-block",
            block: completeShellBlock(withOutput, e.exitCode, e.cwd),
          });
        }
        rawCommandOutputRef.current = "";
        rawCommandFallbackRef.current = "";
        if (activeShellBlock || shouldRestoreInlineSurface) {
          dispatchToSurface(tab.tabId, { type: "set-control", control: "idle" });
        }

        const currentEnvironment = surfaceRef.current?.environment;
        dispatchToSurface(tab.tabId, {
          type: "set-environment",
          environment: {
            kind: "ssh",
            sessionId: tab.sessionId,
            host: sessionProfile?.host,
            port: sessionProfile?.port,
            username: sessionProfile?.username,
            connected: true,
            cwd: e.cwd,
            shell: currentEnvironment?.shell,
            os: currentEnvironment?.os,
          },
        });
      } else if (e.type === "exit") {
        void runtimeRef.current?.stop(tab.tabId);
        const activeShellBlock = activeShellBlockRef.current;
        const shouldRestoreInlineSurface =
          rawTerminalRef.current ||
          activeShellBlock?.interactive === true ||
          surfaceRef.current?.control === "raw-terminal";
        rawTerminalRef.current = false;
        rawCommandOutputRef.current = "";
        rawCommandFallbackRef.current = "";
        if (activeShellBlock) {
          activeShellBlockRef.current = null;
          activeShellCommandIdRef.current = null;
          dispatchToSurface(tab.tabId, {
            type: "replace-block",
            block: {
              ...activeShellBlock,
              status: "error",
              output: `${activeShellBlock.output}\n[终端连接已断开]`.trim(),
            },
          });
        }
        if (activeShellBlock || shouldRestoreInlineSurface) {
          dispatchToSurface(tab.tabId, { type: "set-control", control: "idle" });
        }
        // 本地终端、用户主动关闭、从未连接成功：不重连
        if (tab.kind === "local" || disposedRef.current || !wasConnectedRef.current) {
          onStatus(tab.tabId, "closed", e.message ?? undefined);
          term.write("\r\n\x1b[90m[会话已结束]\x1b[0m\r\n");
        } else {
          scheduleReconnect();
        }
      }
    }

    function scheduleReconnect() {
      if (disposedRef.current) return;
      if (attemptsRef.current >= MAX_RECONNECT) {
        onStatus(tab.tabId, "closed");
        term.write("\r\n\x1b[31m[重连失败，已放弃。关闭本标签后可重新连接]\x1b[0m\r\n");
        return;
      }
      const n = attemptsRef.current++;
      const delay = Math.min(10000, 1000 * 2 ** n);
      onStatus(tab.tabId, "reconnecting");
      term.write(`\r\n\x1b[33m[连接断开，${delay / 1000}s 后第 ${n + 1} 次重连...]\x1b[0m\r\n`);
      const old = termIdRef.current;
      if (old) api.termClose(old).catch(() => {});
      termIdRef.current = null;
      reconnectTimerRef.current = window.setTimeout(() => {
        if (!disposedRef.current) connect();
      }, delay);
    }

    function connect() {
      shellIntegrationReadyRef.current = false;
      activeShellCommandIdRef.current = null;
      integrationStateRef.current = tab.kind === "ssh" ? "pending" : "raw";
      setIntegrationState(integrationStateRef.current);
      const p =
        tab.kind === "local"
          ? api.openLocalTerminal(term.cols, term.rows, handleEvent)
          : api.openSshBySession(tab.sessionId!, term.cols, term.rows, handleEvent);
      p.then((id) => {
        wasConnectedRef.current = true;
        attemptsRef.current = 0;
        onStatus(tab.tabId, "connected");
        termIdRef.current = id;
        registerTermId(tab.tabId, id);
      }).catch((err) => {
        if (!wasConnectedRef.current) {
          onStatus(tab.tabId, "closed");
          term.write(`\r\n\x1b[31m连接失败: ${String(err)}\x1b[0m\r\n`);
        } else {
          scheduleReconnect();
        }
      });
    }

    connect();

    let writeQueue = Promise.resolve();
    const writeToPty = (data: string) => {
      writeQueue = writeQueue
        .then(() => {
          const id = termIdRef.current;
          return id ? api.termWrite(id, data) : Promise.resolve();
        })
        .catch(() => {});
    };
    writeToPtyRef.current = writeToPty;

    const resetInputCapture = (keepPromptReady = false) => {
      inputCaptureRef.current = { text: "", reliable: true };
      inputStartedAtPromptRef.current = false;
      promptReadyRef.current = keepPromptReady;
    };

    const dataSub = term.onData((data) => {
      if (composerActiveRef.current) {
        if (data === "\r" || data === "\n") {
          submitComposerRef.current();
        } else if (data === "\t" || data.startsWith("\x1b")) {
          void handoffToTerminalRef.current(data);
        } else if (data === "\x03" || data === "\x15") {
          updateComposerDraft("");
        } else if (data === "\x7f" || data === "\b") {
          updateComposerDraft(
            Array.from(composerDraftRef.current).slice(0, -1).join("")
          );
        } else {
          const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
          if (printable) {
            updateComposerDraft(composerDraftRef.current + printable);
          }
        }
        return;
      }

      if (rawTerminalRef.current) {
        writeToPty(data);
        return;
      }

      if (inputModeRef.current === "shell") {
        writeToPty(data);
        if (
          splitTerminalSubmissionData(data) ||
          data.includes("\x03") ||
          data.includes("\x15")
        ) {
          resetInputCapture(false);
        }
        return;
      }

      const submission = splitTerminalSubmissionData(data);
      if (submission) {
        if (submission.input) {
          const printableInput = submission.input
            .replace(/\x1b\[200~/g, "")
            .replace(/\x1b\[201~/g, "")
            .replace(/[\x00-\x1f\x7f]/g, "");
          const promptIsReady =
            promptReadyRef.current ||
            isLikelyShellPrompt(outputTailRef.current);
          if (
            !inputStartedAtPromptRef.current &&
            promptIsReady &&
            printableInput
          ) {
            promptReadyRef.current = true;
            inputStartedAtPromptRef.current = true;
            inputCaptureRef.current = { text: "", reliable: true };
          }
          if (inputStartedAtPromptRef.current) {
            inputCaptureRef.current = updateTerminalInputCapture(
              inputCaptureRef.current,
              submission.input
            );
          }
        }

        const capture = inputCaptureRef.current;
        const bufferedCommand = readCompletedCommandFromTerminal(
          term,
          rawCommandFallbackRef.current || capture.text
        );
        if (bufferedCommand) rawCommandFallbackRef.current = bufferedCommand;
        const submittedText = bufferedCommand || capture.text.trim();
        const recoveredFromTerminal = Boolean(bufferedCommand);
        const decision = classifyTerminalInput(
          submittedText,
          inputModeRef.current,
          agentAvailableRef.current && integrationStateRef.current !== "raw"
        );
        const canRoute = canRouteTerminalSubmission({
          submittedText,
          inputStartedAtPrompt: inputStartedAtPromptRef.current,
          captureReliable: capture.reliable,
          recoveredFromTerminal,
          decision,
        });

        if (
          inlineAgentEnabledRef.current &&
          canRoute &&
          decision.target === "agent" &&
          tab.sessionId
        ) {
          writeToPty("\x15");
          const prompt = submittedText;
          resetInputCapture(true);
          dispatchToSurface(tab.tabId, {
            type: "set-input-target",
            target: decision.target,
          });
          void runtimeRef.current
            ?.submit({
              surfaceId: tab.tabId,
              sessionId: tab.sessionId,
              prompt,
            })
            .catch(() => {});
          return;
        }

        if (
          shellIntegrationReadyRef.current &&
          canRoute &&
          decision.target === "shell"
        ) {
          const command = submittedText;
          const interactive = isInteractiveShellCommand(command);
          const block = createShellBlock(
            `shell-${tab.tabId}-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            command,
            surfaceRef.current?.environment?.cwd,
            interactive
          );
          activeShellBlockRef.current = block;
          dispatchToSurface(tab.tabId, { type: "append-block", block });
          if (interactive) {
            rawTerminalRef.current = true;
            dispatchToSurface(tab.tabId, {
              type: "set-control",
              control: "raw-terminal",
            });
          }
        }

        writeToPty(data);
        resetInputCapture(false);
        dispatchToSurface(tab.tabId, {
          type: "set-input-target",
          target: decision.target,
        });
        return;
      }

      const printableData = data
        .replace(/\x1b\[200~/g, "")
        .replace(/\x1b\[201~/g, "")
        .replace(/[\x00-\x1f\x7f]/g, "");
      if (!inputStartedAtPromptRef.current && promptReadyRef.current && printableData) {
        inputStartedAtPromptRef.current = true;
        inputCaptureRef.current = { text: "", reliable: true };
      }

      if (inputStartedAtPromptRef.current) {
        inputCaptureRef.current = updateTerminalInputCapture(inputCaptureRef.current, data);
        dispatchToSurface(tab.tabId, {
          type: "set-input-target",
          target: classifyTerminalInput(
            inputCaptureRef.current.text,
            inputModeRef.current,
            agentAvailableRef.current && integrationStateRef.current !== "raw"
          ).target,
        });
      }

      writeToPty(data);
      if (data.includes("\x03")) resetInputCapture(false);
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      onSize?.(tab.tabId, cols, rows);
      const id = termIdRef.current;
      if (id) api.termResize(id, cols, rows).catch(() => {});
    });

    // Ctrl+F 打开搜索
    const writeClipboardToTerminal = () => {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
    };

    const copySelectionToClipboard = () => {
      const selection = term.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const key = ev.key.toLowerCase();
      const copyShortcut =
        (ev.ctrlKey && ev.key === "Insert") || ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && key === "c");
      const pasteShortcut =
        (ev.shiftKey && ev.key === "Insert" && !ev.ctrlKey && !ev.altKey) ||
        ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && key === "v");

      if (copyShortcut) {
        copySelectionToClipboard();
        return false;
      }
      if (pasteShortcut) {
        writeClipboardToTerminal();
        return false;
      }

      if (
        !rawTerminalRef.current &&
        (ev.ctrlKey || ev.metaKey) &&
        ev.shiftKey &&
        key === "i"
      ) {
        setInputMode(
          toggleFixedInputMode(
            inputModeRef.current,
            "agent",
            agentAvailableRef.current
          )
        );
        return false;
      }
      if (
        !rawTerminalRef.current &&
        (ev.ctrlKey || ev.metaKey) &&
        ev.shiftKey &&
        key === "y"
      ) {
        onOpenCommandAssistant();
        return false;
      }

      if (ev.key === "Tab" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = termIdRef.current;
        if (id) api.termWrite(id, "\t").catch(() => {});
        return false;
      }

      if ((ev.ctrlKey || ev.metaKey) && key === "f") {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      return true;
    });

    const observer = new ResizeObserver(() => fitAndReport());
    observer.observe(containerRef.current);

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      dataSub.dispose();
      resizeSub.dispose();
      observer.disconnect();
      const id = termIdRef.current;
      if (id) api.termClose(id).catch(() => {});
      activeShellCommandIdRef.current = null;
      writeToPtyRef.current = () => {};
      void runtimeRef.current?.dispose(tab.tabId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isVisible) {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) onSize?.(tab.tabId, term.cols, term.rows);
    }
  }, [active, composerActive, isVisible, onSize, tab.tabId]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(theme, backgroundActive);
    }
  }, [backgroundActive, theme]);

  const menu = (e: React.MouseEvent) => {
    const term = termRef.current;
    const selection = term?.getSelection() ?? "";
    const write = (data: string) => {
      const id = termIdRef.current;
      if (id) api.termWrite(id, data).catch(() => {});
    };
    showMenu(e, [
      {
        label: "复制",
        disabled: !selection,
        onClick: () => navigator.clipboard.writeText(selection).catch(() => {}),
      },
      {
        label: "粘贴",
        onClick: () =>
          navigator.clipboard
            .readText()
            .then((t) => t && write(t))
            .catch(() => {}),
      },
      { label: "清屏", onClick: () => term?.clear() },
      {
        label: "查找 (Ctrl+F)",
        onClick: () => {
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 0);
        },
      },
      SEPARATOR,
      ...(onOpenSftp ? [{ label: "打开 SFTP 面板", onClick: onOpenSftp }, SEPARATOR] : []),
      {
        label: "添加选中内容到 Agent 上下文",
        disabled: !selection || !inlineAgentEnabled || !agentAvailable,
        onClick: () => attachTerminalSelection(selection),
      },
      {
        label: "AI 解释选中内容",
        disabled: !selection,
        onClick: () => onAskAi(`请解释这段终端内容：\n\`\`\`\n${selection}\n\`\`\``),
      },
      {
        label: "AI 诊断最近输出",
        onClick: () => onAskAi("请分析终端最近输出中的报错原因，并给出修复命令。"),
      },
    ]);
  };

  // 搜索高亮：所有匹配黄色底、当前匹配橙色底，右侧概览标尺也打点
  const searchOptions = {
    decorations: {
      matchBackground: "#ffd33d40",
      matchBorder: "#ffd33d",
      matchOverviewRuler: "#ffd33d",
      activeMatchBackground: "#f7816680",
      activeMatchBorder: "#f78166",
      activeMatchColorOverviewRuler: "#f78166",
    },
  };

  const doSearch = (dir: "next" | "prev") => {
    const t = searchText.trim();
    if (!t) return;
    if (dir === "next") searchRef.current?.findNext(t, searchOptions);
    else searchRef.current?.findPrevious(t, searchOptions);
  };

  return (
    <div
      className={`terminal-wrapper${inlineAgentEnabled ? " inline-agent-enabled" : ""}${
        contextAttachments.length > 0 ? " has-context-attachments" : ""
      }${
        surface?.contextPolicy === "none" ? " context-disabled" : ""
      }${
        isVisible && inlineTimelineVisible
          ? " has-agent-timeline"
          : ""
      }`}
      style={{ display: isVisible ? "block" : "none" }}
    >
      {isVisible && inlineAgentEnabled && (
        <div className="terminal-mode-bar">
          <div
            className="terminal-mode-segments"
            role="group"
            aria-label="终端输入模式"
          >
            {(["shell", "agent"] as TerminalInputTarget[]).map((mode) => {
              const label = mode === "shell" ? "Shell" : "Agent";
              const indicator = getInputModeIndicator(
                inputMode,
                activeInputTarget,
                mode
              );
              return (
                <button
                  key={mode}
                  type="button"
                  className={`terminal-mode-option${
                    indicator !== "inactive" ? " active" : ""
                  }${
                    indicator === "automatic"
                      ? " auto-active"
                      : ""
                  }${
                    indicator === "fixed" ? " fixed-active" : ""
                  }`}
                  disabled={mode === "agent" && !agentAvailable}
                  title={
                    mode === "agent" && !agentAvailable
                      ? "Agent（请先配置 AI Provider）"
                      : inputMode === mode
                        ? `${label} 固定模式（再次点击恢复自动）${
                            mode === "agent" ? " · Ctrl+Shift+I" : ""
                          }`
                        : `${label}${
                            mode === "agent" ? " · Ctrl+Shift+I" : ""
                          }（点击固定）`
                  }
                  aria-label={label}
                  aria-pressed={mode === activeInputTarget}
                  onClick={() =>
                    setInputMode(
                      toggleFixedInputMode(
                        inputMode,
                        mode,
                        mode !== "agent" || agentAvailable
                      )
                    )
                  }
                >
                  <Icon
                    name={mode === "shell" ? "terminal" : "ai"}
                    size={14}
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
      {searchOpen && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            className="input"
            placeholder="查找终端内容..."
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              if (e.target.value.trim()) searchRef.current?.findNext(e.target.value.trim(), searchOptions);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doSearch(e.shiftKey ? "prev" : "next");
              } else if (e.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
          />
          <button className="icon-btn" title="上一个" onClick={() => doSearch("prev")}>
            <Icon name="arrowUp" size={14} />
          </button>
          <button className="icon-btn" title="下一个" onClick={() => doSearch("next")}>
            <Icon name="arrowDown" size={14} />
          </button>
          <button
            className="icon-btn"
            title="关闭 (Esc)"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div ref={containerRef} className="terminal-container" onContextMenu={menu} />
      {isVisible && inlineTimelineVisible && surface && (
        <InlineAgentTimeline
          blocks={surface.blocks}
          control={surface.control}
          promptLabel={promptLabel}
          attachedBlockIds={attachedBlockIds}
          onToggleBlockContext={toggleBlockContext}
          onToggleShell={(block) =>
            dispatchToSurface(tab.tabId, {
              type: "replace-block",
              block: { ...block, collapsed: !block.collapsed },
            })
          }
          onToggleExecution={(block) =>
            dispatchToSurface(tab.tabId, {
              type: "replace-block",
              block: { ...block, collapsed: !block.collapsed },
            })
          }
          onContinue={() => {
            void runtimeRef.current?.continue(tab.tabId);
          }}
          onEnd={() => {
            void runtimeRef.current?.end(tab.tabId);
          }}
          onStop={() => {
            void runtimeRef.current?.stop(tab.tabId);
          }}
        >
          {composerActive && (
            <div className="terminal-native-input">
              {contextAttachments.length > 0 && (
                <div
                  className="terminal-context-chips"
                  aria-label="Agent 上下文附件"
                >
                  <label
                    className={`terminal-context-policy${
                      surface?.contextPolicy === "none" ? " off" : ""
                    }`}
                    title="选择 Agent 使用的终端上下文"
                  >
                    <span>上下文 {contextAttachments.length}</span>
                    <select
                      aria-label="Agent 终端上下文策略"
                      value={surface?.contextPolicy ?? "recent"}
                      onChange={(event) =>
                        setContextPolicy(
                          event.target.value as AgentContextPolicy
                        )
                      }
                    >
                      <option value="none">关闭上下文</option>
                      <option value="recent">最近输出 + 已选内容</option>
                      <option value="selected-blocks">仅已选内容</option>
                    </select>
                  </label>
                  {contextAttachments.map((attachment) => (
                    <div className="terminal-context-chip" key={attachment.id}>
                      <button
                        type="button"
                        className="terminal-context-chip-label"
                        title="查看上下文内容"
                        onClick={() => showContextAttachment(attachment)}
                      >
                        {attachment.label}
                      </button>
                      <button
                        type="button"
                        className="terminal-context-chip-remove"
                        title="移除上下文"
                        aria-label={`移除上下文 ${attachment.label}`}
                        onClick={() => removeContextAttachment(attachment)}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="terminal-native-input-row">
                <code className="terminal-native-prompt">{promptLabel}</code>
                <textarea
                  ref={composerInputRef}
                  value={composerDraft}
                  rows={1}
                  spellCheck={false}
                  aria-label="终端输入"
                  placeholder={
                    agentAvailable
                      ? "输入自然语言或命令"
                      : "输入 Shell 命令"
                  }
                  onChange={(event) => updateComposerDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void submitComposer();
                      return;
                    }
                    if (event.key === "Tab") {
                      event.preventDefault();
                      void handoffToTerminal("\t");
                      return;
                    }
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.shiftKey &&
                      event.key.toLowerCase() === "i"
                    ) {
                      event.preventDefault();
                      setInputMode(
                        toggleFixedInputMode(
                          inputMode,
                          "agent",
                          agentAvailable
                        )
                      );
                      return;
                    }
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.shiftKey &&
                      event.key.toLowerCase() === "y"
                    ) {
                      event.preventDefault();
                      onOpenCommandAssistant();
                      return;
                    }
                    if (
                      event.key === "ArrowUp" &&
                      !event.shiftKey &&
                      !composerDraft.includes("\n")
                    ) {
                      const history = composerHistoryRef.current;
                      if (history.length > 0) {
                        event.preventDefault();
                        const next = Math.min(
                          history.length - 1,
                          composerHistoryIndexRef.current + 1
                        );
                        composerHistoryIndexRef.current = next;
                        updateComposerDraft(history[next]);
                      }
                      return;
                    }
                    if (
                      event.key === "ArrowDown" &&
                      !event.shiftKey &&
                      composerHistoryIndexRef.current >= 0
                    ) {
                      event.preventDefault();
                      const next = composerHistoryIndexRef.current - 1;
                      composerHistoryIndexRef.current = next;
                      updateComposerDraft(
                        next >= 0 ? composerHistoryRef.current[next] : ""
                      );
                    }
                  }}
                />
              </div>
            </div>
          )}
        </InlineAgentTimeline>
      )}
      {isVisible && runningShellBlock && (
        <div className="terminal-command-running" role="status">
          <span className="terminal-command-running-dot" aria-hidden="true" />
          <span>{getRunningShellCommandLabel(runningShellBlock.command)}</span>
          <span className="terminal-command-running-shortcut">Ctrl+C</span>
          <button
            type="button"
            title="中断当前命令 (Ctrl+C)"
            onClick={() => {
              writeToPtyRef.current("\x03");
              termRef.current?.focus();
            }}
          >
            <Icon name="close" size={11} />
            <span>中断</span>
          </button>
        </div>
      )}
      {isVisible && inlineAgentEnabled && integrationState !== "ready" && (
        <div className={`terminal-integration-status ${integrationState}`}>
          {integrationState === "pending"
            ? "正在检测 Shell Integration"
            : "Raw Terminal"}
        </div>
      )}
    </div>
  );
}
