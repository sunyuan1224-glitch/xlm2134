/*
 * 导出中间层：把 `buildSelfContainedHtml` 产出的**自包含 HTML** 解析成与渲染无关的
 * 文档块模型，DOCX / EPUB 两个导出器共用。
 *
 * 为什么走「HTML → 块模型 → 目标格式」，而不是各自再解析一遍 Markdown：
 *   1. htmlExport 已经解决了最难的部分——本地图片内嵌成 data URL、远程图片只占位不下载、
 *      复杂块保留源码。导出器只需要消费这些成果，
 *      不必再实现一遍（也不可能保持三处一致）。
 *      （公式 / 图表的消费分支仍保留：本渲染器已不产出 KaTeX / Mermaid，
 *      但外层 HTML 可能来自旧版本或第三方，遇到时不至于整块丢掉。）
 *   2. 图片读取失败 / 远程图片 / 渲染失败在 HTML 里本来就是**可见的占位块**
 *      （.md-img-error / .md-img-remote），解析时原样识别成占位，导出报告里逐条列出，
 *      绝不静默丢内容。
 *   3. 复杂块的源码回退块（div.md-source-fallback）在导出里必须**完整保留源码**：
 *      这里把它识别成 code 块 + 警告，DOCX/EPUB 都会把源码写进文件并附上说明。
 *
 * 安全前提：本模块**不创建 DOM、不插入文档、不执行任何脚本**，
 * 自己用一个小型 tokenizer 解析（浏览器与 Node 行为一致），
 * script/style 的内容会被直接丢弃，属性值一律按文本处理。
 * 输出到 XHTML 时由 escapeXml/escapeXmlAttr 统一转义。
 */
import { unescapeEntities } from "./htmlExport";
import { escapeXml, escapeXmlAttr, sanitizeXmlText } from "./bytes";

/* ------------------------------------------------------------------ *
 * 块模型
 * ------------------------------------------------------------------ */

export interface ExportInline {
  kind: "text" | "code" | "link" | "image" | "math" | "place" | "br";
  /** text / code / link 标签文字 / place 提示文字 */
  text?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
  /** link：地址（已校验安全），internal 表示文档内锚点 */
  href?: string;
  internal?: boolean;
  /** image：data URL（本地图片已内嵌）或内联 SVG 源码 */
  src?: string;
  alt?: string;
  title?: string;
  svg?: string;
  /** math：TeX 源码 */
  tex?: string;
  display?: boolean;
  failed?: boolean;
  /** place：降级原因（远程未下载 / 读取失败 / 不支持的地址） */
  note?: string;
}

export interface ExportListItem {
  inlines: ExportInline[];
  /** 嵌套在条目里的块（子列表、代码块等） */
  blocks: ExportBlock[];
}

export interface ExportNavItem {
  text: string;
  level: number;
  href: string;
}

export type ExportBlock =
  | { kind: "heading"; level: number; inlines: ExportInline[]; id?: string }
  | { kind: "para"; inlines: ExportInline[] }
  | { kind: "math"; tex: string; display: boolean; failed: boolean }
  | { kind: "list"; ordered: boolean; items: ExportListItem[] }
  | { kind: "quote"; blocks: ExportBlock[] }
  | { kind: "callout"; variant: string; title: string | null; blocks: ExportBlock[] }
  | { kind: "code"; text: string; lang: string; origin: "code" | "fallback"; note?: string }
  | { kind: "table"; head: ExportInline[][]; rows: ExportInline[][][] }
  | { kind: "rule" }
  | { kind: "image"; inlines: ExportInline[] }
  | { kind: "nav"; title: string; items: ExportNavItem[] }
  | { kind: "footnotes"; items: { id: string; inlines: ExportInline[] }[] }
  | { kind: "raw"; note: string; text: string };

/* ------------------------------------------------------------------ *
 * 警告 / 报告
 * ------------------------------------------------------------------ */

export type ExportWarningKind =
  | "source-fallback"
  | "math-failed"
  | "remote-image"
  | "image-error"
  | "image-unsupported"
  | "unsafe-link"
  | "internal-link"
  | "image-dropped"
  | "unsupported-tag";

export interface ExportWarning {
  kind: ExportWarningKind;
  message: string;
  /** 相关源码片段 / 地址，便于用户定位到底是哪一段降级了 */
  detail?: string;
}

/** 去重后追加（同一类警告同一个 message 只留一条，避免报告被刷屏） */
export function pushWarning(list: ExportWarning[], w: ExportWarning): void {
  if (list.some((it) => it.kind === w.kind && it.message === w.message && it.detail === w.detail)) return;
  list.push(w);
}

/* ------------------------------------------------------------------ *
 * 极简 HTML tokenizer + 树（不依赖 DOM，浏览器与 Node 行为一致）
 * ------------------------------------------------------------------ */

export interface HtmlElement {
  type: "element";
  tag: string;
  attrs: Record<string, string | null>;
  children: HtmlNode[];
}

export interface HtmlText {
  type: "text";
  text: string;
}

export type HtmlNode = HtmlElement | HtmlText;

/** HTML 的空元素（自闭合，不能有子节点） */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** 这些标签的**内容**是原始文本，绝不能当标签解析（script/style 的内容直接丢弃） */
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "textarea"]);

export function classListOf(node: HtmlElement): string[] {
  return (node.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

export function hasClass(node: HtmlElement, name: string): boolean {
  return classListOf(node).includes(name);
}

function parseAttrs(body: string): Record<string, string | null> {
  const attrs: Record<string, string | null> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s/]/.test(body[i])) i++;
    if (i >= body.length) break;
    const nameStart = i;
    while (i < body.length && !/[\s=/]/.test(body[i])) i++;
    const name = body.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    while (i < body.length && /\s/.test(body[i])) i++;
    let value: string | null = null;
    if (body[i] === "=") {
      i++;
      while (i < body.length && /\s/.test(body[i])) i++;
      const quote = body[i];
      if (quote === '"' || quote === "'") {
        i++;
        const close = body.indexOf(quote, i);
        const stop = close === -1 ? body.length : close;
        value = body.slice(i, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < body.length && !/\s/.test(body[i])) i++;
        value = body.slice(vs, i);
      }
    }
    // 只保留第一次出现（重复属性不是我们生成的 HTML，后写的当作噪声丢掉）
    if (!(name in attrs)) attrs[name] = value === null ? null : unescapeEntities(value);
  }
  return attrs;
}

/**
 * 把 HTML 片段解析成节点树。
 * 容错原则：闭合标签对不上时**就地闭合最近的同名元素**，多余的闭合标签忽略；
 * 任何异常都只是结束循环——绝不抛异常，也绝不因为畸形输入丢掉已解析的内容。
 */
export function parseHtmlTree(html: string): HtmlElement {
  const root: HtmlElement = { type: "element", tag: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;

  const appendText = (text: string) => {
    if (!text) return;
    // 实体在这里就还原（&lt; 变回 <）：解码发生在**分词之后**，所以还原出来的字符
    // 不可能被重新当成标签解析；下游（代码块、公式源码、纯文本）拿到的就是原字符。
    const decoded = unescapeEntities(text);
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === "text") last.text += decoded;
    else parent.children.push({ type: "text", text: decoded });
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      appendText(html.slice(i));
      break;
    }
    if (lt > i) appendText(html.slice(i, lt));

    // 注释 / doctype / 处理指令：整块丢弃
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      const name = (end < 0 ? html.slice(lt + 2) : html.slice(lt + 2, end)).trim().toLowerCase();
      i = end < 0 ? html.length : end + 1;
      const at = stack.map((el) => el.tag).lastIndexOf(name);
      if (at > 0) stack.length = at; // 就地闭合（at 位置上的元素一并弹出）
      continue;
    }

    // 开始标签：找到标签结束的 '>'（跳过引号里的内容）
    let j = lt + 1;
    let quote: string | null = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    const inner = html.slice(lt + 1, j);
    i = j < html.length ? j + 1 : html.length;

    const selfClosing = /\/\s*$/.test(inner);
    const body = selfClosing ? inner.replace(/\/\s*$/, "") : inner;
    const nameEnd = body.search(/[\s/]/);
    const tag = (nameEnd < 0 ? body : body.slice(0, nameEnd)).trim().toLowerCase();
    if (!tag || !/^[a-z][a-z0-9:-]*$/.test(tag)) continue;
    const attrs = parseAttrs(nameEnd < 0 ? "" : body.slice(nameEnd));
    const el: HtmlElement = { type: "element", tag, attrs, children: [] };
    top().children.push(el);

    if (RAW_TEXT_TAGS.has(tag)) {
      // 原始文本元素：内容一律不当标签；script/style 直接丢弃，title/textarea 收进文本
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const raw = m ? rest.slice(0, m.index) : rest;
      i = m ? i + m.index + m[0].length : html.length;
      if (tag === "title" || tag === "textarea") appendText(unescapeEntities(raw));
      continue;
    }
    if (VOID_TAGS.has(tag) || selfClosing) continue;
    stack.push(el);
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * 行内节点 → ExportInline
 * ------------------------------------------------------------------ */

const SAFE_SCHEMES = /^(?:https?:|mailto:|tel:)/i;

/** 链接地址是否可信：只允许 http/https/mailto/tel、文档内锚点；其余（含 javascript:）一律降级 */
export function isSafeHref(href: string): boolean {
  const s = href.trim();
  if (!s) return false;
  if (s.startsWith("#")) return true;
  if (SAFE_SCHEMES.test(s)) return true;
  // 无协议的相对地址（a/b.html）：不含冒号就当作安全相对路径
  return !s.includes(":") && /^[a-z0-9._~\-/%#?=&+]+$/i.test(s);
}

function collectText(node: HtmlNode, out: string[] = []): string[] {
  if (node.type === "text") out.push(node.text);
  else for (const child of node.children) collectText(child, out);
  return out;
}

function findFirst(node: HtmlNode, test: (el: HtmlElement) => boolean): HtmlElement | null {
  if (node.type === "text") return null;
  if (test(node)) return node;
  for (const child of node.children) {
    const hit = findFirst(child, test);
    if (hit) return hit;
  }
  return null;
}

function findAll(node: HtmlNode, test: (el: HtmlElement) => boolean, out: HtmlElement[] = []): HtmlElement[] {
  if (node.type === "text") return out;
  if (test(node)) out.push(node);
  for (const child of node.children) findAll(child, test, out);
  return out;
}

/** 折叠普通文本里的连续空白（HTML 的默认渲染行为）；pre 里的文本不走这里 */
function collapse(text: string): string {
  return sanitizeXmlText(text).replace(/\s+/g, " ");
}

/**
 * 公式的 TeX 源码：KaTeX 输出里 `<annotation encoding="application/x-tex">` 就是原文；
 * 渲染失败的降级块则把原文写在 data-md-math-src 上。
 * 本渲染器已不产出公式，这里是防御性分支（外层 HTML 可能来自旧版本）。
 */
export function mathTexOf(node: HtmlElement): { tex: string; failed: boolean; display: boolean } {
  const failed = hasClass(node, "md-math-error") || node.attrs["data-md-math-error"] !== undefined;
  const display = hasClass(node, "md-math-block") || hasClass(node, "cm-lp-katex-display");
  const direct = node.attrs["data-md-math-src"];
  if (direct) return { tex: direct, failed: true, display };
  const annotation = findFirst(
    node,
    (el) => el.tag === "annotation" && (el.attrs.encoding ?? "").toLowerCase() === "application/x-tex",
  );
  if (annotation) return { tex: collectText(annotation).join(""), failed, display };
  // 退路：katex-html 里的可见文本（不是 TeX，但比空着强，且会记进警告）
  const visible = findFirst(node, (el) => hasClass(el, "katex-html"));
  const text = visible ? collectText(visible).join("").replace(/\s+/g, "") : "";
  return { tex: text, failed: true, display };
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
}

function inlinesFrom(node: HtmlNode, style: InlineStyle, warn: (w: ExportWarning) => void): ExportInline[] {
  if (node.type === "text") {
    const text = collapse(node.text);
    return text ? [{ kind: "text", text, ...style }] : [];
  }
  switch (node.tag) {
    case "input": {
      const checked = node.attrs.checked !== undefined;
      return [{ kind: "text", text: checked ? "☑ " : "☐ ", ...style }];
    }
    case "br":
      return [{ kind: "br" }];
    case "strong":
    case "b":
      return node.children.flatMap((c) => inlinesFrom(c, { ...style, bold: true }, warn));
    case "em":
    case "i":
      return node.children.flatMap((c) => inlinesFrom(c, { ...style, italic: true }, warn));
    case "del":
    case "s":
    case "strike":
      return node.children.flatMap((c) => inlinesFrom(c, { ...style, strike: true }, warn));
    case "sup":
      return node.children.flatMap((c) => inlinesFrom(c, { ...style, sup: true }, warn));
    case "sub":
      return node.children.flatMap((c) => inlinesFrom(c, { ...style, sub: true }, warn));
    case "code": {
      const text = collectText(node).join("").replace(/\s+/g, " ").trim();
      return text ? [{ kind: "code", text, ...style }] : [];
    }
    case "img": {
      const src = (node.attrs.src ?? node.attrs["data-md-src"] ?? "").trim();
      const alt = (node.attrs.alt ?? "").trim();
      const title = (node.attrs.title ?? "").trim();
      if (!src) return [];
      if (/^data:/i.test(src)) return [{ kind: "image", src, alt, title }];
      // 自包含导出里不该出现外链图片；万一出现，只占位、绝不下载
      warn({
        kind: "image-unsupported",
        message: `图片地址没有内嵌，导出时只保留占位：${src}`,
        detail: src,
      });
      return [{ kind: "place", text: alt || src, note: "图片未内嵌到自包含 HTML", ...style }];
    }
    case "a": {
      const href = (node.attrs.href ?? "").trim();
      const label = node.children.flatMap((c) => inlinesFrom(c, style, warn));
      const text = label.map((it) => it.text ?? "").join("") || href;
      if (hasClass(node, "md-link-bad")) {
        warn({ kind: "unsafe-link", message: `不安全的链接已按纯文本导出：${text}`, detail: text });
        return [{ kind: "text", text, ...style }];
      }
      if (!href) return label.length ? label : text ? [{ kind: "text", text, ...style }] : [];
      if (href.startsWith("#")) {
        warn({
          kind: "internal-link",
          message: "文档内锚点链接在导出格式里降级为普通文字（不建立跳转）",
          detail: href,
        });
        return [{ kind: "link", text, href, internal: true, ...style }];
      }
      if (!isSafeHref(href)) {
        warn({ kind: "unsafe-link", message: `链接地址不被信任，已降级为文字：${href}`, detail: href });
        return [{ kind: "text", text, ...style }];
      }
      return [{ kind: "link", text, href, ...style }];
    }
    case "span": {
      if (hasClass(node, "md-math") || hasClass(node, "cm-lp-katex")) {
        const { tex, failed, display } = mathTexOf(node);
        if (failed) warn({ kind: "math-failed", message: "公式渲染失败，导出为 TeX 原文", detail: tex });
        return [{ kind: "math", tex, display, failed }];
      }
      if (hasClass(node, "md-img-placeholder")) {
        const remote = node.attrs["data-remote-src"];
        const bad = node.attrs["data-md-error-src"];
        const reason = node.attrs["data-md-error"] ?? "";
        const label = collectText(node).join("").replace(/\s+/g, " ").trim();
        if (remote) {
          warn({ kind: "remote-image", message: `远程图片未下载（离线导出不联网）：${remote}`, detail: remote });
          return [{ kind: "place", text: label, note: `远程图片未下载：${remote}`, ...style }];
        }
        warn({
          kind: "image-error",
          message: `本地图片未能内嵌：${bad ?? ""}${reason ? `（${reason}）` : ""}`,
          detail: bad ?? reason,
        });
        return [{ kind: "place", text: label, note: reason || "图片读取失败", ...style }];
      }
      if (hasClass(node, "md-link-bad")) {
        const text = collectText(node).join("").replace(/\s+/g, " ").trim();
        warn({ kind: "unsafe-link", message: `不安全的链接已按纯文本导出：${text}`, detail: text });
        return [{ kind: "text", text, ...style }];
      }
      return node.children.flatMap((c) => inlinesFrom(c, style, warn));
    }
    case "math": {
      // 万一有裸 MathML（别人塞进来的），退回到可见文本
      const text = collectText(node).join("").replace(/\s+/g, "").trim();
      warn({ kind: "math-failed", message: "公式不是 TeX/KaTeX 输出，按可见文本导出", detail: text });
      return text ? [{ kind: "text", text, ...style }] : [];
    }
    case "svg": {
      const svg = svgSourceOf(node);
      if (svg) return [{ kind: "image", svg, alt: "", title: "" }];
      warn({ kind: "unsupported-tag", message: "SVG 图形含脚本特征，已丢弃（不导出可疑图形）" });
      return [];
    }
    default: {
      if (!KNOWN_INLINE.has(node.tag)) {
        warn({ kind: "unsupported-tag", message: `导出不认识的标签已按内容展开：<${node.tag}>` });
      }
      return node.children.flatMap((c) => inlinesFrom(c, style, warn));
    }
  }
}

const KNOWN_INLINE = new Set([
  "abbr",
  "bdi",
  "bdo",
  "cite",
  "dfn",
  "kbd",
  "mark",
  "q",
  "samp",
  "small",
  "span",
  "strong",
  "em",
  "i",
  "b",
  "u",
  "var",
  "time",
  "wbr",
  "a",
  "code",
  "sup",
  "sub",
  "del",
  "s",
  "img",
  "br",
  "svg",
]);

/* ------------------------------------------------------------------ *
 * 块级节点 → ExportBlock
 * ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
  "svg",
  "math",
]);

export function isBlockNode(node: HtmlNode): node is HtmlElement {
  return node.type === "element" && BLOCK_TAGS.has(node.tag);
}

function serialize(node: HtmlNode): string {
  if (node.type === "text") return escapeXml(node.text);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escapeXmlAttr(String(v))}"`))
    .join("");
  const inner = node.children.map(serialize).join("");
  return VOID_TAGS.has(node.tag) ? `<${node.tag}${attrs}/>` : `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/**
 * SVG 源码（把内联 SVG 当图片导出）。
 * 正文渲染器已不生成 SVG（图表功能已移除），这里只兜住别人塞进 HTML 的 `<svg>`。
 * 防御：只要出现 script / 事件属性 / javascript: 就返回 null（宁可不导出这张图）。
 */
export function svgSourceOf(node: HtmlElement): string | null {
  const svg = findFirst(node, (el) => el.tag === "svg");
  if (!svg) return null;
  const src = serialize(svg);
  if (/<script|\son[a-z]+\s*=|javascript:|<foreignObject/i.test(src)) return null;
  return src;
}

function codeBlockFromPre(pre: HtmlElement): { text: string; lang: string } {
  const code = pre.children.find((c): c is HtmlElement => c.type === "element" && c.tag === "code");
  const text = collectText(code ?? pre).join("").replace(/^\n/, "").replace(/\n$/, "");
  const cls = code ? classListOf(code).find((c) => c.startsWith("language-")) : undefined;
  const lang = (pre.attrs["data-lang"] ?? cls?.slice("language-".length) ?? "").trim();
  return { text, lang };
}

interface BlockCtx {
  warn: (w: ExportWarning) => void;
}

function trimInlines(inlines: ExportInline[]): ExportInline[] {
  const out = inlines.slice();
  while (out.length && out[0].kind === "text" && (out[0].text ?? "").trim() === "") out.shift();
  while (out.length && out[out.length - 1].kind === "text" && (out[out.length - 1].text ?? "").trim() === "") out.pop();
  if (out.length && out[0].kind === "text") out[0] = { ...out[0], text: (out[0].text ?? "").replace(/^ /, "") };
  if (out.length && out[out.length - 1].kind === "text") {
    const last = out[out.length - 1];
    out[out.length - 1] = { ...last, text: (last.text ?? "").replace(/ $/, "") };
  }
  return out;
}

function listItemsOf(list: HtmlElement, ctx: BlockCtx): ExportListItem[] {
  const items: ExportListItem[] = [];
  for (const child of list.children) {
    if (child.type !== "element" || child.tag !== "li") continue;
    const inlineNodes: HtmlNode[] = [];
    const blockNodes: HtmlNode[] = [];
    let seenBlock = false;
    for (const li of child.children) {
      if (isBlockNode(li)) {
        seenBlock = true;
        blockNodes.push(li);
      } else if (seenBlock) {
        // 块之后又回到行内：归入后续块，保证顺序不丢
        blockNodes.push(li);
      } else {
        inlineNodes.push(li);
      }
    }
    items.push({
      inlines: trimInlines(inlineNodes.flatMap((n) => inlinesFrom(n, {}, ctx.warn))),
      blocks: blocksFrom(blockNodes, ctx),
    });
  }
  return items;
}

function tableBlockOf(table: HtmlElement, ctx: BlockCtx): ExportBlock {
  const rows: { head: boolean; cells: ExportInline[][] }[] = [];
  const walk = (node: HtmlNode, isHead: boolean) => {
    if (node.type === "text") return;
    if (node.tag === "tr") {
      const cells = node.children
        .filter((c): c is HtmlElement => c.type === "element" && (c.tag === "td" || c.tag === "th"))
        .map((c) =>
          trimInlines(
            c.children.flatMap((cell) =>
              isBlockNode(cell) ? inlineOnlyOf(cell, ctx) : inlinesFrom(cell, {}, ctx.warn),
            ),
          ),
        );
      rows.push({
        head: isHead || node.children.some((c) => c.type === "element" && c.tag === "th"),
        cells,
      });
      return;
    }
    const nextHead = isHead || node.tag === "thead";
    for (const child of node.children) walk(child, nextHead);
  };
  walk(table, false);
  const headRows = rows.filter((r) => r.head).map((r) => r.cells);
  const body = rows.filter((r) => !r.head).map((r) => r.cells);
  const headRow = headRows.length ? headRows[0] : body.shift() ?? [];
  return { kind: "table", head: headRow, rows: body };
}

/** 单元格里的块级内容（少见）：只取其中的行内文本，避免丢字 */
function inlineOnlyOf(node: HtmlElement, ctx: BlockCtx): ExportInline[] {
  const out: ExportInline[] = [];
  for (const child of node.children) {
    if (child.type === "text") out.push(...inlinesFrom(child, {}, ctx.warn));
    else if (isBlockNode(child)) out.push(...inlineOnlyOf(child, ctx));
    else out.push(...inlinesFrom(child, {}, ctx.warn));
  }
  return out;
}

const KNOWN_BLOCK_CONTAINER = new Set([
  "div",
  "section",
  "article",
  "aside",
  "main",
  "header",
  "footer",
  "li",
  "dd",
  "dt",
  "dl",
  "details",
  "figcaption",
  "figure",
  "address",
  "form",
  "fieldset",
  "nav",
]);

function blocksFrom(nodes: HtmlNode[], ctx: BlockCtx): ExportBlock[] {
  const out: ExportBlock[] = [];
  let pending: ExportInline[] = [];
  const flush = () => {
    const inlines = trimInlines(pending);
    pending = [];
    if (inlines.length) out.push({ kind: "para", inlines });
  };

  for (const node of nodes) {
    if (node.type === "text") {
      pending.push(...inlinesFrom(node, {}, ctx.warn));
      continue;
    }
    const tag = node.tag;
    if (/^h[1-6]$/.test(tag)) {
      flush();
      out.push({
        kind: "heading",
        level: Number(tag[1]),
        inlines: trimInlines(node.children.flatMap((c) => inlinesFrom(c, {}, ctx.warn))),
        id: node.attrs.id ?? undefined,
      });
      continue;
    }
    if (tag === "p") {
      flush();
      const inlines = trimInlines(
        node.children.flatMap((c) => (isBlockNode(c) ? inlineOnlyOf(c, ctx) : inlinesFrom(c, {}, ctx.warn))),
      );
      if (inlines.length) out.push({ kind: "para", inlines });
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      flush();
      out.push({ kind: "list", ordered: tag === "ol", items: listItemsOf(node, ctx) });
      continue;
    }
    if (tag === "blockquote") {
      flush();
      if (hasClass(node, "md-callout")) {
        const titleEl = findFirst(node, (el) => hasClass(el, "md-callout-title"));
        const bodyEl = findFirst(node, (el) => hasClass(el, "md-callout-body"));
        const variant = classListOf(node).find((c) => c.startsWith("md-callout-"))?.slice(11) ?? "note";
        const title = titleEl ? collectText(titleEl).join("").replace(/\s+/g, " ").trim() : null;
        out.push({
          kind: "callout",
          variant,
          title,
          blocks: bodyEl ? blocksFrom(bodyEl.children, ctx) : blocksFrom(node.children, ctx),
        });
      } else {
        out.push({ kind: "quote", blocks: blocksFrom(node.children, ctx) });
      }
      continue;
    }
    if (tag === "pre") {
      flush();
      const code = codeBlockFromPre(node);
      out.push({ kind: "code", text: code.text, lang: code.lang, origin: "code" });
      continue;
    }
    if (tag === "table") {
      flush();
      out.push(tableBlockOf(node, ctx));
      continue;
    }
    if (tag === "hr") {
      flush();
      out.push({ kind: "rule" });
      continue;
    }
    if (tag === "nav" && hasClass(node, "md-toc")) {
      flush();
      const titleEl = findFirst(node, (el) => hasClass(el, "md-toc-title"));
      const title = titleEl ? collectText(titleEl).join("").replace(/\s+/g, " ").trim() : "";
      const items: ExportNavItem[] = [];
      for (const li of findAll(node, (el) => el.tag === "li")) {
        const a = findFirst(li, (el) => el.tag === "a");
        if (!a) continue;
        const level = classListOf(li).find((c) => c.startsWith("lvl-"));
        items.push({
          text: collectText(a).join("").replace(/\s+/g, " ").trim(),
          level: level ? Number(level.slice(4)) || 1 : 1,
          href: (a.attrs.href ?? "").trim(),
        });
      }
      out.push({ kind: "nav", title: title || "目录", items });
      continue;
    }
    if (tag === "section" && hasClass(node, "md-footnotes")) {
      flush();
      const items = findAll(node, (el) => el.tag === "li").map((li, index) => ({
        id: li.attrs.id ?? `fn-${index + 1}`,
        inlines: trimInlines(inlineOnlyOf(li, ctx)),
      }));
      out.push({ kind: "footnotes", items });
      continue;
    }
    // 复杂块回退：既认类名，也认 mdExport 的规范属性 data-md-fallback
    if (hasClass(node, "md-source-fallback") || node.attrs["data-md-fallback"] !== undefined) {
      flush();
      const noteEl = findFirst(node, (el) => hasClass(el, "md-source-fallback-note"));
      const pre = findFirst(node, (el) => el.tag === "pre");
      const note = noteEl ? collectText(noteEl).join("").replace(/\s+/g, " ").trim() : "";
      const text = pre ? codeBlockFromPre(pre).text : collectText(node).join("");
      ctx.warn({
        kind: "source-fallback",
        message: `复杂块未渲染，已按源码完整保留：${note || "（无说明）"}`,
        detail: text.split("\n").slice(0, 3).join(" / ").slice(0, 120),
      });
      out.push({ kind: "code", text, lang: "markdown", origin: "fallback", note });
      continue;
    }
    if (hasClass(node, "md-math-block") || (hasClass(node, "md-math") && hasClass(node, "cm-lp-katex-block"))) {
      flush();
      const { tex, failed } = mathTexOf(node);
      if (failed) ctx.warn({ kind: "math-failed", message: "公式渲染失败，导出为 TeX 原文", detail: tex });
      out.push({ kind: "math", tex, display: true, failed });
      continue;
    }
    if (tag === "img" || tag === "svg") {
      flush();
      out.push({ kind: "image", inlines: inlinesFrom(node, {}, ctx.warn) });
      continue;
    }
    if (isBlockNode(node)) {
      flush();
      if (!KNOWN_BLOCK_CONTAINER.has(tag)) {
        // 不认识的容器：保留其纯文本内容 + 明确说明，绝不静默丢弃
        const text = collectText(node).join("").trim();
        ctx.warn({ kind: "unsupported-tag", message: `导出不认识的容器已按纯文本保留：<${tag}>` });
        if (text) out.push({ kind: "raw", note: `<${tag}> 内容未识别，按纯文本保留`, text });
        continue;
      }
      out.push(...blocksFrom(node.children, ctx));
      continue;
    }
    // 走到这里 node 一定是元素（文本与块级元素都已分流）
    const el = node as HtmlElement;
    if (!KNOWN_INLINE.has(tag) && el.children.some(isBlockNode)) {
      // 不认识的标签里套着块级内容：我们不知道该怎么映射，
      // 就把它当「保留原文的降级块」——文字一字不丢，并明确告知用户。
      flush();
      const text = collectText(el).join("").trim();
      ctx.warn({ kind: "unsupported-tag", message: `导出不认识的容器已按纯文本保留：<${tag}>` });
      if (text) out.push({ kind: "raw", note: `<${tag}> 内容未识别，按纯文本保留`, text });
      continue;
    }
    pending.push(...inlinesFrom(el, {}, ctx.warn));
  }
  flush();
  return out;
}

export interface ParseExportHtmlResult {
  blocks: ExportBlock[];
  warnings: ExportWarning[];
}

/** 自包含 HTML → 块模型（+ 降级警告） */
export function parseExportHtml(html: string): ParseExportHtmlResult {
  const warnings: ExportWarning[] = [];
  const ctx: BlockCtx = { warn: (w) => pushWarning(warnings, w) };
  const tree = parseHtmlTree(html);
  const main = findFirst(tree, (el) => el.tag === "main") ?? tree;
  const blocks = blocksFrom(main.children, ctx);
  return { blocks, warnings };
}

/* ------------------------------------------------------------------ *
 * 块模型 → XHTML（EPUB 用）
 * ------------------------------------------------------------------ */

export interface RenderXhtmlOptions {
  /** 图片解析：返回图片在包内的相对地址；返回 null 表示这张图在目标格式里放不下（降级为文字） */
  resolveImage?: (inline: ExportInline) => string | null;
  /** 标题 id 生成（EPUB 导航需要）；level 为标题级别（1-6） */
  headingId?: (text: string, index: number, level: number) => string;
  onImageDropped?: (inline: ExportInline) => void;
}

function renderInlines(inlines: ExportInline[], opts: RenderXhtmlOptions): string {
  const out: string[] = [];
  for (const it of inlines) {
    switch (it.kind) {
      case "text": {
        let html = escapeXml(it.text ?? "");
        if (it.bold) html = `<strong>${html}</strong>`;
        if (it.italic) html = `<em>${html}</em>`;
        if (it.strike) html = `<del>${html}</del>`;
        if (it.sup) html = `<sup>${html}</sup>`;
        if (it.sub) html = `<sub>${html}</sub>`;
        out.push(html);
        break;
      }
      case "code":
        out.push(`<code>${escapeXml(it.text ?? "")}</code>`);
        break;
      case "link": {
        const label = escapeXml(it.text ?? "");
        if (it.internal || !isSafeHref(it.href ?? "")) out.push(label);
        else out.push(`<a href="${escapeXmlAttr(it.href ?? "")}">${label}</a>`);
        break;
      }
      case "image": {
        const href = opts.resolveImage ? opts.resolveImage(it) : null;
        if (href) {
          out.push(`<img class="md-img" src="${escapeXmlAttr(href)}" alt="${escapeXmlAttr(it.alt ?? "")}"/>`);
        } else {
          opts.onImageDropped?.(it);
          out.push(
            `<span class="md-img-missing">⚠ ${escapeXml(it.alt || "图片")}（该图片在本格式里无法嵌入）</span>`,
          );
        }
        break;
      }
      case "math":
        out.push(`<code class="md-math-src${it.failed ? " failed" : ""}">${escapeXml(it.tex ?? "")}</code>`);
        break;
      case "place":
        out.push(`<span class="md-img-missing">${escapeXml(it.text || it.note || "内容缺失")}</span>`);
        break;
      case "br":
        out.push("<br/>");
        break;
    }
  }
  return out.join("");
}

function renderBlocks(
  blocks: ExportBlock[],
  opts: RenderXhtmlOptions,
  counter: { n: number } = { n: 0 },
): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "heading": {
        const id = opts.headingId ? opts.headingId(inlineText(b.inlines), counter.n++, b.level) : b.id;
        out.push(
          `<h${b.level}${id ? ` id="${escapeXmlAttr(id)}"` : ""}>${renderInlines(b.inlines, opts)}</h${b.level}>`,
        );
        break;
      }
      case "para":
        out.push(`<p>${renderInlines(b.inlines, opts)}</p>`);
        break;
      case "math":
        out.push(`<p class="md-math-block${b.failed ? " failed" : ""}"><code>${escapeXml(b.tex)}</code></p>`);
        break;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items
          .map((it) => `<li>${renderInlines(it.inlines, opts)}${renderBlocks(it.blocks, opts, counter)}</li>`)
          .join("");
        out.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case "quote":
        out.push(`<blockquote>${renderBlocks(b.blocks, opts, counter)}</blockquote>`);
        break;
      case "callout":
        out.push(
          `<aside class="callout callout-${escapeXmlAttr(b.variant)}">${
            b.title ? `<p class="callout-title">${escapeXml(b.title)}</p>` : ""
          }${renderBlocks(b.blocks, opts, counter)}</aside>`,
        );
        break;
      case "code":
        out.push(
          `<div class="code${b.origin !== "code" ? " code-degraded" : ""}">${
            b.note ? `<p class="code-note">⚠ ${escapeXml(b.note)}</p>` : ""
          }<pre><code${
            b.lang ? ` class="language-${escapeXmlAttr(b.lang)}"` : ""
          }>${escapeXml(b.text)}</code></pre></div>`,
        );
        break;
      case "table": {
        const head = b.head.length
          ? `<thead><tr>${b.head.map((c) => `<th>${renderInlines(c, opts)}</th>`).join("")}</tr></thead>`
          : "";
        const rows = b.rows
          .map((row) => `<tr>${row.map((c) => `<td>${renderInlines(c, opts)}</td>`).join("")}</tr>`)
          .join("");
        out.push(`<table>${head}<tbody>${rows}</tbody></table>`);
        break;
      }
      case "rule":
        out.push("<hr/>");
        break;
      case "image":
        out.push(`<p>${renderInlines(b.inlines, opts)}</p>`);
        break;
      case "nav":
        out.push(
          `<nav class="toc"><p class="toc-title">${escapeXml(b.title)}</p><ol>${b.items
            .map((it) => `<li class="lvl-${it.level}">${escapeXml(it.text)}</li>`)
            .join("")}</ol></nav>`,
        );
        break;
      case "footnotes":
        out.push(
          `<section class="footnotes"><hr/><ol>${b.items
            .map((it) => `<li id="${escapeXmlAttr(it.id)}">${renderInlines(it.inlines, opts)}</li>`)
            .join("")}</ol></section>`,
        );
        break;
      case "raw":
        out.push(`<div class="raw"><p class="raw-note">⚠ ${escapeXml(b.note)}</p><pre>${escapeXml(b.text)}</pre></div>`);
        break;
    }
  }
  return out.join("");
}

/** 行内序列的纯文本（标题文字、章节名等） */
export function inlineText(inlines: ExportInline[]): string {
  return inlines
    .map((it) => it.text ?? it.tex ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderBlocksToXhtml(blocks: ExportBlock[], opts: RenderXhtmlOptions = {}): string {
  return renderBlocks(blocks, opts);
}
