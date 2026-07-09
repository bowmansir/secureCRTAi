import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as api from "../api";
import type { TabInfo } from "../types";

interface Props {
  tab: TabInfo;
  active: boolean;
  theme: AppTheme;
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

type AppTheme = "dark" | "midnight" | "light";

const TERM_THEMES = {
  dark: { background: "#0d1117", foreground: "#e6edf3", cursor: "#58a6ff", selectionBackground: "#264f78" },
  midnight: { background: "#060a10", foreground: "#dbe7f7", cursor: "#7aa7ff", selectionBackground: "#20365a" },
  light: { background: "#fbfdff", foreground: "#172033", cursor: "#245dce", selectionBackground: "#c8dcff" },
};

const PROMPT = "\x1b[95msftp>\x1b[0m ";

/** 类 SecureCRT 的 sftp> 交互式命令行，get/put 走传输队列 */
export default function SftpCliView({ tab, active, theme, onStatus, startTransfer }: Props) {
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
      theme: TERM_THEMES[theme],
      cursorBlink: true,
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
        } else if (ch >= " " || ch === "\t") {
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
      return true;
    });

    term.writeln("\x1b[90mTermAI SFTP 命令行 — 输入 help 查看命令，get/put 自动进入传输队列\x1b[0m");

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
    if (termRef.current) termRef.current.options.theme = TERM_THEMES[theme];
  }, [theme]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
