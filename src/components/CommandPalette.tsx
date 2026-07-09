import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icons";
import type { IconName } from "./Icons";

export interface CommandPaletteItem {
  id: string;
  title: string;
  section: string;
  subtitle?: string;
  icon?: IconName;
  keywords?: string[];
  disabled?: boolean;
  onRun: () => void;
}

interface Props {
  open: boolean;
  items: CommandPaletteItem[];
  onClose: () => void;
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");

function itemHaystack(item: CommandPaletteItem) {
  return normalize([item.title, item.subtitle, item.section, ...(item.keywords ?? [])].filter(Boolean).join(" "));
}

export default function CommandPalette({ open, items, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return items;
    return items.filter((item) => {
      const haystack = itemHaystack(item);
      return tokens.every((token) => haystack.includes(normalize(token)));
    });
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const firstEnabled = filtered.findIndex((item) => !item.disabled);
    setSelectedIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [filtered]);

  if (!open) return null;

  const runItem = (item: CommandPaletteItem | undefined) => {
    if (!item || item.disabled) return;
    onClose();
    window.setTimeout(item.onRun, 0);
  };

  const moveSelection = (direction: 1 | -1) => {
    if (filtered.length === 0) return;
    for (let step = 1; step <= filtered.length; step += 1) {
      const next = (selectedIndex + direction * step + filtered.length) % filtered.length;
      if (!filtered[next].disabled) {
        setSelectedIndex(next);
        return;
      }
    }
  };

  let lastSection = "";

  return (
    <div className="command-palette-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="command-palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            moveSelection(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveSelection(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            runItem(filtered[selectedIndex]);
          }
        }}
      >
        <div className="command-search">
          <Icon name="command" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话、AI、设置、命令片段"
          />
        </div>

        <div className="command-list">
          {filtered.length === 0 ? (
            <div className="command-empty">没有匹配命令</div>
          ) : (
            filtered.map((item, index) => {
              const showSection = item.section !== lastSection;
              lastSection = item.section;
              return (
                <Fragment key={item.id}>
                  {showSection && <div className="command-section">{item.section}</div>}
                  <button
                    className={`command-item${index === selectedIndex ? " selected" : ""}`}
                    disabled={item.disabled}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => runItem(item)}
                  >
                    <span className="command-icon">{item.icon && <Icon name={item.icon} size={15} />}</span>
                    <span className="command-copy">
                      <span className="command-title">{item.title}</span>
                      {item.subtitle && <span className="command-subtitle">{item.subtitle}</span>}
                    </span>
                  </button>
                </Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
