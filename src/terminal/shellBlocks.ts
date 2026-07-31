import type { ShellBlock } from "../agent/surfaceModel";

export const SHELL_BLOCK_OUTPUT_LIMIT = 200_000;
export const SHELL_BLOCK_AUTO_COLLAPSE_THRESHOLD = 12_000;

export function createShellBlock(
  id: string,
  command: string,
  cwd?: string,
  interactive = false,
  commandId?: string
): ShellBlock {
  return {
    id,
    kind: "shell",
    commandId,
    command,
    output: "",
    cwd,
    interactive,
    exitCode: null,
    status: "running",
    collapsed: interactive,
    createdAt: Date.now(),
  };
}

export function appendShellBlockOutput(
  block: ShellBlock,
  chunk: string
): ShellBlock {
  if (block.interactive) return block;
  const cleaned = stripTerminalControlSequences(chunk);
  if (!cleaned) return block;
  const combined = block.output + cleaned;
  const output =
    combined.length <= SHELL_BLOCK_OUTPUT_LIMIT
      ? combined
      : `[较早输出已截断]\n${combined.slice(-SHELL_BLOCK_OUTPUT_LIMIT)}`;
  return output === block.output ? block : { ...block, output };
}

export function completeShellBlock(
  block: ShellBlock,
  exitCode: number,
  cwd: string
): ShellBlock {
  const output = removeEchoedCommand(block.output, block.command);
  return {
    ...block,
    output,
    cwd: block.cwd || cwd,
    exitCode,
    status: exitCode === 0 ? "success" : "error",
    collapsed:
      block.collapsed ||
      block.interactive === true ||
      output.length > SHELL_BLOCK_AUTO_COLLAPSE_THRESHOLD,
  };
}

export function stripTerminalControlSequences(value: string): string {
  const withoutOsc = value.replace(
    /\x1b\][^\x07]*(?:\x07|\x1b\\)/g,
    ""
  );
  const withoutCsi = withoutOsc.replace(
    /\x1b\[[0-?]*[ -/]*[@-~]/g,
    ""
  );
  const withoutControls = withoutCsi
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x07\x0b-\x1a\x1c-\x1f\x7f]/g, "");
  return applyBackspaces(withoutControls);
}

export function isInteractiveShellCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  let commandIndex = 0;
  let usesSudo = false;
  if (tokens[commandIndex] === "sudo") {
    usesSudo = true;
    commandIndex++;
    const optionsWithValue = new Set([
      "-u",
      "--user",
      "-g",
      "--group",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-C",
      "--close-from",
      "-R",
      "--chroot",
      "-D",
      "--chdir",
      "-T",
      "--command-timeout",
    ]);
    while (tokens[commandIndex]?.startsWith("-")) {
      const option = tokens[commandIndex++];
      if (optionsWithValue.has(option) && tokens[commandIndex]) commandIndex++;
    }
  }
  if (tokens[commandIndex] === "env") {
    commandIndex++;
    while (
      tokens[commandIndex]?.startsWith("-") ||
      tokens[commandIndex]?.includes("=")
    ) {
      commandIndex++;
    }
  }

  const executable = basename(tokens[commandIndex] ?? "").toLowerCase();
  const args = tokens.slice(commandIndex + 1);
  if (usesSudo) return true;
  if (
    [
      "vi",
      "vim",
      "nvim",
      "nano",
      "top",
      "htop",
      "less",
      "more",
      "man",
      "ssh",
      "telnet",
      "tmux",
      "screen",
    ].includes(executable)
  ) {
    return true;
  }
  if (["python", "python3", "node", "irb"].includes(executable)) {
    return args.length === 0;
  }
  if (
    [
      "bash",
      "zsh",
      "sh",
      "dash",
      "fish",
      "ksh",
      "pwsh",
      "powershell",
    ].includes(executable)
  ) {
    if (args.some((arg) => arg === "-c" || arg === "--command")) return false;
    return args.every((arg) => arg.startsWith("-"));
  }
  if (executable === "php") return args.length === 0 || args.includes("-a");
  if (executable === "psql") return !args.includes("-c") && !args.includes("--command");
  if (executable === "mysql") return !args.includes("-e") && !args.includes("--execute");
  if (executable === "redis-cli") return args.length === 0;
  return false;
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() ?? value;
}

function removeEchoedCommand(output: string, command: string): string {
  const normalizedCommand = command.trim();
  const afterWrappedEchoes = removeWrappedCommandEchoes(
    output.replace(/^\s*\n/, ""),
    normalizedCommand
  );
  const lines = afterWrappedEchoes.split("\n");

  while (lines.length > 0) {
    const line = lines[0].trim();
    if (!line) {
      lines.shift();
      continue;
    }
    if (!isCommandEcho(line, normalizedCommand)) break;
    lines.shift();
  }

  return lines.join("\n").replace(/^\n+/, "").trimEnd();
}

function removeWrappedCommandEchoes(output: string, command: string): string {
  if (!command) return output;

  const candidateStarts = [0];
  const promptPattern =
    /(?:^|\n)(?:\[[^\n\]]+\]|[^\n]{0,100})(?:[$#>%❯])\s*/g;
  for (const match of output.matchAll(promptPattern)) {
    candidateStarts.push((match.index ?? 0) + match[0].length);
  }

  let lastEchoEnd = -1;
  for (const candidateStart of candidateStarts) {
    const echoEnd = consumeWrappedCommandEcho(output, candidateStart, command);
    if (echoEnd > lastEchoEnd) lastEchoEnd = echoEnd;
  }

  return lastEchoEnd > 0 ? output.slice(lastEchoEnd) : output;
}

function consumeWrappedCommandEcho(
  output: string,
  start: number,
  command: string
): number {
  let sourceIndex = start;
  let commandIndex = 0;

  while (commandIndex < command.length && sourceIndex < output.length) {
    const sourceChar = output[sourceIndex];
    const commandChar = command[commandIndex];
    if (sourceChar === commandChar) {
      sourceIndex++;
      commandIndex++;
      continue;
    }
    if (sourceChar === "\n") {
      sourceIndex++;
      if (/\s/.test(commandChar)) commandIndex++;
      continue;
    }
    if (sourceChar === " " && commandChar !== " ") {
      sourceIndex++;
      continue;
    }
    return -1;
  }

  return commandIndex === command.length ? sourceIndex : -1;
}

function isCommandEcho(line: string, command: string): boolean {
  if (line === command) return true;
  if (!line.endsWith(command)) return false;

  const prompt = line.slice(0, -command.length).trimEnd();
  return /(?:^|\s|\])(?:[$#>%❯])\s*$/.test(prompt);
}

function applyBackspaces(value: string): string {
  const output: string[] = [];
  for (const char of value) {
    if (char === "\b") output.pop();
    else output.push(char);
  }
  return output.join("");
}
