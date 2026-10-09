/*
 * Markdown 块级结构分析（只读、纯函数、无副作用）。
 *
 * 为什么需要它：
 *  - mdExport 的块级解析是逐行正则状态机。碰到嵌套容器时边界会算错：
 *      · 「段落 + 下划线」的 Setext 标题会把下划线行吞进段落缓冲；
 *      · 缩进代码块（4 空格 / 制表符）被当普通段落；
 *      · 表格的行循环用「行里含 |」判定，会把后面的列表行 / 引用行吞成表格行；
 *      · 列表按「只要还是 list 行」贪心收集，混合类型（- / 1.）被并进同一个 <ul>，
 *        跨空行的宽松列表被切成两个列表。
 *  - 即时预览（livePreview）一个顶层块整体替换成 widget，块边界必须与
 *    CodeMirror / CommonMark 完全一致，否则渲染 DOM 会和源码错位。
 *
 * 做法：直接用**已经安装并已在源码中使用**的 @lezer/markdown 解析（编辑器语法高亮
 * 本来就用它，没有新依赖、不下载、不联网），拿到：
 *  - topBlocks：顶层块的名字 + 精确范围 + 「当前渲染器能否忠实还原」的判定；
 *  - codeRanges：围栏代码 / 缩进代码 / 注释块 / 行内代码区间（用于屏蔽伪语法）。
 *
 * 保守原则：只要块内出现「正则渲染器说不清」的嵌套结构（引用套引用、引用套列表、
 * 列表项套引用/表格/标题、表格里塞非表格行…），一律标记 fallback，
 * 由调用方**完整保留 / 整块转义回退源码**，绝不用正则去猜结构，
 * 也绝不把渲染结果写回源码。也就是：宁可少渲染，不可渲染错。
 */
import { GFM, parser } from "@lezer/markdown";

/** 与编辑器一致的 Markdown 方言（@codemirror/lang-markdown 默认 base + GFM）。 */
export const markdownParser = parser.configure([GFM]);

export type MarkdownTree = ReturnType<typeof markdownParser.parse>;
export type MarkdownNode = MarkdownTree["topNode"];

/** 解析纯文本为 Lezer 语法树（偏移是相对这段文本的绝对偏移）。 */
export function parseMarkdown(text: string): MarkdownTree {
  return markdownParser.parse(text);
}

/** 节点的直接子节点（用 cursor 遍历，对 CM 的未缓冲树同样有效）。 */
export function childNodes(node: MarkdownNode): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      out.push(cursor.node);
    } while (cursor.nextSibling());
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 一、顶层块 + 复杂块判定
 * ------------------------------------------------------------------ */

export interface TopBlock {
  /** 语法树节点名：Paragraph / SetextHeading1 / FencedCode / BulletList / Table … */
  name: string;
  from: number;
  to: number;
  /** true = 当前渲染器无法忠实还原：编辑器保留源码，导出整块转义回退 */
  fallback: boolean;
  /** 降级原因（中文，可直接展示给用户） */
  hint?: string;
  node: MarkdownNode;
}

/** 列表项里允许出现的直接子节点（其余一律视为「说不清的复杂结构」）。 */
const LIST_ITEM_ALLOWED = new Set([
  "ListMark",
  "Paragraph",
  "Task",
  "TaskMarker",
  "BulletList",
  "OrderedList",
  "FencedCode",
  "CodeBlock",
  // 列表项里的标题（`- # 标题`）能精确还原，不算复杂结构
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
]);

/** 引用块里只有「段落 + 引用标记」时才算简单引用。 */
const QUOTE_ALLOWED = new Set(["QuoteMark", "Paragraph"]);

/** 节点名的中文说明（只用于提示文案）。 */
const NODE_LABELS: Record<string, string> = {
  Blockquote: "嵌套引用",
  Table: "表格",
  BulletList: "列表",
  OrderedList: "有序列表",
  ListItem: "列表项",
  FencedCode: "围栏代码块",
  CodeBlock: "缩进代码块",
  HorizontalRule: "分割线",
  HTMLBlock: "HTML 块",
  CommentBlock: "注释块",
  SetextHeading1: "标题",
  SetextHeading2: "标题",
};

function labelOf(name: string): string {
  if (NODE_LABELS[name]) return NODE_LABELS[name];
  if (/^ATXHeading/.test(name)) return "标题";
  return name;
}

function quoteComplexity(node: MarkdownNode): string | null {
  for (const child of childNodes(node)) {
    if (!QUOTE_ALLOWED.has(child.name)) {
      return `引用块内嵌套了${labelOf(child.name)}`;
    }
  }
  return null;
}

function listComplexity(node: MarkdownNode): string | null {
  for (const child of childNodes(node)) {
    if (child.name !== "ListItem") continue;
    for (const inner of childNodes(child)) {
      if (!LIST_ITEM_ALLOWED.has(inner.name)) return `列表项内嵌了${labelOf(inner.name)}`;
      // 嵌套的子列表同样逐层校验
      if (inner.name === "BulletList" || inner.name === "OrderedList") {
        const nested = listComplexity(inner);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * 判断一个（顶层）块节点当前渲染器能否忠实还原。
 * 只做「结构性」判断，判不准的结构一律判为复杂 → 调用方回退源码。
 */
export function blockComplexity(node: MarkdownNode): { fallback: boolean; hint?: string } {
  let reason: string | null = null;
  switch (node.name) {
    case "Blockquote":
      reason = quoteComplexity(node);
      break;
    case "BulletList":
    case "OrderedList":
      reason = listComplexity(node);
      break;
    default:
      reason = null;
  }
  return reason ? { fallback: true, hint: `${reason}，为保证不丢源码已按原文保留` } : { fallback: false };
}

/**
 * 顶层块清单（按出现顺序，空白行不在任何块内）。
 * 传入的文本可以是整篇文档，也可以是即时预览切出来的单个顶层块。
 */
export function topBlocks(text: string): TopBlock[] {
  const tree = parseMarkdown(text);
  const out: TopBlock[] = [];
  for (const node of childNodes(tree.topNode)) {
    const { fallback, hint } = blockComplexity(node);
    out.push({ name: node.name, from: node.from, to: node.to, fallback, hint, node });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 二、代码区与真实任务框（供源码定位 / 屏蔽伪语法使用）
 * ------------------------------------------------------------------ */

/** 语法树里算「代码 / 不可解析区域」的节点：这些区域内的 [^x]、- [ ] 都不是语法。 */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "CommentBlock", "InlineCode"]);

/** 代码区间（围栏 / 缩进 / 注释块 / 行内代码），用于屏蔽代码区里的伪任务、伪脚注。 */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  parseMarkdown(text).iterate({
    enter(node) {
      if (CODE_NODES.has(node.name)) {
        ranges.push([node.from, node.to]);
        return false;
      }
      return undefined;
    },
  });
  return ranges;
}
