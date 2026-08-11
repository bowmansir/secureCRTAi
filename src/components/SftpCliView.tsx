import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "../api";
import type { FileEntry, TabInfo } from "../types";
import {
  getTerminalTheme,
  type AppTheme,
} from "../terminal/terminalThemes";

interface Props {
  tab: TabInfo;
  active: boolean;
  theme: AppTheme;
  backgroundActive: boolean;
  onStatus: (tabId: string, status: TabInfo["status"]) => void;
  startTransfer: (
    sftpId: string,
    kind: "upload" | "download",
    local: string,
    remote: string,
    title: string,
    onDone?: () => void
  ) => void;
}

const PROMPT = "\x1b[95msftp>\x1b[0m ";
const COMMANDS = ["ls", "ll", "cd", "pwd", "lls", "lcd", "lpwd", "get", "put", "mkdir", "rm", "rmdir", "mv", "rename", "clear", "help"];

type CompletionSide = "command" | "remote" | "local";

interface ParsedToken {
  text: string;
  rawStart: number;
  rawEnd: number;
  quoted: boolean;
}

interface CompletionContext {
  side: CompletionSide;
  token: ParsedToken;
  onlyDirs: boolean;
}

function parseTokens(line: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let text = "";
  let rawStart = -1;
  let quoted = false;
  let quote: string | null = null;

  const push = (rawEnd: number) => {
    if (rawStart < 0) return;
    tokens.push({ text, rawStart, rawEnd, quoted });
    text = "";
    rawStart = -1;
    quoted = false;
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else text += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (rawStart < 0) rawStart = i;
      quoted = true;
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push(i);
      continue;
    }
    if (rawStart < 0) rawStart = i;
    text += ch;
  }
  push(line.length);
  return tokens;
}

function currentToken(line: string): { tokens: ParsedToken[]; tokenIndex: number; token: ParsedToken } {
  const tokens = parseTokens(line);
  if (line.length === 0 || /\s$/.test(line)) {
    return {
      tokens,
      tokenIndex: tokens.length,
      token: { text: "", rawStart: line.length, rawEnd: line.length, quoted: false },
    };
  }
  const tokenIndex = Math.max(0, tokens.length - 1);
  return { tokens, tokenIndex, token: tokens[tokenIndex] };
}

function completionContext(line: string): CompletionContext | null {
  const { tokens, tokenIndex, token } = currentToken(line);
  if (tokenIndex === 0) return { side: "command", token, onlyDirs: false };

  const cmd = tokens[0]?.text.toLowerCase();
  if (!cmd) return null;

  if (cmd === "put") {
    if (tokenIndex === 1) return { side: "local", token, onlyDirs: false };
    if (tokenIndex === 2) return { side: "remote", token, onlyDirs: false };
  }
  if (cmd === "get") {
    if (tokenIndex === 1) return { side: "remote", token, onlyDirs: false };
    if (tokenIndex === 2) return { side: "local", token, onlyDirs: false };
  }
  if (cmd === "cd" || cmd === "rmdir") {
    if (tokenIndex === 1) return { side: "remote", token, onlyDirs: true };
  }
  if (cmd === "lcd") {
    if (tokenIndex === 1) return { side: "local", token, onlyDirs: true };
  }
  if (cmd === "ls" || cmd === "ll" || cmd === "rm" || cmd === "mkdir") {
    if (tokenIndex === 1) return { side: "remote", token, onlyDirs: false };
  }
  if (cmd === "lls") {
    if (tokenIndex === 1) return { side: "local", token, onlyDirs: false };
  }
  if (cmd === "mv" || cmd === "rename") {
    if (tokenIndex === 1 || tokenIndex === 2) return { side: "remote", token, onlyDirs: false };
  }
  return null;
}

function joinRemotePath(cwd: string, path: string): string {
  if (!path) return cwd;
  if (path.startsWith("/")) return path.replace(/\/+$/, "") || "/";
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return `${base}${path}`.replace(/\/+$/, "") || "/";
}

function isLocalAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function trimLocalPathEnd(path: string): string {
  if (/^[a-zA-Z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "") || path;
}

function joinLocalPath(cwd: string, path: string): string {
  if (!path) return cwd;
  if (isLocalAbsolute(path)) return trimLocalPathEnd(path);
  const sep = cwd.includes("/") && !cwd.includes("\\") ? "/" : "\\";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${path.replace(/[\\/]+$/, "")}`;
}

function splitPathToken(value: string, side: Exclude<CompletionSide, "command">) {
  const slash = value.lastIndexOf("/");
  const backslash = side === "local" ? value.lastIndexOf("\\") : -1;
  const idx = Math.max(slash, backslash);
  const dirPrefix = idx >= 0 ? value.slice(0, idx + 1) : "";
  const prefix = idx >= 0 ? value.slice(idx + 1) : value;
  const sep = side === "remote" ? "/" : dirPrefix.includes("/") && !dirPrefix.includes("\\") ? "/" : "\\";
  return { dirPrefix, prefix, sep };
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

function renderToken(value: string, quoted: boolean): string {
  if (!quoted && !/\s/.test(value)) return value;
  return `"${value.replace(/"/g, "")}"`;
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/** 类 SecureCRT 的 sftp> 交互式命令行，get/put 走传输队列 */
export default function SftpCliView({
  tab,
  active,
  theme,
  backgroundActive,
  onStatus,
  startTransfer,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || openedRef.current) return;
    openedRef.current = true;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      theme: getTerminalTheme(theme, backgroundActive),
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // 会话状态：远程/本地工作目录 + 行编辑缓冲
    let sftpId: string | null = null;
    let cwd = "/";
    let lcwd = "";
    let buffer = "";
    let busy = false;
    let completing = false;
    const history: string[] = [];
    let histIdx = -1;

    const writeLines = (text: string) => {
      if (text) term.write(text.split("\n").join("\r\n") + "\r\n");
    };
    const prompt = () => term.write(PROMPT);
    const clearLine = () => {
      term.write("\r\x1b[K");
      term.write(PROMPT + buffer);
    };

    const runLine = async (line: string) => {
      if (!line.trim()) {
        prompt();
        return;
      }
      if (line.trim() === "clear") {
        term.clear();
        prompt();
        return;
      }
      if (!sftpId) {
        writeLines("\x1b[31m连接尚未就绪\x1b[0m");
        prompt();
        return;
      }
      busy = true;
      try {
        const r = await api.sftpCliExec(sftpId, line, cwd, lcwd);
        cwd = r.cwd;
        lcwd = r.lcwd;
        writeLines(r.output);
        if (r.transfer) {
          startTransfer(sftpId, r.transfer.kind, r.transfer.local, r.transfer.remote, r.transfer.title);
        }
      } catch (e) {
        writeLines(`\x1b[31m${String(e)}\x1b[0m`);
      } finally {
        busy = false;
        prompt();
      }
    };

    const copySelectionToClipboard = () => {
      const selection = term.getSelection();
      if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    };

    const writeCompletionList = (labels: string[]) => {
      const shown = labels.slice(0, 100);
      const width = Math.min(Math.max(...shown.map((label) => label.length), 8) + 2, 42);
      const columns = Math.max(1, Math.floor(term.cols / width));
      term.write("\r\n");
      for (let i = 0; i < shown.length; i += columns) {
        term.write(shown.slice(i, i + columns).map((label) => label.padEnd(width)).join("") + "\r\n");
      }
      if (labels.length > shown.length) term.write(`... 还有 ${labels.length - shown.length} 项\r\n`);
      clearLine();
    };

    const replaceToken = (ctx: CompletionContext, value: string, trailingSpace = false) => {
      const rendered = renderToken(value, ctx.token.quoted);
      buffer = `${buffer.slice(0, ctx.token.rawStart)}${rendered}${trailingSpace ? " " : ""}`;
      clearLine();
    };

    const completePath = async () => {
      if (busy || completing) return;
      const ctx = completionContext(buffer);
      if (!ctx) {
        term.write("\x07");
        return;
      }

      if (ctx.side === "command") {
        const prefix = ctx.token.text.toLowerCase();
        const matches = COMMANDS.filter((cmd) => cmd.startsWith(prefix));
        if (matches.length === 0) {
          term.write("\x07");
        } else if (matches.length === 1) {
          replaceToken(ctx, matches[0], true);
        } else {
          const common = longestCommonPrefix(matches);
          if (common.length > ctx.token.text.length) replaceToken(ctx, common);
          else writeCompletionList(matches);
        }
        return;
      }

      completing = true;
      try {
        const { dirPrefix, prefix, sep } = splitPathToken(ctx.token.text, ctx.side);
        const listPath =
          ctx.side === "remote" ? joinRemotePath(cwd, dirPrefix) : joinLocalPath(lcwd, dirPrefix);
        if (ctx.side === "remote" && !sftpId) {
          term.write("\r\n\x1b[31m连接尚未就绪\x1b[0m\r\n");
          clearLine();
          return;
        }
        const entries =
          ctx.side === "remote" ? await api.sftpList(sftpId!, listPath) : await api.localList(listPath);
        const lowerPrefix = prefix.toLowerCase();
        const matches = sortEntries(entries).filter(
          (entry) => entry.name.toLowerCase().startsWith(lowerPrefix) && (!ctx.onlyDirs || entry.isDir)
        );
        if (matches.length === 0) {
          term.write("\x07");
          return;
        }

        const insertions = matches.map((entry) => `${dirPrefix}${entry.name}${entry.isDir ? sep : ""}`);
        if (matches.length === 1) {
          replaceToken(ctx, insertions[0], !matches[0].isDir);
          return;
        }

        const common = longestCommonPrefix(insertions);
        if (common.length > ctx.token.text.length) {
          replaceToken(ctx, common);
          return;
        }

        writeCompletionList(matches.map((entry) => `${entry.name}${entry.isDir ? sep : ""}`));
      } catch (e) {
        term.write(`\r\n\x1b[31m补全失败: ${String(e)}\x1b[0m\r\n`);
        clearLine();
      } finally {
        completing = false;
      }
    };

    const handleInput = (data: string) => {
      if (busy) return;
      // 转义序列（方向键等）单独处理，不进入字符循环
      if (data.startsWith("\x1b")) {
        if (data === "\x1b[A" && history.length > 0) {
          histIdx = Math.max(0, histIdx - 1);
          buffer = history[histIdx] ?? "";
          clearLine();
        } else if (data === "\x1b[B") {
          histIdx = Math.min(history.length, histIdx + 1);
          buffer = history[histIdx] ?? "";
          clearLine();
        }
        return;
      }
      for (const ch of data) {
        if (ch === "\r") {
          term.write("\r\n");
          const line = buffer;
          buffer = "";
          if (line.trim()) {
            history.push(line);
          }
          histIdx = history.length;
          void runLine(line);
        } else if (ch === "\x7f") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            term.write("\b \b");
          }
        } else if (ch === "\x03") {
          // Ctrl+C 取消当前输入
          buffer = "";
          term.write("^C\r\n");
          prompt();
        } else if (ch === "\t") {
          void completePath();
        } else if (ch >= " ") {
          buffer += ch;
          term.write(ch);
        }
      }
    };

    const pasteClipboardToInput = () => {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) handleInput(text.replace(/\r\n/g, "\r").replace(/\n/g, "\r"));
        })
        .catch(() => {});
    };

    term.onData(handleInput);

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
        pasteClipboardToInput();
        return false;
      }
      if (ev.key === "Tab" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        void completePath();
        return false;
      }
      return true;
    });

    term.writeln("\x1b[90mTermexa SFTP 命令行 — 输入 help 查看命令，get/put 自动进入传输队列\x1b[0m");

    Promise.all([api.sftpOpen(tab.sessionId!), api.localHome()])
      .then(([{ id, home }, localHome]) => {
        sftpId = id;
        cwd = home;
        lcwd = localHome;
        onStatus(tab.tabId, "connected");
        term.writeln(`\x1b[32m已连接\x1b[0m 远程目录 ${home} · 本地目录 ${localHome}`);
        prompt();
      })
      .catch((e) => {
        onStatus(tab.tabId, "closed");
        term.writeln(`\x1b[31m连接失败: ${String(e)}\x1b[0m`);
      });

    const observer = new ResizeObserver(() => fitRef.current?.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (sftpId) api.sftpClose(sftpId).catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      termRef.current?.focus();
    }
  }, [active]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(theme, backgroundActive);
    }
  }, [backgroundActive, theme]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
