import * as api from "../api";
import Icon from "./Icons";
import type { TransferItem } from "../types";

interface Props {
  height: number;
  items: TransferItem[];
  onClear: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function eta(item: TransferItem): string {
  if (item.rateBps <= 0 || item.totalBytes <= item.transferred) return "";
  const s = Math.round((item.totalBytes - item.transferred) / item.rateBps);
  if (s < 60) return `剩余 ${s}s`;
  if (s < 3600) return `剩余 ${Math.floor(s / 60)}m${s % 60}s`;
  return `剩余 ${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

const STATUS_TEXT: Record<TransferItem["status"], string> = {
  running: "传输中",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};

export default function TransferPanel({ height, items, onClear }: Props) {
  if (items.length === 0) return null;
  const running = items.filter((i) => i.status === "running").length;

  return (
    <div className="transfer-panel" style={{ height, maxHeight: height }}>
      <div className="transfer-header">
        <span>
          文件传输{running > 0 ? `（${running} 进行中）` : ""}
        </span>
        <button className="btn mini" onClick={onClear} disabled={running > 0}>
          清空记录
        </button>
      </div>
      <div className="transfer-list">
        {items.map((t) => {
          // totalBytes 为 0 表示目录传输、总量未知，显示脉冲态而非假百分比
          const known = t.totalBytes > 0;
          const pct = known ? Math.min(100, (t.transferred / t.totalBytes) * 100) : 0;
          const indeterminate = t.status === "running" && !known;
          const barWidth = known ? `${pct}%` : t.status === "done" ? "100%" : "100%";
          return (
            <div key={t.id} className={`transfer-item ${t.status}`}>
              <div className="transfer-row1">
                <span className="transfer-kind">
                  <Icon name={t.kind === "upload" ? "arrowUp" : "arrowDown"} size={14} />
                </span>
                <span className="transfer-title" title={t.currentFile}>
                  {t.title}
                  {t.status === "done" && t.doneFiles > 1 && `（${t.doneFiles} 个文件）`}
                </span>
                <span className={`transfer-status ${t.status}`}>
                  {STATUS_TEXT[t.status]}
                </span>
                {t.status === "running" && t.backendId && (
                  <button
                    className="icon-btn danger"
                    title="取消"
                    onClick={() => api.transferCancel(t.backendId!)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
              <div className="transfer-bar">
                <div
                  className={`transfer-bar-fill ${indeterminate ? "pulse" : ""}`}
                  style={{ width: barWidth }}
                />
              </div>
              <div className="transfer-row2">
                <span>
                  {known
                    ? `${fmtBytes(t.transferred)} / ${fmtBytes(t.totalBytes)}（${pct.toFixed(1)}%）`
                    : `已传 ${fmtBytes(t.transferred)}${t.currentFile ? ` · ${t.currentFile}` : ""}`}
                </span>
                {t.status === "running" && (
                  <span>
                    {t.rateBps > 0 && `${fmtBytes(t.rateBps)}/s `}
                    {known && eta(t)}
                  </span>
                )}
                {t.message && <span className="transfer-msg">{t.message}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
