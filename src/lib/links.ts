/*
 * 文档内链接解析（对应 Typora 的本地链接与跨文档跳转）。
 *
 * 支持三类写法：
 *   [文本](#某标题)             → 当前文档内锚点
 *   [文本](sub/other.md)        → 工作区内另一个 Markdown 文件
 *   [文本](sub/other.md#标题)   → 另一个文件 + 锚点
 * 目标文件不存在时返回 kind: "missing"，由调用方询问是否创建。
 */
import { extractOutline } from "./outline";
import { buildFootnoteIndex, collectLinkDefs, normalizeLabel, footnoteSlug } from "./mdExport";
import type { FootnoteDefinition, FootnoteIndex } from "./mdExport";

export type LinkTarget =
  | { kind: "anchor"; anchor: string }
  | { kind: "file"; path: string; anchor?: string }
  | { kind: "missing"; path: string; anchor?: string }
  | { kind: "external"; href: string };

function decodeLink(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      else return ""; // 越出工作区，视为非法
    } else parts.push(seg);
  }
  return parts.join("/");
}

export function resolveLink(href: string, activePath: string | null, files: string[]): LinkTarget {
  if (EXTERNAL_RE.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) {
    return { kind: "external", href };
  }
  const raw = href.trim();
  const hashAt = raw.indexOf("#");
  const target = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const anchorRaw = hashAt === -1 ? "" : raw.slice(hashAt + 1);
  const anchor = anchorRaw ? decodeLink(anchorRaw) : "";
  if (!target) return { kind: "anchor", anchor };

  const decoded = decodeLink(target);
  if (/^[a-z]+:/i.test(decoded)) return { kind: "external", href: decoded };
  const dir = activePath && activePath.includes("/") ? activePath.slice(0, activePath.lastIndexOf("/")) : "";
  const joined = dir ? dir + "/" + decoded : decoded;
  const rel = normalize(joined);
  if (!rel) return { kind: "external", href: decoded };
  const withExt = /\.[a-z0-9]+$/i.test(rel) ? rel : rel + ".md";
  const hit =
    files.find((f) => f === withExt) ??
    files.find((f) => f.toLowerCase() === withExt.toLowerCase()) ??
    files.find((f) => f.endsWith("/" + withExt));
  if (hit) return { kind: "file", path: hit, anchor: anchor || undefined };
  return { kind: "missing", path: withExt, anchor: anchor || undefined };
}

/** 生成与 Typora/GitHub 类似的锚点：小写、去标点、空格换连字符 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
}

/** 按序号找脚注（`#fn-2` 这类只有序号、没有标签的锚点） */
function footnoteByNumber(idx: FootnoteIndex, s: string): FootnoteDefinition | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return idx.defOrder.find((d) => d.number === n);
}

/**
 * 脚注锚点 → 源码位置。
 * 支持 `fn-<标签>` / `fn-<序号>`（脚注定义）与
 * `fnref-<标签>` / `fnref-<标签>-<第几次>` / `fnref-<序号>`（引用）。
 */
export function findFootnoteAnchorPos(content: string, anchor: string): number | null {
  const raw = anchor.trim().replace(/^#/, "");
  const ref = /^fnref-(.+)$/.exec(raw);
  const defOrCaret = /^(?:fn-|\^)(.+)$/.exec(raw);
  if (!ref && !defOrCaret) return null;
  const idx = buildFootnoteIndex(content);

  if (ref) {
    const want = ref[1].trim();
    const hit = idx.refById.get(`fnref-${want}`);
    if (hit) return hit.pos;
    // 退化 1：只有序号 → 该脚注的首次引用
    const byNum = footnoteByNumber(idx, want) ?? idx.defs.get(normalizeLabel(want));
    const first = byNum ? idx.refs.get(byNum.key)?.[0] : undefined;
    if (first) return first.pos;
    // 退化 2：`fnref-x-2` 里 x 自带连字符时拆不出标签，用「标签 + 序号」再试一次
    const tail = /^(.*)-(\d+)$/.exec(want);
    if (tail) {
      const ordinal = Number(tail[2]);
      const list = idx.refs.get(normalizeLabel(tail[1]));
      const nth = list?.find((r) => r.ordinal === ordinal);
      if (nth) return nth.pos;
    }
    return null;
  }

  const want = (defOrCaret as RegExpExecArray)[1].trim();
  const def =
    idx.defById.get(`fn-${want}`) ??
    idx.defs.get(normalizeLabel(want)) ??
    (idx.defById.get(`fn-${footnoteSlug(want)}`) as FootnoteDefinition | undefined) ??
    footnoteByNumber(idx, want);
  return def ? def.from : null;
}

/** 引用式链接/图片定义锚点（`#ref-x`、`#def-x` 或直接写标签）→ 定义行位置 */
export function findLinkDefAnchorPos(content: string, anchor: string): number | null {
  const prefixed = /^(?:ref|def)-(.+)$/.exec(anchor.trim());
  const label = normalizeLabel(prefixed ? prefixed[1] : anchor);
  if (!label) return null;
  const def = collectLinkDefs(content).get(label);
  return def ? def.from : null;
}

/**
 * 在文档里按锚点找到源码位置；找不到返回 null。
 * 依次尝试：标题锚点 → 脚注定义/引用 → 标题模糊匹配 → 引用式链接定义。
 */
export function findAnchorPos(content: string, anchor: string): number | null {
  if (!anchor) return null;
  const decoded = decodeLink(anchor);
  const bare = decoded.trim().replace(/^#/, "");
  if (!bare) return null;
  const want = slugifyHeading(bare);
  const items = extractOutline(content);
  for (const it of items) {
    if (slugifyHeading(it.text) === want) return it.from;
  }
  const fnPos = findFootnoteAnchorPos(content, bare);
  if (fnPos !== null) return fnPos;
  // 退化：纯文本包含匹配（中文标题里带空格/标点时常见）
  const plain = bare.replace(/[-_]/g, "");
  for (const it of items) {
    if (it.text.replace(/[\s\-_]/g, "").includes(plain)) return it.from;
  }
  return findLinkDefAnchorPos(content, bare);
}

