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
        /** 点完不关菜单：给「放大/缩小字号」这类要连点的项用 */
        keepOpen?: boolean;
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
  const [frame, setFrame] = useState<PopFrame | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<number | null>(null);
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

    // 外层可能还停在上一个菜单的宽高上：先临时放开尺寸，量到内容真实大小再还原。
    const prev = { width: pop.style.width, height: pop.style.height };
    pop.style.width = "max-content";
    pop.style.height = "max-content";
    const w = inner.offsetWidth;
    const h = inner.offsetHeight;
    pop.style.width = prev.width;
    pop.style.height = prev.height;

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

  /*
   * 菜单开合与「在菜单之间切换」都只做一件事：量一次、把位置和尺寸写下去。
   *
   * 这里原先有一套 requestAnimationFrame 双帧 + 过渡状态机，专门为了让面板在菜单
   * 之间"滑过去"。代价是：光标扫过菜单栏时动画刚起步就被下一次切换打断，看起来卡；
   * 而且每帧都要重新合成一次带阴影的面板。现在改成瞬时跳转，一套状态机、一个 ref
   * 生成号、一次 rAF 全都不需要了。
   */
  useLayoutEffect(() => {
    if (open === null) {
      setFrame(null);
      return;
    }
    const next = measure(open);
    if (!next) return;
    putFrame(next);
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
          className="menu-pop"
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
                      if (!item.keepOpen) closeMenu();
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
