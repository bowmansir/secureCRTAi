import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  AgentExecutionBlock,
  AgentLimitBlock,
  ShellBlock,
  TerminalBlock,
} from "../agent/surfaceModel";
import AgentMarkdown from "./AgentMarkdown";
import Icon from "./Icons";
import { getExecutionLabel } from "../agent/executionPresentation";
import { shouldCollapseAgentMessage } from "../agent/messagePresentation";
import {
  TIMELINE_BLOCK_PAGE_SIZE,
  windowTimelineBlocks,
} from "../terminal/timelineWindow";

type Props = {
  blocks: TerminalBlock[];
  promptLabel: string;
  control:
    | "idle"
    | "streaming"
    | "executing"
    | "waiting-approval"
    | "paused"
    | "raw-terminal";
  onToggleExecution: (block: AgentExecutionBlock) => void;
  onToggleShell: (block: ShellBlock) => void;
  attachedBlockIds: string[];
  onToggleBlockContext: (block: ShellBlock) => void;
  onContinue: (block: AgentLimitBlock) => void;
  onEnd: (block: AgentLimitBlock) => void;
  onStop: () => void;
  children?: ReactNode;
};

function shellStatusLabel(block: ShellBlock): string {
  if (block.status === "running") return "运行中";
  if (block.status === "cancelled") return "已取消";
  if (block.exitCode === 0) return "成功";
  return `退出码 ${block.exitCode ?? "未知"}`;
}

export default function InlineAgentTimeline({
  blocks,
  promptLabel,
  control,
  onToggleExecution,
  onToggleShell,
  attachedBlockIds,
  onToggleBlockContext,
  onContinue,
  onEnd,
  onStop,
  children,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastBlockIdRef = useRef<string | undefined>(undefined);
  const historyAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const [visibleBlockLimit, setVisibleBlockLimit] = useState(
    TIMELINE_BLOCK_PAGE_SIZE
  );
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const timelineWindow = windowTimelineBlocks(blocks, visibleBlockLimit);
  const visibleBlocks = timelineWindow.blocks;
  const hasAgentBlocks = blocks.some((block) => block.kind !== "shell");
  const active =
    control === "streaming" ||
    control === "executing" ||
    control === "waiting-approval";

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const lastBlock = blocks[blocks.length - 1];
    const appended = lastBlock?.id !== lastBlockIdRef.current;
    if (lastBlock?.kind === "agent-user" && appended) {
      stickToBottomRef.current = true;
    }
    lastBlockIdRef.current = lastBlock?.id;
    if (element && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [blocks]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = historyAnchorRef.current;
    if (!element || !anchor) return;
    element.scrollTop =
      anchor.scrollTop + (element.scrollHeight - anchor.scrollHeight);
    historyAnchorRef.current = null;
  }, [visibleBlockLimit]);

  if (blocks.length === 0) return null;

  return (
    <section className="terminal-agent-timeline" aria-label="终端 Agent 时间线">
      <div
        ref={scrollRef}
        className="terminal-agent-blocks"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {timelineWindow.hiddenCount > 0 && (
          <button
            type="button"
            className="terminal-agent-history-loader"
            onClick={() => {
              const element = scrollRef.current;
              if (element) {
                historyAnchorRef.current = {
                  scrollHeight: element.scrollHeight,
                  scrollTop: element.scrollTop,
                };
              }
              setVisibleBlockLimit(
                (limit) => limit + TIMELINE_BLOCK_PAGE_SIZE
              );
            }}
          >
            加载更早记录（{timelineWindow.hiddenCount}）
          </button>
        )}
        {visibleBlocks.map((block, index) => {
          if (block.kind === "shell") {
            const attached = attachedBlockIds.includes(block.id);
            return (
              <div
                key={block.id}
                className={`terminal-shell-transcript ${block.status}${
                  block.collapsed ? "" : " open"
                }`}
              >
                <div className="terminal-shell-transcript-command">
                  <code className="terminal-transcript-prompt">{promptLabel}</code>
                  <code>{block.command}</code>
                  <button
                    type="button"
                    className="terminal-shell-transcript-toggle"
                    onClick={() => onToggleShell(block)}
                    aria-expanded={!block.collapsed}
                    title={block.collapsed ? "展开命令输出" : "收起命令输出"}
                  >
                    {block.collapsed ? shellStatusLabel(block) : "收起"}
                  </button>
                  {block.status !== "running" && (
                    <button
                      type="button"
                      className={`icon-btn terminal-context-block-toggle${
                        attached ? " active" : ""
                      }`}
                      title={
                        attached
                          ? "从 Agent 上下文移除"
                          : "附加到 Agent 上下文"
                      }
                      aria-label={
                        attached
                          ? "从 Agent 上下文移除"
                          : "附加到 Agent 上下文"
                      }
                      onClick={() => onToggleBlockContext(block)}
                    >
                      <Icon name={attached ? "close" : "plus"} size={13} />
                    </button>
                  )}
                </div>
                {!block.collapsed && (
                  <pre className="terminal-shell-transcript-output">
                    {block.output ||
                      (block.interactive
                        ? "交互式会话已结束，屏幕内容未写入时间线。"
                        : "(暂无输出)")}
                  </pre>
                )}
              </div>
            );
          }
          if (block.kind === "agent-user") {
            return (
              <div
                key={block.id}
                className={`terminal-agent-request${block.queued ? " queued" : ""}${
                  block.cancelled ? " cancelled" : ""
                }`}
              >
                <code className="terminal-transcript-prompt">{promptLabel}</code>
                <span className="terminal-agent-request-content">{block.content}</span>
                {(block.queued || block.cancelled) && (
                  <small>
                    {block.cancelled ? "已取消" : "等待当前步骤完成后处理"}
                  </small>
                )}
              </div>
            );
          }
          if (block.kind === "agent-message") {
            const followedByExecution =
              visibleBlocks[index + 1]?.kind === "agent-execution";
            const collapsible =
              block.status !== "streaming" &&
              shouldCollapseAgentMessage(block.content);
            const expanded = expandedMessageIds.has(block.id);
            return (
              <div
                key={block.id}
                className={`terminal-agent-block assistant ${block.status}`}
              >
                <div className="terminal-agent-block-heading">
                  <span className="terminal-agent-heading-dot" />
                  <strong>TermAI</strong>
                  <span>
                    {block.status === "streaming"
                      ? "正在分析"
                      : block.status === "error"
                        ? "处理失败"
                        : followedByExecution
                          ? "执行计划"
                          : "分析完成"}
                  </span>
                  {collapsible && (
                    <button
                      type="button"
                      className={`terminal-agent-message-toggle${
                        expanded ? " expanded" : ""
                      }`}
                      onClick={() =>
                        setExpandedMessageIds((current) => {
                          const next = new Set(current);
                          if (next.has(block.id)) next.delete(block.id);
                          else next.add(block.id);
                          return next;
                        })
                      }
                      aria-expanded={expanded}
                    >
                      {expanded ? "收起" : "展开"}
                      <Icon name="chevronDown" size={12} />
                    </button>
                  )}
                </div>
                <div
                  className={`terminal-agent-message-content${
                    collapsible && !expanded ? " collapsed" : ""
                  }`}
                >
                  <AgentMarkdown
                    content={block.content}
                    codeClassName="agent-code"
                    hideCodeBlocks={
                      block.status === "complete" && followedByExecution
                    }
                  />
                  {block.status === "streaming" && (
                    <span className="cursor-blink">▌</span>
                  )}
                </div>
              </div>
            );
          }
          if (block.kind === "agent-execution") {
            return (
              <div
                key={block.id}
                className={`terminal-agent-execution ${block.status}${
                  block.collapsed ? "" : " open"
                }`}
              >
                <button
                  type="button"
                  className="terminal-agent-execution-row"
                  onClick={() => onToggleExecution(block)}
                  aria-expanded={!block.collapsed}
                >
                  <span className="terminal-agent-execution-state">
                    <span className="terminal-agent-execution-dot" />
                    {getExecutionLabel(block)}
                  </span>
                  <code title={block.commands.join("\n")}>
                    {block.commands[0] ?? "命令"}
                    {block.commands.length > 1
                      ? `  +${block.commands.length - 1}`
                      : ""}
                  </code>
                  <span>{block.collapsed ? "查看" : "收起"}</span>
                </button>
                {!block.collapsed && (
                  <pre className="terminal-agent-execution-output">
                    {block.output || "(暂无输出)"}
                  </pre>
                )}
              </div>
            );
          }
          if (block.kind === "agent-limit") {
            return (
              <div key={block.id} className={`terminal-agent-limit ${block.status}`}>
                <span>
                  {block.status === "paused"
                    ? `已连续执行 ${block.rounds} 轮，任务尚未完成`
                    : block.status === "continued"
                      ? "已继续执行"
                      : "任务已结束"}
                </span>
                {block.status === "paused" && (
                  <div>
                    <button
                      className="btn mini primary"
                      onClick={() => onContinue(block)}
                    >
                      继续 12 轮
                    </button>
                    <button className="btn mini" onClick={() => onEnd(block)}>
                      结束
                    </button>
                  </div>
                )}
              </div>
            );
          }
          return null;
        })}
        {hasAgentBlocks && active && (
          <div className={`terminal-agent-activity ${control}`}>
            <span className="terminal-agent-activity-dot" />
            <span>
              {control === "streaming"
                ? "正在分析"
                : control === "executing"
                  ? "正在执行"
                  : "等待确认"}
            </span>
            <button className="btn mini" onClick={onStop}>
              停止
            </button>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
