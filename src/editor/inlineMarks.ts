/*
 * 行内标记的即时可见性：正在编辑的那一段也要能直接看出 ==高亮== / ^上标^ / ~下标~。
 *
 * 为什么需要它：即时预览是「块级渲染 + 当前块显示源码」，光标一进某一段，那段就切成源码，
 * 于是 `==重点==` 看上去就是四个等号；而 Markdown 的语法高亮（Lezer）只认标准 Markdown，
 * 不认这三个 Typora 扩展语法 —— 于是当前块完全没有视觉反馈，和加粗、列表这些标准标记
 * 的观感对不上。
 *
 * 做法：给**视口内的行**加一层纯装饰（只改观感，不改文档、不进撤销历史）：标记本身压暗、
 * 内容上样式。扫描规则与 lib/mdExport.ts 解析这三个语法的规则保持一致，保证「编辑时看到的」
 * 与「渲染/导出后得到的」覆盖同一段文本，不会出现只有一处认出来的情况。
 * 只扫视口：非当前块的行本来就被渲染成块了，扫了也看不见。
 */
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const MARK = Decoration.mark({ class: "cm-im-mark" });
const HL = Decoration.mark({ class: "cm-im-hl" });
const SUP = Decoration.mark({ class: "cm-im-sup" });
const SUB = Decoration.mark({ class: "cm-im-sub" });

interface Hit {
  from: number;
  to: number;
  deco: Decoration;
}

/**
 * 扫描一行里三种语法的位置。
 *
 * 手写扫描而不是套一个大正则：要跳过转义与行内代码，还要挡住脚注引用 `[^1]`
 * （它的 ^ 两侧是方括号，按成对规则会被当成一对上标），手写反而更短更准。
 */
function scanLine(text: string, base: number, out: Hit[]): void {
  const pair = (open: number, close: number, content: Decoration) => {
    if (close <= open + 1) return false;
    out.push({ from: base + open, to: base + open + 1, deco: MARK });
    out.push({ from: base + open + 1, to: base + close, deco: content });
    out.push({ from: base + close, to: base + close + 1, deco: MARK });
    return true;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2; // 转义：下一个字符不参与配对
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      i = end === -1 ? text.length : end + 1; // 行内代码整段跳过
      continue;
    }
    if (c === "=" && text[i + 1] === "=") {
      const close = text.indexOf("==", i + 2);
      if (close > i + 1 && pair(i, close, HL)) {
        i = close + 2;
        continue;
      }
    }
    // ^上标^：左边不能是 [（脚注引用），内容里不能出现 [ ] $ \
    if (c === "^" && text[i - 1] !== "[") {
      const close = text.indexOf("^", i + 1);
      const inner = close === -1 ? "" : text.slice(i + 1, close);
      if (close > i + 1 && !/[\[\]$\\]/.test(inner) && text[close + 1] !== "]" && pair(i, close, SUP)) {
        i = close + 1;
        continue;
      }
    }
    // ~下标~：单个 ~ 才是下标，~~ 是删除线（标准 Markdown，交给语法高亮）
    if (c === "~" && text[i + 1] !== "~") {
      const close = text.indexOf("~", i + 1);
      const inner = close === -1 ? "" : text.slice(i + 1, close);
      if (close > i + 1 && text[close + 1] !== "~" && !/[\[\]$\\]/.test(inner) && pair(i, close, SUB)) {
        i = close + 1;
        continue;
      }
    }
    i++;
  }
}

function build(view: EditorView): DecorationSet {
  const hits: Hit[] = [];
  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos);
      scanLine(line.text, line.from, hits);
      pos = line.to + 1;
    }
  }
  hits.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const h of hits) builder.add(h.from, h.to, h.deco);
  return builder.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  ".cm-im-mark": { color: "var(--fg-dim)" },
  ".cm-im-hl": { background: "var(--highlight-bg, rgba(172, 63, 112, .18))", borderRadius: "2px" },
  ".cm-im-sup": { fontSize: "0.76em", verticalAlign: "super", lineHeight: "0" },
  ".cm-im-sub": { fontSize: "0.76em", verticalAlign: "sub", lineHeight: "0" },
});

export const inlineMarks: Extension = [theme, plugin];
