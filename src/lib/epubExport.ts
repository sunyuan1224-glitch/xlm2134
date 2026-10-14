/*
 * 离线 EPUB 3 导出（真实 OCF 容器：mimetype + META-INF/container.xml + OEBPS/*，绝不是 HTML 改后缀）。
 *
 * 数据流：
 *   每章 Markdown → buildSelfContainedHtml（本地图片内嵌、远程图占位）
 *                 → parseExportHtml（块模型 + 降级警告）
 *                 → renderBlocksToXhtml（严格 XHTML，全部经 escapeXml 转义）
 *   图片 data URL → 取出字节写进 OEBPS/images/image-N.ext，并在 OPF manifest 登记
 *   全部部件 → fflate 打成 ZIP（mimetype 必须是**第一个条目且不压缩**，这是 OCF 的硬要求）
 *
 * 明确保证：
 *   1. 结构合规：mimetype 在偏移 30、未压缩；container.xml 指向 OPF；
 *      OPF 有 dc:identifier/dc:title/dc:language + dcterms:modified；
 *      同时生成 EPUB3 nav 与 EPUB2 兼容的 toc.ncx（老阅读器也能看见目录）；
 *      章节可带 volume：nav 卷套章（li → 嵌套 ol）、ncx 嵌套 navPoint、playOrder 递增，
 *      并可选生成极简分卷页（text/volume-N.xhtml，卷标题 + 引言）；不传 volume 则目录扁平；
 *   2. 离线：不联网、不下载远程图片（远程图在 HTML 阶段就变成占位文字）；
 *   3. 降级可见：复杂块源码、读不到的图片，都以可见文字/代码留在书里，
 *      并在报告里逐条列出，绝不静默丢内容；
 *   4. 文件名与 id 全部由本模块生成（image-1.png、text/chapter-1.xhtml），
 *      用户输入只出现在被转义的文本里 —— 目录穿越在结构上不可能出现。
 */
import { zipSync, type ZipOptions } from "fflate";
import { buildSelfContainedHtml, type EmbedImagesOptions, type ImageIssue } from "./htmlExport";
import {
  parseExportHtml,
  renderBlocksToXhtml,
  type ExportInline,
  type ExportWarning,
  pushWarning,
} from "./exportDoc";
import { bytesToBase64, decodeImageDataUrl, escapeXml, escapeXmlAttr, utf8, sanitizeXmlText } from "./bytes";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface EpubChapter {
  /** 章节标题（用于导航；也从正文里删除不了任何东西，正文保持原样） */
  title: string;
  /** 章节 Markdown 原文（**只读**：本模块绝不修改、也绝不写回用户文件） */
  markdown: string;
  /** 章节在工作区里的相对路径（用来解析章节内图片的相对地址），可选 */
  path?: string;
  /**
   * 所属卷（可选）。相同 key 的章节会归入同一卷（按首次出现顺序）：
   * nav.xhtml 变成「卷（li）→ 章（li 嵌套 ol）」，toc.ncx 变成嵌套 navPoint，
   * playOrder 在文档阅读顺序上递增。不传 volume = 整本书不设卷，目录保持扁平。
   */
  volume?: EpubVolume;
}

export interface EpubVolume {
  /** 分组键：同一卷的章节共享（通常用卷目录路径或卷号） */
  key: string;
  /** 目录与分卷页上显示的卷标题 */
  title: string;
  /** 分卷页引言（可选）：生成 text/volume-N.xhtml 时写在卷标题之下 */
  intro?: string;
  /** 引言所在文件路径（解析相对图片用），可选 */
  path?: string;
}

export interface EpubExportOptions extends Omit<EmbedImagesOptions, "baseDir"> {
  /** 书名 */
  title: string;
  /** 段内单换行是否保留（透传给 HTML 渲染） */
  preserveLineBreaks?: boolean;
  /** 作者 */
  author?: string;
  /** 语言（默认 zh-CN） */
  language?: string;
  /** 章节列表（顺序即阅读顺序） */
  chapters: EpubChapter[];
  /** 固定书籍标识（可复现构建/测试用；默认随机 UUID） */
  identifier?: string;
  /** dcterms:modified（默认当前 UTC 时间，ISO8601） */
  modified?: string;
  /** 是否生成极简分卷页（默认 true；有卷时才生效） */
  volumePages?: boolean;
  /** 封面图（data URL，可选） */
  cover?: string;
  /** 打包时间戳（默认固定值，保证同一份输入产出同样的字节） */
  mtime?: Date;
}

export interface EpubExportResult {
  /** 真实 EPUB 二进制（ZIP / OCF 容器） */
  bytes: Uint8Array;
  /** 同一份数据的 base64，供 Tauri write_binary_abs 直接写盘 */
  base64: string;
  /** 章节数 */
  chapterCount: number;
  /** 卷数（0 = 整本书不设卷） */
  volumeCount: number;
  /** 包内图片数 */
  imageCount: number;
  /** 包内部件清单（测试与排查用；顺序即 ZIP 内的写入顺序） */
  entries: string[];
  /** 降级 / 失败警告 */
  warnings: ExportWarning[];
  /** 图片层面的底层问题 */
  issues: ImageIssue[];
  /** 一句话报告 */
  summary: string;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 固定打包时间：让「同一份 Markdown → 同样的 EPUB」成立，便于测试与版本对比 */
const DEFAULT_MTIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

export function randomUuid(): string {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isoTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 章节所属目录（用于把相对图片地址解析成「工作区相对路径」） */
function dirOf(path: string | undefined): string {
  if (!path) return "";
  const norm = path.replace(/\\/g, "/");
  const at = norm.lastIndexOf("/");
  return at < 0 ? "" : norm.slice(0, at);
}

/** 导航/标题 id：只留 XML Name 里安全的字符，且必须唯一 */
function safeId(text: string, index: number, used: Set<string>): string {
  const base =
    sanitizeXmlText(text)
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `sec-${index}`;
  let id = `h-${base}`;
  let n = 2;
  while (used.has(id)) id = `h-${base}-${n++}`;
  used.add(id);
  return id;
}

/** 简单稳定哈希（内容寻址去重用；不需要密码学强度） */
function hashBytes(bytes: Uint8Array, extra = ""): string {
  let h = 0x811c9dc5;
  const seed = utf8(extra);
  for (let i = 0; i < seed.length; i++) {
    h ^= seed[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

interface EpubAsset {
  id: string;
  href: string;
  mime: string;
  bytes: Uint8Array;
}

/** 一章在包内的落地信息（含所属卷，供目录分组使用） */
interface ChapterDoc {
  title: string;
  href: string;
  id: string;
  content: ChapterContent;
  volume: EpubVolume | null;
}

/** 一卷在包内的落地信息（分卷页 + 它的章） */
interface VolumeDoc {
  key: string;
  title: string;
  href: string;
  id: string;
  body: string;
}

/** 相邻/同卷章节的归组结果 */
interface ChapterGroup {
  volume: EpubVolume | null;
  docs: ChapterDoc[];
}

/* ------------------------------------------------------------------ *
 * 章节 XHTML
 * ------------------------------------------------------------------ */

export interface ChapterContent {
  /** 章节 XHTML 正文（不含 <html> 外壳） */
  body: string;
  /** 本章的标题锚点（供 nav.xhtml 生成二级目录；href 由调用方拼章节地址） */
  headings: { text: string; id: string; level: number }[];
  /** 本章的资源问题（图片读不到 / 未内嵌等） */
  issues: ImageIssue[];
}

const CHAPTER_CSS = `/* MyNovel 离线导出样式（不含任何外部资源引用） */
html { font-size: 100%; }
body { margin: 0; padding: 0 0.6em; line-height: 1.75; font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif; color: #17171a; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.6em; page-break-after: avoid; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.28em; }
h3 { font-size: 1.14em; }
section.volume { page-break-before: always; }
h1.volume-title { font-size: 1.9em; text-align: center; margin: 2em 0 1em; }
p { margin: 0 0 0.7em; text-indent: 2em; }
p code, li code, td code, th code { text-indent: 0; }
blockquote, aside.callout { margin: 0.8em 0; padding: 0.2em 0.8em; border-left: 3px solid #9aa0aa; background: #fbfbfd; }
aside.callout .callout-title { font-weight: bold; text-indent: 0; }
ul, ol { margin: 0.6em 0 0.8em 1.4em; padding: 0; }
li { margin: 0.2em 0; }
pre { margin: 0.6em 0; padding: 0.6em 0.7em; background: #fafafc; border: 1px solid #d7d7dd; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
pre code { font-family: "Noto Sans Mono CJK SC", "DejaVu Sans Mono", monospace; font-size: 0.9em; }
.code-note, .raw-note { color: #b3261e; font-weight: bold; text-indent: 0; }
table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
th, td { border: 1px solid #c2c2c9; padding: 0.25em 0.45em; text-align: left; }
th { background: #f2f2f5; }
img { max-width: 100%; height: auto; }
.md-img-missing { color: #b3261e; font-style: italic; }
.md-math-src { font-family: "Noto Sans Mono CJK SC", monospace; background: #f4f4f6; padding: 0 0.2em; }
nav.toc { border: 1px solid #d7d7dd; padding: 0.4em 0.8em; }
nav.toc .toc-title { font-weight: bold; text-indent: 0; }
.footnotes { font-size: 0.92em; }
hr { border: none; border-top: 1px solid #c8c8cf; margin: 1.2em 0; }
`;

/**
 * 一章 Markdown → XHTML 正文 + 导航项。
 * 图片通过 registerAsset 回调登记，并返回包内相对地址（../images/image-N.ext）。
 */
export async function buildChapterContent(
  chapter: EpubChapter,
  options: EpubExportOptions,
  registerAsset: (inline: ExportInline) => string | null,
  warnings: ExportWarning[],
): Promise<ChapterContent> {
  const baseDir = dirOf(chapter.path);
    const selfContained = await buildSelfContainedHtml(chapter.markdown, chapter.title, {
      root: options.root,
      baseDir,
      readImage: options.readImage,
      placeholderClass: options.placeholderClass,
      preserveLineBreaks: options.preserveLineBreaks,
      standalone: false,
    csp: false,
    placeholderStyles: false,
  });
  const parsed = parseExportHtml(selfContained.html);
  for (const w of parsed.warnings) pushWarning(warnings, w);
  for (const issue of selfContained.errors) {
    pushWarning(warnings, {
      kind: "image-error",
      message: `章节「${chapter.title}」的图片未能内嵌：${issue.src}（${issue.reason}）`,
      detail: issue.path ?? issue.src,
    });
  }

  const used = new Set<string>();
  const headings: { text: string; id: string; level: number }[] = [];
  let counter = 0;
  const body = renderBlocksToXhtml(parsed.blocks, {
    resolveImage: registerAsset,
    headingId: (text, _index, level) => {
      const id = safeId(text, counter++, used);
      if (text && level <= 3) headings.push({ text, id, level });
      return id;
    },
    onImageDropped: (inline) => {
      pushWarning(warnings, {
        kind: "image-dropped",
        message: `章节「${chapter.title}」有图片无法写入 EPUB，已降级为文字`,
        detail: inline.alt ?? "",
      });
    },
  });

  return { body, headings, issues: selfContained.errors };
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 一组章节 → 离线 EPUB 3（可选按卷分组）。
 * 章节正文只读；任何资源问题都不会让导出失败，只会进 warnings / issues。
 */
export async function buildEpub(options: EpubExportOptions): Promise<EpubExportResult> {
  const warnings: ExportWarning[] = [];
  const issues: ImageIssue[] = [];
  if (!options.chapters.length) throw new Error("EPUB 至少需要一个章节");

  const assets: EpubAsset[] = [];
  const assetByHash = new Map<string, EpubAsset>();
  const inlineToAsset = new WeakMap<ExportInline, string>();
  let assetSeq = 0;

  const registerAsset = (inline: ExportInline): string | null => {
    const cached = inlineToAsset.get(inline);
    if (cached) return cached;
    // 内联 SVG：直接作为 image/svg+xml 资源
    if (inline.svg) {
      const bytes = utf8(inline.svg);
      const key = hashBytes(bytes, "image/svg+xml");
      let asset = assetByHash.get(key);
      if (!asset) {
        assetSeq += 1;
        asset = { id: `image-${assetSeq}`, href: `images/image-${assetSeq}.svg`, mime: "image/svg+xml", bytes };
        assetByHash.set(key, asset);
        assets.push(asset);
      }
      inlineToAsset.set(inline, `../${asset.href}`);
      return `../${asset.href}`;
    }
    if (!inline.src) return null;
    const decoded = decodeImageDataUrl(inline.src);
    if (!decoded) {
      pushWarning(warnings, {
        kind: "image-error",
        message: "图片数据无法解码，EPUB 里已降级为文字占位",
        detail: inline.alt || inline.src.slice(0, 60),
      });
      return null;
    }
    const key = hashBytes(decoded.bytes, decoded.mime);
    let asset = assetByHash.get(key);
    if (!asset) {
      assetSeq += 1;
      const ext = decoded.kind === "jpg" ? "jpg" : decoded.kind;
      asset = {
        id: `image-${assetSeq}`,
        href: `images/image-${assetSeq}.${ext}`,
        mime: decoded.mime,
        bytes: decoded.bytes,
      };
      assetByHash.set(key, asset);
      assets.push(asset);
    }
    inlineToAsset.set(inline, `../${asset.href}`);
    return `../${asset.href}`;
  };

  const chapterDocs: ChapterDoc[] = [];
  for (let i = 0; i < options.chapters.length; i++) {
    const chapter = options.chapters[i];
    const content = await buildChapterContent(chapter, options, registerAsset, warnings);
    chapterDocs.push({
      title: chapter.title,
      href: `text/chapter-${i + 1}.xhtml`,
      id: `chapter-${i + 1}`,
      content,
      volume: chapter.volume ?? null,
    });
    for (const issue of content.issues) issues.push(issue);
  }

  const identifier = `urn:uuid:${options.identifier ?? randomUuid()}`;
  const modified = options.modified ?? isoTimestamp(new Date());
  const language = options.language || "zh-CN";
  const author = options.author?.trim() || "";

  // 封面单独登记（id 必须是 cover-image 且只能出现一次，否则 OPF 会重复登记同一张图）
  let coverHref: string | null = null;
  if (options.cover) {
    const decoded = decodeImageDataUrl(options.cover);
    if (decoded) {
      assetSeq += 1;
      const ext = decoded.kind === "jpg" ? "jpg" : decoded.kind;
      const asset: EpubAsset = {
        id: "cover-image",
        href: `images/cover.${ext}`,
        mime: decoded.mime,
        bytes: decoded.bytes,
      };
      assets.push(asset);
      coverHref = asset.href;
    } else {
      pushWarning(warnings, {
        kind: "image-error",
        message: "封面图片无法解码，EPUB 未包含封面",
      });
    }
  }

  /* ---------------- 卷分组与分卷页 ---------------- */

  // 相邻且同卷的章归入同一卷；不设卷的章归到 volume=null 的组（扁平目录）。
  const groups: ChapterGroup[] = [];
  for (const doc of chapterDocs) {
    const vol = doc.volume;
    const last = groups[groups.length - 1];
    if (last && ((last.volume === null && vol === null) || (last.volume !== null && vol !== null && last.volume.key === vol.key))) {
      last.docs.push(doc);
    } else {
      groups.push({ volume: vol, docs: [doc] });
    }
  }

  const useVolumePages = options.volumePages !== false;
  const volumeDocs = new Map<ChapterGroup, VolumeDoc>();
  if (useVolumePages) {
    let n = 0;
    for (const group of groups) {
      if (!group.volume) continue;
      n += 1;
      const intro = group.volume.intro?.trim() ?? "";
      let body = `<h1 class="volume-title">${escapeXml(group.volume.title)}</h1>\n`;
      if (intro) {
        // 引言复用章节管线：同样的清洗、转义、图片内嵌、降级可见，绝不让引言破坏 XHTML。
        const introContent = await buildChapterContent(
          { title: group.volume.title, markdown: intro, path: group.volume.path },
          options,
          registerAsset,
          warnings,
        );
        for (const issue of introContent.issues) issues.push(issue);
        body += introContent.body;
      }
      volumeDocs.set(group, {
        key: group.volume.key,
        title: group.volume.title,
        href: `text/volume-${n}.xhtml`,
        id: `volume-${n}`,
        body,
      });
    }
  }

  /* ---------------- 各部件内容 ---------------- */

  /** 章节页与分卷页共用的 XHTML 外壳（严格 XML，正文已全部转义） */
  const xhtmlPage = (title: string, id: string, className: string, body: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttr(
      language,
    )}" lang="${escapeXmlAttr(language)}">\n` +
    `<head>\n<meta charset="utf-8"/>\n<title>${escapeXml(title)}</title>\n` +
    `<link rel="stylesheet" type="text/css" href="../css/style.css"/>\n</head>\n` +
    `<body>\n<section class="${className}" id="${escapeXmlAttr(id)}">\n${body}\n</section>\n</body>\n</html>\n`;

  const chapterXhtml = (doc: ChapterDoc): string => xhtmlPage(doc.title, doc.id, "chapter", doc.content.body);
  const volumeXhtml = (doc: VolumeDoc): string => xhtmlPage(doc.title, doc.id, "volume", doc.body);

  /** 一个章条目：章标题 + （有的话）章内标题作为二级 ol */
  const chapterNavItem = (doc: ChapterDoc): string =>
    `<li><a href="${escapeXmlAttr(doc.href)}">${escapeXml(doc.title)}</a>${
      doc.content.headings.length
        ? `\n<ol>\n${doc.content.headings
            .map((n) => `<li><a href="${escapeXmlAttr(`${doc.href}#${n.id}`)}">${escapeXml(n.text)}</a></li>`)
            .join("\n")}\n</ol>\n`
        : ""
    }</li>`;

  /** nav 的顶层列表：有卷时「卷 → 章」，无卷时保持扁平的章列表 */
  const navTocBody = groups
    .map((group) => {
      if (!group.volume) return group.docs.map(chapterNavItem).join("\n");
      const volumeDoc = volumeDocs.get(group);
      const inner = group.docs.map(chapterNavItem).join("\n");
      const label = group.volume.title;
      // 有分卷页 → 卷标题可点；极端情况（关掉分卷页）退化成不可点的 span，目录结构仍然合法
      const head = volumeDoc
        ? `<a href="${escapeXmlAttr(volumeDoc.href)}">${escapeXml(label)}</a>`
        : `<span>${escapeXml(label)}</span>`;
      return `<li>${head}\n<ol>\n${inner}\n</ol>\n</li>`;
    })
    .join("\n");

  const navXhtml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttr(
      language,
    )}" lang="${escapeXmlAttr(language)}">\n` +
    `<head>\n<meta charset="utf-8"/>\n<title>目录</title>\n` +
    `<link rel="stylesheet" type="text/css" href="css/style.css"/>\n</head>\n` +
    `<body>\n<nav epub:type="toc" id="toc">\n<h1>目录</h1>\n<ol>\n` +
    navTocBody +
    `\n</ol>\n</nav>\n` +
    (coverHref
      ? `<nav epub:type="landmarks" id="landmarks" hidden="hidden">\n<ol>\n<li><a epub:type="cover" href="text/cover.xhtml">封面</a></li>\n<li><a epub:type="bodymatter" href="${escapeXmlAttr(
          chapterDocs[0].href,
        )}">正文</a></li>\n</ol>\n</nav>\n`
      : "") +
    `</body>\n</html>\n`;

  /* ---------------- toc.ncx（EPUB2 兼容）：嵌套 navPoint + 递增 playOrder ---------------- */

  const navPoint = (id: string, playOrder: number, label: string, src: string, children = ""): string =>
    `<navPoint id="navPoint-${id}" playOrder="${playOrder}">\n<navLabel><text>${escapeXml(
      label,
    )}</text></navLabel>\n<content src="${escapeXmlAttr(src)}"/>${children ? `\n${children}` : ""}\n</navPoint>`;

  const navMapParts: string[] = [];
  let playOrder = 0;
  for (const group of groups) {
    if (!group.volume) {
      for (const doc of group.docs) {
        playOrder += 1;
        navMapParts.push(navPoint(doc.id.replace(/^chapter-/, ""), playOrder, doc.title, doc.href));
      }
      continue;
    }
    playOrder += 1;
    const order = playOrder;
    const volumeDoc = volumeDocs.get(group);
    const children = group.docs
      .map((doc) => {
        playOrder += 1;
        return navPoint(doc.id.replace(/^chapter-/, ""), playOrder, doc.title, doc.href);
      })
      .join("\n");
    navMapParts.push(
      navPoint(
        `volume-${volumeDocs.has(group) ? order : group.docs[0].id}`,
        order,
        group.volume.title,
        volumeDoc ? volumeDoc.href : group.docs[0].href,
        children,
      ),
    );
  }
  const ncxDepth = groups.some((g) => g.volume) ? 2 : 1;

  const ncx =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXmlAttr(language)}">\n` +
    `<head>\n<meta name="dtb:uid" content="${escapeXmlAttr(identifier)}"/>\n` +
    `<meta name="dtb:depth" content="${ncxDepth}"/>\n<meta name="dtb:totalPageCount" content="0"/>\n` +
    `<meta name="dtb:maxPageNumber" content="0"/>\n</head>\n` +
    `<docTitle><text>${escapeXml(options.title)}</text></docTitle>\n<navMap>\n` +
    navMapParts.join("\n") +
    `\n</navMap>\n</ncx>\n`;

  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="css/style.css" media-type="text/css"/>`,
    ...chapterDocs.map(
      (doc) => `<item id="${escapeXmlAttr(doc.id)}" href="${escapeXmlAttr(doc.href)}" media-type="application/xhtml+xml"/>`,
    ),
    ...[...volumeDocs.values()].map(
      (doc) => `<item id="${escapeXmlAttr(doc.id)}" href="${escapeXmlAttr(doc.href)}" media-type="application/xhtml+xml"/>`,
    ),
    ...assets.map(
      (asset) =>
        `<item id="${escapeXmlAttr(asset.id)}" href="${escapeXmlAttr(asset.href)}" media-type="${escapeXmlAttr(
          asset.mime,
        )}"${asset.id === "cover-image" ? ' properties="cover-image"' : ""}/>`,
    ),
    ...(coverHref ? [`<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`] : []),
  ];

  const spineItems = [
    ...(coverHref ? [`<itemref idref="cover"/>`] : []),
    ...groups.flatMap((group) => {
      const volumeDoc = volumeDocs.get(group);
      return [
        ...(volumeDoc ? [`<itemref idref="${escapeXmlAttr(volumeDoc.id)}"/>`] : []),
        ...group.docs.map((doc) => `<itemref idref="${escapeXmlAttr(doc.id)}"/>`),
      ];
    }),
  ];

  const opf =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXmlAttr(
      language,
    )}">\n` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>\n` +
    `<dc:title>${escapeXml(options.title)}</dc:title>\n` +
    `<dc:language>${escapeXml(language)}</dc:language>\n` +
    (author ? `<dc:creator id="creator">${escapeXml(author)}</dc:creator>\n` : "") +
    `<meta property="dcterms:modified">${escapeXml(modified)}</meta>\n` +
    `</metadata>\n` +
    `<manifest>\n${manifestItems.join("\n")}\n</manifest>\n` +
    `<spine toc="ncx">\n${spineItems.join("\n")}\n</spine>\n</package>\n`;

  const containerXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
    `<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>\n`;

  const coverXhtml = coverHref
    ? `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXmlAttr(language)}" lang="${escapeXmlAttr(
        language,
      )}">\n<head>\n<meta charset="utf-8"/>\n<title>封面</title>\n` +
      `<link rel="stylesheet" type="text/css" href="../css/style.css"/>\n</head>\n` +
      `<body class="cover">\n<div><img src="../${escapeXmlAttr(coverHref)}" alt="封面"/></div>\n</body>\n</html>\n`
    : null;

  /* ---------------- 打包 ---------------- */

  const mtime = options.mtime ?? DEFAULT_MTIME;
  // 写入顺序 = OCF 要求：mimetype 第一且不压缩，其余按 META-INF → OEBPS 顺序
  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  const add = (name: string, data: Uint8Array, level: ZipOptions["level"] = 6) => {
    files[name] = [data, { level, mtime }];
  };
  add("mimetype", utf8("application/epub+zip"), 0);
  add("META-INF/container.xml", utf8(containerXml));
  add("OEBPS/content.opf", utf8(opf));
  add("OEBPS/nav.xhtml", utf8(navXhtml));
  add("OEBPS/toc.ncx", utf8(ncx));
  add("OEBPS/css/style.css", utf8(CHAPTER_CSS));
  for (const doc of chapterDocs) add(`OEBPS/${doc.href}`, utf8(chapterXhtml(doc)));
  for (const doc of volumeDocs.values()) add(`OEBPS/${doc.href}`, utf8(volumeXhtml(doc)));
  if (coverXhtml) add("OEBPS/text/cover.xhtml", utf8(coverXhtml));
  // 图片：PNG/JPEG 本身已压缩，再压收益极小还拖慢打包，直接用 store
  for (const asset of assets) add(`OEBPS/${asset.href}`, asset.bytes, asset.mime === "image/svg+xml" ? 6 : 0);

  const zipped = zipSync(files, { mtime });
  const bytes = new Uint8Array(zipped);

  return {
    bytes,
    base64: bytesToBase64(bytes),
    chapterCount: chapterDocs.length,
    volumeCount: volumeDocs.size,
    imageCount: assets.length,
    entries: Object.keys(files),
    warnings,
    issues,
    summary: describeEpubResult({
      title: options.title,
      chapters: chapterDocs.length,
      volumes: volumeDocs.size,
      images: assets.length,
      warnings,
    }),
  };
}

/** 一句话结论（诚实：只说确实写进包里的东西） */
export function describeEpubResult(r: {
  title: string;
  chapters: number;
  volumes?: number;
  images: number;
  warnings: ExportWarning[];
}): string {
  const parts = [`已生成 EPUB（${r.title}）`, `${r.chapters} 章`, `图片 ${r.images} 张`];
  if (r.volumes) parts.push(`${r.volumes} 卷`);
  if (r.warnings.length) parts.push(`降级说明 ${r.warnings.length} 条`);
  return parts.join("，");
}
