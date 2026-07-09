import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** 传 "-" 作为分隔线 */
  onClick?: () => void;
}

export const SEPARATOR: MenuItem = { label: "-" };

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface ContextMenuApi {
  showMenu: (e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => void;
}

const Ctx = createContext<ContextMenuApi>({ showMenu: () => {} });

export function useContextMenu() {
  return useContext(Ctx);
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  // 屏蔽 WebView 默认右键菜单（输入框除外，保留原生复制粘贴）
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest("input, textarea")) e.preventDefault();
    };
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  const showMenu = useCallback(
    (e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => {
      e.preventDefault();
      // 防止菜单溢出窗口
      const w = 180;
      const h = items.length * 30 + 12;
      const x = Math.min(e.clientX, window.innerWidth - w - 8);
      const y = Math.min(e.clientY, window.innerHeight - h - 8);
      setMenu({ x, y, items });
    },
    []
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, { capture: true, once: false });
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, { capture: true });
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  return (
    <Ctx.Provider value={{ showMenu }}>
      {children}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((item, i) =>
            item.label === "-" ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                className={`menu-item ${item.danger ? "danger" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  setMenu(null);
                  item.onClick?.();
                }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}
