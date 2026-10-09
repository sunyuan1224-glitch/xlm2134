/*
 * 本地图片自包含 HTML 导出。
 *
 * 目标：导出的**一个** HTML 文件在离线分发时就能看到全部插图，并且
 * 绝不因为 HTML 里的 <img> 触发任何网络请求。
 *
 * 处理顺序：
 *   1. markdownToHtml(...) 生成 HTML。新版的图片地址写在 data-md-src（不写 src），
 *      所以即使有人用 innerHTML 把它塞进页面也不会自动发请求；
 *      这里同时兼容旧输出里的 src / data-src，读取时按 data-md-src → src → data-src 取第一个；
 *   2. 逐个 <img> 判断地址种类：
 *        - data:            → 直接写进 src（本来就是内嵌图，例如即时预览的产物）；
 *        - http(s)://、// → **只占位、不下载**，换成带原地址的占位块；
 *        - 工作区内的相对路径 → api.readImageDataUrl 读成 data URL 后写进 src，
 *          嵌入成功后删除 data-md-src（读取只发生在工作区内，且只读显式引用的文件）；
 *        - 工作区外的绝对路径 / 其他协议 / 越出工作区的 `..` → 记为错误；
 *   3. 任何本地图片读取失败都进 errors（明确报错），绝不静默丢图；
 *   4. 全程只做字符串级处理，不创建 DOM、不插入文档，所以不存在「解析时就加载图片」。
 *
 * markdownToHtml 的 baseDir 选项会让图片地址变成「相对工作区」，
 * 本模块约定地址是「相对当前文档」的，因此调用方不要传 baseDir，
 * 由这里用 opts.baseDir（当前文档所在目录）统一解析。
 */
import { markdownToHtml } from "./mdExport";
import { api } from "../api";

/** 导出 HTML 的安全策略：不允许脚本、不允许任何网络来源，只允许内嵌 data: 图片 */
export const EXPORT_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface ImageIssue {
  /** Markdown 里写的原始地址 */
  src: string;
  /** 解析后的工作区相对路径（解析失败时为 null） */
  path: string | null;
  reason: string;
}

export interface EmbedImagesOptions {
  /** 工作区根目录；为空表示没有工作区，本地图片一律算错误 */
  root: string | null;
  /** 当前文档所在目录（工作区相对路径），用来解析相对图片地址 */
  baseDir?: string;
  /** 读取图片为 data URL；默认走 Tauri 的 read_image_data_url。测试可注入替身 */
  readImage?: (root: string, path: string) => Promise<string | null>;
  /** 占位块样式类名前缀 */
  placeholderClass?: string;
}

export interface EmbedImagesResult {
  html: string;
  /** 从工作区读出来并内嵌的本地图片数 */
  embedded: number;
  /** 本来就是 data: 地址的图片数 */
  inline: number;
  /** 远程图片数（只占位，未下载） */
  remote: number;
  errors: ImageIssue[];
}

export type ImageRefKind = "inline" | "remote" | "local" | "absolute" | "unsupported";

/* ------------------------------------------------------------------ *
 * 文本与属性工具
 * ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** 还原 HTML 实体（图片 alt/title 是转义过的，显示与判断前先还原） */
export function unescapeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 只转义会破坏双引号属性值的字符，单引号（CSP 里的 'none'）保持原样 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface TagAttr {
  name: string;
  /** 原始（仍带转义）的属性值；无值属性为 null */
  value: string | null;
}

/** 解析 <img ...> 里的属性表，保留原始书写顺序与转义 */
export function parseImgAttrs(inner: string): TagAttr[] {
  const out: TagAttr[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s/]/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const nameStart = i;
    while (i < inner.length && !/[\s=/]/.test(inner[i])) i++;
    const name = inner.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    while (i < inner.length && /\s/.test(inner[i])) i++;
    let value: string | null = null;
    if (inner[i] === "=") {
      i++;
      while (i < inner.length && /\s/.test(inner[i])) i++;
      const quote = inner[i];
      if (quote === '"' || quote === "'") {
        i++;
        const close = inner.indexOf(quote, i);
        const stop = close === -1 ? inner.length : close;
        value = inner.slice(i, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < inner.length && !/\s/.test(inner[i])) i++;
        value = inner.slice(vs, i);
      }
    }
    out.push({ name, value });
  }
  return out;
}

/** 取属性值（已还原实体）；没有该属性或属性无值返回 null */
export function attrOf(attrs: TagAttr[], name: string): string | null {
  const hit = attrs.find((a) => a.name === name && a.value !== null);
  return hit && hit.value !== null ? unescapeEntities(hit.value) : null;
}

/** 找出全部 <img ...> 标签（按引号配对定位结束的 `>`），带位置信息 */
export function findImgTags(html: string): { start: number; end: number; tag: string }[] {
  const out: { start: number; end: number; tag: string }[] = [];
  const re = /<img[\s/>]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const start = m.index;
    let i = start + 4;
    let quote: string | null = null;
    while (i < html.length) {
      const ch = html[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      i++;
    }
    const end = i < html.length ? i + 1 : html.length;
    out.push({ start, end, tag: html.slice(start, end) });
    re.lastIndex = end;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 地址分类
 * ------------------------------------------------------------------ */

export function classifyImageRef(src: string): ImageRefKind {
  const s = src.trim();
  if (/^data:/i.test(s)) return "inline";
  if (/^(?:https?|ftps?|wss?):/i.test(s) || s.startsWith("//")) return "remote";
  if (/^[a-z]:[\\/]/i.test(s)) return "absolute";
  if (/^file:/i.test(s)) return "unsupported";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "unsupported";
  if (/^[\\/]/.test(s)) return "absolute";
  return "local";
}

function normalizeRel(input: string, label: string): { path?: string; error?: string } {
  const stack: string[] = [];
  for (const seg of input.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!stack.length) return { error: `${label}越出工作区范围` };
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (!stack.length) return { error: `${label}为空` };
  return { path: stack.join("/") };
}

/** 相对地址 → 工作区相对路径；越界、空路径返回 error（不猜、不与工作区外的文件打交道） */
export function resolveLocalImagePath(baseDir: string, src: string): { path?: string; error?: string } {
  const trimmed = src.trim();
  if (!trimmed) return { error: "图片地址为空" };
  const bare = trimmed.split(/[?#]/)[0];
  if (!bare) return { error: `图片地址只有查询/锚点：${src}` };
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    /* 不是合法百分号编码，就按原样用 */
  }
  const dir = (baseDir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalizeRel(dir ? `${dir}/${decoded}` : decoded, `图片路径 ${src}`);
}

/* ------------------------------------------------------------------ *
 * 占位块
 * ------------------------------------------------------------------ */

function fileNameOf(src: string): string {
  const bare = src.split(/[?#]/)[0].replace(/\\/g, "/");
  const parts = bare.split("/");
  return parts[parts.length - 1] || src;
}

function remotePlaceholder(src: string, alt: string, title: string, cls: string): string {
  const label = alt || fileNameOf(src) || src;
  return (
    `<span class="${escapeAttr(cls)} md-img-remote" data-remote-src="${escapeAttr(src)}"` +
    ` title="${escapeAttr(title || "远程图片未下载")}" role="img">` +
    `🖼 ${escapeText(label)}（远程图片，未下载：${escapeText(src)}）</span>`
  );
}

function errorPlaceholder(src: string, alt: string, reason: string, cls: string): string {
  const label = alt || fileNameOf(src) || src;
  return (
    `<span class="${escapeAttr(cls)} md-img-error" data-md-error-src="${escapeAttr(src)}"` +
    ` data-md-error="${escapeAttr(reason)}" role="img">` +
    `⚠ ${escapeText(label)}（图片未能内嵌：${escapeText(reason)}）</span>`
  );
}

/*
 * 永远丢弃的源属性：srcset 里的候选地址可能是网络地址，
 * 而自包含导出只需要一个已经内嵌好的 src（CSP 也会兜住这些请求）。
 */
const NEVER_KEEP = ["srcset", "imagesrcset", "data-srcset"];

/** 重建 <img>：写回 src，按需删除 data-md-src 等标记属性 */
function renderImg(attrs: TagAttr[], src: string, drop: string[]): string {
  const kept = attrs.filter(
    (a) => a.name !== "src" && !NEVER_KEEP.includes(a.name) && !drop.includes(a.name),
  );
  const rest = kept
    .map((a) => (a.value === null ? a.name : `${a.name}="${a.value}"`))
    .join(" ");
  return `<img src="${escapeAttr(src)}"${rest ? " " + rest : ""}>`;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const defaultReadImage = (root: string, path: string): Promise<string | null> =>
  api.readImageDataUrl(root, path);

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 把 HTML 里的图片内嵌成 data URL，并让远程图片变成占位块。
 * 不修改入参，返回新的 HTML 与统计/错误清单。
 */
export async function embedWorkspaceImages(
  html: string,
  opts: EmbedImagesOptions,
): Promise<EmbedImagesResult> {
  const readImage = opts.readImage ?? defaultReadImage;
  const cls = opts.placeholderClass ?? "md-img-placeholder";
  const cache = new Map<string, string | null>();
  const errors: ImageIssue[] = [];
  const out: string[] = [];
  let cursor = 0;
  let embedded = 0;
  let inline = 0;
  let remote = 0;

  for (const { start, end, tag } of findImgTags(html)) {
    out.push(html.slice(cursor, start));
    cursor = end;
    const attrs = parseImgAttrs(tag.replace(/^<img/i, "").replace(/>$/, ""));
    const src = (attrOf(attrs, "data-md-src") ?? attrOf(attrs, "src") ?? attrOf(attrs, "data-src") ?? "").trim();
    const alt = (attrOf(attrs, "alt") ?? "").trim();
    const title = (attrOf(attrs, "title") ?? "").trim();
    if (!src) {
      out.push(tag);
      continue;
    }
    const kind = classifyImageRef(src);
    if (kind === "inline") {
      inline++;
      out.push(renderImg(attrs, src, ["data-md-src", "data-src"]));
      continue;
    }
    if (kind === "remote") {
      remote++;
      out.push(remotePlaceholder(src, alt, title, cls));
      continue;
    }
    if (kind === "absolute" || kind === "unsupported") {
      const reason =
        kind === "absolute"
          ? "工作区外的绝对路径，只导出工作区内的本地图片"
          : `不支持的图片地址协议：${src}`;
      errors.push({ src, path: null, reason });
      out.push(errorPlaceholder(src, alt, reason, cls));
      continue;
    }
    if (!opts.root) {
      const reason = "尚未打开工作区，无法读取本地图片";
      errors.push({ src, path: null, reason });
      out.push(errorPlaceholder(src, alt, reason, cls));
      continue;
    }
    const resolved = resolveLocalImagePath(opts.baseDir ?? "", src);
    const path = resolved.path;
    if (!path) {
      const reason = resolved.error ?? `非法图片路径：${src}`;
      errors.push({ src, path: null, reason });
      out.push(errorPlaceholder(src, alt, reason, cls));
      continue;
    }
    if (!cache.has(path)) {
      try {
        cache.set(path, await readImage(opts.root, path));
      } catch (e) {
        cache.set(path, null);
        const reason = `读取本地图片失败：${errText(e)}`;
        errors.push({ src, path, reason });
        out.push(errorPlaceholder(src, alt, reason, cls));
        continue;
      }
    }
    const dataUrl = cache.get(path) ?? null;
    if (!dataUrl || !/^data:/i.test(dataUrl)) {
      const reason = "未找到该图片文件（或不是支持的图片格式）";
      errors.push({ src, path, reason });
      out.push(errorPlaceholder(src, alt, `找不到 ${path}`, cls));
      continue;
    }
    embedded++;
    out.push(renderImg(attrs, dataUrl, ["data-md-src", "data-src"]));
  }
  out.push(html.slice(cursor));
  return { html: out.join(""), embedded, inline, remote, errors };
}

const PLACEHOLDER_CSS = `<style>
.md-img-placeholder { display: inline-block; border: 1px dashed #d9a7b9; border-radius: 8px;
  padding: .35em .7em; margin: .2em 0; background: #fdf3f7; color: #7a6871; font-size: .92em; }
.md-img-remote { border-color: #a08b95; }
.md-img-error { border-color: #b3261e; color: #b3261e; }
</style>
`;

function insertInHead(html: string, snippet: string): string {
  const close = html.search(/<\/head\s*>/i);
  if (close >= 0) return html.slice(0, close) + snippet + html.slice(close);
  const open = /<head[^>]*>/i.exec(html);
  if (open) {
    const at = open.index + open[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  return snippet + html;
}

/** 注入 CSP（已存在则不重复注入） */
export function injectCsp(html: string, policy: string = EXPORT_CSP): string {
  if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html)) return html;
  return insertInHead(
    html,
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy)}">\n`,
  );
}

export interface SelfContainedOptions extends EmbedImagesOptions {
  /** 完整文档；false 时只返回内嵌处理后的片段（供剪贴板复制） */
  standalone?: boolean;
  /** 是否注入 CSP（默认跟随 standalone） */
  csp?: boolean;
  /** 是否注入占位块样式（默认跟随 standalone） */
  placeholderStyles?: boolean;
}

export interface SelfContainedResult extends EmbedImagesResult {
  html: string;
  /** 实际注入的 CSP 内容；未注入为 null */
  csp: string | null;
}

/**
 * Markdown → 自包含 HTML。
 * 本地图片：读成 data URL 内嵌；远程图片：占位不下载；本地读取失败：进 errors。
 */
export async function buildSelfContainedHtml(
  md: string,
  title: string,
  opts: SelfContainedOptions,
): Promise<SelfContainedResult> {
  const standalone = opts.standalone !== false;
  const rendered = markdownToHtml(md, title, { standalone });
  const res = await embedWorkspaceImages(rendered, opts);
  let html = res.html;
  let applied: string | null = null;
  if (standalone) {
    if (opts.placeholderStyles !== false) html = insertInHead(html, PLACEHOLDER_CSS);
    if (opts.csp !== false) {
      applied = EXPORT_CSP;
      html = injectCsp(html, applied);
    }
  }
  return { ...res, html, csp: applied };
}

/** 错误清单 → 一行可读文字（状态栏用） */
export function describeIssues(issues: ImageIssue[], limit = 3): string {
  const shown = issues.slice(0, limit).map((it) => {
    const where = it.path ?? it.src;
    return `${where}（${it.reason}）`;
  });
  const more = issues.length > shown.length ? ` 等 ${issues.length} 项` : "";
  return shown.join("；") + more;
}

/** 导出/复制结果 → 状态栏摘要 */
export function summarizeExport(
  prefix: string,
  res: Pick<EmbedImagesResult, "embedded" | "inline" | "remote" | "errors">,
  limit = 3,
): string {
  const notes: string[] = [];
  if (res.embedded) notes.push(`已内嵌本地图片 ${res.embedded} 张`);
  if (res.inline) notes.push(`内嵌图片 ${res.inline} 张`);
  if (res.remote) notes.push(`远程图片 ${res.remote} 张仅占位未下载`);
  if (res.errors.length) notes.push(`本地图片失败 ${res.errors.length} 张：${describeIssues(res.errors, limit)}`);
  return notes.length ? `${prefix}（${notes.join("；")}）` : prefix;
}
