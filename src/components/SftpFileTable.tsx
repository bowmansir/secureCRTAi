import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { FileEntry } from "../types";
import Icon from "./Icons";

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 29;
const OVERSCAN = 8;
const COLUMN_WIDTHS_KEY = "termai.sftpColumnWidths";
const OPS_COL_WIDTH = 90;
const GRID_GAP_TOTAL = 24;
const ROW_PADDING_TOTAL = 24;

type ColumnKey = "name" | "size" | "time";

type ColumnWidths = Record<ColumnKey, number>;

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  name: 220,
  size: 84,
  time: 156,
};

const MIN_COLUMN_WIDTHS: ColumnWidths = {
  name: 120,
  size: 64,
  time: 112,
};

const MAX_COLUMN_WIDTHS: ColumnWidths = {
  name: 720,
  size: 220,
  time: 300,
};

interface Props {
  entries: FileEntry[];
  selectedName?: string | null;
  emptyText?: string;
  titleForEntry: (entry: FileEntry) => string;
  onSelect?: (entry: FileEntry) => void;
  onEnterDir: (entry: FileEntry) => void;
  onFileAction: (entry: FileEntry) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, entry: FileEntry) => void;
  actionLabel?: (entry: FileEntry) => ReactNode;
  actionTitle?: (entry: FileEntry) => string | undefined;
  onAction?: (event: MouseEvent<HTMLButtonElement>, entry: FileEntry) => void;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(t: number | null): string {
  if (!t) return "-";
  return new Date(t * 1000).toLocaleString("zh-CN", { hour12: false });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function loadColumnWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_KEY);
    if (!raw) return DEFAULT_COLUMN_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      name: clamp(Number(parsed.name) || DEFAULT_COLUMN_WIDTHS.name, MIN_COLUMN_WIDTHS.name, MAX_COLUMN_WIDTHS.name),
      size: clamp(Number(parsed.size) || DEFAULT_COLUMN_WIDTHS.size, MIN_COLUMN_WIDTHS.size, MAX_COLUMN_WIDTHS.size),
      time: clamp(Number(parsed.time) || DEFAULT_COLUMN_WIDTHS.time, MIN_COLUMN_WIDTHS.time, MAX_COLUMN_WIDTHS.time),
    };
  } catch {
    return DEFAULT_COLUMN_WIDTHS;
  }
}

export default function SftpFileTable({
  entries,
  selectedName,
  emptyText = "空目录",
  titleForEntry,
  onSelect,
  onEnterDir,
  onFileAction,
  onContextMenu,
  actionLabel,
  actionTitle,
  onAction,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(loadColumnWidths);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths));
    } catch {
      /* 忽略列宽偏好持久化失败 */
    }
  }, [columnWidths]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [entries]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resizing = resizingRef.current;
      if (!resizing) return;
      const nextWidth = clamp(
        resizing.startWidth + event.clientX - resizing.startX,
        MIN_COLUMN_WIDTHS[resizing.key],
        MAX_COLUMN_WIDTHS[resizing.key]
      );
      setColumnWidths((prev) => ({ ...prev, [resizing.key]: nextWidth }));
    };

    const stopResize = () => {
      if (!resizingRef.current) return;
      resizingRef.current = null;
      document.body.classList.remove("sftp-column-resizing");
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.classList.remove("sftp-column-resizing");
    };
  }, []);

  const range = useMemo(() => {
    const bodyTop = Math.max(0, scrollTop - HEADER_HEIGHT);
    const start = Math.max(0, Math.floor(bodyTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil((viewportHeight + HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN * 2;
    return {
      start,
      end: Math.min(entries.length, start + visibleCount),
    };
  }, [entries.length, scrollTop, viewportHeight]);

  const visibleEntries = entries.slice(range.start, range.end);
  const tableMinWidth =
    columnWidths.name + columnWidths.size + columnWidths.time + OPS_COL_WIDTH + GRID_GAP_TOTAL + ROW_PADDING_TOTAL;
  const tableStyle = {
    "--sftp-name-col": `${columnWidths.name}px`,
    "--sftp-size-col": `${columnWidths.size}px`,
    "--sftp-time-col": `${columnWidths.time}px`,
    "--sftp-ops-col": `${OPS_COL_WIDTH}px`,
    "--sftp-table-min-width": `${tableMinWidth}px`,
  } as CSSProperties;

  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, key: ColumnKey) => {
    event.preventDefault();
    event.stopPropagation();
    resizingRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key],
    };
    document.body.classList.add("sftp-column-resizing");
  };

  const resetColumn = (event: MouseEvent<HTMLSpanElement>, key: ColumnKey) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnWidths((prev) => ({ ...prev, [key]: DEFAULT_COLUMN_WIDTHS[key] }));
  };

  const headerCell = (key: ColumnKey, className: string, label: string) => (
    <span className={`${className} sftp-header-cell`}>
      <span className="sftp-header-label">{label}</span>
      <span
        className="sftp-col-resizer"
        title="拖动调整列宽，双击恢复默认宽度"
        onPointerDown={(event) => startResize(event, key)}
        onDoubleClick={(event) => resetColumn(event, key)}
      />
    </span>
  );

  return (
    <div
      className="sftp-table"
      ref={scrollRef}
      style={tableStyle}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="sftp-row header compact">
        {headerCell("name", "col-name", "名称")}
        {headerCell("size", "col-size", "大小")}
        {headerCell("time", "col-time", "修改时间")}
        <span className="col-ops" />
      </div>
      {entries.length === 0 ? (
        <div className="empty-hint">{emptyText}</div>
      ) : (
        <div className="sftp-virtual-body" style={{ height: entries.length * ROW_HEIGHT }}>
          {visibleEntries.map((entry, offset) => {
            const index = range.start + offset;
            const label = actionLabel?.(entry);
            return (
              <div
                key={`${entry.name}-${index}`}
                className={`sftp-row compact virtual${selectedName === entry.name ? " selected" : ""}`}
                style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                onClick={() => onSelect?.(entry)}
                onDoubleClick={() => (entry.isDir ? onEnterDir(entry) : onFileAction(entry))}
                onContextMenu={(event) => {
                  event.stopPropagation();
                  onContextMenu(event, entry);
                }}
                title={titleForEntry(entry)}
              >
                <span className="col-name">
                  <span className="file-icon">
                    <Icon name={entry.isDir ? "folder" : "file"} size={14} />
                  </span>
                  <span className="file-name">{entry.name}</span>
                </span>
                <span className="col-size">{entry.isDir ? "-" : fmtSize(entry.size)}</span>
                <span className="col-time">{fmtTime(entry.mtime)}</span>
                <span className="col-ops">
                  {label && (
                    <button
                      className="btn mini sftp-row-transfer"
                      onClick={(event) => {
                        event.stopPropagation();
                        onAction?.(event, entry);
                      }}
                      title={actionTitle?.(entry)}
                    >
                      {label}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
