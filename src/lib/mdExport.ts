/*
 * Markdown → HTML（离线导出 + 即时预览共用），不依赖任何第三方库。
 *
 *  - markdownToHtml：整篇转换；standalone=true 时输出带 meta charset 与内联 CSS 的完整文档。
 *  - inlineMarkdownToHtml：行内转换。即时预览的行内渲染也调用它，保证「预览所见 == 导出所得」。
 *
 * 安全约定：正文里的 < > & 一律转义；只有白名单行内标签（u/kbd/s/del…）被保留，
 * 且**丢弃全部属性**；链接 href 若是 javascript:/data:text/html 则退化为纯文本。
 *
 * 面向小说写作：不做公式（KaTeX）、图表（Mermaid）、表格、提示块与 [TOC]；
 * 围栏代码块只输出纯 <pre><code>（不做语法高亮）。标题仍照常渲染，
 * 因为「大纲即文档」要用 # 组织卷 / 章。
 */
import { frontmatterEndLine } from "./outline";
import {
  childNodes,
  topBlocks,
  type MarkdownNode,
  type TopBlock,
} from "./markdownBlocks";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ *
 * token 化：代码 / HTML 抽出后换成一个哨兵，避免内部再被解释
 * ------------------------------------------------------------------ */
const SENT = "\x00";
const SENT_RE = /\x00(\d+)\x00/g;

interface Tokenizer {
  push(html: string): string;
  restore(s: string): string;
}

function makeTokenizer(): Tokenizer {
  const toks: string[] = [];
  return {
    push(html) {
      toks.push(html);
      return SENT + (toks.length - 1) + SENT;
    },
    restore(s) {
      for (let i = 0; i <= toks.length && /\x00\d+\x00/.test(s); i++) {
        s = s.replace(SENT_RE, (_m, n: string) => toks[Number(n)] ?? "");
      }
      return s;
    },
  };
}

const INLINE_TAGS = new Set([
  "u", "mark", "sub", "sup", "kbd", "s", "del", "ins", "em", "i", "b", "strong",
  "code", "small", "cite", "q", "abbr", "br",
]);

function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(h.replace(/[\x00-\x20]/g, "")) && !/^(https?:|mailto:|ftp:)/i.test(h)) return null;
  return h;
}

/* ------------------------------------------------------------------ *
 * 引用语义扫描：链接定义、脚注定义与引用
 *
 * 这些扫描器同时服务两个调用方：
 *  - markdownToHtml 的 document / sourceOffset 选项：按块渲染时也能查到全文定义；
 *  - links.findAnchorPos：把 `#fn-x` / `#fnref-x` / 引用式定义标签解析成源码位置。
 * 扫描时跳过 YAML frontmatter 与围栏代码块里的「伪定义」。
 * ------------------------------------------------------------------ */

export interface LinkDefinition {
  /** 规范化标签（小写 + 空白折叠），用于匹配 */
  label: string;
  /** 原文标签 */
  raw: string;
  href: string;
  title?: string;
  /** 定义在文档中的绝对起止偏移（to 为最后一行行尾，不含换行） */
  from: number;
  to: number;
}

export type LinkDefMap = Map<string, LinkDefinition>;
/** 兼容旧调用：也接受直接给 href 字符串的 Map */
export type DefLookup = Map<string, string | LinkDefinition>;

/** 链接/脚注标签匹配规则：小写、折叠连续空白、去首尾空白 */
export function normalizeLabel(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface DocLine {
  text: string;
  /** 行首在文本中的绝对偏移 */
  from: number;
  /** true = frontmatter 或围栏代码块内部，不参与定义扫描 */
  skip: boolean;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** 按行扫描文档，并标出 frontmatter / 围栏代码块内部的行 */
export function scanDocumentLines(md: string): DocLine[] {
  const lines = md.split("\n");
  const fmEnd = frontmatterEndLine(lines);
  const out: DocLine[] = [];
  let pos = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const inFrontmatter = fmEnd > 0 && i < fmEnd;
    let inCode = false;
    const fm = FENCE_OPEN_RE.exec(text);
    if (fence !== null) {
      inCode = true;
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && fm[2].trim() === "") fence = null;
    } else if (fm) {
      inCode = true;
      fence = fm[1];
    }
    out.push({ text, from: pos, skip: inFrontmatter || inCode });
    pos += text.length + 1;
  }
  return out;
}

/** 把若干区间换成空格（保持长度不变），用于排除不参与匹配的区域 */
function blankRanges(md: string, ranges: { from: number; to: number }[]): string {
  if (ranges.length === 0) return md;
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.to <= pos) continue;
    const from = Math.max(r.from, pos);
    out += md.slice(pos, from) + " ".repeat(Math.max(0, r.to - from));
    pos = r.to;
  }
  return out + md.slice(pos);
}

/** 链接目标：`<...>` 或一段非空白（内部括号需配平） */
function parseDestination(s: string): { href: string; rest: string } | null {
  if (s.startsWith("<")) {
    const end = s.indexOf(">", 1);
    if (end === -1) return null;
    const href = s.slice(1, end);
    if (/[\s<>]/.test(href)) return null;
    return { href: href.replace(/\\([<>\\])/g, "$1"), rest: s.slice(end + 1) };
  }
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (/\s/.test(c)) break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  if (i === 0 || depth !== 0) return null;
  const href = s.slice(0, i);
  if (/[\x00-\x20<>]/.test(href)) return null;
  return { href: href.replace(/\\([()\\])/g, "$1"), rest: s.slice(i) };
}

/** 链接标题：`"…"`、`'…'` 或 `(…)` */
function parseTitle(s: string): { title: string; rest: string } | null {
  const t = s.trimStart();
  const open = t[0];
  if (open !== '"' && open !== "'" && open !== "(") return null;
  const close = open === "(" ? ")" : open;
  let i = 1;
  while (i < t.length) {
    if (t[i] === "\\") { i += 2; continue; }
    if (t[i] === close) break;
    if (open === "(" && t[i] === "<") return null;
    i++;
  }
  if (i >= t.length) return null;
  return { title: t.slice(1, i).replace(/\\(["'()\\])/g, "$1"), rest: t.slice(i + 1) };
}

const DEF_LINE_RE = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(.*)$/;

/**
 * 收集 `[label]: url "title"` 定义（标签不区分大小写、空白折叠）。
 * 跳过 frontmatter 与围栏代码块；目标或标题可以缩进写在下一行。
 */
export function collectLinkDefs(md: string): LinkDefMap {
  const defs: LinkDefMap = new Map();
  const lines = scanDocumentLines(md);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.skip) continue;
    const m = DEF_LINE_RE.exec(ln.text);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw || raw.startsWith("^")) continue; // 脚注定义另走 FootnoteIndex
    const label = normalizeLabel(raw);
    if (!label || defs.has(label)) continue;
    let rest = m[2];
    let to = ln.from + ln.text.length;
    if (!rest.trim()) {
      const nx = lines[i + 1];
      if (nx && !nx.skip && /^[ \t]+\S/.test(nx.text)) {
        rest = nx.text;
        to = nx.from + nx.text.length;
      }
    }
    const dest = parseDestination(rest.trimStart());
    if (!dest) continue;
    let title: string | undefined;
    let tail = dest.rest;
    if (tail.trim()) {
      const t = parseTitle(tail);
      if (!t) continue;
      title = t.title;
      tail = t.rest;
    }
    if (tail.trim() !== "") continue;
    const safe = safeHref(dest.href);
    if (!safe) continue;
    defs.set(label, { label, raw, href: safe, title, from: ln.from, to });
  }
  return defs;
}

/* ---- 脚注索引 ----
 *
 * 正文不再渲染脚注（novel 写作不需要），但这份索引仍然服务文档内锚点跳转：
 * links.findAnchorPos 靠它把 `#fn-x` / `#fnref-x` 解析成源码位置，旧文档里的
 * 手写脚注锚点因此仍可点击定位。
 */

export interface FootnoteDefinition {
  /** 原文标签 */
  label: string;
  /** 规范化标签 */
  key: string;
  /** 用于 id / 锚点的片段（文档内唯一） */
  slug: string;
  /** 定义正文（多行以 \n 连接，缩进已去掉） */
  text: string;
  /** `[^label]:` 行首绝对偏移 */
  from: number;
  /** 定义最后一行行尾绝对偏移 */
  to: number;
  /** 脚注序号（1 起，按首次引用位置排序，未被引用的排在最后） */
  number: number;
}

export interface FootnoteReference {
  label: string;
  key: string;
  /** `[` 在文档中的绝对偏移 */
  pos: number;
  /** 该脚注的第几次引用（1 起） */
  ordinal: number;
  /** 引用锚点 id：fnref-x / fnref-x-2 */
  id: string;
  /** 所引脚注的序号（没有对应定义时为 0） */
  number: number;
}

export interface FootnoteIndex {
  /** 规范化标签 → 定义 */
  defs: Map<string, FootnoteDefinition>;
  /** 定义顺序 */
  defOrder: FootnoteDefinition[];
  /** 规范化标签 → 引用（按文档顺序） */
  refs: Map<string, FootnoteReference[]>;
  /** 定义 id（fn-x）→ 定义 */
  defById: Map<string, FootnoteDefinition>;
  /** 引用 id（fnref-x / fnref-x-2）→ 引用 */
  refById: Map<string, FootnoteReference>;
  /** 定义起始绝对偏移 → 定义 */
  defsAt: Map<number, FootnoteDefinition>;
  /** 引用绝对偏移 → 引用 */
  refsAt: Map<number, FootnoteReference>;
}

const FN_DEF_RE = /^ {0,3}\[\^([^\]\n]+)\]:[ \t]*(.*)$/;
const FN_REF_RE = /\[\^([^\]\n]+)\]/g;

/** 脚注标签 → id 片段 */
export function footnoteSlug(label: string): string {
  const s = label
    .trim()
    .replace(/\s+/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/["'`<>#$%&?\\()\[\]{}\x00-\x1f]/g, "");
  return s || "note";
}

/**
 * 扫描整篇文档里的脚注：定义（含 4 空格/制表符缩进的续行）、引用位置、
 * 重复引用的唯一 id 与序号。代码块与 frontmatter 里的伪定义会被忽略。
 */
export function buildFootnoteIndex(md: string): FootnoteIndex {
  const lines = scanDocumentLines(md);
  const defOrder: FootnoteDefinition[] = [];
  const markers: { from: number; to: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.skip) continue;
    const m = FN_DEF_RE.exec(ln.text);
    if (!m) continue;
    const label = m[1].trim();
    if (!label) continue;
    const body: string[] = [m[2]];
    markers.push({ from: ln.from, to: ln.from + (m[0].length - m[2].length) });
    let to = ln.from + ln.text.length;
    let j = i + 1;
    while (j < lines.length && !lines[j].skip && /^(?: {4}|\t)/.test(lines[j].text)) {
      body.push(lines[j].text.replace(/^(?: {4}|\t)/, ""));
      to = lines[j].from + lines[j].text.length;
      j++;
    }
    defOrder.push({ label, key: normalizeLabel(label), slug: "", text: body.join("\n"), from: ln.from, to, number: 0 });
    i = j - 1;
  }

  // 引用位置：只屏蔽代码块/frontmatter 行与定义标记本身，定义正文里的引用仍然算数
  const excluded = markers.concat(lines.filter((l) => l.skip).map((l) => ({ from: l.from, to: l.from + l.text.length })));
  const refs = new Map<string, FootnoteReference[]>();
  for (const m of blankRanges(md, excluded).matchAll(FN_REF_RE)) {
    const label = m[1].trim();
    if (!label) continue;
    const key = normalizeLabel(label);
    const list = refs.get(key) ?? [];
    list.push({ label, key, pos: m.index ?? 0, ordinal: 0, id: "", number: 0 });
    refs.set(key, list);
  }

  // id 片段：按定义顺序分配，冲突时加序号
  const taken = new Set<string>();
  for (const d of defOrder) {
    let slug = footnoteSlug(d.label);
    for (let n = 2; taken.has(slug); n++) slug = `${footnoteSlug(d.label)}-${n}`;
    taken.add(slug);
    d.slug = slug;
  }

  // 序号：按首次引用位置排序，未被引用的定义排在最后
  const firstRef = (d: FootnoteDefinition) => refs.get(d.key)?.[0]?.pos ?? Number.MAX_SAFE_INTEGER;
  [...defOrder].sort((a, b) => firstRef(a) - firstRef(b) || a.from - b.from).forEach((d, k) => { d.number = k + 1; });

  const defs = new Map<string, FootnoteDefinition>();
  const defById = new Map<string, FootnoteDefinition>();
  const defsAt = new Map<number, FootnoteDefinition>();
  for (const d of defOrder) {
    defs.set(d.key, d);
    defById.set(`fn-${d.slug}`, d);
    defsAt.set(d.from, d);
  }
  const refById = new Map<string, FootnoteReference>();
  const refsAt = new Map<number, FootnoteReference>();
  for (const [key, list] of refs) {
    const def = defs.get(key);
    const slug = def ? def.slug : footnoteSlug(list[0].label);
    list.sort((a, b) => a.pos - b.pos);
    list.forEach((r, k) => {
      r.ordinal = k + 1;
      // 第一次引用沿用 fnref-x，之后 fnref-x-2、fnref-x-3…，保证 id 全局唯一
      r.id = k === 0 ? `fnref-${slug}` : `fnref-${slug}-${k + 1}`;
      r.number = def ? def.number : 0;
      refById.set(r.id, r);
      refsAt.set(r.pos, r);
    });
  }
  return { defs, defOrder, refs, defById, refById, defsAt, refsAt };
}

/** 行内代码：`x`、``x``，按 CommonMark 的「等长反引号才闭合」处理 */
function extractCodeSpans(s: string, tk: Tokenizer): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "`") {
      out += s[i++];
      continue;
    }
    let n = 0;
    while (s[i + n] === "`") n++;
    const ticks = s.slice(i, i + n);
    let c = s.indexOf(ticks, i + n);
    while (c !== -1) {
      let extra = 0;
      while (s[c + n + extra] === "`") extra++;
      if (extra === 0) break;
      c = s.indexOf(ticks, c + n);
    }
    if (c === -1) {
      out += ticks;
      i += n;
      continue;
    }
    let body = s.slice(i + n, c);
    if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "") body = body.slice(1, -1);
    out += tk.push(`<code class="md-code">${escapeHtml(body.replace(/\n/g, " "))}</code>`);
    i = c + n;
  }
  return out;
}

/** 反斜杠转义：\* 之类按字面量输出 */
function extractEscapes(s: string, tk: Tokenizer): string {
  return s.replace(/\\([\\`*_{}\[\]()#+\-.!>~^=|$<>&])/g, (_m, ch: string) => tk.push(escapeHtml(ch)));
}

/** 硬换行：行尾两个空格或一个反斜杠 */
function convertBreaks(s: string, tk: Tokenizer): string {
  const lines = s.split("\n");
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const hard = /( {2,}|\\)$/.test(prev);
    if (hard) out = out.replace(/( {2,}|\\)$/, "");
    out += (hard ? tk.push("<br>") : " ") + lines[i];
  }
  return out;
}

const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>\s]*>|[^\s)]+)(?:\s+["']([^"']*)["'])?\s*\)/g;
const IMG_REF_RE = /!\[([^\]]*)\]\[([^\]]*)\]/g;
const IMG_SHORT_RE = /!\[([^\]]*)\]/g;

function defParts(v: string | LinkDefinition | undefined): { href: string; title?: string } | null {
  if (v === undefined) return null;
  if (typeof v === "string") return v ? { href: v } : null;
  return v.href ? { href: v.href, title: v.title } : null;
}

/** 查链接/图片定义（标签不区分大小写、空白折叠） */
function lookupDef(defs: DefLookup | undefined, label: string): { href: string; title?: string } | null {
  if (!defs || defs.size === 0) return null;
  return defParts(defs.get(normalizeLabel(label)));
}

function withBase(href: string, base?: string): string {
  if (!href || !base) return href;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return href;
  return resolveRelative(base, href);
}

interface ImageOpts {
  defs?: DefLookup;
  base?: string;
  /** true = 同时写出 src（仅供导出静态 HTML 使用） */
  inlineSrc?: boolean;
}

/**
 * 图像一律输出 data-md-src：innerHTML 注入时浏览器不会去请求远程资源，
 * 由渲染方（widget / 导出）自己决定何时把 data-md-src 赋给 src。
 */
function imgTag(src: string, alt: string, title: string | undefined, o: ImageOpts): string {
  const url = escapeAttr(src);
  const t = title ? ` title="${escapeAttr(title)}"` : "";
  const srcAttr = o.inlineSrc ? ` src="${url}"` : "";
  return `<img class="md-img" data-md-src="${url}"${srcAttr} alt="${escapeAttr(alt)}"${t}>`;
}

function extractImages(s: string, tk: Tokenizer, o: ImageOpts): string {
  let out = s.replace(IMG_RE, (_m, alt: string, rawSrc: string, title?: string) => {
    const raw = rawSrc.startsWith("<") && rawSrc.endsWith(">") ? rawSrc.slice(1, -1) : rawSrc;
    return tk.push(imgTag(withBase(raw, o.base), alt, title, o));
  });
  // 引用式图片：![alt][ref] / ![alt][] / ![alt]
  out = out.replace(IMG_REF_RE, (m, alt: string, ref: string) => {
    const d = lookupDef(o.defs, ref || alt);
    if (!d) return m;
    return tk.push(imgTag(withBase(d.href, o.base), alt, d.title, o));
  });
  out = out.replace(IMG_SHORT_RE, (m, alt: string) => {
    const d = lookupDef(o.defs, alt);
    if (!d) return m;
    return tk.push(imgTag(withBase(d.href, o.base), alt, d.title, o));
  });
  return out;
}

const LINK_RE = /\[([^\]]*)\]\(\s*(<[^>\s]*>|[^\s)]*)(?:\s+["']([^"']*)["'])?\s*\)/g;
const REF_LINK_RE = /\[([^\]]+)\]\[([^\]]*)\]/g;
const SHORT_REF_RE = /\[([^\]^][^\]]*)\](?!\s*[(:])/g;
const AUTOLINK_RE = /<((?:https?|ftp|mailto):[^\s<>]+)>/g;
const MAILTO_RE = /<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g;

function extractLinks(s: string, tk: Tokenizer, o: ImageOpts): string {
  let out = s.replace(LINK_RE, (_m, text: string, rawHref: string, title?: string) => {
    const href = rawHref.startsWith("<") && rawHref.endsWith(">") ? rawHref.slice(1, -1) : rawHref;
    const finalHref = withBase(href, o.base);
    const safe = safeHref(finalHref);
    const label = renderInlineCtx(text, { tk, defs: o.defs, base: o.base });
    const t = title ? ` title="${escapeAttr(title)}"` : "";
    if (safe === null) return tk.push(`<span class="md-link-bad" title="不安全的链接已禁用">${label}</span>`);
    if (!safe) return tk.push(label);
    return tk.push(`<a class="md-link" href="${escapeAttr(safe)}"${t}>${label}</a>`);
  });
  const refHtml = (text: string, d: { href: string; title?: string }) => {
    const href = safeHref(withBase(d.href, o.base));
    if (href === null) return null;
    const t = d.title ? ` title="${escapeAttr(d.title)}"` : "";
    return tk.push(`<a class="md-link" href="${escapeAttr(href)}"${t}>${renderInlineCtx(text, { tk, defs: o.defs, base: o.base })}</a>`);
  };
  // 完整引用式 [text][ref] 与折叠引用式 [text][]（ref 为空时用 text 当标签）
  out = out.replace(REF_LINK_RE, (m, text: string, ref: string) => {
    const d = lookupDef(o.defs, ref || text);
    return d ? refHtml(text, d) ?? m : m;
  });
  // 简写引用式 [text]：只认有定义的标签，避免把普通方括号文本吃掉
  out = out.replace(SHORT_REF_RE, (m, text: string) => {
    const d = lookupDef(o.defs, text);
    return d ? refHtml(text, d) ?? m : m;
  });
  out = out.replace(AUTOLINK_RE, (_m, href: string) => {
    const safe = safeHref(href);
    if (safe === null) return tk.push(escapeHtml(href));
    return tk.push(`<a class="md-link" href="${escapeAttr(safe)}">${escapeHtml(href.replace(/^mailto:/i, ""))}</a>`);
  });
  out = out.replace(MAILTO_RE, (_m, mail: string) => tk.push(`<a class="md-link" href="mailto:${escapeAttr(mail)}">${escapeHtml(mail)}</a>`));
  return out;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g;

function extractHtmlTags(s: string, tk: Tokenizer): string {
  return s.replace(TAG_RE, (m, close: string, name: string, _attrs: string, selfClose: string) => {
    const tag = name.toLowerCase();
    if (!INLINE_TAGS.has(tag)) return tk.push(escapeHtml(m));
    if (tag === "br") return tk.push("<br>");
    return tk.push(`<${close}${tag}${selfClose}>`);
  });
}

function extractEmphasis(s: string, ctx: RenderCtx, depth = 0): string {
  if (depth > 3) return s;
  const tk = ctx.tk;
  const inner = (t: string) => extractEmphasis(t, ctx, depth + 1);
  let out = s;
  out = out.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, (_m, t: string) => tk.push(`<strong><em>${inner(t)}</em></strong>`));
  out = out.replace(/(^|[^\w])___(?=\S)([\s\S]*?\S)___(?!\w)/g, (_m, p: string, t: string) => p + tk.push(`<strong><em>${inner(t)}</em></strong>`));
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_m, t: string) => tk.push(`<strong>${inner(t)}</strong>`));
  out = out.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_m, p: string, t: string) => p + tk.push(`<strong>${inner(t)}</strong>`));
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_m, t: string) => tk.push(`<del>${inner(t)}</del>`));
  /*
   * Typora 那套行内语法：==高亮== ^上标^ ~下标~（下标必须排在删除线之后，且避开 ~~ 的另一半）。
   *
   * 三个规则的边界都要挡住两类"同样含这些符号"的文本，否则会跨着把它们吃掉：
   *   - 脚注引用 [^1]：它的 ^ 两侧是方括号，所以标记左边不许紧跟 [；
   *   - 公式 $E = mc^2$：一行里可能有两个 ^（比如再带一个脚注），所以内容里不许出现 $ [ ] \。
   * 只禁这两类字符，`第 ^3^ 次` 这种前面是空格的正常写法照样成立。
   */
  out = out.replace(/(^|[^=\[$])==(?=\S)([^=\[\]$\n\\]*?\S)==/g, (_m, p: string, t: string) => p + tk.push(`<mark>${inner(t)}</mark>`));
  out = out.replace(/(^|[^\^\[$])\^(?=\S)([^\^\[\]$\n\\]*?\S)\^/g, (_m, p: string, t: string) => p + tk.push(`<sup>${inner(t)}</sup>`));
  out = out.replace(/(^|[^~\[$])~(?=\S)([^~\[\]$\n\\]*?\S)~(?![~])/g, (_m, p: string, t: string) => p + tk.push(`<sub>${inner(t)}</sub>`));
  out = out.replace(/\*(?=\S)([^*\n]*?\S)\*/g, (_m, t: string) => tk.push(`<em>${inner(t)}</em>`));
  out = out.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, (_m, p: string, t: string) => p + tk.push(`<em>${inner(t)}</em>`));
  return out;
}

const BARE_URL_RE = /(^|[\s(（【])((?:https?|ftp):\/\/[^\s<>()（）【】"']+)/g;

function linkify(s: string): string {
  return s.replace(BARE_URL_RE, (_m, pre: string, url: string) => {
    const trimmed = url.replace(/[.,;:!?、。；：！？]+$/, "");
    return `${pre}<a class="md-link" href="${escapeAttr(trimmed)}">${trimmed}</a>${url.slice(trimmed.length)}`;
  });
}

/** 行内渲染的共享上下文：token 表 + 定义表 */
interface RenderCtx {
  tk: Tokenizer;
  defs?: DefLookup;
  base?: string;
  inlineImageSrc?: boolean;
}

function renderInlineCtx(md: string, ctx: RenderCtx): string {
  const tk = ctx.tk;
  let s = convertBreaks(md, tk);
  s = extractCodeSpans(s, tk);
  s = extractEscapes(s, tk);
  s = extractImages(s, tk, { defs: ctx.defs, base: ctx.base, inlineSrc: ctx.inlineImageSrc });
  s = extractLinks(s, tk, { defs: ctx.defs, base: ctx.base, inlineSrc: ctx.inlineImageSrc });
  s = extractHtmlTags(s, tk);
  s = extractEmphasis(s, ctx);
  return escapeHtml(s);
}

/** 行内 Markdown → HTML（不含块级结构；tk 由调用方传入以便复用 token 表） */
export function renderInline(md: string, tk: Tokenizer, defs?: DefLookup, base?: string): string {
  return renderInlineCtx(md, { tk, defs, base });
}

/** 行内 Markdown → HTML */
export function inlineMarkdownToHtml(md: string, defs?: DefLookup): string {
  const tk = makeTokenizer();
  return tk.restore(linkify(renderInline(md, tk, defs)));
}

/* ------------------------------------------------------------------ *
 * 路径工具
 * ------------------------------------------------------------------ */
export function resolveRelative(baseDir: string, rel: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(rel)) return rel;
  const stack = baseDir ? baseDir.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".") : [];
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** 标题 → 锚点 id */
export function slugOf(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^\w一-龥-]/g, "");
  return s || "section";
}

/* ------------------------------------------------------------------ *
 * 块级
 * ------------------------------------------------------------------ */

interface ListItemPlan {
  indent: number;
  ordered: boolean;
  start: number;
  task: string;
  /** 复选框内部字符（`- [x]` 里的 x 或空格）在原文中的绝对偏移；非任务项为 -1 */
  taskPos: number;
  text: string;
}

function renderList(items: ListItemPlan[], ctx: RenderCtx): string {
  let idx = 0;
  const build = (indent: number): string => {
    const ordered = items[idx].ordered;
    const startAttr = ordered && items[idx].start !== 1 ? ` start="${items[idx].start}"` : "";
    let html = `<${ordered ? "ol" : "ul"}${startAttr}>`;
    while (idx < items.length && items[idx].indent >= indent) {
      if (items[idx].indent > indent) {
        html += build(items[idx].indent);
        continue;
      }
      const it = items[idx++];
      // 复选框保持 disabled，由渲染方按 data-task-pos 决定何时允许点击改写源码
      const box = it.task
        ? `<input type="checkbox" disabled${it.task !== " " ? " checked" : ""}${
            it.taskPos >= 0 ? ` data-task-pos="${it.taskPos}"` : ""
          }> `
        : "";
      let body = `${box}${renderInlineCtx(it.text, ctx)}`;
      while (idx < items.length && items[idx].indent > indent) body += build(items[idx].indent);
      html += `<li${it.task ? ' class="task"' : ""}>${body}</li>`;
    }
    return html + `</${ordered ? "ol" : "ul"}>`;
  };
  let out = "";
  while (idx < items.length) out += build(items[idx].indent);
  return out;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export interface MarkdownToHtmlOptions {
  standalone?: boolean;
  /** 文档所在目录（相对工作区）；用于把相对图片/链接解析成可移植路径 */
  baseDir?: string;
  /**
   * 整篇 Markdown 原文。按块渲染（即时预览）时传入，才能跨块查到全篇的
   * 引用式链接定义与引用式图片定义；不传时以传入的 `md` 作为全文。
   */
  document?: string;
  /**
   * 传入的 `md` 在整篇文档中的绝对起始偏移（UTF-16 字符数）。
   * 任务列表的 data-task-pos 依赖它定位，默认 0。
   */
  sourceOffset?: number;
  /**
   * true = 图像额外写出 `src`（仅供外部特殊需要时显式开启）。
   * 默认 false：所有图像仅输出 `data-md-src`，避免 innerHTML 插入时自动发起远程网络请求。
   */
  inlineImageSrc?: boolean;
}

/* ================================================================== *
 * 语法树辅助：复杂块安全回退 + 缩进代码 / 列表的精确边界
 *
 * 逐行正则遇到嵌套容器时边界必错（Setext 下划线被吞进段落、缩进代码被当段落、
 * 混合类型列表被并进同一个 <ul>）。这里用**已安装**的 @lezer/markdown 语法树
 * 拿到精确范围：
 *   1) 判不准的复杂块 → 整块完整转义成源码 + 明确提示（不猜结构、不丢字符）；
 *   2) 判得准的缩进代码 / 列表 → 按语法树给出的边界渲染。
 * ================================================================== */

/** 复杂块源码回退的标记属性（便于外部样式与测试识别） */
export const SOURCE_FALLBACK_ATTR = "data-md-fallback";
export const SOURCE_FALLBACK_KIND = "complex-block";

/**
 * 复杂块 → 完整源码（整块转义）+ 提示。
 * 绝不渲染、绝不丢字符、绝不执行块内内容：这里的输出是纯文本。
 */
export function sourceFallbackHtml(raw: string, hint: string): string {
  return (
    `<div class="md-source-fallback" ${SOURCE_FALLBACK_ATTR}="${SOURCE_FALLBACK_KIND}">` +
    `<div class="md-source-fallback-note">⚠ ${escapeHtml(hint)}</div>` +
    `<pre class="md-pre md-source-fallback-pre"><code>${escapeHtml(raw)}</code></pre>` +
    `</div>`
  );
}

/** 缩进代码块（语法树确认）正文：CodeText 子节点已剥掉缩进，直接拼接即可。 */
function indentedCodeText(node: MarkdownNode, text: string): string {
  const parts = childNodes(node)
    .filter((c) => c.name === "CodeText")
    .map((c) => text.slice(c.from, c.to));
  return parts.length ? parts.join("") : text.slice(node.from, node.to);
}

/** 围栏代码块的语言与正文（列表项内部的围栏用；顶层围栏仍走逐行分支以保持字节一致）。 */
function fencedCodeParts(node: MarkdownNode, text: string): { lang: string; code: string } {
  const kids = childNodes(node);
  const info = kids.find((c) => c.name === "CodeInfo");
  const lang = info ? (/^\S*/.exec(text.slice(info.from, info.to))?.[0] ?? "") : "";
  const code = kids
    .filter((c) => c.name === "CodeText")
    .map((c) => text.slice(c.from, c.to))
    .join("");
  return { lang, code };
}

/** 代码块 HTML：纯 <pre><code>，只保留语言 class，不做语法高亮。 */
function codeBlockHtml(lang: string, code: string): string {
  return (
    `<pre class="md-pre"${lang ? ` data-lang="${escapeAttr(lang)}"` : ""}>` +
    `<code${lang ? ` class="language-${escapeAttr(lang)}"` : ""}>${escapeHtml(code)}</code></pre>`
  );
}

/* ---------------------------- 列表（语法树驱动） ---------------------------- */

function listItems(node: MarkdownNode): MarkdownNode[] {
  return childNodes(node).filter((c) => c.name === "ListItem");
}

/** 宽松列表：列表项之间有空行，或某个列表项直接含多个段落。 */
function isLooseList(items: MarkdownNode[], text: string): boolean {
  const paragraphsOf = (item: MarkdownNode) =>
    childNodes(item).filter((c) => c.name === "Paragraph" || c.name === "Task").length;
  if (items.some((it) => paragraphsOf(it) > 1)) return true;
  for (let k = 1; k < items.length; k++) {
    if (/\n[ \t]*\n/.test(text.slice(items[k - 1].to, items[k].from))) return true;
  }
  return false;
}

/**
 * 列表 → HTML（嵌套、宽松、混合类型分组全部由语法树决定）。
 * base 是本段文本在整篇文档里的绝对偏移，任务框的 data-task-pos 靠它保持绝对正确。
 */
function renderAstList(node: MarkdownNode, text: string, base: number, ctx: RenderCtx): string {
  const ordered = node.name === "OrderedList";
  const items = listItems(node);
  const loose = isLooseList(items, text);
  const firstMark = items.length ? childNodes(items[0]).find((c) => c.name === "ListMark") : undefined;
  const start = ordered && firstMark ? parseInt(text.slice(firstMark.from, firstMark.to), 10) : 1;
  const startAttr = ordered && Number.isFinite(start) && start !== 1 ? ` start="${start}"` : "";
  let html = `<${ordered ? "ol" : "ul"}${startAttr}>`;
  for (const item of items) html += renderAstListItem(item, text, base, ctx, loose);
  return html + `</${ordered ? "ol" : "ul"}>`;
}

function renderAstListItem(
  item: MarkdownNode,
  text: string,
  base: number,
  ctx: RenderCtx,
  loose: boolean,
): string {
  let checkbox = "";
  let isTask = false;
  const content: string[] = [];
  for (const child of childNodes(item)) {
    switch (child.name) {
      case "ListMark":
        break;
      case "Task": {
        const marker = childNodes(child).find((c) => c.name === "TaskMarker");
        const chAt = marker ? marker.from + 1 : -1;
        const ch = chAt >= 0 ? text[chAt] : "";
        if (marker && (ch === " " || ch === "x" || ch === "X")) {
          isTask = true;
          // 复选框保持 disabled，由渲染方按 data-task-pos 决定何时允许点击改写源码
          checkbox = `<input type="checkbox" disabled${ch.toLowerCase() === "x" ? " checked" : ""} data-task-pos="${
            base + chAt
          }"> `;
        }
        const raw = text.slice(child.from + 3, child.to).replace(/^[ \t]+/, "");
        content.push(loose ? `<p>${renderInlineCtx(raw, ctx)}</p>` : renderInlineCtx(raw, ctx));
        break;
      }
      case "Paragraph": {
        const raw = text.slice(child.from, child.to);
        content.push(loose ? `<p>${renderInlineCtx(raw, ctx)}</p>` : renderInlineCtx(raw, ctx));
        break;
      }
      case "BulletList":
      case "OrderedList":
        content.push(renderAstList(child, text, base, ctx));
        break;
      case "FencedCode": {
        const { lang, code } = fencedCodeParts(child, text);
        content.push(codeBlockHtml(lang, code));
        break;
      }
      case "CodeBlock":
        content.push(`<pre class="md-pre"><code>${escapeHtml(indentedCodeText(child, text))}</code></pre>`);
        break;
      case "ATXHeading1":
      case "ATXHeading2":
      case "ATXHeading3":
      case "ATXHeading4":
      case "ATXHeading5":
      case "ATXHeading6": {
        const lvl = parseInt(child.name.slice(10), 10) || 1;
        const raw = text.slice(child.from, child.to).replace(/^#{1,6}\s*/, "");
        content.push(`<h${lvl} id="${escapeAttr(slugOf(raw))}">${renderInlineCtx(raw, ctx)}</h${lvl}>`);
        break;
      }
      case "SetextHeading1":
      case "SetextHeading2": {
        const lvl = child.name === "SetextHeading1" ? 1 : 2;
        const innerLines = text.slice(child.from, child.to).split("\n");
        const head = innerLines.slice(0, Math.max(1, innerLines.length - 1)).join(" ").trim();
        content.push(`<h${lvl} id="${escapeAttr(slugOf(head))}">${renderInlineCtx(head, ctx)}</h${lvl}>`);
        break;
      }
      default:
        break;
    }
  }
  return `<li${isTask ? ' class="task"' : ""}>${checkbox}${content.join("")}</li>`;
}

export function markdownToHtml(md: string, title: string, opts: MarkdownToHtmlOptions = {}): string {
  const tk = makeTokenizer();
  const doc = opts.document ?? md;
  const offset = opts.sourceOffset ?? 0;
  const defs = collectLinkDefs(doc);
  const base = opts.baseDir;
  // 所有图像不得在 innerHTML 插入时自动加载远程资源，输出 data-md-src 代替 src
  const inlineImageSrc = opts.inlineImageSrc === true;
  const renderCtx: RenderCtx = { tk, defs, base, inlineImageSrc };
  const lines = md.split("\n");
  const body: string[] = [];

  // 每行的绝对偏移：块渲染时用于任务复选框位置
  const lineOffsets: number[] = new Array(lines.length);
  let curOff = offset;
  for (let li = 0; li < lines.length; li++) {
    lineOffsets[li] = curOff;
    curOff += lines[li].length + 1;
  }

  let i = 0;
  if (/^---[ \t]*$/.test(lines[0] ?? "")) {
    const end = lines.slice(1, 200).findIndex((l) => /^(---|\.\.\.)[ \t]*$/.test(l));
    if (end >= 0 && lines.slice(1, end + 1).some((l) => /^\s*[\w.-]+\s*:/.test(l))) i = end + 2;
  }

  const isBlockStart = (l: string): boolean =>
    /^ {0,3}(#{1,6})(\s|$)/.test(l) ||
    /^ {0,3}(`{3,}|~{3,})/.test(l) ||
    /^ {0,3}>/.test(l) ||
    /^ {0,3}([-*+]|\d+[.)])\s+/.test(l) ||
    /^ {0,3}\[\^[^\]]+\]:/.test(l) ||
    /^ {0,3}\[[^\]]+\]:\s*\S/.test(l);

  // —— 语法树给出的顶层块计划：行 → 块（含复杂块判定）——
  // 正则状态机判不准的边界（Setext 下划线、缩进代码、列表分组）
  // 一律以语法树为准；语法树覆盖不到时（极少）才退回逐行启发式。
  const relStarts: number[] = new Array(lines.length);
  {
    let at = 0;
    for (let li = 0; li < lines.length; li++) {
      relStarts[li] = at;
      at += lines[li].length + 1;
    }
  }
  const plan = topBlocks(md);
  const blockByLine: Array<TopBlock | null> = new Array(lines.length).fill(null);
  const blockEndByLine: number[] = new Array(lines.length).fill(-1);
  {
    let li = 0;
    for (const b of plan) {
      while (li < lines.length && relStarts[li] + lines[li].length < b.from) li++;
      let j = li;
      while (j < lines.length && relStarts[j] < b.to) j++;
      for (let k = li; k < j; k++) blockEndByLine[k] = j - 1;
      for (let k = li; k < j; k++) blockByLine[k] = b;
      li = j;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const block = blockByLine[i];
    const blockEnd = block ? blockEndByLine[i] : -1;
    // —— 语法树判定的复杂块：整块回退完整源码，不猜结构、不丢字符 ——
    if (block && block.fallback && blockEnd >= i) {
      body.push(sourceFallbackHtml(lines.slice(i, blockEnd + 1).join("\n"), block.hint ?? "该块结构复杂，已按原文保留"));
      i = blockEnd + 1;
      continue;
    }
    // —— Setext 标题：语法树确认「段落 + 下划线」是标题，绝不把下划线吞进段落 ——
    if (block && (block.name === "SetextHeading1" || block.name === "SetextHeading2") && blockEnd >= i) {
      const lvl = block.name === "SetextHeading1" ? 1 : 2;
      const text = lines.slice(i, Math.max(i, blockEnd)).join("\n").trim();
      body.push(`<h${lvl} id="${escapeAttr(slugOf(text))}">${renderInlineCtx(text, renderCtx)}</h${lvl}>`);
      i = blockEnd + 1;
      continue;
    }
    // —— 缩进代码块（4 空格 / 制表符）：语法树确认后按代码块渲染 ——
    if (block && block.name === "CodeBlock" && blockEnd >= i) {
      body.push(`<pre class="md-pre"><code>${escapeHtml(indentedCodeText(block.node, md))}</code></pre>`);
      i = blockEnd + 1;
      continue;
    }
    // —— 列表：语法树驱动（嵌套 / 宽松 / 混合类型分组）——
    if (block && (block.name === "BulletList" || block.name === "OrderedList") && blockEnd >= i) {
      body.push(renderAstList(block.node, md, offset, renderCtx));
      i = blockEnd + 1;
      continue;
    }
    // 分割线
    if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(line)) {
      body.push("<hr>");
      i++;
      continue;
    }
    // 围栏代码
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const mark = fence[1];
      const info = fence[2].trim();
      const closer = new RegExp("^ {0,3}" + (mark[0] === "`" ? "`" : "~") + "{" + mark.length + ",}[ \\t]*$");
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        if (closer.test(lines[i])) {
          i++;
          break;
        }
        buf.push(lines[i++]);
      }
      const lang = /^\S*/.exec(info)?.[0] ?? "";
      body.push(codeBlockHtml(lang, buf.join("\n")));
      continue;
    }
    // ATX 标题
    const h = /^ {0,3}(#{1,6})(?:\s+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const text = h[2] ?? "";
      body.push(`<h${lvl} id="${escapeAttr(slugOf(text))}">${renderInlineCtx(text, renderCtx)}</h${lvl}>`);
      i++;
      continue;
    }
    // 引用
    if (/^ {0,3}>/.test(line)) {
      const buf: string[] = [];
      const stripQuoteMark = (l: string) => l.replace(/^ {0,3}>\s?/, "");
      if (block && block.name === "Blockquote" && blockEnd >= i) {
        // 语法树给出的引用块范围（含惰性续行「> a\nb」这类行），比逐行正则更准
        for (let k = i; k <= blockEnd; k++) buf.push(stripQuoteMark(lines[k]));
        i = blockEnd + 1;
      } else {
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) buf.push(stripQuoteMark(lines[i++]));
      }
      const inner: string[] = [];
      let para: string[] = [];
      const flush = () => {
        if (para.length) inner.push(`<p>${renderInlineCtx(para.join("\n"), renderCtx)}</p>`);
        para = [];
      };
      for (const l of buf) {
        if (l.trim() === "") flush();
        else para.push(l);
      }
      flush();
      body.push(`<blockquote>${inner.join("")}</blockquote>`);
      continue;
    }
    // 链接定义（不输出）；`[^label]:` 是脚注定义，不是链接定义，按普通段落原样显示
    const defLine = /^ {0,3}\[([^\]\n]+)\]:\s*\S/.exec(line);
    if (defLine && !defLine[1].trimStart().startsWith("^")) {
      i++;
      continue;
    }
    // 列表
    if (LIST_RE.test(line)) {
      const items: ListItemPlan[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
        let taskPos = -1;
        if (task) {
          const lineStart = lineOffsets[i];
          const prefixLen = m[1].length + m[2].length;
          const bracketIdx = lines[i].indexOf("[", prefixLen);
          taskPos = bracketIdx >= 0 ? lineStart + bracketIdx + 1 : -1;
        }
        items.push({
          indent: m[1].replace(/\t/g, "    ").length,
          ordered: /\d/.test(m[2]),
          start: /\d/.test(m[2]) ? parseInt(m[2], 10) || 1 : 1,
          task: task ? task[1] : "",
          taskPos,
          text: task ? task[2] : m[3],
        });
        i++;
      }
      body.push(renderList(items, renderCtx));
      continue;
    }
    // 段落（含 Setext 标题）
    const buf: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) buf.push(lines[i++]);
    if (buf.length === 0) buf.push(lines[i++] ?? "");
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i] ?? "");
    if (buf.length === 1 && setext) {
      const lvl = setext[1][0] === "=" ? 1 : 2;
      body.push(`<h${lvl} id="${escapeAttr(slugOf(buf[0]))}">${renderInlineCtx(buf[0], renderCtx)}</h${lvl}>`);
      i++;
      continue;
    }
    body.push(`<p>${renderInlineCtx(buf.join("\n"), renderCtx)}</p>`);
  }

  const inner = tk.restore(body.join("\n"));
  if (!opts.standalone) return inner;
  const safeTitle = escapeHtml(title || "MyNovel");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #fffafc; color: #3b3237;
         font-family: "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif;
         font-size: 16px; line-height: 1.9; }
  main { max-width: 752px; margin: 0 auto; padding: 2.25rem 1rem 4.375rem; }
  h1, h2, h3, h4, h5, h6 { color: #2b2428; line-height: 1.35; margin: 1.2em 0 .4em; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.25rem; } h3 { font-size: 1.15rem; }
  p { margin: 0 0 .75em; }
  a { color: #ac3f70; }
  code { font-family: "JetBrains Mono", monospace; background: #f7e6ec; color: #4a4046;
         padding: .1em .3em; border-radius: 4px; font-size: .9em; }
  pre { background: #fdf3f7; border: 1px solid #ecd6de; border-radius: 10px; padding: .9em 1em; overflow: auto; }
  pre code { background: none; padding: 0; }
    blockquote { margin: .6em 0; padding: .2em 1em; border-left: 3px solid #a8466f; background: #fbeef3;
                 border-radius: 0 8px 8px 0; color: #7a6871; }
    blockquote p:last-child { margin-bottom: .3em; }
    /* 高亮 / 上标 / 下标：导出到 HTML、EPUB 与打印时都保持可见 */
    mark { background: rgba(172, 63, 112, .18); color: inherit; }
    sup, sub { font-size: .76em; line-height: 0; }
    hr { border: none; border-top: 1px solid #ecd6de; margin: 1.5em 0; }
  img { max-width: 100%; border-radius: 8px; }
  li.task { list-style: none; }
  li > p { margin: 0 0 .4em; }
  /* 复杂块（引用套列表/代码等）：整块安全回退为源码 + 提示，绝不猜结构 */
  .md-source-fallback { margin: .8em 0; padding: .5em .8em; background: #fdf3f7; border: 1px dashed #96601c;
                        border-radius: 10px; }
  .md-source-fallback-note { color: #96601c; font-size: .82em; margin-bottom: .4em; }
  .md-source-fallback-pre { margin: 0; background: none; border: none; padding: 0; }
  .md-source-fallback-pre code { color: #3b3237; }
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>
`;
}
