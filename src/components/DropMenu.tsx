import { useEffect, useRef, useState, type ReactNode } from "react";

export type DropMenuItem = {
  key: string;
  label: string;
  /** 悬停提示（快捷键说明等） */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  /** 当前选中项：显示粉色高亮与勾号 */
  active?: boolean;
};

export type DropMenuGroup = {
  /** 分组小标题，用于把相关动作收在一起 */
  title?: string;
  items: DropMenuItem[];
};

/**
 * 轻量下拉菜单：点击外部 / Escape / 窗口尺寸变化即收起。
 * 顶栏「更多」与右侧「工作台」选择器共用，保证两处交互与手感一致。
 * 不引入任何第三方依赖。
 */
export function DropMenu({
  trigger,
  title,
  groups,
  align = "right",
  className = "",
}: {
  trigger: ReactNode;
  title?: string;
  groups: DropMenuGroup[];
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // 菜单打开时 Escape 只负责收起菜单
      setOpen(false);
    };
    const onReflow = () => setOpen(false);
    // 捕获阶段监听，避免被内部 stopPropagation 的点击漏掉
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  return (
    <div className={"dmenu " + className} ref={rootRef}>
      <button
        type="button"
        className={"dmenu-trigger" + (open ? " open" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dmenu-trigger-label">{trigger}</span>
        <svg
          className="dmenu-caret"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 3.75L5 6.25L7.5 3.75" />
        </svg>
      </button>
      {open && (
        <div
          className={"dmenu-pop " + (align === "right" ? "align-right" : "align-left")}
          role="menu"
        >
          {groups.map((g, gi) => (
            <div className="dmenu-group" key={g.title ?? gi}>
              {g.title && <div className="dmenu-group-title">{g.title}</div>}
              {g.items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  className={"dmenu-item" + (it.active ? " on" : "")}
                  disabled={it.disabled}
                  title={it.hint}
                  onClick={() => {
                    if (it.disabled) return;
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  <span className="dmenu-item-label">{it.label}</span>
                  {it.active && (
                    <span className="dmenu-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
