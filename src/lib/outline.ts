/*
 * 文档大纲：从 Markdown 文本里抽出标题层级。
 * 用途：左侧栏「大纲」面板里的 Ctrl+点击标题跳到对应章节（`atxHeadingOf`）、
 * 章节内标题统计（EPUB 章内目录）、文档内标题锚点跳转。
 * 注意正文不再提供插入标题的命令，但标题渲染与解析都保留（旧稿仍要能读）。
 *
 * 规则（尽量贴近 CommonMark / GFM）：
 *  - 只认 ATX 标题（最多 3 个前导空格 + # ~ ######）与 Setext 标题（=== / --- 下划线）；
 *  - 围栏代码块（``` / ~~~）内部的所有 # 一律跳过；
 *  - 文档开头的 YAML frontmatter 整块跳过（MyNovel 用它存章节状态/目标）；
 *  - 4 空格缩进的代码块不会被误判（ATX 最多允许 3 个前导空格）。
 */
export interface OutlineItem {
  level: number;
  text: string;
  /** 1 起的行号 */
  line: number;
  /** 标题行在整篇文本中的绝对偏移 */
  from: number;
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const FM_OPEN_RE = /^---[ \t]*$/;

/** 返回 frontmatter 结束（含结束行）的下一行下标；没有 frontmatter 返回 0 */
export function frontmatterEndLine(lines: string[]): number {
  if (lines.length === 0 || !FM_OPEN_RE.test(lines[0])) return 0;
  const limit = Math.min(lines.length, 200);
  for (let i = 1; i < limit; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
      // 至少要像 YAML（含 k: v 或 k:）才认，避免把「--- 分割线」误当 frontmatter
      const body = lines.slice(1, i);
      if (body.some((l) => /^\s*[\w.-]+\s*:/.test(l))) return i + 1;
      return 0;
    }
  }
  return 0;
}

export function cleanTitle(raw: string): string {
  const t = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~^=]/g, "")
    .trim();
  return t || "(无标题)";
}

/**
 * 单行文本是不是 ATX 标题（`## 第 3 章 出发`）→ 清洗后的标题文本。
 * 供「Ctrl+点击标题打开对应章节」使用：与 extractOutline 用同一套规则与清洗。
 */
export function atxHeadingOf(line: string): { level: number; text: string } | null {
  const atx = ATX_RE.exec(line);
  if (!atx) return null;
  const text = cleanTitle(atx[2] ?? "");
  return text === "(无标题)" ? null : { level: atx[1].length, text };
}

export function extractOutline(md: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = md.split("\n");
  const start = frontmatterEndLine(lines);
  let pos = 0;
  for (let i = 0; i < start; i++) pos += lines[i].length + 1;

  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_RE.exec(line);
    if (fm) {
      const mark = fm[1];
      if (fence === null) {
        fence = mark;
      } else if (mark[0] === fence[0] && mark.length >= fence.length && fm[2].trim() === "") {
        fence = null;
      }
      pos += line.length + 1;
      continue;
    }
    if (fence === null) {
      const atx = ATX_RE.exec(line);
      if (atx) {
        items.push({ level: atx[1].length, text: cleanTitle(atx[2] ?? ""), line: i + 1, from: pos });
      } else if (line.trim() !== "" && i + 1 < lines.length) {
        const setext = SETEXT_RE.exec(lines[i + 1]);
        if (setext && !/^\s*([-*+]|\d+[.)])\s+/.test(line) && !/^\s*>/.test(line)) {
          items.push({
            level: setext[1][0] === "=" ? 1 : 2,
            text: cleanTitle(line),
            line: i + 1,
            from: pos,
          });
        }
      }
    }
    pos += line.length + 1;
  }
  return items;
}
