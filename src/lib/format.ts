/*
 * Markdown 格式化命令。
 *
 * 两条出口：
 *  - applyFormatToText(text, from, to, cmd)：纯字符串变换，便于单测，也便于在没有
 *    EditorView 的场景（例如批量整理）里复用；
 *  - runFormat(view, cmd)：把变换结果 dispatch 回 CodeMirror，并把选区放到合理位置。
 *
 * 所有命令的共同约束：**不损坏 Markdown 原文**。特别是同一命令执行两次要回到
 * 原状（例如对已加粗文本再加粗 = 取消加粗），行级命令不得留下多余空行。
 */
import type { EditorView } from "@codemirror/view";

export type FormatCmd =
  | { k: "inline"; style: "bold" | "italic" | "underline" | "strike" | "highlight" | "sup" | "sub" }
  | { k: "quote" }
  | { k: "list"; kind: "ul" | "ol" }
  | { k: "heading"; level: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
  | { k: "hr" }
  | { k: "link" }
  | { k: "image" }
  | { k: "paraMove"; dir: -1 | 1 }
  | { k: "paraDelete" }
  | { k: "paraDuplicate" }
  | { k: "clearFormat" }
  | { k: "insertText"; text: string };

export interface FormatResult {
  text: string;
  /** 变换后该放光标/选区的区间（相对整篇文本） */
  from: number;
  to: number;
}

const INLINE_MARK: Record<
  Extract<FormatCmd, { k: "inline" }>["style"],
  { open: string; close: string }
> = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  underline: { open: "<u>", close: "</u>" },
  strike: { open: "~~", close: "~~" },
  highlight: { open: "==", close: "==" },
  sup: { open: "^", close: "^" },
  sub: { open: "~", close: "~" },
};

const HEADING_RE = /^(#{1,6})\s+/;
const UL_RE = /^\s*[-*+]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;
const TASK_RE = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const QUOTE_RE = /^\s*>\s?/;

function lineBoundsAt(text: string, pos: number): { from: number; to: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  const from = text.lastIndexOf("\n", Math.max(0, p - 1)) + 1;
  let to = text.indexOf("\n", p);
  if (to === -1) to = text.length;
  return { from, to };
}

function blockBoundsAt(text: string, pos: number): { from: number; to: number } {
  // 段落边界 = 空行；首尾也视作边界
  const first = lineBoundsAt(text, pos);
  let from = first.from;
  let to = first.to;
  while (from > 0) {
    // 往上找「上一行的内容」要用 from - 1：from 是行首，from - 1 才是上一行的最后一个
    // 字符（空行就是它自己那个换行符）。以前写成 from - 2 会跳到上上行，于是
    // 「标题 + 空行 + 正文」这样的文档里，正文所在段落会连标题一起吞掉。
    const prev = lineBoundsAt(text, from - 1);
    if (text.slice(prev.from, prev.to).trim() === "") break;
    from = prev.from;
  }
  while (to < text.length) {
    const next = lineBoundsAt(text, to + 1);
    if (text.slice(next.from, next.to).trim() === "") break;
    to = next.to;
  }
  return { from, to };
}

function mapLines(text: string, from: number, to: number, fn: (line: string) => string): string {
  const seg = text.slice(from, to);
  return text.slice(0, from) + seg.split("\n").map(fn).join("\n") + text.slice(to);
}

/**
 * 行首的块级标记。设标题前先摘掉这些，避免出现 `# - 内容` 这种混血行。
 * 任务框要排在无序列表前面：`- [ ] x` 得先被 TASK_RE 整条吃掉，
 * 否则 UL_RE 只摘掉 `- `，会剩一个孤零零的 `[ ]`。
 */
const BLOCK_PREFIX_RES = [HEADING_RE, TASK_RE, QUOTE_RE, UL_RE, OL_RE];

function stripBlockPrefix(line: string): string {
  let l = line;
  for (const re of BLOCK_PREFIX_RES) l = l.replace(re, "");
  return l;
}

/**
 * 设置标题级别（level 0 = 普通段落）。手感对齐 Typora：
 *  - 光标在正文里 → 作用于整个段落（连续的若干非空行）；
 *  - 有选区 → 作用于选区覆盖到的所有行；
 *  - **同一级别再按一次 = 取消标题**（所以 Ctrl+1 兼作开关），Ctrl+0 是显式取消。
 */
function setHeading(text: string, sel: { from: number; to: number }, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): FormatResult {
  const b =
    sel.to > sel.from
      ? { from: lineBoundsAt(text, sel.from).from, to: lineBoundsAt(text, sel.to).to }
      : blockBoundsAt(text, sel.from);
  const lines = text.slice(b.from, b.to).split("\n");

  const levelOf = (l: string): number => {
    const m = l.match(HEADING_RE);
    return m ? m[1].length : 0;
  };
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  // 块内每行都已经是指定级别 → 再按一次变回正文
  const sameLevel = level > 0 && nonEmpty.length > 0 && nonEmpty.every((l) => levelOf(l) === level);
  const target = sameLevel ? 0 : level;

  // 逐行改行首，同时记下「这一行行首长度变了多少」，用于把光标平移到正确位置
  const shifts: { start: number; len: number; delta: number }[] = [];
  let cursor = b.from; // 当前行的绝对起点
  const out = lines.map((l) => {
    const start = cursor - b.from;
    cursor += l.length + 1; // +1 是换行符
    if (l.trim() === "") {
      shifts.push({ start, len: 0, delta: 0 });
      return l;
    }
    const bare = stripBlockPrefix(l);
    const used = l.length - bare.length;
    const prefix = target === 0 ? "" : "#".repeat(target) + " ";
    shifts.push({ start, len: bare.length, delta: prefix.length - used });
    return prefix + bare;
  });
  const body = out.join("\n");

  // 有选区 → 整块选中；只是光标 → 按行首变化量平移（并夹在块内）
  let from = b.from;
  let to = b.from + body.length;
  if (sel.to === sel.from) {
    const rel = sel.from - b.from;
    let acc = 0;
    for (const s of shifts) {
      acc += s.delta;
      if (rel <= s.start + s.len) break;
    }
    const moved = Math.max(b.from, Math.min(b.from + rel + acc, b.from + body.length));
    from = moved;
    to = moved;
  }
  return { text: text.slice(0, b.from) + body + text.slice(b.to), from, to };
}

/** 把选区（可能跨行）整体加/去行首标记；全部行都有标记时视为取消 */
function toggleLinePrefix(text: string, from: number, to: number, add: (line: string) => string, detect: RegExp): FormatResult {
  const b = to > from ? { from: lineBoundsAt(text, from).from, to: lineBoundsAt(text, to).to } : blockBoundsAt(text, from);
  const lines = text.slice(b.from, b.to).split("\n");
  const all = lines.every((l) => l.trim() === "" || detect.test(l));
  const next = lines.map((l) => {
    if (l.trim() === "") return l;
    if (all) return l.replace(detect, "");
    // 先去掉冲突的列表/标题标记，再套新的
    return add(l.replace(HEADING_RE, "").replace(UL_RE, "").replace(OL_RE, "").replace(TASK_RE, "").replace(QUOTE_RE, ""));
  });
  const body = next.join("\n");
  return { text: text.slice(0, b.from) + body + text.slice(b.to), from: b.from, to: b.from + body.length };
}

function wrapInline(text: string, from: number, to: number, open: string, close: string): FormatResult {
  const inner = text.slice(from, to);
  // 选区已经带着同样的标记 → 取消
  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
    return { text: text.slice(0, from) + inner.slice(open.length, inner.length - close.length) + text.slice(to), from, to: to - open.length - close.length };
  }
  // 标记在选区外侧（Typora 里光标停在加粗词里按 Ctrl+B 的常见情形）→ 一并摘掉
  const before = text.slice(Math.max(0, from - open.length), from);
  const after = text.slice(to, to + close.length);
  if (before === open && after === close) {
    return {
      text: text.slice(0, from - open.length) + inner + text.slice(to + close.length),
      from: from - open.length,
      to: to - open.length,
    };
  }
  const next = text.slice(0, from) + open + inner + close + text.slice(to);
  if (from === to) return { text: next, from: from + open.length, to: from + open.length };
  return { text: next, from: from + open.length, to: to + open.length };
}

function stripInline(line: string): string {
  return line
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[^~])~(?=\S)([^~\n]*?\S)~(?![~])/g, "$1$2")
    .replace(/==(.+?)==/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<\/?u>/g, "")
    .replace(/(^|[^\w])\^([^^]+)\^/g, "$1$2");
}

function shiftParagraph(text: string, pos: number, dir: -1 | 1): FormatResult {
  const b = blockBoundsAt(text, pos);
  if (dir === -1) {
    if (b.from === 0) return { text, from: b.from, to: b.to };
    // 上一段（含其后的空行）
    let pStart = b.from - 1;
    while (pStart > 0 && text[pStart - 1] !== "\n") pStart--;
    let pEnd = pStart;
    if (pStart > 0 && text[pStart - 1] === "\n" && text.slice(0, pStart - 1).endsWith("\n")) pStart--;
    else if (pStart > 0 && text[pStart - 1] === "\n") pStart--;
    while (pEnd < b.from && text[pEnd] !== "\n") pEnd++;
    const above = text.slice(pStart, pEnd);
    const rest = text.slice(b.from, b.to);
    const tail = text.slice(b.to);
    const gap = "\n\n";
    const next = text.slice(0, pStart) + rest + gap + above.replace(/^\n+/, "") + tail;
    return { text: next, from: pStart, to: pStart + rest.length };
  }
  // 下移：把当前段与后面一段互换
  const afterFrom = b.to + (text.slice(b.to, b.to + 2) === "\n\n" ? 2 : text[b.to] === "\n" ? 1 : 0);
  if (afterFrom >= text.length) return { text, from: b.from, to: b.to };
  const afterEnd = text.indexOf("\n\n", afterFrom) === -1 ? text.length : text.indexOf("\n\n", afterFrom);
  const below = text.slice(afterFrom, afterEnd);
  const next = text.slice(0, b.from) + below + "\n\n" + text.slice(b.from, b.to) + text.slice(afterEnd);
  return { text: next, from: b.from + below.length + 2, to: b.from + below.length + 2 + (b.to - b.from) };
}

/** 纯文本变换：给定文本与选区，返回变换后的文本与新区间 */
export function applyFormatToText(text: string, from: number, to: number, cmd: FormatCmd): FormatResult {
  const sel = { from: Math.max(0, Math.min(from, text.length)), to: Math.max(0, Math.min(to, text.length)) };
  switch (cmd.k) {
    case "inline": {
      const m = INLINE_MARK[cmd.style];
      return wrapInline(text, sel.from, sel.to, m.open, m.close);
    }
    case "quote":
      return toggleLinePrefix(text, sel.from, sel.to, (l) => "> " + l, QUOTE_RE);
    case "list":
      return toggleLinePrefix(
        text,
        sel.from,
        sel.to,
        cmd.kind === "ul" ? (l) => "- " + l : (() => { let i = 0; return (l: string) => `${++i}. ` + l; })(),
        cmd.kind === "ul" ? UL_RE : OL_RE,
      );
    case "heading":
      return setHeading(text, sel, cmd.level);
    case "hr": {
      const line = lineBoundsAt(text, sel.from);
      const insert = (line.from === 0 ? "" : "\n") + "---\n";
      const next = text.slice(0, line.to) + insert + text.slice(line.to);
      return { text: next, from: line.to + insert.length, to: line.to + insert.length };
    }
    case "link": {
      const inner = text.slice(sel.from, sel.to);
      const next = text.slice(0, sel.from) + `[${inner}](url)` + text.slice(sel.to);
      const urlFrom = sel.from + inner.length + 3;
      return { text: next, from: urlFrom, to: urlFrom + 3 };
    }
    case "image": {
      const inner = text.slice(sel.from, sel.to);
      const next = text.slice(0, sel.from) + `![${inner}](src)` + text.slice(sel.to);
      return { text: next, from: sel.from + inner.length + 3, to: sel.from + inner.length + 6 };
    }
    case "paraMove":
      return shiftParagraph(text, sel.from, cmd.dir);
    case "paraDelete": {
      const b = blockBoundsAt(text, sel.from);
      let to = b.to;
      if (text.slice(to, to + 2) === "\n\n") to += 2;
      else if (text[to] === "\n") to += 1;
      else if (b.from > 0 && text.slice(b.from - 2, b.from) === "\n\n") {
        return { text: text.slice(0, b.from - 2) + text.slice(b.to), from: Math.max(0, b.from - 2), to: Math.max(0, b.from - 2) };
      }
      return { text: text.slice(0, b.from) + text.slice(to), from: b.from, to: b.from };
    }
    case "paraDuplicate": {
      const b = blockBoundsAt(text, sel.from);
      const body = text.slice(b.from, b.to);
      const next = text.slice(0, b.to) + "\n\n" + body + text.slice(b.to);
      return { text: next, from: b.to + 2, to: b.to + 2 + body.length };
    }
    case "clearFormat": {
      const b = blockBoundsAt(text, sel.from);
      const out = mapLines(text, b.from, b.to, (l) =>
        stripInline(l.replace(HEADING_RE, "").replace(QUOTE_RE, "").replace(TASK_RE, "").replace(UL_RE, "").replace(OL_RE, "")),
      );
      return { text: out, from: b.from, to: b.to };
    }
    case "insertText": {
      const next = text.slice(0, sel.from) + cmd.text + text.slice(sel.to);
      return { text: next, from: sel.from + cmd.text.length, to: sel.from + cmd.text.length };
    }
  }
}

/** 把命令作用到编辑器上（含图片命令的空实现兜底，图片走 insertImageFromDisk） */
export function runFormat(view: EditorView, cmd: FormatCmd): boolean {
  if (cmd.k === "image") return false;
  const sel = view.state.selection.main;
  const text = view.state.doc.toString();
  const res = applyFormatToText(text, sel.from, sel.to, cmd);
  if (res.text === text && res.from === sel.from && res.to === sel.to) return true;
  view.dispatch({
    changes: { from: 0, to: text.length, insert: res.text },
    selection: { anchor: Math.min(res.from, res.text.length), head: Math.min(res.to, res.text.length) },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}
