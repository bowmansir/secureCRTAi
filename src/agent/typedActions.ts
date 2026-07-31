import { checkDangerous } from "../dangerous.ts";

export type ShellExecuteAction = {
  type: "shell.execute";
  actionId: string;
  surfaceId: string;
  sessionId: string;
  cwd?: string;
  command: string;
  timeoutMs: number;
};

export type TerminalReadBlocksAction = {
  type: "terminal.readBlocks";
  actionId: string;
  surfaceId: string;
  blockIds: string[];
};

export type TerminalWaitAction = {
  type: "terminal.wait";
  actionId: string;
  surfaceId: string;
  durationMs: number;
  reason: string;
};

export type TerminalInterruptAction = {
  type: "terminal.interrupt";
  actionId: string;
  surfaceId: string;
  runtimeId: string;
};

export type AgentTypedAction =
  | ShellExecuteAction
  | TerminalReadBlocksAction
  | TerminalWaitAction
  | TerminalInterruptAction;

export type AgentActionRisk = {
  level: "safe" | "approval-required" | "invalid";
  reason?: string;
};

export type LegacyActionParseOptions = {
  surfaceId: string;
  sessionId: string;
  cwd?: string;
  timeoutMs?: number;
  maxActions?: number;
};

export type AgentActionPlan = {
  displayText: string;
  actions: AgentTypedAction[];
  source: "typed" | "legacy" | "none";
  errors: string[];
  warnings: string[];
};

type UnknownRecord = Record<string, unknown>;

const APPROVAL_RULES: Array<{ test: RegExp; reason: string }> = [
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|unlink|rmdir|shred)\b/i,
    reason: "删除文件或目录",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:cp|mv|install)\b/i,
    reason: "复制、移动或覆盖文件",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:chmod|chown|chgrp|setfacl)\b/i,
    reason: "修改权限或所有者",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable|mask|unmask)\b/i,
    reason: "修改服务运行状态",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:apt|apt-get|yum|dnf|pacman|zypper|brew)\b[^;&|]*\b(?:install|remove|purge|upgrade|dist-upgrade|uninstall)\b/i,
    reason: "安装、卸载或升级软件",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:useradd|userdel|usermod|groupadd|groupdel|groupmod|passwd)\b/i,
    reason: "修改用户、用户组或密码",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?(?:ufw\s+allow|firewall-cmd\b[^;&|]*--add-|iptables\s+-(?:A|I)|nft\s+add\s+rule)\b/i,
    reason: "修改防火墙或暴露端口",
  },
  {
    test: /\b(?:docker\s+(?:run|create)|podman\s+(?:run|create))\b[^;&|]*(?:\s-p\s|\s--publish(?:=|\s))/i,
    reason: "启动容器并暴露端口",
  },
  {
    test: /\b(?:kubectl\s+expose|ssh\s+-R\b)/i,
    reason: "创建远程端口暴露",
  },
  {
    test: /(?:^|[;&|]\s*)(?:sudo\s+)?tee\b/i,
    reason: "写入或覆盖文件",
  },
  {
    test: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
    reason: "下载并直接执行脚本",
  },
  {
    test: /\b(?:drop|delete|truncate|alter|update|insert)\b[\s\S]*\b(?:database|table|from|into|set)\b/i,
    reason: "修改数据库数据或结构",
  },
];

const READ_ONLY_COMMANDS = new Set([
  "[",
  "basename",
  "cat",
  "column",
  "command",
  "cut",
  "df",
  "dirname",
  "du",
  "echo",
  "egrep",
  "env",
  "false",
  "fgrep",
  "free",
  "grep",
  "head",
  "iostat",
  "id",
  "last",
  "lastlog",
  "lscpu",
  "lsblk",
  "lsof",
  "ls",
  "mpstat",
  "netstat",
  "nproc",
  "pidof",
  "pgrep",
  "printf",
  "ps",
  "pwd",
  "readlink",
  "realpath",
  "stat",
  "tail",
  "test",
  "top",
  "tr",
  "true",
  "type",
  "uname",
  "uniq",
  "uptime",
  "vmstat",
  "w",
  "wc",
  "whereis",
  "which",
  "who",
  "whoami",
]);

const SHELL_CONTROL_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "(",
  "{",
]);
const SHELL_TERMINATORS = new Set(["fi", "done", ")", "}"]);

function hasFileOverwriteRedirection(command: string): boolean {
  const redirects = command.matchAll(
    /(?:^|[\s;|&])\d*>(?![>&])\|?\s*([^\s;|&]+)/g
  );
  for (const redirect of redirects) {
    const target = redirect[1].replace(/^["']|["']$/g, "");
    if (target !== "/dev/null") return true;
  }
  return false;
}

function splitShellSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (pair === "&>") {
      current += pair;
      index += 1;
      continue;
    }
    if (char === "&" && command[index - 1] !== ">") {
      // Background execution can outlive the bounded Agent action and may hide
      // an arbitrary second command. Keep it behind explicit approval.
      return null;
    }
    if (char === ";" || char === "\n" || char === "|" || pair === "&&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if (pair === "&&" || pair === "||") index += 1;
      continue;
    }
    current += char;
  }

  if (quote || escaped) return null;
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (!current) return;
    words.push(current);
    current = "";
  };

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  if (quote || escaped) return null;
  push();
  return words;
}

function unwrapExecutable(words: string[]): string[] | null {
  let remaining = [...words];
  while (remaining.length > 0) {
    const first = remaining[0];
    if (SHELL_CONTROL_WORDS.has(first) || first === "!") {
      remaining = remaining.slice(1);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      remaining = remaining.slice(1);
      continue;
    }
    if (first === "sudo") {
      remaining = remaining.slice(1);
      while (remaining[0]?.startsWith("-")) remaining = remaining.slice(1);
      continue;
    }
    if (first === "env") {
      remaining = remaining.slice(1);
      while (
        remaining[0]?.startsWith("-") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining[0] ?? "")
      ) {
        if (
          remaining[0] === "-S" ||
          remaining[0]?.startsWith("--split-string")
        ) {
          return null;
        }
        remaining = remaining.slice(1);
      }
      continue;
    }
    if (first === "timeout") {
      remaining = remaining.slice(1);
      while (remaining[0]?.startsWith("-")) remaining = remaining.slice(1);
      if (remaining[0] && /^\d+(?:\.\d+)?[smhd]?$/.test(remaining[0])) {
        remaining = remaining.slice(1);
      }
      continue;
    }
    if (first === "command") {
      if (remaining[1] === "-v" || remaining[1] === "-V") return [];
      remaining = remaining.slice(1);
      continue;
    }
    break;
  }
  return remaining;
}

function isReadOnlyExecutable(words: string[]): boolean {
  const withoutFdRedirections = words.filter(
    (word) => !/^\d*(?:>&\d+|>\/dev\/null|<\/dev\/null)$/.test(word)
  );
  const unwrapped = unwrapExecutable(withoutFdRedirections);
  if (!unwrapped) return false;
  if (unwrapped.length === 0 || SHELL_TERMINATORS.has(unwrapped[0])) return true;
  const executable = unwrapped[0]
    .replace(/^[({]+/, "")
    .replace(/^.*[\\/]/, "");
  const args = unwrapped.slice(1);

  if (READ_ONLY_COMMANDS.has(executable)) return true;
  if (executable === "blkid") {
    return !args.some((arg) => arg === "-w" || arg === "--garbage-collect");
  }
  if (executable === "date") {
    return !args.some(
      (arg) =>
        arg === "-s" ||
        arg === "--set" ||
        arg.startsWith("--set=") ||
        (!arg.startsWith("-") && !arg.startsWith("+"))
    );
  }
  if (executable === "dmesg") {
    return !args.some((arg) =>
      /^(?:-c|-C|-D|-E|-n|--clear|--read-clear|--console-off|--console-on|--console-level)$/.test(
        arg
      )
    );
  }
  if (executable === "find") {
    return !args.some((arg) =>
      /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(arg)
    );
  }
  if (executable === "hostname") {
    return !args.some((arg) => !arg.startsWith("-"));
  }
  if (executable === "journalctl") {
    return !args.some((arg) =>
      /^--(?:flush|sync|relinquish-var|rotate|vacuum-|update-catalog|setup-keys)/.test(
        arg
      )
    );
  }
  if (executable === "sar") {
    return !args.some(
      (arg) => arg === "-o" || arg === "--output" || /^-o.+/.test(arg)
    );
  }
  if (executable === "systemctl") {
    const operation = args.find((arg) => !arg.startsWith("-")) ?? "";
    return /^(?:status|show|cat|is-active|is-enabled|is-failed|list-units|list-unit-files)$/.test(
      operation
    );
  }
  if (executable === "service") {
    return args.includes("--status-all") || args[args.length - 1] === "status";
  }
  if (executable === "ip") {
    return !args.some((arg) =>
      /^(?:add|append|attach|change|delete|del|exec|flush|replace|set|xdp)$/.test(
        arg
      )
    );
  }
  if (executable === "docker" || executable === "podman") {
    const operation = args.find((arg) => !arg.startsWith("-")) ?? "";
    return /^(?:ps|images|inspect|logs|stats|top|info|version)$/.test(operation);
  }
  if (executable === "git") {
    const operation = args.find((arg) => !arg.startsWith("-")) ?? "";
    return /^(?:status|diff|log|show|rev-parse|ls-files|ls-tree)$/.test(operation);
  }
  if (executable === "mount") {
    return args.every((arg) =>
      /^(?:-l|--show-labels|-h|--help|-V|--version)$/.test(arg)
    );
  }
  if (executable === "sort") {
    return !args.some(
      (arg) =>
        arg === "-o" ||
        arg === "--output" ||
        /^-o.+/.test(arg) ||
        arg.startsWith("--output=")
    );
  }
  if (executable === "ss") {
    return !args.some((arg) => arg === "-K" || arg === "--kill");
  }
  if (executable === "sysctl") {
    return !args.some((arg) => arg === "-w" || arg === "--write" || arg.includes("="));
  }
  return false;
}

function isConservativelyReadOnly(command: string): boolean {
  if (
    /[`]|[$]\(|<\(|>\(|<<|>>/.test(command) ||
    /(?:^|[\s;])(?:for|while|until|case|function)\b/.test(command)
  ) {
    return false;
  }
  const segments = splitShellSegments(command);
  if (!segments || segments.length === 0) return false;
  return segments.every((segment) => {
    const words = shellWords(segment);
    return Boolean(words && isReadOnlyExecutable(words));
  });
}

function splitCodeBlocks(text: string): string[] {
  const commands: string[] = [];
  const pattern =
    /(?:^|\r?\n)[ \t]*(```|~~~)[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const language = match[2].toLowerCase();
    if (
      language &&
      !["bash", "sh", "shell", "zsh", "console", "terminal"].includes(language)
    ) {
      continue;
    }
    const command = match[3]
      .replace(/^\s*\$\s+/gm, "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (command) commands.push(command);
  }
  return commands;
}

const TYPED_ACTION_FENCE =
  /(?:^|\r?\n)[ \t]*```[ \t]*termai-actions[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```[ \t]*(?=\r?\n|$)|$)/gi;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseTypedAction(
  value: unknown,
  index: number,
  options: LegacyActionParseOptions
): { action?: AgentTypedAction; error?: string } {
  if (!isRecord(value)) {
    return { error: `动作 ${index + 1} 不是对象` };
  }
  const type = stringValue(value.type);
  const actionId = `typed-action-${index + 1}`;
  switch (type) {
    case "shell.execute": {
      const command = stringValue(value.command);
      if (!command) {
        return { error: `动作 ${index + 1} shell.execute 缺少有效 command` };
      }
      return {
        action: {
          type,
          actionId,
          surfaceId: options.surfaceId,
          sessionId: options.sessionId,
          cwd: options.cwd,
          command,
          timeoutMs: boundedInteger(
            value.timeoutMs,
            options.timeoutMs ?? 35_000,
            1_000,
            120_000
          ),
        },
      };
    }
    case "terminal.readBlocks": {
      if (!Array.isArray(value.blockIds)) {
        return {
          error: `动作 ${index + 1} terminal.readBlocks 缺少 blockIds`,
        };
      }
      const blockIds = [
        ...new Set(
          value.blockIds
            .map(stringValue)
            .filter((blockId): blockId is string => Boolean(blockId))
        ),
      ].slice(0, 20);
      if (blockIds.length === 0) {
        return {
          error: `动作 ${index + 1} terminal.readBlocks 没有有效 Block`,
        };
      }
      return {
        action: {
          type,
          actionId,
          surfaceId: options.surfaceId,
          blockIds,
        },
      };
    }
    case "terminal.wait": {
      const reason = stringValue(value.reason);
      if (!reason) {
        return { error: `动作 ${index + 1} terminal.wait 缺少 reason` };
      }
      return {
        action: {
          type,
          actionId,
          surfaceId: options.surfaceId,
          durationMs: boundedInteger(value.durationMs, 1_000, 100, 30_000),
          reason: reason.slice(0, 200),
        },
      };
    }
    case "terminal.interrupt":
      return {
        action: {
          type,
          actionId,
          surfaceId: options.surfaceId,
          runtimeId: `terminal:${options.surfaceId}`,
        },
      };
    default:
      return {
        error: `动作 ${index + 1} 使用了不支持的类型 ${type ?? "(empty)"}`,
      };
  }
}

export function stripTypedActionEnvelopeForDisplay(
  text: string,
  streaming = false
): string {
  if (streaming) {
    const marker = text.search(
      /(?:^|\r?\n)[ \t]*```[ \t]*termai-actions\b/i
    );
    if (marker >= 0) return text.slice(0, marker).trim();
  }
  return text.replace(TYPED_ACTION_FENCE, "").trim();
}

export function parseAgentActionPlan(
  text: string,
  options: LegacyActionParseOptions
): AgentActionPlan {
  const matches = [...text.matchAll(TYPED_ACTION_FENCE)];
  if (matches.length === 0) {
    const actions = parseLegacyAgentActions(text, options);
    return {
      displayText: text.trim(),
      actions,
      source: actions.length > 0 ? "legacy" : "none",
      errors: [],
      warnings: [],
    };
  }

  const maxActions = Math.max(0, options.maxActions ?? 5);
  const rawActions: unknown[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const match of matches) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      const actions = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.actions)
          ? parsed.actions
          : undefined;
      if (!actions) {
        errors.push("termai-actions 必须是动作数组或包含 actions 数组");
        continue;
      }
      rawActions.push(...actions);
    } catch (error) {
      errors.push(`termai-actions JSON 无法解析：${String(error)}`);
    }
  }

  const actions: AgentTypedAction[] = [];
  for (const [index, value] of rawActions.slice(0, maxActions).entries()) {
    const parsed = parseTypedAction(value, index, options);
    if (parsed.action) actions.push(parsed.action);
    if (parsed.error) errors.push(parsed.error);
  }
  if (rawActions.length > maxActions) {
    warnings.push(`动作数量超过上限 ${maxActions}，其余动作已忽略`);
  }

  return {
    displayText: stripTypedActionEnvelopeForDisplay(text),
    actions,
    source: "typed",
    errors,
    warnings,
  };
}

export function parseLegacyAgentActions(
  text: string,
  options: LegacyActionParseOptions
): ShellExecuteAction[] {
  const maxActions = Math.max(0, options.maxActions ?? 5);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 35_000);
  return splitCodeBlocks(text)
    .slice(0, maxActions)
    .map((command, index) => ({
      type: "shell.execute",
      actionId: `legacy-shell-${index + 1}`,
      surfaceId: options.surfaceId,
      sessionId: options.sessionId,
      cwd: options.cwd,
      command,
      timeoutMs,
    }));
}

export function assessAgentAction(action: AgentTypedAction): AgentActionRisk {
  switch (action.type) {
    case "terminal.readBlocks":
    case "terminal.wait":
    case "terminal.interrupt":
      return { level: "safe" };
    case "shell.execute": {
      const command = action.command.trim();
      if (!command) return { level: "invalid", reason: "命令为空" };
      if (command.includes("\0")) return { level: "invalid", reason: "命令包含非法空字符" };

      const existingVerdict = checkDangerous(command);
      if (existingVerdict.danger) {
        return {
          level: "approval-required",
          reason: existingVerdict.reason ?? "命令可能修改系统",
        };
      }
      if (hasFileOverwriteRedirection(command)) {
        return {
          level: "approval-required",
          reason: "重定向覆盖文件",
        };
      }
      for (const rule of APPROVAL_RULES) {
        if (rule.test.test(command)) {
          return { level: "approval-required", reason: rule.reason };
        }
      }
      return isConservativelyReadOnly(command)
        ? { level: "safe" }
        : {
            level: "approval-required",
            reason: "命令不在只读自动执行范围",
          };
    }
  }
}
