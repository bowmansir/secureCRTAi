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
  riskLevel?: "unknown" | "moderate" | "high";
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
  "getent",
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
  "sleep",
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
const INFERRED_QUERY_WORD =
  /^(?:check|count|describe|diff|get|health|info|inspect|list|ls|policy|query|read|search|show|status|summary|validate|version|view)(?:[-_:]|$)/i;
const INFERRED_MUTATION_WORD =
  /^(?:add|append|apply|attach|clone|commit|copy|cp|create|delete|del|deploy|destroy|download|edit|enable|exec|execute|fix|format|import|init|install|kill|mkdir|mkfs|modify|move|mv|patch|publish|purge|push|put|reboot|release|remove|rename|reset|restart|restore|rm|rmdir|run|save|send|set|shell|start|stop|submit|touch|truncate|uninstall|update|upgrade|upload|write)(?:[-_:]|$)/i;
const INFERRED_QUERY_FLAG =
  /^(?:-h|-V|-\?|--(?:check|describe|help|info|inspect|list|query|show|status|summary|validate|version|view))(?:=|$)/i;
const INFERRED_MUTATION_FLAG =
  /^(?:-w|--(?:add|append|apply|clone|command|commit|copy|create|delete|deploy|destroy|download|edit|enable|eval|exec|execute|fix|force|format|hook|import|in-place|init|install|kill|library|load|mkdir|modify|module|move|output-file|patch|plugin|preload|publish|purge|push|put|reboot|release|remove|rename|reset|restart|restore|run|save|script|send|set|shell|start|stop|submit|touch|truncate|uninstall|update|upgrade|upload|write))(?:=|$)/i;
const INFERRED_OUTPUT_WRITE_WORD =
  /^(?:get|read)-(?:artifact|archive|blob|file|object)(?:[-_:]|$)/i;
const READ_ONLY_SUBSTITUTION_PLACEHOLDER = "__TERMEXA_READONLY_SUBSTITUTION__";

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
const SAFE_EXPORTED_PATH_ENTRIES = new Set([
  "$PATH",
  "${PATH}",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
]);
const SAFE_CURL_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "user-agent",
  "x-api-key",
  "x-elastic-product-origin",
]);

function hasFileOverwriteRedirection(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== ">") continue;

    let cursor = index + 1;
    if (command[cursor] === "&") {
      cursor += 1;
      if (/[-0-9]/.test(command[cursor] ?? "")) {
        while (/[-0-9]/.test(command[cursor] ?? "")) cursor += 1;
        index = cursor - 1;
        continue;
      }
    }
    if (command[cursor] === ">" || command[cursor] === "|") cursor += 1;
    while (/\s/.test(command[cursor] ?? "")) cursor += 1;
    if (cursor >= command.length) return true;

    let target = "";
    let targetQuote: "'" | '"' | null = null;
    let targetEscaped = false;
    for (; cursor < command.length; cursor += 1) {
      const targetChar = command[cursor];
      if (targetEscaped) {
        target += targetChar;
        targetEscaped = false;
        continue;
      }
      if (targetChar === "\\" && targetQuote !== "'") {
        targetEscaped = true;
        continue;
      }
      if (targetQuote) {
        if (targetChar === targetQuote) targetQuote = null;
        else target += targetChar;
        continue;
      }
      if (targetChar === "'" || targetChar === '"') {
        targetQuote = targetChar;
        continue;
      }
      if (/\s/.test(targetChar) || /[;|&]/.test(targetChar)) break;
      target += targetChar;
    }
    if (!target || target !== "/dev/null") return true;
    index = cursor - 1;
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

type UnwrappedExecutable = {
  words: string[];
  boundedByTimeout: boolean;
};

function unwrapExecutable(words: string[]): UnwrappedExecutable | null {
  let remaining = [...words];
  let boundedByTimeout = false;
  while (remaining.length > 0) {
    const first = remaining[0];
    if (SHELL_CONTROL_WORDS.has(first) || first === "!") {
      remaining = remaining.slice(1);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      if (!isSafeReadOnlyEnvironmentAssignment(first)) {
        let cursor = 0;
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining[cursor] ?? "")) {
          cursor += 1;
        }
        const environmentQuery = remaining.slice(cursor);
        if (
          !(
            (environmentQuery[0] === "env" && environmentQuery.length === 1) ||
            environmentQuery[0] === "printenv"
          )
        ) {
          return null;
        }
        return { words: environmentQuery, boundedByTimeout };
      }
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
        if (
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining[0] ?? "") &&
          !isSafeReadOnlyEnvironmentAssignment(remaining[0])
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
        boundedByTimeout = true;
        remaining = remaining.slice(1);
      }
      continue;
    }
    if (first === "command") {
      if (remaining[1] === "-v" || remaining[1] === "-V") {
        return { words: [], boundedByTimeout };
      }
      remaining = remaining.slice(1);
      continue;
    }
    break;
  }
  return { words: remaining, boundedByTimeout };
}

function isSafeReadOnlyEnvironmentAssignment(assignment: string): boolean {
  const match = assignment.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return false;
  const [, name, value] = match;
  if (/^(?:LC_ALL|LANG|LANGUAGE|TZ|COLUMNS|LINES|TERM|NO_COLOR|SYSTEMD_COLORS)$/.test(name)) {
    return /^[A-Za-z0-9_+.,:@%/=-]*$/.test(value);
  }
  if (/^(?:PAGER|SYSTEMD_PAGER|GIT_PAGER)$/.test(name)) {
    return value === "cat" || value === "";
  }
  return false;
}

function isSafeTemporaryPathExport(args: string[]): boolean {
  if (args.length !== 1 || !args[0].startsWith("PATH=")) return false;
  const entries = args[0].slice("PATH=".length).split(":");
  return (
    entries.length > 1 &&
    entries.some((entry) => entry === "$PATH" || entry === "${PATH}") &&
    entries.every((entry) => SAFE_EXPORTED_PATH_ENTRIES.has(entry))
  );
}

function isReadOnlyIptables(args: string[]): boolean {
  const queryOperation =
    /^(?:-[CLS]|--(?:check|list|list-rules))(?:=|$)/;
  const mutatingLongOperation =
    /^--(?:append|delete|insert|replace|flush|zero|new-chain|delete-chain|policy|rename-chain)(?:=|$)/;
  return (
    args.some((arg) => queryOperation.test(arg)) &&
    !args.some(
      (arg) =>
        /^-[^-]*[ADIRFZNXPE]/.test(arg) || mutatingLongOperation.test(arg)
    )
  );
}

function isReadOnlyNft(args: string[]): boolean {
  const operation = args.find((arg) => !arg.startsWith("-")) ?? "";
  return /^(?:list|get|describe)$/.test(operation);
}

function isReadOnlyUfw(args: string[]): boolean {
  const operation = args.find((arg) => !arg.startsWith("-")) ?? "";
  return /^(?:status|show)$/.test(operation);
}

function isReadOnlyFirewallCmd(args: string[]): boolean {
  const queryArgument =
    /^(?:--state$|--check-config$|--get-|--list-|--query-)/;
  const selectorArgument =
    /^(?:--zone=|--policy=|--permanent$|--help$|--version$|-h$|-V$|-q$)/;
  return (
    args.some((arg) => queryArgument.test(arg)) &&
    args.every(
      (arg) => queryArgument.test(arg) || selectorArgument.test(arg)
    )
  );
}

function isReadOnlyPm2(
  args: string[],
  boundedByTimeout: boolean
): boolean {
  const operation = args[0]?.toLowerCase() ?? "";
  if (
    /^(?:list|ls|status|show|describe|info|jlist|prettylist|ping)$/.test(
      operation
    )
  ) {
    return true;
  }
  if (operation === "log" || operation === "logs") {
    return args.includes("--nostream") || boundedByTimeout;
  }
  return false;
}

function takeOptionValue(
  args: string[],
  index: number,
  inlineValue: string | undefined
): { value: string; nextIndex: number } | null {
  if (inlineValue) return { value: inlineValue, nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("-")) return null;
  return { value, nextIndex: index + 1 };
}

function isReadOnlySearchApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      /^(?:http|https):$/.test(url.protocol) &&
      /\/_(?:search|count)\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isSafeCurlHeader(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  const name = value.slice(0, separator).trim().toLowerCase();
  return SAFE_CURL_HEADERS.has(name);
}

function isInlineJsonObject(value: string): boolean {
  if (!value || value.startsWith("@")) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function isReadOnlyCurl(args: string[]): boolean {
  const safeFlags = new Set([
    "--compressed",
    "--fail",
    "--fail-with-body",
    "--head",
    "--http1.0",
    "--http1.1",
    "--http2",
    "--include",
    "--insecure",
    "--ipv4",
    "--ipv6",
    "--location",
    "--no-progress-meter",
    "--show-error",
    "--silent",
    "--verbose",
  ]);
  const dataOptions = new Set([
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-raw",
    "--json",
  ]);
  const safeValueOptions = new Set([
    "--cacert",
    "--capath",
    "--cert",
    "--connect-timeout",
    "--interface",
    "--key",
    "--max-time",
    "--proxy",
    "--proxy-user",
    "--referer",
    "--resolve",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--user",
    "--user-agent",
    "--write-out",
  ]);
  const safeShortFlags = new Set(["4", "6", "f", "i", "I", "k", "L", "s", "S", "v"]);
  const safeShortValueOptions = new Set(["A", "e", "m", "u", "w", "x"]);
  const urls: string[] = [];
  const requestBodies: string[] = [];
  let requestMethod: "GET" | "HEAD" | "POST" | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^https?:\/\//i.test(arg)) {
      urls.push(arg);
      continue;
    }
    if (arg === "--") {
      const trailingUrls = args.slice(index + 1);
      if (
        trailingUrls.length === 0 ||
        !trailingUrls.every((value) => /^https?:\/\//i.test(value))
      ) {
        return false;
      }
      urls.push(...trailingUrls);
      break;
    }
    if (arg.startsWith("--request=")) {
      const method = arg.slice("--request=".length).toUpperCase();
      if (!/^(?:GET|HEAD|POST)$/.test(method)) return false;
      requestMethod = method as "GET" | "HEAD" | "POST";
      continue;
    }
    if (arg === "--request") {
      const option = takeOptionValue(args, index, undefined);
      const method = option?.value.toUpperCase() ?? "";
      if (!option || !/^(?:GET|HEAD|POST)$/.test(method)) return false;
      requestMethod = method as "GET" | "HEAD" | "POST";
      index = option.nextIndex;
      continue;
    }
    const longOption = arg.match(/^(--[^=]+)(?:=(.*))?$/);
    if (longOption?.[1] === "--output") {
      const option = takeOptionValue(args, index, longOption[2]);
      if (!option || option.value !== "/dev/null") return false;
      index = option.nextIndex;
      continue;
    }
    if (longOption && dataOptions.has(longOption[1])) {
      const option = takeOptionValue(args, index, longOption[2]);
      if (!option || !isInlineJsonObject(option.value)) return false;
      requestBodies.push(option.value);
      index = option.nextIndex;
      continue;
    }
    if (longOption?.[1] === "--header") {
      const option = takeOptionValue(args, index, longOption[2]);
      if (!option || !isSafeCurlHeader(option.value)) return false;
      index = option.nextIndex;
      continue;
    }
    if (safeFlags.has(arg)) continue;
    if (longOption) {
      if (!safeValueOptions.has(longOption[1])) return false;
      const option = takeOptionValue(args, index, longOption[2]);
      if (!option) return false;
      index = option.nextIndex;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      const shortMethod = arg.match(/^-X(GET|HEAD|POST)$/i);
      if (shortMethod) {
        requestMethod = shortMethod[1].toUpperCase() as
          | "GET"
          | "HEAD"
          | "POST";
        continue;
      }
      if (arg === "-X") {
        const option = takeOptionValue(args, index, undefined);
        const method = option?.value.toUpperCase() ?? "";
        if (!option || !/^(?:GET|HEAD|POST)$/.test(method)) return false;
        requestMethod = method as "GET" | "HEAD" | "POST";
        index = option.nextIndex;
        continue;
      }
      const shortData = arg.match(/^-d(.*)$/);
      if (shortData) {
        const option = takeOptionValue(args, index, shortData[1]);
        if (!option || !isInlineJsonObject(option.value)) return false;
        requestBodies.push(option.value);
        index = option.nextIndex;
        continue;
      }
      const shortHeader = arg.match(/^-H(.*)$/);
      if (shortHeader) {
        const option = takeOptionValue(args, index, shortHeader[1]);
        if (!option || !isSafeCurlHeader(option.value)) return false;
        index = option.nextIndex;
        continue;
      }
      const shortOutput = arg.match(/^-o(.*)$/);
      if (shortOutput) {
        const option = takeOptionValue(args, index, shortOutput[1]);
        if (!option || option.value !== "/dev/null") return false;
        index = option.nextIndex;
        continue;
      }
      const shortValue = arg.match(/^-([Aemuwx])(.*)$/);
      if (shortValue && safeShortValueOptions.has(shortValue[1])) {
        const option = takeOptionValue(args, index, shortValue[2]);
        if (!option) return false;
        index = option.nextIndex;
        continue;
      }
      const flags = arg.slice(1).split("");
      if (flags.length > 0 && flags.every((flag) => safeShortFlags.has(flag))) {
        continue;
      }
      return false;
    }
    return false;
  }

  if (urls.length === 0) return false;
  if (requestBodies.length === 0) {
    if (requestMethod === "POST") {
      return urls.every(isReadOnlySearchApiUrl);
    }
    return (
      requestMethod === null ||
      requestMethod === "GET" ||
      requestMethod === "HEAD"
    );
  }
  return (
    requestBodies.length === 1 &&
    (requestMethod === null ||
      requestMethod === "GET" ||
      requestMethod === "POST") &&
    urls.every(isReadOnlySearchApiUrl)
  );
}

function isReadOnlyRedisCli(args: string[]): boolean {
  const flags = new Set([
    "--csv",
    "--insecure",
    "--no-auth-warning",
    "--no-raw",
    "--raw",
    "--scan",
    "--tls",
  ]);
  const valueOptions = new Set([
    "--cacert",
    "--cacertdir",
    "--cert",
    "--count",
    "--db",
    "--host",
    "--key",
    "--pass",
    "--pattern",
    "--port",
    "--sni",
    "--type",
    "--uri",
    "--user",
  ]);
  const shortValueOptions = new Set(["a", "h", "n", "p", "u"]);
  const command: string[] = [];
  let scan = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (command.length > 0) {
      command.push(arg);
      continue;
    }
    if (arg === "--scan") {
      scan = true;
      continue;
    }
    if (flags.has(arg)) continue;
    const longOption = arg.match(/^(--[^=]+)(?:=(.*))?$/);
    if (longOption) {
      if (!valueOptions.has(longOption[1])) return false;
      const option = takeOptionValue(args, index, longOption[2]);
      if (!option) return false;
      index = option.nextIndex;
      continue;
    }
    const shortOption = arg.match(/^-([ahnpu])(.*)$/);
    if (shortOption && shortValueOptions.has(shortOption[1])) {
      const option = takeOptionValue(args, index, shortOption[2]);
      if (!option) return false;
      index = option.nextIndex;
      continue;
    }
    if (arg.startsWith("-")) return false;
    command.push(arg);
  }

  if (scan) return command.length === 0;
  if (command.length === 0) return false;

  const operation = command[0].toUpperCase();
  if (
    new Set([
      "COMMAND",
      "DBSIZE",
      "EXISTS",
      "GET",
      "HGET",
      "HGETALL",
      "HEXISTS",
      "HLEN",
      "HMGET",
      "INFO",
      "LLEN",
      "LRANGE",
      "MGET",
      "PING",
      "PTTL",
      "ROLE",
      "SCAN",
      "SCARD",
      "SISMEMBER",
      "SMEMBERS",
      "SSCAN",
      "STRLEN",
      "TIME",
      "TTL",
      "TYPE",
      "XLEN",
      "XRANGE",
      "ZCARD",
      "ZRANGE",
      "ZSCAN",
      "ZSCORE",
    ]).has(operation)
  ) {
    return true;
  }
  const subcommand = command[1]?.toUpperCase() ?? "";
  if (operation === "CLIENT") return /^(?:GETNAME|ID|INFO|LIST)$/.test(subcommand);
  if (operation === "CONFIG") return subcommand === "GET";
  if (operation === "MEMORY") return /^(?:DOCTOR|STATS|USAGE)$/.test(subcommand);
  if (operation === "SCRIPT") return subcommand === "EXISTS";
  if (operation === "SLOWLOG") return /^(?:GET|LEN)$/.test(subcommand);
  return false;
}

function isReadOnlyAwk(args: string[]): boolean {
  let program: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (program !== undefined) continue;
    if (arg === "--") {
      program = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "-F" || arg === "--field-separator") {
      if (!args[index + 1]) return false;
      index += 1;
      continue;
    }
    if (/^-F.+/.test(arg) || arg.startsWith("--field-separator=")) {
      continue;
    }
    if (arg === "-v" || arg === "--assign") {
      const assignment = args[index + 1];
      if (!assignment || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment)) {
        return false;
      }
      index += 1;
      continue;
    }
    if (/^(?:-v|--assign=)[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      continue;
    }
    if (arg.startsWith("-")) return false;
    program = arg;
  }

  if (!program) return false;
  return !(
    /(?:^|[^A-Za-z0-9_])(?:system|close)\s*\(/i.test(program) ||
    /\bgetline\b|@(?:include|load)\b/i.test(program) ||
    /[|`]/.test(program) ||
    /\b(?:print|printf)\b[^;\n}]*(?:>>|>(?!=))/i.test(program)
  );
}

function isInferredReadOnlyUnknownExecutable(
  executable: string,
  args: string[]
): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(executable)) return false;
  if (args.some((arg) => INFERRED_MUTATION_FLAG.test(arg))) return false;

  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.some((arg) => INFERRED_MUTATION_WORD.test(arg))) return false;
  if (positional.some((arg) => INFERRED_OUTPUT_WRITE_WORD.test(arg))) return false;

  const executableParts = executable.split(/[-_.]+/).filter(Boolean);
  if (executableParts.some((part) => INFERRED_MUTATION_WORD.test(part))) {
    return false;
  }

  return (
    args.some((arg) => INFERRED_QUERY_FLAG.test(arg)) ||
    positional.some((arg) => INFERRED_QUERY_WORD.test(arg)) ||
    executableParts.some((part) => INFERRED_QUERY_WORD.test(part))
  );
}

function isReadOnlyNginx(args: string[]): boolean {
  let diagnostic = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^(?:-t|-T|-v|-V)$/.test(arg)) {
      diagnostic = true;
      continue;
    }
    if (arg === "-q") continue;
    if (arg === "-c" || arg === "-p") {
      const value = args[index + 1];
      if (!value || value.startsWith("-") || /[$`]/.test(value)) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return diagnostic;
}

function isReadOnlyOpenSsl(args: string[], boundedByTimeout: boolean): boolean {
  const operation = args[0] ?? "";
  const operationArgs = args.slice(1);
  if (operation === "s_client") {
    return (
      boundedByTimeout &&
      !operationArgs.some((arg) =>
        /^(?:-keylogfile|-msgfile|-out|-sess_out|-writerand)$/.test(arg)
      )
    );
  }
  if (operation === "x509") {
    if (!operationArgs.includes("-noout")) return false;
    const flagsWithValues = new Set([
      "-in",
      "-inform",
      "-nameopt",
      "-certopt",
      "-checkend",
      "-ext",
    ]);
    const displayFlags = new Set([
      "-noout",
      "-subject",
      "-issuer",
      "-dates",
      "-startdate",
      "-enddate",
      "-serial",
      "-fingerprint",
      "-text",
      "-email",
      "-ocsp_uri",
      "-purpose",
      "-pubkey",
      "-modulus",
    ]);
    for (let index = 0; index < operationArgs.length; index += 1) {
      const arg = operationArgs[index];
      if (displayFlags.has(arg)) continue;
      if (flagsWithValues.has(arg) && operationArgs[index + 1]) {
        index += 1;
        continue;
      }
      return false;
    }
    return true;
  }
  return /^(?:ciphers|list|version|verify)$/.test(operation);
}

function isStaticAbsolutePath(value: string): boolean {
  return (
    /^\/[A-Za-z0-9._+@%/-]+$/.test(value) &&
    !value.split("/").includes("..")
  );
}

function isSafeTemporaryWriteSequence(command: string): boolean {
  const match = command.match(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(mktemp(\s+-d)?\s+(\/[A-Za-z0-9._+@%/-]+\.XXXXXX)\)\s*&&\s*([\s\S]+)$/
  );
  if (!match) return false;
  const [, variable, directoryFlag, template, remainder] = match;
  if (!isStaticAbsolutePath(template)) return false;

  const isTemporaryNamespace = /^\/(?:tmp|var\/tmp)\/(?:termexa|mya)[A-Za-z0-9._-]*\.XXXXXX$/.test(
    template
  );
  const isInPlaceWriteProbe = /\/\.termexa_write_test\.XXXXXX$/.test(template);
  if (!isTemporaryNamespace && !isInPlaceWriteProbe) return false;
  if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(template)) return false;

  const reference = `"$${variable}"`;
  const steps = remainder.split(/\s*&&\s*/).map((step) => step.trim());
  if (steps.length === 0 || steps.some((step) => !step)) return false;
  const cleanup = steps.pop();
  const expectedCleanup = directoryFlag
    ? `rmdir -- ${reference}`
    : `rm -f -- ${reference}`;
  if (cleanup !== expectedCleanup) return false;

  for (const step of steps) {
    if (step.includes("`") || step.includes("$(")) return false;
    const references = step.match(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g) ?? [];
    if (references.some((item) => item !== `$${variable}` && item !== `\${${variable}}`)) {
      return false;
    }
    if (!step.includes(reference)) return false;

    const normalized = step.split(reference).join("/tmp/termexa-probe");
    if (isConservativelyReadOnly(normalized)) continue;
    if (directoryFlag || !isTemporaryNamespace) return false;
    if (/^(?:printf|echo)\b[^;&|]*>\s*\/tmp\/termexa-probe$/.test(normalized)) {
      continue;
    }
    return false;
  }
  return true;
}

function isReadOnlyPing(args: string[], boundedByTimeout: boolean): boolean {
  if (args.some((arg) => /^(?:-f|--flood|-p|--pattern)$/.test(arg))) return false;
  return boundedByTimeout || args.some((arg, index) => {
    if (/^-c\d+$/.test(arg) || /^--count=\d+$/.test(arg)) return true;
    return /^(?:-c|--count)$/.test(arg) && /^\d+$/.test(args[index + 1] ?? "");
  });
}

function isReadOnlyNetcat(args: string[], boundedByTimeout: boolean): boolean {
  return (
    boundedByTimeout &&
    args.some((arg) => arg === "-z" || /^-[^-]*z/.test(arg)) &&
    !args.some(
      (arg) =>
        /^(?:--listen|-e|-c|-o)$/.test(arg) ||
        (/^-[^-]+/.test(arg) && /[leco]/.test(arg.slice(1)))
    )
  );
}

function isReadOnlySed(args: string[]): boolean {
  if (!args.includes("-n") || args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "-f")) {
    return false;
  }
  const program = args.find((arg) => !arg.startsWith("-"));
  return Boolean(
    program &&
      !/(?:^|[;{}])\s*(?:e|w)\b|s(?:[^\\/]|\\.)*\/(?:[^\\/]|\\.)*\/[a-zA-Z]*[ew]/.test(
        program
      )
  );
}

function isReadOnlyWget(args: string[]): boolean {
  return (
    args.some((arg) => arg === "--spider") &&
    args.some((arg) => /^https?:\/\//i.test(arg)) &&
    !args.some((arg) =>
      /^(?:-O|-o|-a|-e|--output-document|--output-file|--append-output|--execute|--post-|--body-file)(?:=|$)/.test(
        arg
      )
    )
  );
}

function hasFollowFlag(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "-f" ||
      /^-[^-]*f/.test(arg) ||
      arg === "--follow" ||
      arg.startsWith("--follow=")
  );
}

function isReadOnlyContainerCommand(
  args: string[],
  boundedByTimeout: boolean
): boolean {
  const operationIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (operationIndex < 0) return false;
  const operation = args[operationIndex];
  const operationArgs = args.slice(operationIndex + 1);
  if (/^(?:ps|images|inspect|top|info|version)$/.test(operation)) return true;
  if (operation === "logs") {
    return boundedByTimeout || !hasFollowFlag(operationArgs);
  }
  if (operation === "stats") {
    return boundedByTimeout || operationArgs.includes("--no-stream");
  }
  if (/^(?:network|volume|container|image)$/.test(operation)) {
    const subcommand = operationArgs.find((arg) => !arg.startsWith("-")) ?? "";
    return /^(?:ls|list|inspect)$/.test(subcommand);
  }
  if (operation === "compose") {
    const subcommandIndex = operationArgs.findIndex((arg) => !arg.startsWith("-"));
    if (subcommandIndex < 0) return false;
    const subcommand = operationArgs[subcommandIndex];
    const subcommandArgs = operationArgs.slice(subcommandIndex + 1);
    if (/^(?:ps|images|top)$/.test(subcommand)) return true;
    if (subcommand === "config") {
      return !subcommandArgs.some((arg) => /^(?:-o|--output)(?:=|$)/.test(arg));
    }
    if (subcommand === "logs") {
      return boundedByTimeout || !hasFollowFlag(subcommandArgs);
    }
  }
  return false;
}

function isReadOnlyKubectl(
  args: string[],
  boundedByTimeout: boolean
): boolean {
  const operationIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (operationIndex < 0) return false;
  const operation = args[operationIndex];
  const operationArgs = args.slice(operationIndex + 1);
  if (
    /^(?:get|describe|top|cluster-info|version|api-resources|api-versions|explain)$/.test(
      operation
    )
  ) {
    return true;
  }
  if (operation === "logs") {
    return boundedByTimeout || !hasFollowFlag(operationArgs);
  }
  if (operation === "auth") {
    return operationArgs[0] === "can-i";
  }
  if (operation === "config") {
    return /^(?:view|current-context|get-contexts)$/.test(operationArgs[0] ?? "");
  }
  return false;
}

function normalizeReadOnlyCommandSubstitutions(
  command: string,
  inheritedTimeout: boolean
): string | null {
  let normalized = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      normalized += char;
      if (char === "'") quote = null;
      continue;
    }
    if (escaped) {
      normalized += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      normalized += char;
      escaped = true;
      continue;
    }
    if (char === "'") {
      normalized += char;
      quote = "'";
      continue;
    }
    if (char === '"') {
      normalized += char;
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (char === "`") return null;
    if (char !== "$" || command[index + 1] !== "(") {
      normalized += char;
      continue;
    }
    if (command[index + 2] === "(") return null;

    let depth = 1;
    let innerQuote: "'" | '"' | null = null;
    let innerEscaped = false;
    let end = index + 2;
    for (; end < command.length; end += 1) {
      const innerChar = command[end];
      if (innerQuote === "'") {
        if (innerChar === "'") innerQuote = null;
        continue;
      }
      if (innerEscaped) {
        innerEscaped = false;
        continue;
      }
      if (innerChar === "\\") {
        innerEscaped = true;
        continue;
      }
      if (innerChar === "'") {
        innerQuote = "'";
        continue;
      }
      if (innerChar === '"') {
        innerQuote = innerQuote === '"' ? null : '"';
        continue;
      }
      if (innerChar === "`") return null;
      if (innerChar === "(") depth += 1;
      if (innerChar === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;
    const inner = command.slice(index + 2, end);
    if (!isConservativelyReadOnly(inner, inheritedTimeout)) return null;
    normalized += READ_ONLY_SUBSTITUTION_PLACEHOLDER;
    index = end;
  }

  return normalized;
}

function allowsReadOnlyCommandSubstitution(words: string[]): boolean {
  const unwrapped = unwrapExecutable(
    words.filter((word) => !/^\d*(?:>&\d+|>\/dev\/null|<\/dev\/null)$/.test(word))
  );
  if (!unwrapped?.words.length) return false;
  const executable = unwrapped.words[0]
    .replace(/^[({]+/, "")
    .replace(/^.*[\\/]/, "");
  return READ_ONLY_COMMANDS.has(executable);
}

function isReadOnlyExecutable(
  words: string[],
  inheritedTimeout = false
): boolean {
  const withoutFdRedirections = words.filter(
    (word) => !/^\d*(?:>&\d+|>\/dev\/null|<\/dev\/null)$/.test(word)
  );
  const unwrapped = unwrapExecutable(withoutFdRedirections);
  if (!unwrapped) return false;
  if (
    unwrapped.words.length === 0 ||
    SHELL_TERMINATORS.has(unwrapped.words[0])
  ) {
    return true;
  }
  const executable = unwrapped.words[0]
    .replace(/^[({]+/, "")
    .replace(/^.*[\\/]/, "");
  const args = unwrapped.words.slice(1);
  const boundedByTimeout =
    inheritedTimeout || unwrapped.boundedByTimeout;

  if (READ_ONLY_COMMANDS.has(executable)) return true;
  if (/^(?:dig|nslookup|host)$/.test(executable)) {
    return args.length > 0;
  }
  if (/^(?:sha(?:1|224|256|384|512)sum|md5sum|file|strings)$/.test(executable)) {
    return args.length > 0;
  }
  if (executable === "printenv" || executable === "lsmod") {
    return true;
  }
  if (executable === "ping" || executable === "ping6") {
    return isReadOnlyPing(args, boundedByTimeout);
  }
  if (/^(?:nc|netcat|ncat)$/.test(executable)) {
    return isReadOnlyNetcat(args, boundedByTimeout);
  }
  if (executable === "sed") {
    return isReadOnlySed(args);
  }
  if (executable === "jq") {
    return !args.some((arg) => /^(?:-f|--from-file|-L|--library-path)$/.test(arg));
  }
  if (executable === "yq") {
    return !args.some((arg) => arg === "-i" || arg === "--inplace");
  }
  if (executable === "crontab") {
    return (
      (args.length === 1 && args[0] === "-l") ||
      (args.length === 3 &&
        args[0] === "-u" &&
        /^[A-Za-z0-9_.-]+$/.test(args[1]) &&
        args[2] === "-l")
    );
  }
  if (executable === "rpm") {
    return (
      args.some((arg) => /^-q/.test(arg) || arg === "--query") &&
      !args.some((arg) =>
        /^(?:-i|-U|-F|-e|--install|--upgrade|--freshen|--erase|--setperms|--setugids)$/.test(
          arg
        )
      )
    );
  }
  if (executable === "dpkg") {
    return (
      args.some((arg) => arg === "-l" || arg === "--list") &&
      !args.some((arg) =>
        /^(?:-i|--install|-r|--remove|-P|--purge|--configure|--unpack)$/.test(
          arg
        )
      )
    );
  }
  if (executable === "wget") {
    return isReadOnlyWget(args);
  }
  if (executable === "sshd") {
    return args.length > 0 && args.every((arg) => arg === "-T");
  }
  if (/^(?:apachectl|apache2ctl)$/.test(executable)) {
    return args.length > 0 && args.every((arg) => /^(?:-t|configtest|-S|-M)$/.test(arg));
  }
  if (executable === "certbot") {
    return args.length === 1 && args[0] === "certificates";
  }
  if (executable === "docker" || executable === "podman") {
    return isReadOnlyContainerCommand(args, boundedByTimeout);
  }
  if (executable === "kubectl") {
    return isReadOnlyKubectl(args, boundedByTimeout);
  }
  if (
    /^(?:ba|da|z)?sh$/.test(executable) &&
    args.length === 2 &&
    args[0] === "-c"
  ) {
    return isConservativelyReadOnly(args[1], boundedByTimeout);
  }
  if (executable === "export") {
    return isSafeTemporaryPathExport(args);
  }
  if (executable === "iptables" || executable === "ip6tables") {
    return isReadOnlyIptables(args);
  }
  if (executable === "nft") {
    return isReadOnlyNft(args);
  }
  if (executable === "ufw") {
    return isReadOnlyUfw(args);
  }
  if (executable === "firewall-cmd") {
    return isReadOnlyFirewallCmd(args);
  }
  if (executable === "pm2") {
    return isReadOnlyPm2(args, boundedByTimeout);
  }
  if (executable === "curl") {
    return isReadOnlyCurl(args);
  }
  if (executable === "redis-cli") {
    return isReadOnlyRedisCli(args);
  }
  if (executable === "nginx") {
    return isReadOnlyNginx(args);
  }
  if (executable === "openssl") {
    return isReadOnlyOpenSsl(args, boundedByTimeout);
  }
  if (/^(?:awk|gawk|mawk|nawk)$/.test(executable)) {
    return isReadOnlyAwk(args);
  }
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
    return /^(?:status|show|cat|is-active|is-enabled|is-failed|is-system-running|get-default|list-dependencies|list-units|list-unit-files)$/.test(
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
  return isInferredReadOnlyUnknownExecutable(executable, args);
}

function isReadOnlyLiteralForLoop(
  command: string,
  inheritedTimeout: boolean
): boolean {
  const match = command.match(
    /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\r\n]+?)\s*;\s*do\s+([\s\S]*?)\s*;\s*done\s*$/
  );
  if (!match) return false;

  const values = shellWords(match[2]);
  if (
    !values?.length ||
    !values.every((value) => /^[A-Za-z0-9_./:+@%=-]+$/.test(value))
  ) {
    return false;
  }

  return isConservativelyReadOnly(match[3], inheritedTimeout);
}

function isConservativelyReadOnly(
  command: string,
  inheritedTimeout = false
): boolean {
  if (/<\(|>\(|<<|>>/.test(command)) {
    return false;
  }
  if (/(?:^|[\s;])for\b/.test(command) && command.includes("$(")) {
    return false;
  }
  const normalized = normalizeReadOnlyCommandSubstitutions(
    command,
    inheritedTimeout
  );
  if (normalized === null) return false;
  if (/(?:^|[\s;])for\b/.test(normalized)) {
    return isReadOnlyLiteralForLoop(normalized, inheritedTimeout);
  }
  if (/(?:^|[\s;])(?:while|until|case|function)\b/.test(normalized)) {
    return false;
  }
  const segments = splitShellSegments(normalized);
  if (!segments || segments.length === 0) return false;
  return segments.every((segment) => {
    const words = shellWords(segment);
    return Boolean(
      words &&
        (!segment.includes(READ_ONLY_SUBSTITUTION_PLACEHOLDER) ||
          allowsReadOnlyCommandSubstitution(words)) &&
        isReadOnlyExecutable(words, inheritedTimeout)
    );
  });
}

function isAssignmentOnlyInput(command: string): boolean {
  const segments = command
    .split(/[&\r\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (
    segments.length > 0 &&
    segments.every((segment) =>
      /^[A-Za-z_][A-Za-z0-9_]*=[^;&|\s]*$/.test(segment)
    )
  );
}

function looksLikeTimestampedTerminalOutput(command: string): boolean {
  const timestampPrefix = /^(?:\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?|\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\]?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+/i;
  const normalized = command
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r/g, "");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  if (timestampPrefix.test(lines[0])) return true;
  return lines.filter((line) => timestampPrefix.test(line)).length >= 2;
}

function shellCommandValidationError(command: string): string | undefined {
  if (isAssignmentOnlyInput(command)) {
    return "仅包含参数赋值，缺少可执行命令";
  }
  if (looksLikeTimestampedTerminalOutput(command)) {
    return "内容看起来是日志或终端输出，缺少可执行命令";
  }
  return undefined;
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
  /(?:^|\r?\n)[ \t]*```[ \t]*(?:termexa|termai)-actions[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```[ \t]*(?=\r?\n|$)|$)/gi;

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
      /(?:^|\r?\n)[ \t]*```[ \t]*(?:termexa|termai)-actions\b/i
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
        errors.push("termexa-actions 必须是动作数组或包含 actions 数组");
        continue;
      }
      rawActions.push(...actions);
    } catch (error) {
      errors.push(`termexa-actions JSON 无法解析：${String(error)}`);
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
      const validationError = shellCommandValidationError(command);
      if (validationError) return { level: "invalid", reason: validationError };

      const existingVerdict = checkDangerous(command);
      if (existingVerdict.danger) {
        return {
          level: "approval-required",
          riskLevel: "high",
          reason: existingVerdict.reason ?? "命令可能修改系统",
        };
      }
      if (isSafeTemporaryWriteSequence(command)) {
        return { level: "safe" };
      }
      if (hasFileOverwriteRedirection(command)) {
        return {
          level: "approval-required",
          riskLevel: "moderate",
          reason: "重定向覆盖文件",
        };
      }
      for (const rule of APPROVAL_RULES) {
        if (rule.test.test(command)) {
          return {
            level: "approval-required",
            riskLevel: "moderate",
            reason: rule.reason,
          };
        }
      }
      return isConservativelyReadOnly(command)
        ? { level: "safe" }
        : {
            level: "approval-required",
            riskLevel: "unknown",
            reason: "命令不在只读自动执行范围",
          };
    }
  }
}
