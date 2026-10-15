/*
 * 编辑器主题与语法高亮。
 *
 * 所有即时预览用到的元素都走这里的 CodeMirror theme（而不是全局 CSS 文件），
 * 颜色一律用 src/styles.css 里的 CSS 变量，保证跟随暖白柔粉轻盈主题。
 *
 * 语法高亮刻意使用**显式 class 名**（cm-tk-*）而不是自动生成的随机 class：
 * 这样围栏代码块的 widget 可以直接用 highlightTree 得到同一套配色，
 * 预览里的代码配色与源码模式完全一致。
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, type TagStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const baseTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      fontSize: "var(--editor-font-size, 16px)",
      backgroundColor: "var(--bg-editor)",
      color: "var(--fg)",
    },
    ".cm-scroller": {
      fontFamily: "var(--editor-font-family, 'Noto Serif CJK SC', serif)",
      lineHeight: "var(--editor-line-height, 1.9)",
      padding: "40px 0 45vh",
      overflowY: "auto",
    },
    ".cm-content": {
      maxWidth: "var(--editor-measure, 42em)",
      margin: "0 auto",
      padding: "0 24px",
      caretColor: "var(--accent)",
    },
    ".cm-line": { padding: "0 2px" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--sel-bg) !important",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-gutters": { display: "none" },
    ".cm-placeholder": { color: "var(--fg-dim)" },

    /* 查找/替换面板：跟随配色，别用 CodeMirror 默认的亮色 */
    ".cm-panels": {
      backgroundColor: "var(--bg-panel)",
      color: "var(--fg)",
      borderTop: "1px solid var(--border)",
    },
    ".cm-panel.cm-search": { padding: "6px 10px", fontSize: "0.86em" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
      fontSize: "inherit",
    },
    ".cm-panel.cm-search input": {
      background: "var(--bg-code)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-panel.cm-search button": {
      background: "var(--bg-hover)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "2px 8px",
      cursor: "pointer",
    },
    ".cm-panel.cm-search button[name=close]": {
      background: "transparent",
      border: "none",
      color: "var(--fg-dim)",
      fontSize: "1.1em",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(150, 96, 28, 0.22)",
      outline: "1px solid rgba(150, 96, 28, 0.5)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(172, 63, 112, 0.3)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(172, 63, 112, 0.14)" },
    ".cm-tooltip": {
      background: "var(--bg-panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "8px",
    },

    /* ---------------- 源码模式 ---------------- */
    "&.cm-source-mode .cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontSize: "calc(var(--editor-font-size, 16px) * 0.94)",
      lineHeight: "1.75",
    },
    "&.cm-source-mode .cm-content": {
      whiteSpace: "pre-wrap",
      maxWidth: "var(--editor-measure, 42em)",
    },
    "&.cm-source-mode .cm-activeLine": {
      backgroundColor: "rgba(172, 63, 112, 0.05)",
      borderRadius: "4px",
    },

    /* 专注模式的「非当前块变淡」由 typora.css 负责（那条规则带 :not(.cm-activeLine)，
       选择器更具体，无论谁先注入都以它为准）。这里以前还留了一份 0.32 的旧值 +
       cm-lp-focus / cm-widgetBuffer 三条规则，那两个类源码里根本不生成，已删。 */

    /* ---------------- 隐藏行（整块渲染时被折叠掉的源码行） ---------------- */
    ".cm-line.cm-lp-gone": { display: "none" },

    /* ---------------- 图片 ---------------- */
    /* 未联网加载的外部图片：只显示占位标签，绝不请求网络 */
    ".cm-lp-img-external": {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.4em",
      maxWidth: "100%",
      border: "1px dashed var(--border)",
      borderRadius: "var(--r-sm, 8px)",
      padding: "0.45em 0.7em",
      color: "var(--fg-dim)",
      background: "var(--bg-panel)",
      fontSize: "0.85em",
      wordBreak: "break-all",
    },

    ".cm-lp-img": {
      maxWidth: "100%",
      borderRadius: "var(--r-sm, 8px)",
      border: "1px solid var(--border)",
      display: "block",
    },
    ".cm-lp-img-missing": {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.4em",
      border: "1px dashed var(--border)",
      borderRadius: "var(--r-sm, 8px)",
      padding: "0.5em 0.8em",
      color: "var(--fg-dim)",
      fontSize: "0.86em",
      background: "var(--bg-panel)",
    },
    ".cm-lp-img-loading": { opacity: "0.55" },
    /* ==高亮== ^上标^ ~下标~ 渲染后的样子（HTML 是 markdownToHtml 生成的，这里只补样式） */
    ".cm-lp-rendered mark": {
      background: "var(--highlight-bg, rgba(172, 63, 112, .18))",
      color: "inherit",
      borderRadius: "2px",
    },
    ".cm-lp-rendered sup, .cm-lp-rendered sub": { fontSize: "0.76em", lineHeight: "0" },

    /* ---------------- 标记着色（Markdown 语法高亮） ---------------- */
    ".cm-tk-h1": { color: "var(--fg-strong)", fontWeight: "700", fontSize: "1.5em" },
    ".cm-tk-h2": { color: "var(--fg-strong)", fontWeight: "700", fontSize: "1.32em" },
    ".cm-tk-h3": { color: "var(--fg-strong)", fontWeight: "600", fontSize: "1.16em" },
    ".cm-tk-h4": { color: "var(--fg-strong)", fontWeight: "600", fontSize: "1.08em" },
    ".cm-tk-h5": { color: "var(--fg-strong)", fontWeight: "600", fontSize: "1.04em" },
    ".cm-tk-h6": { color: "var(--fg-dim)", fontWeight: "600", fontSize: "1em" },
    /* 源码模式：标题不放大 */
    ".cm-tk-hplain": { color: "var(--fg-strong)", fontWeight: "600" },
    ".cm-tk-strong": { color: "var(--fg-strong)", fontWeight: "700" },
    ".cm-tk-em": { fontStyle: "italic" },
    ".cm-tk-strike": { textDecoration: "line-through", opacity: "0.7" },
    ".cm-tk-link": { color: "var(--accent)" },
    ".cm-tk-url": { color: "var(--accent-dim)" },
    ".cm-tk-mono": {
      fontFamily: "var(--font-mono)",
      background: "var(--bg-code)",
      color: "var(--code-fg)",
    },
    ".cm-tk-quote": { color: "var(--fg-dim)", fontStyle: "italic" },
    ".cm-tk-list": { color: "var(--fg-dim)" },
    ".cm-tk-comment": { color: "var(--fg-dim)", fontStyle: "italic" },
    ".cm-tk-meta": { color: "var(--fg-dim)" },
    ".cm-tk-punct": { color: "var(--fg-dim)" },
    ".cm-tk-sep": { color: "var(--fg-dim)" },
  },
  { dark: false },
);

/**
 * 语法高亮规则；源码模式与预览模式只在「标题是否放大」上不同。
 * 注意：TagStyle 一旦给了 class，其内联样式不会再生成 CSS（CodeMirror 的行为），
 * 所以标题的六种字号必须落在各自的 class 上，由上面的 theme 定义。
 */
function tokenSpecs(scaleHeadings: boolean): TagStyle[] {
  const h = (level: 1 | 2 | 3 | 4 | 5 | 6): string =>
    scaleHeadings ? `cm-tk-h${level}` : "cm-tk-hplain";
  return [
    { tag: t.heading1, class: h(1) },
    { tag: t.heading2, class: h(2) },
    { tag: t.heading3, class: h(3) },
    { tag: t.heading4, class: h(4) },
    { tag: t.heading5, class: h(5) },
    { tag: t.heading6, class: h(6) },
    { tag: t.strong, class: "cm-tk-strong" },
    { tag: t.emphasis, class: "cm-tk-em" },
    { tag: t.strikethrough, class: "cm-tk-strike" },
    { tag: t.link, class: "cm-tk-link" },
    { tag: t.url, class: "cm-tk-url" },
    { tag: t.monospace, class: "cm-tk-mono" },
    { tag: t.quote, class: "cm-tk-quote" },
    { tag: t.list, class: "cm-tk-list" },
    { tag: t.comment, class: "cm-tk-comment" },
    { tag: t.lineComment, class: "cm-tk-comment" },
    { tag: t.blockComment, class: "cm-tk-comment" },
    { tag: t.meta, class: "cm-tk-meta" },
    { tag: t.processingInstruction, class: "cm-tk-meta" },
    { tag: t.contentSeparator, class: "cm-tk-sep" },
    { tag: t.punctuation, class: "cm-tk-punct" },
    { tag: t.separator, class: "cm-tk-punct" },
    { tag: t.labelName, class: "cm-tk-meta" },
  ];
}

/** 预览模式的语法高亮（标题按级别放大） */
export const highlightStyle = HighlightStyle.define(tokenSpecs(true));

/** 源码模式的语法高亮：等宽、标题不放大 */
export const sourceHighlightStyle = HighlightStyle.define(tokenSpecs(false));

