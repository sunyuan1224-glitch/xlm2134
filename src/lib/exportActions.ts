/*
 * DOCX / EPUB 导出的「动作层」：串起构建 → 目标校验 → 二进制写盘 → 报告。
 *
 * 三条硬规矩（对应「不要伪成功」）：
 *   1. 只有 writeBinaryAbs 真的返回成功，才报告「已导出 <路径>」；
 *      用户取消（对话框返回 null）、路径被拒、写盘失败，都给出各自的事实，绝不混为一谈；
 *   2. 导出的降级与错误必须可见：warnings / issues 汇总成 ExportReport，
 *      由调用方显示（对话框或状态栏），不静默吞掉；
 *   3. 导出目标绝不可能是源文件本身：即使系统保存对话框允许选到 .md，
 *      这里也会在写盘前拦下（并且 Rust 侧还有第二道闸）。
 */
import { api, isDesktop } from "../api";
import type { ImageIssue } from "./htmlExport";
import { describeIssues } from "./htmlExport";
import type { ExportWarning } from "./exportDoc";
import { sanitizeFileName } from "./chapter";
/*
 * docx / fflate 只在导出那一刻才用得上，却各自是几百 KB。
 * 用 import type 拿类型（编译期擦除、不进包），函数体里再 await import()：
 * 主包（启动时就要解析的那份）因此少了这两个大依赖。
 */
import type { DocxExportOptions } from "./docxExport";
import type { EpubChapter, EpubExportOptions } from "./epubExport";

/* ------------------------------------------------------------------ *
 * 报告
 * ------------------------------------------------------------------ */

export interface ExportReport {
  /** 一句话结论（状态栏用；只说确实发生过的事） */
  summary: string;
  /** 明细行（错误在前、降级在后），可直接展示给用户 */
  lines: string[];
  /** 是否有需要用户知道的问题 */
  hasIssues: boolean;
}

/** 把警告按种类翻成中文前缀，方便用户一眼看出严重程度 */
function warningLabel(w: ExportWarning): string {
  switch (w.kind) {
    case "source-fallback":
      return "复杂块未渲染（源码已完整保留）";
    case "math-failed":
      return "公式渲染失败（已按 TeX 原文导出）";
    case "remote-image":
      return "远程图片未下载（离线导出不联网）";
    case "image-error":
      return "图片读取/解码失败";
    case "image-unsupported":
      return "图片格式需转码";
    case "image-dropped":
      return "图片未能写入本格式";
    case "unsafe-link":
      return "不安全链接已降级为文字";
    case "internal-link":
      return "文档内跳转已降级";
    case "unsupported-tag":
      return "不认识的 HTML 标签";
  }
}

export function buildReport(input: {
  /** 成功写盘后的最终路径；没有写盘就不要传 */
  writtenPath?: string;
  /** 构建阶段的汇总（例如「已生成 DOCX（第 1 章），图片 内嵌 1 / 共 2」） */
  summary: string;
  warnings: ExportWarning[];
  issues: ImageIssue[];
  /** 额外提示（如降级到「不带图片」之类） */
  notes?: string[];
}): ExportReport {
  const lines: string[] = [];
  if (input.issues.length) {
    lines.push(`图片问题共 ${input.issues.length} 处：`);
    lines.push(...describeIssues(input.issues, 5).split("\n").filter(Boolean).map((l) => `  ${l}`));
  }
  if (input.warnings.length) {
    lines.push(`格式降级/警告共 ${input.warnings.length} 条：`);
    for (const w of input.warnings.slice(0, 12)) {
      lines.push(`  · ${warningLabel(w)}：${w.message}${w.detail ? `（${w.detail}）` : ""}`);
    }
    if (input.warnings.length > 12) lines.push(`  · …其余 ${input.warnings.length - 12} 条同类问题已省略`);
  }
  for (const n of input.notes ?? []) lines.push(`· ${n}`);
  const summary = input.writtenPath ? `${input.summary}；已写入 ${input.writtenPath}` : input.summary;
  return {
    summary,
    lines,
    hasIssues: input.issues.length > 0 || input.warnings.length > 0 || (input.notes?.length ?? 0) > 0,
  };
}

/* ------------------------------------------------------------------ *
 * 目标路径校验（保护源文件）
 * ------------------------------------------------------------------ */

/** 与 Rust 侧 SOURCE_EXTENSIONS 保持一致：这些扩展名绝不允许被导出覆盖 */
export const SOURCE_EXTENSIONS = ["md", "markdown", "mdx", "txt"];

function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, "/");
  const parts: string[] = [];
  const absolute = unified.startsWith("/");
  for (const seg of unified.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

export function extOf(p: string): string {
  const bare = p.replace(/\\/g, "/").split("/").pop() ?? "";
  const at = bare.lastIndexOf(".");
  return at > 0 ? bare.slice(at + 1).toLowerCase() : "";
}

/**
 * 导出目标是否安全。返回错误文案，安全时返回空串。
 *
 * 拦下的情况：
 *   - 目标是源文件本身（同一个文件，无论如何都不允许）；
 *   - 目标扩展名是 .md/.markdown/.mdx/.txt（手稿扩展名，导出绝不写这些）；
 *   - 目标为空。
 */
export function validateExportTarget(
  target: string,
  sourcePath?: string | null,
  root?: string | null,
): string {
  const t = target.trim();
  if (!t) return "导出目标路径为空";
  const ext = extOf(t);
  if (SOURCE_EXTENSIONS.includes(ext)) {
    return `不允许把导出文件写成 .${ext}（那是手稿扩展名），请换一个扩展名`;
  }
  if (sourcePath) {
    // 源文件是工作区相对路径时，拼上工作区根目录再比较
    const sourceAbs =
      sourcePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(sourcePath)
        ? sourcePath
        : root
          ? `${root.replace(/[\\/]+$/, "")}/${sourcePath}`
          : sourcePath;
    if (normalizePath(t) === normalizePath(sourceAbs)) {
      return "导出目标不能是原始 Markdown 文件本身，请换一个文件名或目录";
    }
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * 保存（对话框 + 写盘）
 * ------------------------------------------------------------------ */

export const DOCX_FILTER = [{ name: "Word 文档", extensions: ["docx"] }];
export const EPUB_FILTER = [{ name: "EPUB 电子书", extensions: ["epub"] }];

/** 导出文件名：清洗非法字符（换行、斜杠等），保证对话框拿到的名字能落地 */
export function exportFileName(title: string, ext: string, suffix = ""): string {
  const stem = sanitizeFileName(title).replace(/\.(md|markdown|mdx|txt)$/i, "").trim() || "未命名";
  return `${stem}${suffix}.${ext}`;
}

async function writeBinary(target: string, base64: string): Promise<void> {
  if (!isDesktop()) throw new Error("浏览器预览模式无法写入本地文件，请在桌面应用里导出");
  await api.writeBinaryAbs(target, base64);
}

export interface SaveDocxInput {
  markdown: string;
  /** 文档标题（章节名） */
  title: string;
  /** 段内单换行是否保留（来自 Markdown 设置） */
  preserveLineBreaks?: boolean;
  root: string | null;
  /** 当前文档所在目录（工作区相对路径） */
  baseDir?: string;
  /** 当前文档在工作区里的相对路径（用于拦截「导出覆盖源文件」） */
  sourcePath?: string | null;
  creator?: string;
  readImage?: DocxExportOptions["readImage"];
  rasterize?: DocxExportOptions["rasterize"];
  /** 默认文件名（不传按标题生成） */
  defaultName?: string;
  /** 单元测试注入：跳过系统保存对话框 */
  pickTarget?: (defaultName: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  /** 单元测试注入：替换真实写盘动作 */
  writeBinaryFile?: (target: string, base64: string) => Promise<void>;
}

export interface SaveExportResult {
  /** 用户取消（什么都没写） */
  cancelled: boolean;
  /** 真正写成功的路径；取消/失败时为 null */
  path: string | null;
  /** 报告（取消时也可能带构建阶段的问题说明） */
  report: ExportReport;
}

/** 构建并保存 DOCX。返回结果严格对应实际发生的事。 */
export async function saveDocxExport(input: SaveDocxInput): Promise<SaveExportResult> {
  const { buildDocx } = await import("./docxExport");
    const result = await buildDocx(input.markdown, input.title, {
      root: input.root,
      baseDir: input.baseDir,
      readImage: input.readImage,
      rasterize: input.rasterize,
      creator: input.creator,
      preserveLineBreaks: input.preserveLineBreaks,
    });
  const pick = input.pickTarget ?? ((name, filters) => api.saveExportFile(name, filters));
  const target = await pick(input.defaultName ?? exportFileName(input.title, "docx"), DOCX_FILTER);
  if (!target) {
    return {
      cancelled: true,
      path: null,
      report: buildReport({ summary: "已取消导出（未写入任何文件）", warnings: [], issues: [] }),
    };
  }
  const invalid = validateExportTarget(target, input.sourcePath, input.root);
  if (invalid) {
    return {
      cancelled: false,
      path: null,
      report: buildReport({ summary: `导出被拒绝：${invalid}`, warnings: [], issues: [], notes: [invalid] }),
    };
  }
  await (input.writeBinaryFile ?? writeBinary)(target, result.base64);
  return {
    cancelled: false,
    path: target,
    report: buildReport({
      writtenPath: target,
      summary: result.summary,
      warnings: result.warnings,
      issues: result.issues,
    }),
  };
}

export interface SaveEpubInput {
  /** 书名 */
  title: string;
  /** 段内单换行是否保留（来自 Markdown 设置） */
  preserveLineBreaks?: boolean;
  author?: string;
  chapters: EpubChapter[];
  root: string | null;
  /** 当前文档相对路径（拦截覆盖源文件）；整本书导出时传 null */
  sourcePath?: string | null;
  cover?: string;
  readImage?: EpubExportOptions["readImage"];
  defaultName?: string;
  pickTarget?: SaveDocxInput["pickTarget"];
  /** 单元测试注入：替换真实写盘动作 */
  writeBinaryFile?: SaveDocxInput["writeBinaryFile"];
}

/** 构建并保存 EPUB。 */
export async function saveEpubExport(input: SaveEpubInput): Promise<SaveExportResult> {
  const { buildEpub } = await import("./epubExport");
    const result = await buildEpub({
      title: input.title,
      author: input.author,
      chapters: input.chapters,
      root: input.root,
      cover: input.cover,
      readImage: input.readImage,
      preserveLineBreaks: input.preserveLineBreaks,
    });
  const pick = input.pickTarget ?? ((name, filters) => api.saveExportFile(name, filters));
  const target = await pick(input.defaultName ?? exportFileName(input.title, "epub"), EPUB_FILTER);
  if (!target) {
    return {
      cancelled: true,
      path: null,
      report: buildReport({ summary: "已取消导出（未写入任何文件）", warnings: [], issues: [] }),
    };
  }
  const invalid = validateExportTarget(target, input.sourcePath ?? null, input.root);
  if (invalid) {
    return {
      cancelled: false,
      path: null,
      report: buildReport({ summary: `导出被拒绝：${invalid}`, warnings: [], issues: [], notes: [invalid] }),
    };
  }
  await (input.writeBinaryFile ?? writeBinary)(target, result.base64);
  return {
    cancelled: false,
    path: target,
    report: buildReport({
      writtenPath: target,
      summary: result.summary,
      warnings: result.warnings,
      issues: result.issues,
    }),
  };
}

/** 报告 + 明细拼成一段可显示文本（对话框用） */
export function reportText(report: ExportReport): string {
  if (!report.lines.length) return report.summary;
  return `${report.summary}\n\n${report.lines.join("\n")}`;
}
