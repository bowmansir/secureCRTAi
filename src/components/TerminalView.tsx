import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import * as api from "../api";
import { SEPARATOR, useContextMenu } from "./ContextMenu";
import Icon from "./Icons";
import type { TabInfo, TermEvent } from "../types";

interface Props {
  tab: TabInfo;
  active: boolean;
  visible?: boolean;
  theme: AppTheme;
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
}

type AppTheme = "dark" | "midnight" | "light";

const TERM_THEMES = {
  dark: {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    selectionBackground: "#264f78",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
  midnight: {
    background: "#060a10",
    foreground: "#dbe7f7",
    cursor: "#7aa7ff",
    selectionBackground: "#20365a",
    black: "#303846",
    red: "#ff8b84",
    green: "#4bd06a",
    yellow: "#d8a84c",
    blue: "#7aa7ff",
    magenta: "#b996ff",
    cyan: "#55d5e0",
    white: "#c8d4e6",
    brightBlack: "#5c6878",
    brightRed: "#ffaea9",
    brightGreen: "#74e38c",
    brightYellow: "#efc36c",
    brightBlue: "#9fc0ff",
    brightMagenta: "#d5c2ff",
    brightCyan: "#8ee8ef",
    brightWhite: "#f4f8ff",
  },
  light: {
    background: "#fbfdff",
    foreground: "#172033",
    cursor: "#245dce",
    selectionBackground: "#c8dcff",
    black: "#172033",
    red: "#c3312a",
    green: "#1c7d3d",
    yellow: "#9a6700",
    blue: "#245dce",
    magenta: "#7a4acb",
    cyan: "#157f8f",
    white: "#d6deea",
    brightBlack: "#65758b",
    brightRed: "#e04a43",
    brightGreen: "#269b4d",
    brightYellow: "#b98210",
    brightBlue: "#3578f6",
    brightMagenta: "#9462e8",
    brightCyan: "#209aaa",
    brightWhite: "#ffffff",
  },
};

export default function TerminalView({
  tab,
  active,
  visible,
  theme,
  onStatus,
  onOutput,
  registerTermId,
  onSize,
  onOpenSftp,
  onAskAi,
}: Props) {
  const { showMenu } = useContextMenu();
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
  // 搜索
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const MAX_RECONNECT = 6;
  const isVisible = visible ?? active;

  useEffect(() => {
    if (!containerRef.current || openedRef.current) return;
    openedRef.current = true;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      theme: TERM_THEMES[theme],
      cursorBlink: true,
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
        onOutput(tab.tabId, decoder.current.decode(bytes, { stream: true }));
      } else if (e.type === "connected") {
        const reconnected = wasConnectedRef.current;
        wasConnectedRef.current = true;
        attemptsRef.current = 0;
        onStatus(tab.tabId, "connected");
        if (reconnected) term.write("\r\n\x1b[32m[已重新连接]\x1b[0m\r\n");
      } else if (e.type === "exit") {
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

    const dataSub = term.onData((data) => {
      const id = termIdRef.current;
      if (id) api.termWrite(id, data).catch(() => {});
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
    if (active) {
      termRef.current?.focus();
    }
  }, [active, isVisible, onSize, tab.tabId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = TERM_THEMES[theme];
  }, [theme]);

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
    <div className="terminal-wrapper" style={{ display: isVisible ? "block" : "none" }}>
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
    </div>
  );
}
