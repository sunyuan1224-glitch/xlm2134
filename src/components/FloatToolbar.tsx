/*
 * 浮动格式工具栏（对应 Typora 1.14 的 Floating Editor Toolbar）。
 * 选中文字后浮现在选区上方，提供加粗/斜体/删除线/链接等小说写作常用格式。
 * 可以在「视图 → 浮动工具栏」里关掉。
 */
import type { EditorView } from "@codemirror/view";
import type { FormatCmd } from "../lib/format";

interface Props {
  view: EditorView | null;
  sel: { from: number; to: number } | null;
  enabled: boolean;
  onCommand: (cmd: FormatCmd) => void;
  onLink: () => void;
  onImage: () => void;
}

const BUTTONS: { key: string; label: string; title: string; cmd: FormatCmd }[] = [
  { key: "bold", label: "B", title: "加粗 (Ctrl+B)", cmd: { k: "inline", style: "bold" } },
  { key: "italic", label: "I", title: "斜体 (Ctrl+I)", cmd: { k: "inline", style: "italic" } },
  { key: "strike", label: "S", title: "删除线 (Alt+Shift+5)", cmd: { k: "inline", style: "strike" } },
];

export function FloatToolbar({ view, sel, enabled, onCommand, onLink, onImage }: Props) {
  if (!enabled || !view || !sel || sel.to <= sel.from) return null;
  let coords: { left: number; top: number; right: number; bottom: number } | null = null;
  try {
    const start = view.coordsAtPos(sel.from);
    const end = view.coordsAtPos(sel.to);
    if (start && end) {
      coords = {
        left: Math.min(start.left, end.left),
        top: Math.min(start.top, end.top),
        right: Math.max(start.right, end.right),
        bottom: Math.max(start.bottom, end.bottom),
      };
    }
  } catch {
    coords = null;
  }
  if (!coords) return null;

  const host = view.dom.getBoundingClientRect();
  const centerX = (coords.left + coords.right) / 2;
  const left = Math.max(host.left + 8, Math.min(host.right - 8, centerX));
  const top = coords.top - 8;

  return (
    <div
      className="float-toolbar"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault() /* 保住编辑器选区 */}
    >
      {BUTTONS.map((b) => (
        <span key={b.key}>
          <button
            type="button"
            className={"ft-btn ft-" + b.key}
            title={b.title}
            onClick={() => onCommand(b.cmd)}
          >
            {b.label}
          </button>
        </span>
      ))}
      <span className="ft-sep" />
      <button type="button" className="ft-btn" title="超链接 (Ctrl+K)" onClick={onLink}>
        🔗
      </button>
      <button type="button" className="ft-btn" title="插入图片 (Ctrl+Shift+I)" onClick={onImage}>
        🖼
      </button>
    </div>
  );
}

export default FloatToolbar;
