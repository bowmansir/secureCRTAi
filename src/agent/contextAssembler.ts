import type {
  ContextAttachment,
  ShellBlock,
  TerminalSurfaceEnvironment,
  TerminalSurfaceState,
} from "./surfaceModel.ts";

const DEFAULT_CONTEXT_BUDGET = 12_000;
const TRUNCATION_MARKER = "\n[context truncated]";
const SELECTION_LIMIT = 32_000;
const REDACTION_MARKER = "[REDACTED]";

export type AgentContextSource = {
  id: string;
  kind: "environment" | "recent-shell" | "attachment";
  label: string;
  blockId?: string;
  originalChars: number;
  includedChars: number;
  truncated: boolean;
  redacted: boolean;
};

export type AssembledAgentContext = {
  surfaceId: string;
  text: string;
  sources: AgentContextSource[];
  omittedSourceIds: string[];
  truncated: boolean;
  redacted: boolean;
  charCount: number;
  budget: number;
};

export type ContextAssemblerOptions = {
  includeRecentBlock?: boolean;
  maxChars?: number;
};

type ContextPart = {
  id: string;
  kind: AgentContextSource["kind"];
  label: string;
  blockId?: string;
  content: string;
  priority: number;
  order: number;
};

type RedactionResult = {
  value: string;
  redacted: boolean;
};

function redactSensitiveContent(value: string): RedactionResult {
  let redacted = false;
  const replace = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    value = value.replace(pattern, (...args: string[]) => {
      redacted = true;
      return typeof replacement === "string" ? replacement : replacement(...args);
    });
  };

  replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    `[private key ${REDACTION_MARKER}]`
  );
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTION_MARKER}`);
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, REDACTION_MARKER);
  replace(
    /\b(API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|ACCESS[_-]?KEY)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (_match, name, separator) => `${name}${separator}${REDACTION_MARKER}`
  );

  return { value, redacted };
}

function formatEnvironment(environment: TerminalSurfaceEnvironment | null): string {
  if (!environment) return "Connection: unknown";
  const lines = [
    `Connection: ${environment.kind === "ssh" ? "SSH" : "local"}`,
    environment.host ? `Host: ${environment.host}` : "",
    environment.port ? `Port: ${environment.port}` : "",
    environment.username ? `User: ${environment.username}` : "",
    environment.os ? `OS: ${environment.os}` : "",
    environment.shell ? `Shell: ${environment.shell}` : "",
    environment.cwd ? `CWD: ${environment.cwd}` : "",
    `Connected: ${environment.connected ? "yes" : "no"}`,
  ];
  return lines.filter(Boolean).join("\n");
}

function formatShellBlock(block: ShellBlock): string {
  return [
    `Command: ${block.command}`,
    block.cwd ? `CWD: ${block.cwd}` : "",
    `Exit code: ${block.exitCode ?? "unknown"}`,
    "Output:",
    block.output || "(no output)",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAttachment(attachment: ContextAttachment): string {
  return [
    `Type: ${attachment.kind}`,
    `Label: ${attachment.label}`,
    attachment.content || "(empty)",
  ].join("\n");
}

function resolveAttachmentContent(
  state: TerminalSurfaceState,
  attachment: ContextAttachment
): string {
  if (attachment.kind === "block" && attachment.blockId) {
    const block = state.blocks.find((item) => item.id === attachment.blockId);
    if (block?.kind === "shell") return formatShellBlock(block);
  }
  return formatAttachment(attachment);
}

function findLatestCompletedShellBlock(state: TerminalSurfaceState): ShellBlock | undefined {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index];
    if (block.kind === "shell" && block.status !== "running") return block;
  }
  return undefined;
}

function renderPart(part: ContextPart, content: string): string {
  return `## ${part.label}\n${content}`;
}

export function assembleAgentContext(
  state: TerminalSurfaceState,
  options: ContextAssemblerOptions = {}
): AssembledAgentContext {
  const budget = Math.max(0, options.maxChars ?? DEFAULT_CONTEXT_BUDGET);
  const includeRecentBlock = options.includeRecentBlock ?? state.contextPolicy === "recent";
  const parts: ContextPart[] = [
    {
      id: `environment:${state.surfaceId}`,
      kind: "environment",
      label: "Terminal environment",
      content: formatEnvironment(state.environment),
      priority: 100,
      order: 0,
    },
  ];

  const seenAttachmentIds = new Set<string>();
  const selectedBlockIds = new Set<string>();
  const activeAttachments =
    state.contextPolicy === "none" ? [] : state.contextAttachments;
  for (const attachment of activeAttachments) {
    const identity = attachment.blockId ? `block:${attachment.blockId}` : `attachment:${attachment.id}`;
    if (seenAttachmentIds.has(identity)) continue;
    seenAttachmentIds.add(identity);
    if (attachment.blockId) selectedBlockIds.add(attachment.blockId);
    parts.push({
      id: `attachment:${attachment.id}`,
      kind: "attachment",
      label: `Attached ${attachment.label}${
        attachment.blockId ? ` (block-id: ${attachment.blockId})` : ""
      }`,
      blockId: attachment.blockId,
      content: resolveAttachmentContent(state, attachment),
      priority: 80,
      order: parts.length + 1,
    });
  }

  const recentBlock = includeRecentBlock ? findLatestCompletedShellBlock(state) : undefined;
  if (recentBlock && !selectedBlockIds.has(recentBlock.id)) {
    parts.push({
      id: `block:${recentBlock.id}`,
      kind: "recent-shell",
      label: `Recent shell block (block-id: ${recentBlock.id})`,
      blockId: recentBlock.id,
      content: formatShellBlock(recentBlock),
      priority: 50,
      order: 1,
    });
  }

  const accepted: Array<{
    part: ContextPart;
    rendered: string;
    source: AgentContextSource;
  }> = [];
  const omittedSourceIds: string[] = [];
  let remaining = budget;

  for (const part of [...parts].sort((left, right) => right.priority - left.priority)) {
    const redaction = redactSensitiveContent(part.content);
    const prefix = accepted.length === 0 ? "" : "\n\n";
    const emptyRender = renderPart(part, "");
    const overhead = prefix.length + emptyRender.length;
    if (remaining <= overhead) {
      omittedSourceIds.push(part.id);
      continue;
    }

    const availableContent = remaining - overhead;
    const needsTruncation = redaction.value.length > availableContent;
    const marker = needsTruncation && availableContent > TRUNCATION_MARKER.length
      ? TRUNCATION_MARKER
      : "";
    const content = needsTruncation
      ? redaction.value.slice(0, Math.max(0, availableContent - marker.length)) + marker
      : redaction.value;
    const rendered = `${prefix}${renderPart(part, content)}`;

    accepted.push({
      part,
      rendered,
      source: {
        id: part.id,
        kind: part.kind,
        label: part.label,
        blockId: part.blockId,
        originalChars: part.content.length,
        includedChars: content.length,
        truncated: needsTruncation,
        redacted: redaction.redacted,
      },
    });
    remaining -= rendered.length;
  }

  accepted.sort((left, right) => left.part.order - right.part.order);
  const text = accepted
    .map(({ part, rendered }, index) => {
      const content = rendered.replace(/^\n\n/, "");
      return `${index === 0 ? "" : "\n\n"}${renderPart(
        part,
        content.slice(content.indexOf("\n") + 1)
      )}`;
    })
    .join("");
  const sources = accepted.map(({ source }) => source);

  return {
    surfaceId: state.surfaceId,
    text,
    sources,
    omittedSourceIds,
    truncated: sources.some((source) => source.truncated) || omittedSourceIds.length > 0,
    redacted: sources.some((source) => source.redacted),
    charCount: text.length,
    budget,
  };
}

export function createShellBlockAttachment(block: ShellBlock): ContextAttachment {
  return {
    id: `context-block:${block.id}`,
    kind: "block",
    label: block.command,
    content: "",
    blockId: block.id,
  };
}

export function createRemoteFileAttachment(
  attachmentId: string,
  remotePath: string,
  content: string
): ContextAttachment {
  const label = remotePath.replace(/\/+$/, "").split("/").pop() || remotePath;
  return {
    id: attachmentId,
    kind: "file",
    label,
    content: `Remote path: ${remotePath}\n\n${content}`,
  };
}

export function createTerminalSelectionAttachment(
  attachmentId: string,
  selection: string
): ContextAttachment {
  const normalized = selection.trim();
  const firstLine = normalized.split(/\r?\n/, 1)[0].trim();
  const shortLabel =
    firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
  const truncated = normalized.length > SELECTION_LIMIT;
  return {
    id: attachmentId,
    kind: "selection",
    label: `终端选中：${shortLabel || "文本"}`,
    content: truncated
      ? `${normalized.slice(0, SELECTION_LIMIT)}\n[selection truncated]`
      : normalized,
  };
}

export { redactSensitiveContent };
