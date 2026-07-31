export type TerminalInputMode = "auto" | "shell" | "agent";
export type TerminalInputTarget = "shell" | "agent";

export interface TerminalInputDecision {
  target: TerminalInputTarget;
  confidence: number;
  reason:
    | "manual-shell"
    | "manual-agent"
    | "agent-unavailable"
    | "empty"
    | "shell-syntax"
    | "known-command"
    | "single-token"
    | "natural-language"
    | "safe-fallback";
}

export interface TerminalInputCapture {
  text: string;
  reliable: boolean;
}

export interface TerminalSubmissionData {
  input: string;
  submit: "\r" | "\n" | "\r\n";
}

const KNOWN_SHELL_COMMANDS = new Set([
  "alias",
  "apt",
  "apt-get",
  "awk",
  "bash",
  "bat",
  "brew",
  "cat",
  "cd",
  "chmod",
  "chown",
  "clear",
  "cls",
  "cmd",
  "cp",
  "curl",
  "date",
  "df",
  "dig",
  "dir",
  "dnf",
  "docker",
  "du",
  "echo",
  "env",
  "exit",
  "find",
  "free",
  "git",
  "grep",
  "head",
  "help",
  "history",
  "hostname",
  "htop",
  "ip",
  "journalctl",
  "kill",
  "kubectl",
  "less",
  "ls",
  "make",
  "man",
  "mkdir",
  "more",
  "mv",
  "mysql",
  "netstat",
  "nginx",
  "node",
  "npm",
  "npx",
  "ping",
  "pnpm",
  "powershell",
  "printf",
  "ps",
  "psql",
  "pwd",
  "python",
  "python3",
  "redis-cli",
  "rg",
  "rm",
  "rsync",
  "scp",
  "sed",
  "set",
  "sh",
  "sleep",
  "sort",
  "ssh",
  "ss",
  "sudo",
  "systemctl",
  "tail",
  "tar",
  "top",
  "tr",
  "type",
  "uname",
  "uniq",
  "vim",
  "vi",
  "wc",
  "wget",
  "where",
  "where.exe",
  "which",
  "whoami",
  "wsl",
  "yum",
  "zsh",
]);

const ENGLISH_NATURAL_PREFIX =
  /^(?:analy[sz]e|can|check|could|describe|diagnose|do|does|explain|how|is|please|should|tell|what|when|where|why|would)\b/i;

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function shellDecision(
  reason: TerminalInputDecision["reason"],
  confidence = 1
): TerminalInputDecision {
  return { target: "shell", confidence, reason };
}

function agentDecision(
  reason: TerminalInputDecision["reason"],
  confidence = 1
): TerminalInputDecision {
  return { target: "agent", confidence, reason };
}

function firstExecutableToken(input: string): string {
  const tokens = input.trim().split(/\s+/);
  let index = 0;
  while (tokens[index]) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
      index += 1;
      continue;
    }
    if (["command", "env", "nohup", "sudo", "time"].includes(tokens[index].toLowerCase())) {
      index += 1;
      continue;
    }
    break;
  }
  return (tokens[index] ?? tokens[0] ?? "").replace(/^["']|["']$/g, "").toLowerCase();
}

function hasShellSyntax(input: string): boolean {
  const trimmed = input.trim();
  return (
    /(?:&&|\|\||[|;<>{}`])/.test(trimmed) ||
    /(?:^|\s)(?:>>?|<<?)\s*\S/.test(trimmed) ||
    /(?:^|\s)\$\(|`[^`]+`/.test(trimmed) ||
    /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(trimmed) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) ||
    /^-\w/.test(trimmed)
  );
}

function isKnownCommand(input: string): boolean {
  const token = firstExecutableToken(input);
  if (!token) return false;
  if (KNOWN_SHELL_COMMANDS.has(token)) return true;
  return (
    /^[./~\\]/.test(token) ||
    /^[A-Za-z]:[\\/]/.test(token) ||
    /\.(?:bat|cmd|exe|ps1|py|sh)$/i.test(token)
  );
}

function isNaturalLanguage(input: string): boolean {
  const trimmed = input.trim();
  const cjk = trimmed.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (cjk >= 2) return true;

  const words = trimmed.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  return words.length >= 2 && ENGLISH_NATURAL_PREFIX.test(trimmed);
}

function looksLikeShellCommand(input: string): boolean {
  if (ENGLISH_NATURAL_PREFIX.test(input.trim())) return false;
  const token = firstExecutableToken(input);
  return /^[A-Za-z0-9_.+/-]+$/.test(token);
}

export function classifyTerminalInput(
  input: string,
  mode: TerminalInputMode,
  agentAvailable: boolean
): TerminalInputDecision {
  if (mode === "shell") return shellDecision("manual-shell");
  if (!agentAvailable) return shellDecision("agent-unavailable");

  const trimmed = input.trim();
  if (!trimmed) return shellDecision("empty");
  if (mode === "agent") return agentDecision("manual-agent");
  if (isKnownCommand(trimmed)) return shellDecision("known-command");
  if (looksLikeShellCommand(trimmed)) return shellDecision("safe-fallback", 0.6);
  if (isNaturalLanguage(trimmed)) return agentDecision("natural-language", 0.9);
  if (hasShellSyntax(trimmed)) return shellDecision("shell-syntax");
  if (!/\s/.test(trimmed)) return shellDecision("single-token", 0.9);
  return shellDecision("safe-fallback", 0.6);
}

export function stripTerminalControlSequences(value: string): string {
  return value.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(/\r/g, "");
}

export function isLikelyShellPrompt(outputTail: string): boolean {
  const clean = stripTerminalControlSequences(outputTail);
  const lines = clean.split("\n");
  const line = lines[lines.length - 1]?.trimEnd() ?? "";
  if (!line || line.length > 240) return false;

  return (
    /^(?:\[[^\]\r\n]+@[^\]\r\n]+\][#$]|[^@\s]+@[^:\s]+:[^\r\n]*[$#])\s*$/.test(line) ||
    /^PS\s+[A-Za-z]:[\\/][^>\r\n]*>\s*$/i.test(line) ||
    /^[A-Za-z]:[\\/][^>\r\n]*>\s*$/.test(line) ||
    /^[#$]\s*$/.test(line) ||
    /^(?:➜|❯)\s*(?:\S.*)?$/.test(line)
  );
}

export function extractTerminalPromptInput(
  logicalLine: string,
  partialInput = ""
): string {
  const cleanLine = stripTerminalControlSequences(logicalLine).trimEnd();
  const promptPatterns = [
    /^\s*\[[^\]\r\n]+@[^\]\r\n]+\][#$]\s*(.*)$/,
    /^\s*[^@\s]+@[^:\s]+:[^\r\n]*?[$#]\s*(.*)$/,
    /^\s*PS\s+[A-Za-z]:[\\/][^>\r\n]*>\s*(.*)$/i,
    /^\s*[A-Za-z]:[\\/][^>\r\n]*>\s*(.*)$/,
    /^\s*[#$]\s*(.*)$/,
  ];
  for (const pattern of promptPatterns) {
    const match = cleanLine.match(pattern);
    if (match) return (match[1] ?? "").trim();
  }

  const partial = partialInput.trim();
  if (!partial) return "";
  const commandStart = cleanLine.lastIndexOf(partial);
  return commandStart >= 0 ? cleanLine.slice(commandStart).trim() : partial;
}

export function splitTerminalSubmissionData(
  data: string
): TerminalSubmissionData | null {
  const submit = data.endsWith("\r\n")
    ? "\r\n"
    : data.endsWith("\r")
      ? "\r"
      : data.endsWith("\n")
        ? "\n"
        : null;
  if (!submit) return null;
  return {
    input: data.slice(0, -submit.length),
    submit,
  };
}

export function updateTerminalInputCapture(
  capture: TerminalInputCapture,
  data: string
): TerminalInputCapture {
  if (!data) return capture;

  let text = capture.text;
  let reliable = capture.reliable;
  const normalized = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");

  if (normalized.includes("\r") || normalized.includes("\n")) {
    return { text, reliable: false };
  }

  for (const char of normalized) {
    if (char === "\x03" || char === "\x15") {
      text = "";
      continue;
    }
    if (char === "\x17") {
      text = text.replace(/\s*\S+\s*$/, "");
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      text = Array.from(text).slice(0, -1).join("");
      continue;
    }
    if (char === "\t" || char === "\x1b") {
      reliable = false;
      continue;
    }
    if (char >= " " && char !== "\x7f") text += char;
    else reliable = false;
  }

  return { text, reliable };
}
