import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: (ContextMenuItem | "separator")[];
  onClose: () => void;
  minWidth?: number;
}

export function ContextMenu({ x, y, items, onClose, minWidth = 160 }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  // 视口边缘钳制：测量渲染后的菜单尺寸，防止在右侧/底部溢出屏幕
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let nextX = x;
    let nextY = y;
    if (nextX + rect.width > window.innerWidth - pad) {
      nextX = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (nextY + rect.height > window.innerHeight - pad) {
      nextY = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    setPos({ top: nextY, left: nextX });
  }, [x, y]);

  // 键盘与外部点击事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const actionable = items
        .map((it, idx) => ({ it, idx }))
        .filter((entry) => entry.it !== "separator" && !entry.it.disabled);
      if (actionable.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const curActionableIdx = actionable.findIndex((a) => a.idx === prev);
          const nextActionable = actionable[(curActionableIdx + 1) % actionable.length];
          return nextActionable ? nextActionable.idx : actionable[0].idx;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          const curActionableIdx = actionable.findIndex((a) => a.idx === prev);
          const nextActionable =
            actionable[(curActionableIdx - 1 + actionable.length) % actionable.length];
          return nextActionable ? nextActionable.idx : actionable[actionable.length - 1].idx;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[focusedIndex];
        if (item && item !== "separator" && !item.disabled) {
          item.onClick();
          onClose();
        }
      }
    };

    // WebKitGTK / WebKitWebDriver 下真实点击常只产生 mousedown，
    // 双监听 pointerdown + mousedown 确保任意输入设备与驱动均能可靠关闭菜单
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleScroll = () => onClose();

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handleOutsideClick, true);
    window.addEventListener("mousedown", handleOutsideClick, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handleOutsideClick, true);
      window.removeEventListener("mousedown", handleOutsideClick, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [items, onClose, focusedIndex]);

  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        minWidth,
        zIndex: 1000,
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
        if (item === "separator") {
          return (
            <div
              key={`sep-${i}`}
              style={{
                height: "1px",
                margin: "4px 0",
                backgroundColor: "var(--border, #45475a)",
                opacity: 0.7,
              }}
            />
          );
        }
        const isFocused = focusedIndex === i;
        return (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            style={{
              color: item.danger ? "var(--danger, #f38ba8)" : undefined,
              backgroundColor: isFocused ? "var(--bg-active, #45475a)" : undefined,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
            onMouseEnter={() => setFocusedIndex(i)}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
          >
            {item.icon && <span style={{ opacity: 0.85, width: 14 }}>{item.icon}</span>}
            <span style={{ flex: 1 }}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
