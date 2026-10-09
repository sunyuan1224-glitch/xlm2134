/*
 * Typora 式顶部菜单栏。
 *
 * Typora 的菜单是 文件 / 编辑 / 段落 / 格式 / 视图 / 主题 / 帮助 这一组，
 * 这里沿用同样的分组与条目命名（中文），把 MyNovel 已有的小说功能收进
 * 「文件」和「视图」，不为每个小说面板单独开一个顶级菜单。
 *
 * 交互细节对齐 Typora：鼠标悬停在另一个顶级菜单上会直接切换（不需要再点一次），
 * 点击菜单外部或按 Esc 关闭，快捷键提示右对齐显示。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | "separator"
  | { title: string }
  | {
      label: string;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      onClick?: () => void;
    };

export interface MenuDef {
  label: string;
  items: MenuEntry[];
}

export function isSeparator(e: MenuEntry): e is "separator" {
  return e === "separator";
}

export function isTitle(e: MenuEntry): e is { title: string } {
  return typeof e === "object" && e !== null && "title" in e;
}

interface Props {
  menus: MenuDef[];
  right?: React.ReactNode;
}

type PopFrame = { x: number; w: number; h: number };

function menuSig(menu: MenuDef | undefined): string {
  if (!menu) return "";
  return menu.items
    .map((item, i) => {
      if (isSeparator(item)) return `s${i}`;
      if (isTitle(item)) return `t${item.title}`;
      return `${item.label}:${item.disabled ? 1 : 0}:${item.checked ? 1 : 0}`;
    })
    .join("|");
}

export function MenuBar({ menus, right }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  // 第一次展开才淡入；已经开着时在菜单之间移动，面板保持挂载，只改位置和尺寸。
  const [moving, setMoving] = useState(false);
  const [frame, setFrame] = useState<PopFrame | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<number | null>(null);
  const placedRef = useRef<number | null>(null);
  const moveGen = useRef(0);
  const sig = menuSig(open === null ? undefined : menus[open]);

  function closeMenu() {
    openRef.current = null;
    setOpen(null);
  }

  useEffect(() => {
    if (open === null) return;
    const onDoc = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function measure(index: number): PopFrame | null {
    const bar = barRef.current;
    const pop = popRef.current;
    const inner = innerRef.current;
    const btn = bar?.querySelectorAll<HTMLButtonElement>(".menu-root")[index];
    if (!bar || !pop || !inner || !btn) return null;

    // 外层可能还停在上一个菜单的宽高上。先去掉过渡再放开尺寸，否则会量到正在插值的旧高度。
    const prev = {
      width: pop.style.width,
      height: pop.style.height,
      transition: pop.style.transition,
    };
    pop.style.transition = "none";
    pop.style.width = "max-content";
    pop.style.height = "max-content";
    const w = inner.offsetWidth;
    const h = inner.offsetHeight;
    pop.style.width = prev.width;
    pop.style.height = prev.height;
    pop.style.transition = prev.transition;

    const barRect = bar.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    let x = btnRect.left - barRect.left - bar.clientLeft;
    const limit = bar.clientWidth - w - 4;
    if (x > limit) x = Math.max(4, limit);
    return { x: Math.round(x), w, h };
  }

  function putFrame(next: PopFrame) {
    setFrame((cur) => (cur && cur.x === next.x && cur.w === next.w && cur.h === next.h ? cur : next));
  }

  useLayoutEffect(() => {
    if (open === null) {
      moveGen.current += 1;
      placedRef.current = null;
      setMoving(false);
      setFrame(null);
      return;
    }
    const next = measure(open);
    if (!next) return;

    const placed = placedRef.current;
    placedRef.current = open;
    moveGen.current += 1;
    const gen = moveGen.current;

    // 刚点开，或还是同一个菜单（勾选状态变了）：直接改尺寸，不滑动。
    if (placed === null || placed === open) {
      putFrame(next);
      return;
    }
    // 已经在菜单之间滑了：马上改目标。光标连着划过时，后一次覆盖前一次。
    if (moving) {
      putFrame(next);
      return;
    }
    // 第一次离开刚打开的那个标签：先挂上过渡，等这一帧画出来，再改位置。
    // 同一帧里又改位置的话，浏览器不会启动过渡。
    setMoving(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (moveGen.current !== gen || openRef.current === null) return;
        const measured = measure(openRef.current);
        if (measured) putFrame(measured);
      });
    });
    // moving 只参与本次判断。写进依赖会在挂上过渡时再跑一遍，把滑动掐断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sig]);

  const current = open === null ? null : menus[open];

  return (
    <div className="menubar" ref={barRef}>
      <div className="menubar-left">
        {menus.map((m, i) => (
          <div className="menu-root-wrap" key={m.label}>
            <button
              className={"menu-root " + (open === i ? "open" : "")}
              onClick={() => {
                if (openRef.current === i) closeMenu();
                else {
                  openRef.current = i;
                  setOpen(i);
                }
              }}
              onMouseEnter={() => {
                if (openRef.current === null || openRef.current === i) return;
                openRef.current = i;
                setOpen(i);
              }}
            >
              {m.label}
            </button>
          </div>
        ))}
      </div>
      <div className="menubar-right">{right}</div>
      {current && (
        <div
          ref={popRef}
          className={"menu-pop" + (moving ? " moving" : " opening")}
          style={
            frame
              ? {
                  width: frame.w,
                  height: frame.h,
                  transform: `translate3d(${frame.x}px, 0, 0)`,
                }
              : { visibility: "hidden" }
          }
        >
          <div className="menu-pop-clip">
            <div className="menu-pop-inner" ref={innerRef}>
              {current.items.map((item, k) => {
                if (isSeparator(item)) return <div className="menu-sep" key={"sep" + k} />;
                if (isTitle(item)) return <div className="menu-group" key={item.title + k}>{item.title}</div>;
                return (
                  <button
                    key={item.label + k}
                    className={"menu-item " + (item.disabled ? "disabled" : "") + (item.checked ? " on" : "")}
                    disabled={item.disabled}
                    onClick={() => {
                      closeMenu();
                      item.onClick?.();
                    }}
                  >
                    <span className="menu-check">{item.checked ? "✓" : ""}</span>
                    <span className="menu-label">{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MenuBar;
