/*
 * 离线 DOCX 导出（真实 .docx 容器，绝不是「HTML 改个后缀」）。
 *
 * 数据流：
 *   Markdown
 *     → buildSelfContainedHtml（本地图片内嵌 data URL、远程图只占位）
 *     → parseExportHtml（块模型 + 降级警告）
 *     → docx 结构组装（Heading / Paragraph / Table / ImageRun / ExternalHyperlink）
 *     → Packer.toBuffer（生成规范 OOXML ZIP 包：word/document.xml、_rels/.rels、[Content_Types].xml …）
 *
 * 明确保证：
 *   1. 容器真实：输出是 zip（PK 头）+ 标准 OOXML 部件，Word/WPS/LibreOffice 都能打开；
 *   2. 图片：能解码的（png/jpg/gif/bmp）按页面宽度等比缩放内嵌；
 *      SVG 与 webp 先尝试用 canvas 转成 PNG，转不了就**降级为可见文字**并记警告；
 *      远程图片 / 缺失图片 / 越界图片本来就是 mdExport 的可见占位，这里原样保留成文字；
 *   3. 复杂块（div.md-source-fallback）：源码**一字不丢**地写进文件，
 *      并在报告里给出一条明确警告（不静默、不猜测结构）；
 *   4. 公式：Word 侧不生成 OMML，统一降级为 TeX 原文（带 `[公式: …]` 标记 + 报告说明）；
 *   5. 全程离线：不联网、不执行用户内容、不创建 DOM（除了可选的 SVG 光栅化）。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
} from "docx";
import {
  buildSelfContainedHtml,
  type EmbedImagesOptions,
  type ImageIssue,
} from "./htmlExport";
import {
  parseExportHtml,
  type ExportBlock,
  type ExportInline,
  type ExportWarning,
  pushWarning,
} from "./exportDoc";
import { bytesToBase64, decodeDataUrl, decodeImageDataUrl, type ImageKind } from "./bytes";

/* ------------------------------------------------------------------ *
 * 选项 / 结果
 * ------------------------------------------------------------------ */

/** DOCX 里能直接内嵌的图片类型（Word 不支持 webp/svg 时先转码） */
type NativeImageKind = Extract<ImageKind, "png" | "jpg" | "gif" | "bmp">;

export interface RasterizedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** SVG（或 webp）→ 位图。默认实现用 canvas，测试/Node 环境可注入替身 */
export type RasterizeFn = (
  source: { svg?: string; bytes?: Uint8Array; mime: string },
  size: { width: number | null; height: number | null },
) => Promise<RasterizedImage | null>;

export interface DocxExportOptions extends EmbedImagesOptions {
  /** 文档标题（写进 core 属性） */
  title?: string;
  /** 作者 / 创作者（默认 MyNovel） */
  creator?: string;
  /** 正文图片最大显示宽度（px，96dpi），默认 520 */
  maxImageWidth?: number;
  /** 正文图片最大显示高度（px），默认 700 */
  maxImageHeight?: number;
  /** 注入位图转码实现（默认 canvas；拿不到 canvas 时返回 null 触发降级） */
  rasterize?: RasterizeFn;
}

export interface DocxExportResult {
  /** 真实 DOCX 二进制（ZIP 容器） */
  bytes: Uint8Array;
  /** 同一份数据的 base64，供 Tauri write_binary_abs 直接写盘 */
  base64: string;
  /** 块模型里的图片总数 */
  imageCount: number;
  /** 成功内嵌的图片数 */
  embeddedImages: number;
  /** 降级 / 失败警告（含 mdExport 阶段的图片问题） */
  warnings: ExportWarning[];
  /** 图片层面的底层问题（远程未下载、读取失败、越界等） */
  issues: ImageIssue[];
  /** 一句话报告（中文，可直接进状态栏） */
  summary: string;
}

/* ------------------------------------------------------------------ *
 * 图片尺寸与转码
 * ------------------------------------------------------------------ */

function scaleImage(
  width: number | null,
  height: number | null,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  let w = width && width > 0 ? width : Math.min(maxW, 480);
  let h = height && height > 0 ? height : Math.round(w * 0.66);
  if (w > maxW) {
    h = Math.round((h * maxW) / w);
    w = maxW;
  }
  if (h > maxH) {
    w = Math.round((w * maxH) / h);
    h = maxH;
  }
  // 极小的图（例如 2×3 的测试图或图标）按比例放大到肉眼可见，但比例保持不变
  const minSide = 24;
  if (w < minSide && h < minSide) {
    const factor = minSide / Math.min(w, h);
    w = Math.round(w * factor);
    h = Math.round(h * factor);
  }
  return { width: Math.max(8, Math.round(w)), height: Math.max(8, Math.round(h)) };
}

/**
 * 默认位图转码：把 SVG 源码画到 canvas 再导出 PNG。
 * 只在浏览器/Webview 里可用（没有 document 就返回 null，交给调用方明确降级）。
 * 安全：不改动 SVG 内容，只用它作为 <img> 的源；一旦 canvas 被污染（画布外链资源）
 * toDataURL 会抛异常，这里捕获并返回 null —— 宁可降级，也不把可疑内容写进文件。
 */
export const rasterizeWithCanvas: RasterizeFn = async (source, size) => {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const payload = source.svg !== undefined ? source.svg : source.bytes;
  if (payload === undefined) return null;
  const mime = source.mime || "image/svg+xml";
  const blob = new Blob([payload as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片解码失败"));
      img.src = url;
    });
    const natural = scaleImage(img.naturalWidth, img.naturalHeight, 1600, 1600);
    const target = scaleImage(size.width ?? img.naturalWidth, size.height ?? img.naturalHeight, natural.width, natural.height);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 白底：很多阅读器/Word 不会替你把透明背景刷白
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return null;
    return { bytes: decoded.bytes, width: target.width, height: target.height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * 把块模型里「Word 拿不动」的图片（svg / webp）先转成 PNG。
 * 转不动的保持原样，后续转 runs 时会输出明确的文字降级 + 警告。
 */
async function transcodeUnsupportedImages(
  blocks: ExportBlock[],
  rasterize: RasterizeFn,
  warnings: ExportWarning[],
): Promise<void> {
  const visit = async (inlines: ExportInline[]) => {
    for (let i = 0; i < inlines.length; i++) {
      const it = inlines[i];
      if (it.kind !== "image") continue;
      if (it.svg) {
        const size = estimateSvgSize(it.svg);
        const png = await rasterize({ svg: it.svg, mime: "image/svg+xml" }, size);
        if (png) {
          it.src = `data:image/png;base64,${bytesToBase64(png.bytes)}`;
          it.alt = it.alt || "SVG 图形";
          delete it.svg;
          warnings.push({
            kind: "image-unsupported",
            message: "SVG 图形已转成 PNG 后嵌入（Word 对 SVG 支持不一致）",
          });
        } else {
          pushWarning(warnings, {
            kind: "image-dropped",
            message: "SVG 图形无法在本机转成位图，DOCX 里已降级为文字占位（EPUB/HTML 导出仍可看到图形）",
            detail: it.alt || "SVG 图形",
          });
        }
        continue;
      }
      if (!it.src) continue;
      const decoded = decodeImageDataUrl(it.src);
      if (decoded && decoded.kind === "webp") {
        const png = await rasterize({ bytes: decoded.bytes, mime: decoded.mime }, {
          width: decoded.width,
          height: decoded.height,
        });
        if (png) {
          it.src = `data:image/png;base64,${bytesToBase64(png.bytes)}`;
          continue;
        }
        pushWarning(warnings, {
          kind: "image-dropped",
          message: "WebP 图片无法在本机转码，DOCX 里已降级为文字占位",
          detail: it.alt || "图片",
        });
      }
    }
  };
  const walk = async (list: ExportBlock[]) => {
    for (const b of list) {
      switch (b.kind) {
        case "heading":
        case "para":
        case "image":
          await visit(b.inlines);
          break;
        case "list":
          for (const item of b.items) {
            await visit(item.inlines);
            await walk(item.blocks);
          }
          break;
        case "quote":
        case "callout":
          await walk(b.blocks);
          break;
        case "table":
          for (const cell of b.head) await visit(cell);
          for (const row of b.rows) for (const cell of row) await visit(cell);
          break;
        case "footnotes":
          for (const it of b.items) await visit(it.inlines);
          break;
        default:
          break;
      }
    }
  };
  await walk(blocks);
}

/** 从 SVG 源码里粗略取宽高（转码时的目标尺寸用；取不到交给 canvas 的自然尺寸） */
function estimateSvgSize(svg: string): { width: number | null; height: number | null } {
  const w = /\bwidth\s*=\s*["']?\s*([0-9.]+)/i.exec(svg.slice(0, 4096));
  const h = /\bheight\s*=\s*["']?\s*([0-9.]+)/i.exec(svg.slice(0, 4096));
  const vb = /viewBox\s*=\s*["']\s*[-0-9.eE]+[,\s]+[-0-9.eE]+[,\s]+([0-9.eE]+)[,\s]+([0-9.eE]+)/i.exec(
    svg.slice(0, 4096),
  );
  const width = w ? Number(w[1]) : vb ? Number(vb[1]) : null;
  const height = h ? Number(h[1]) : vb ? Number(vb[2]) : null;
  return { width: width && width > 0 ? width : null, height: height && height > 0 ? height : null };
}

/* ------------------------------------------------------------------ *
 * 行内 → runs
 * ------------------------------------------------------------------ */

type DocxRun = TextRun | ImageRun | ExternalHyperlink;

const DEGRADE_COLOR = "B3261E";
const LINK_COLOR = "1A4C8B";

function inlinesToRuns(
  inlines: ExportInline[],
  warnings: ExportWarning[],
  opts: { maxW: number; maxH: number; forceBold?: boolean },
): DocxRun[] {
  const runs: DocxRun[] = [];
  for (const it of inlines) {
    switch (it.kind) {
      case "text":
        runs.push(
          new TextRun({
            text: it.text ?? "",
            bold: it.bold || opts.forceBold || undefined,
            italics: it.italic || undefined,
            strike: it.strike || undefined,
            superScript: it.sup || undefined,
            subScript: it.sub || undefined,
          }),
        );
        break;
      case "code":
        runs.push(
          new TextRun({
            text: it.text ?? "",
            font: "Consolas",
            color: "1C1C1F",
          }),
        );
        break;
      case "link": {
        const label = it.text || it.href || "";
        if (it.internal || !it.href) {
          runs.push(
            new TextRun({
              text: label,
              color: LINK_COLOR,
              bold: opts.forceBold || undefined,
            }),
          );
        } else {
          runs.push(
            new ExternalHyperlink({
              children: [new TextRun({ text: label, color: LINK_COLOR, underline: {} })],
              link: it.href,
            }),
          );
        }
        break;
      }
      case "image": {
        const decoded = it.src ? decodeImageDataUrl(it.src) : null;
        if (decoded && decoded.kind === "svg") {
          pushWarning(warnings, {
            kind: "image-dropped",
            message: "SVG 图形没能转成位图，DOCX 里按文字占位（EPUB/HTML 导出仍保留图形）",
            detail: it.alt || "SVG 图形",
          });
          break;
        }
        if (decoded && decoded.kind !== "webp") {
          const size = scaleImage(decoded.width, decoded.height, opts.maxW, opts.maxH);
          runs.push(
            new ImageRun({
              data: decoded.bytes,
              type: decoded.kind as NativeImageKind,
              transformation: { width: size.width, height: size.height },
            }),
          );
          break;
        }
        if (decoded) {
          pushWarning(warnings, {
            kind: "image-dropped",
            message: `不支持的图片格式（${decoded.mime}），DOCX 里按文字占位`,
            detail: it.alt || decoded.mime,
          });
        } else {
          pushWarning(warnings, {
            kind: "image-error",
            message: "图片数据无法解码，DOCX 里按文字占位",
            detail: it.alt || (it.src ?? "").slice(0, 60),
          });
        }
        runs.push(
          new TextRun({
            text: `［图片：${it.alt || "插图"}（未能嵌入 DOCX，请用 EPUB/HTML 版本查看）］`,
            color: DEGRADE_COLOR,
            italics: true,
          }),
        );
        break;
      }
      case "math":
        runs.push(
          new TextRun({
            text: `［公式：${it.tex ?? ""}］`,
            font: "Consolas",
            color: it.failed ? DEGRADE_COLOR : "17171A",
          }),
        );
        break;
      case "place":
        runs.push(
          new TextRun({
            text: `［${it.text || it.note || "内容未导出"}］`,
            color: DEGRADE_COLOR,
            italics: true,
          }),
        );
        break;
      case "br":
        runs.push(new TextRun({ break: 1 }));
        break;
    }
  }
  return runs;
}

/* ------------------------------------------------------------------ *
 * 块 → docx 元素
 * ------------------------------------------------------------------ */

interface BlockCtx {
  warnings: ExportWarning[];
  maxW: number;
  maxH: number;
  /** 缩进（twip） */
  indent: number;
  /** 引用块左边框 */
  quote: boolean;
  /** 列表：编号引用 + 实例（同一个实例共享计数器） */
  numbering?: { reference: string; instance: number };
}

const LIST_LEVELS = [0, 1, 2, 3, 4];
const BULLETS = ["•", "◦", "▪", "‣", "·"];

/** 给 docx 的编号定义：项目符号与数字列表各一套，各 5 层 */
function numberingConfig() {
  const bullet = LIST_LEVELS.map((level) => ({
    level,
    format: LevelFormat.BULLET,
    text: BULLETS[level],
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: convertInchesToTwip(0.3 * (level + 1)), hanging: 360 } } },
  }));
  const decimal = LIST_LEVELS.map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: convertInchesToTwip(0.3 * (level + 1)), hanging: 360 } } },
  }));
  return {
    config: [
      { reference: "mynovel-bullet", levels: bullet },
      { reference: "mynovel-decimal", levels: decimal },
    ],
  };
}

function headingLevelOf(level: number) {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    case 5:
      return HeadingLevel.HEADING_5;
    default:
      return HeadingLevel.HEADING_6;
  }
}

function blockToDocx(block: ExportBlock, ctx: BlockCtx): (Paragraph | Table)[] {
  const runsOf = (inlines: ExportInline[], forceBold = false) =>
    inlinesToRuns(inlines, ctx.warnings, { maxW: ctx.maxW, maxH: ctx.maxH, forceBold });
  switch (block.kind) {
    case "heading":
      return [
        new Paragraph({
          heading: headingLevelOf(block.level),
          children: runsOf(block.inlines),
          spacing: { before: 240, after: 120 },
        }),
      ];
    case "para":
      return [
        new Paragraph({
          children: runsOf(block.inlines),
          indent: ctx.indent ? { left: ctx.indent } : undefined,
          border: ctx.quote
            ? { left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: "9AA0AA" } }
            : undefined,
          spacing: { after: 140, line: 340 },
        }),
      ];
    case "list": {
      const instance = Math.floor(Math.random() * 0xffff) + 1;
      const reference = block.ordered ? "mynovel-decimal" : "mynovel-bullet";
      const out: (Paragraph | Table)[] = [];
      const walkItems = (
        ordered: boolean,
        items: typeof block.items,
        level: number,
      ) => {
        const ref = ordered ? "mynovel-decimal" : "mynovel-bullet";
        for (const item of items) {
          out.push(
            new Paragraph({
              numbering: { reference: ref, level: Math.min(level, LIST_LEVELS.length - 1), instance },
              children: runsOf(item.inlines),
              spacing: { after: 60 },
            }),
          );
          for (const sub of item.blocks) {
            if (sub.kind === "list") {
              walkItems(sub.ordered, sub.items, level + 1);
            } else {
              out.push(...blockToDocx(sub, { ...ctx, numbering: { reference: ref, instance } }));
            }
          }
        }
      };
      walkItems(block.ordered, block.items, 0);
      void reference;
      return out;
    }
    case "quote": {
      const out: (Paragraph | Table)[] = [];
      for (const sub of block.blocks) out.push(...blockToDocx(sub, { ...ctx, quote: true }));
      return out.length ? out : [new Paragraph({ children: [] })];
    }
    case "callout": {
      const out: (Paragraph | Table)[] = [];
      const label = block.title
        ? `【${block.variant.toUpperCase()}】${block.title}`
        : `【${block.variant.toUpperCase()}】`;
      out.push(
        new Paragraph({
          children: [new TextRun({ text: label, bold: true, color: "33333A" })],
          shading: { fill: "FBFBFD" },
          spacing: { before: 160, after: 60 },
        }),
      );
      for (const sub of block.blocks) out.push(...blockToDocx(sub, { ...ctx, indent: convertInchesToTwip(0.25) }));
      return out;
    }
    case "code": {
      const out: Paragraph[] = [];
      const lines = block.text.split("\n");
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: block.note ? `⚠ 复杂块按源码完整保留：${block.note}` : "",
              bold: true,
              color: DEGRADE_COLOR,
            }),
          ],
          spacing: { before: 120, after: 40 },
        }),
      );
      for (let i = 0; i < lines.length; i++) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: lines[i] || " ", font: "Consolas", size: 19 })],
            shading: { fill: "FAFAFC" },
            indent: { left: convertInchesToTwip(0.15) },
            spacing: { after: i === lines.length - 1 ? 140 : 0 },
          }),
        );
      }
      return out;
    }
    case "table": {
      const rows: TableRow[] = [];
      const cellOf = (inlines: ExportInline[], header: boolean) =>
        new TableCell({
          children: [new Paragraph({ children: runsOf(inlines, header) })],
          shading: header ? { fill: "F2F2F5" } : undefined,
        });
      if (block.head.length) {
        rows.push(new TableRow({ tableHeader: true, children: block.head.map((c) => cellOf(c, true)) }));
      }
      for (const row of block.rows) {
        rows.push(new TableRow({ children: row.map((c) => cellOf(c, false)) }));
      }
      if (!rows.length) return [];
      const columns = Math.max(block.head.length, ...block.rows.map((r) => r.length), 1);
      return [
        new Table({
          rows,
          width: { size: 100, type: WidthType.PERCENTAGE },
          columnWidths: Array.from({ length: columns }, () => Math.floor(9026 / columns)),
        }),
      ];
    }
    case "rule":
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "C8C8CF" } },
          spacing: { before: 120, after: 120 },
        }),
      ];
    case "image":
      return [new Paragraph({ children: runsOf(block.inlines), spacing: { after: 120 } })];
    case "math":
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: `［公式：${block.tex}］`,
              font: "Consolas",
              color: block.failed ? DEGRADE_COLOR : "17171A",
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 140 },
        }),
      ];
    case "nav": {
      const out: Paragraph[] = [
        new Paragraph({
          children: [new TextRun({ text: block.title, bold: true })],
          spacing: { before: 160, after: 60 },
        }),
      ];
      for (const it of block.items) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: it.text, size: 20 })],
            indent: { left: convertInchesToTwip(0.25 * Math.max(0, it.level)) },
            spacing: { after: 20 },
          }),
        );
      }
      return out;
    }
    case "footnotes": {
      const out: Paragraph[] = [
        new Paragraph({
          children: [new TextRun({ text: "注释", bold: true })],
          border: { top: { style: BorderStyle.SINGLE, size: 6, space: 4, color: "C8C8CF" } },
          spacing: { before: 200, after: 60 },
        }),
      ];
      block.items.forEach((item, index) => {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: `[${index + 1}] `, bold: true }), ...runsOf(item.inlines)],
            indent: { left: convertInchesToTwip(0.25) },
            spacing: { after: 40 },
          }),
        );
      });
      return out;
    }
    case "raw":
      return [
        new Paragraph({
          children: [
            new TextRun({ text: `⚠ ${block.note}`, color: DEGRADE_COLOR, bold: true }),
            new TextRun({ text: block.text, font: "Consolas", break: 1 }),
          ],
          shading: { fill: "FAFAFC" },
          spacing: { before: 120, after: 120 },
        }),
      ];
  }
}

/* ------------------------------------------------------------------ *
 * 对外主入口
 * ------------------------------------------------------------------ */

/**
 * 自包含 HTML → 离线 DOCX。
 * 单独暴露出来是为了：既能在已有 HTML 的场景复用，也让测试可以精确构造
 * （例如带内联 SVG 的块、坏图片等）输入，验证降级行为。
 */
export async function buildDocxFromHtml(
  html: string,
  title: string,
  options: DocxExportOptions & { issues?: ImageIssue[]; embedded?: number },
): Promise<DocxExportResult> {
  const maxW = options.maxImageWidth ?? 520;
  const maxH = options.maxImageHeight ?? 700;
  const parsed = parseExportHtml(html);
  const warnings = parsed.warnings;
  await transcodeUnsupportedImages(parsed.blocks, options.rasterize ?? rasterizeWithCanvas, warnings);

  const children: (Paragraph | Table)[] = [];
  for (const block of parsed.blocks) {
    children.push(...blockToDocx(block, { warnings, maxW, maxH, indent: 0, quote: false }));
  }

  const doc = new Document({
    creator: options.creator ?? "MyNovel",
    title: title,
    description: `由 MyNovel 离线导出：${title}`,
    numbering: numberingConfig(),
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4（twip）
            margin: { top: 1418, right: 1418, bottom: 1418, left: 1418 }, // 2.5cm
          },
        },
        children: children.length ? children : [new Paragraph({ children: [] })],
      },
    ],
  });

  // Tauri runs in a browser WebView: Node Buffer / JSZip nodebuffer is unavailable.
  const buffer = await Packer.toArrayBuffer(doc);
  const bytes = new Uint8Array(buffer);
  const imageCount = countImages(parsed.blocks);

  return {
    bytes,
    base64: bytesToBase64(bytes),
    imageCount,
    embeddedImages: options.embedded ?? 0,
    warnings,
    issues: options.issues ?? [],
    summary: describeDocxResult({
      title,
      imageCount,
      embedded: options.embedded ?? 0,
      warnings,
      issues: options.issues ?? [],
    }),
  };
}

/**
 * Markdown → 离线 DOCX。
 * 任何一步失败都会抛异常（调用方负责提示），
 * 但「单张图片不行 / 某个块降级」这类问题不会失败，只进 warnings。
 */
export async function buildDocx(
  md: string,
  title: string,
  options: DocxExportOptions,
): Promise<DocxExportResult> {
  const html = await buildSelfContainedHtml(md, title, {
    root: options.root,
    baseDir: options.baseDir,
    readImage: options.readImage,
    placeholderClass: options.placeholderClass,
    standalone: true,
  });
  return buildDocxFromHtml(html.html, title, {
    ...options,
    issues: html.errors,
    embedded: html.embedded + html.inline,
  });
}

function countImages(blocks: ExportBlock[]): number {
  let n = 0;
  const visitInlines = (inlines: ExportInline[]) => {
    for (const it of inlines) if (it.kind === "image") n++;
  };
  const walk = (list: ExportBlock[]) => {
    for (const b of list) {
      switch (b.kind) {
        case "heading":
        case "para":
        case "image":
          visitInlines(b.inlines);
          break;
        case "list":
          for (const item of b.items) {
            visitInlines(item.inlines);
            walk(item.blocks);
          }
          break;
        case "quote":
        case "callout":
          walk(b.blocks);
          break;
        case "table":
          for (const cell of b.head) visitInlines(cell);
          for (const row of b.rows) for (const cell of row) visitInlines(cell);
          break;
        case "footnotes":
          for (const it of b.items) visitInlines(it.inlines);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return n;
}

/** 一句话结论（诚实：只说确实发生过的事，绝不谎称「Word 完全兼容」） */
export function describeDocxResult(r: {
  title: string;
  imageCount: number;
  embedded: number;
  warnings: ExportWarning[];
  issues: ImageIssue[];
}): string {
  const parts = [`已生成 DOCX（${r.title}）`];
  parts.push(`图片 内嵌 ${r.embedded} / 共 ${r.imageCount}`);
  if (r.issues.length) parts.push(`图片问题 ${r.issues.length} 处`);
  if (r.warnings.length) parts.push(`降级说明 ${r.warnings.length} 条`);
  return parts.join("，");
}
