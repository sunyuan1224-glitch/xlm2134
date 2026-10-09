/*
 * 工作区侧车读写与总纲自动创建（只有这里 import api，纯计算都在 order.ts）。
 *
 * 侧车文件（与 vault.rs 的 sidecar_path 一致，work 传 "" 落在工作区根）：
 *   .novel/volumes.json       → { "volumes": ["第一卷 风起", "风起", ...] }  卷注册表
 *   .novel/chapter-order.json → { "<目录相对路径>": ["a.md", "b.md", ...] }  章手动顺序
 *   .novel/order-flip.json    → { "books": ["我的书", ...] }  反转显示的书（只影响左侧显示）
 *
 * 浏览器预览里 invoke 会 reject，这些函数全部 try/catch 兜底，不影响纯浏览器 UI。
 */
import { api } from "../api";
import { missingBookOutlines, normalizeDir, type ChapterOrder } from "./order";
import { BOOK_OUTLINE_NAME, OUTLINE_DIR } from "./volume";

const VOLUMES_NAME = "volumes";
const CHAPTER_ORDER_NAME = "chapter-order";
const ORDER_FLIP_NAME = "order-flip";

export async function loadVolumeRegistry(root: string): Promise<string[]> {
  if (!root) return [];
  try {
    const raw = await api.readSidecar(root, "", VOLUMES_NAME);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed as { volumes?: unknown })?.volumes;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => normalizeDir(String(x))).filter(Boolean);
  } catch (e) {
    console.error("读取卷注册表失败", e);
    return [];
  }
}

export async function saveVolumeRegistry(root: string, dirs: string[]): Promise<void> {
  if (!root) return;
  try {
    await api.writeSidecar(root, "", VOLUMES_NAME, JSON.stringify({ volumes: dirs }, null, 2));
  } catch (e) {
    console.error("写卷注册表失败", e);
  }
}

export async function loadChapterOrder(root: string): Promise<ChapterOrder> {
  if (!root) return {};
  try {
    const raw = await api.readSidecar(root, "", CHAPTER_ORDER_NAME);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: ChapterOrder = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          const list = v.map((x) => String(x)).filter(Boolean);
          const key = normalizeDir(k);
          if (key && list.length) out[key] = list;
        }
      }
      return out;
    }
    return {};
  } catch (e) {
    console.error("读取章节顺序失败", e);
    return {};
  }
}

export async function saveChapterOrder(root: string, order: ChapterOrder): Promise<void> {
  if (!root) return;
  try {
    await api.writeSidecar(root, "", CHAPTER_ORDER_NAME, JSON.stringify(order, null, 2));
  } catch (e) {
    console.error("写章节顺序失败", e);
  }
}

/** 总纲在书目录里的相对后缀：outline/总纲.md */
const OUTLINE_SUFFIX = `${OUTLINE_DIR}/${BOOK_OUTLINE_NAME}`;

/** 反转显示的书（右键书 →「反转卷与章的顺序」）。只影响左侧显示，不影响导出顺序。 */
export async function loadFlipRegistry(root: string): Promise<string[]> {
  if (!root) return [];
  try {
    const raw = await api.readSidecar(root, "", ORDER_FLIP_NAME);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { books?: unknown })?.books;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => normalizeDir(String(x))).filter(Boolean);
  } catch (e) {
    console.error("读取反转显示设置失败", e);
    return [];
  }
}

export async function saveFlipRegistry(root: string, books: string[]): Promise<void> {
  if (!root) return;
  try {
    await api.writeSidecar(root, "", ORDER_FLIP_NAME, JSON.stringify({ books }, null, 2));
  } catch (e) {
    console.error("写反转显示设置失败", e);
  }
}

/**
 * 总纲自动创建：某本书（顶层书文件夹）一旦出现任意章节文件，
 * 且该书层级缺少总纲，就补一个内容只有 `# 书名` 的 总纲.md，
 * 放在书目录下的 outline/ 文件夹里。
 * 空目录不触发；幂等（存在即跳过）。返回本次实际创建的路径列表。
 */
export async function ensureBookOutlines(
  root: string,
  files: string[],
  volumes: string[],
): Promise<string[]> {
  if (!root) return [];
  const missing = missingBookOutlines(files, new Set(volumes));
  const created: string[] = [];
  for (const outlinePath of missing) {
    // missingBookOutlines 只会给出「书文件夹/outline/总纲.md」，不会再有根级那份
    const book = outlinePath.slice(0, -(OUTLINE_SUFFIX.length + 1));
    const name = book || root.split("/").pop() || "未命名";
    try {
      await api.createFile(root, outlinePath, `# ${name}\n\n`);
      created.push(outlinePath);
    } catch (e) {
      console.error(`自动创建总纲失败 ${outlinePath}`, e);
    }
  }
  return created;
}
