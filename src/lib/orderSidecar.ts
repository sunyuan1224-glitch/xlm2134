/*
 * 工作区侧车读写与总纲自动创建（只有这里 import api，纯计算都在 order.ts）。
 *
 * 这三个文件都是"跟着书走"的：写的时候**每本书各写一份**到 `<书>/.novel/` 下，
 * 同时在**工作区根**保留一份全量镜像（老版本 MyNovel、以及历史数据都靠它兼容）。
 * 读的时候把各处合并、按路径去重，所以：
 *   - 只把书文件夹搬到另一台电脑 → 书里带着自己那份，原地续写 ✓
 *   - 还没搬的老工作区 → 根目录那份照旧生效，不会丢 ✓
 *   - 删除条目 → 各处都是按当前状态重写的，不会"复活" ✓
 *
 * 文件内容里的路径是**相对书**的（书内的卷写作 "第一卷 风起"，书自身写作 ""）；
 * 读写边界上翻译成工作区相对路径，别处（order.ts / store）完全不用知道这件事。
 *   <书>/.novel/volumes.json       → { "volumes": ["第一卷 风起", ...] }  卷注册表
 *   <书>/.novel/chapter-order.json → { "<目录相对路径>": ["a.md", ...] }  章手动顺序
 *   <书>/.novel/order-flip.json    → { "books": ["", ...] }              反转显示
 *
 * 浏览器预览里 invoke 会 reject，这些函数全部 try/catch 兜底，不影响纯浏览器 UI。
 */
import { api } from "../api";
import { useStore } from "../store";
import { basename } from "./chapter";
import { missingBookOutlines, normalizeDir, type ChapterOrder } from "./order";
import { BOOK_OUTLINE_NAME, OUTLINE_DIR } from "./volume";

const VOLUMES_NAME = "volumes";
const CHAPTER_ORDER_NAME = "chapter-order";
const ORDER_FLIP_NAME = "order-flip";

/**
 * 当前工作区里所有"书"的目录名（顶层目录），外加一个空串代表工作区根
 * —— 根那份既是老数据来源，也是"工作区本身就是一本书"时的落点。
 * 传空数组时只留根：没有文件信息时按最保守的方式处理。
 */
function bookScope(files?: string[]): string[] {
  const list = files ?? useStore.getState().files;
  const tops = [...new Set(list.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter(Boolean);
  return [...tops, ""];
}

/** 书内记录 ↔ 工作区相对路径 */
function toWorkspace(book: string, stored: string): string {
  if (!book) return stored;
  return stored === "" ? book : `${book}/${stored}`;
}

/** 返回 null 表示"这条不属于这本书"，写它的文件时直接跳过 */
function fromWorkspace(book: string, path: string): string | null {
  if (!book) return path;
  if (path === book) return "";
  return path.startsWith(book + "/") ? path.slice(book.length + 1) : null;
}

async function readRaw(root: string, book: string, name: string): Promise<unknown | null> {
  try {
    const raw = await api.readSidecar(root, book, name);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch (e) {
    // 读不到就是个空来源（老工作区可能还没这个文件），不当成错误打断流程
    void e;
    return null;
  }
}

async function writeRaw(root: string, book: string, name: string, data: unknown): Promise<void> {
  try {
    await api.writeSidecar(root, book, name, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`写 ${name} 失败（${book || "工作区根"}）`, e);
  }
}

export async function loadVolumeRegistry(root: string, files?: string[]): Promise<string[]> {
  if (!root) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const scope = bookScope(files);
  // 老工作区（或刚搬来的书）只在根目录有这份文件：把每本书那份补出来，
  // 否则「打开一下、什么都没改就把书搬走」会丢掉卷与章顺序。补写是幂等的。
  let needBackfill = false;
  for (const book of scope) {
    const parsed = await readRaw(root, book, VOLUMES_NAME);
    if (parsed === null && book) needBackfill = true;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { volumes?: unknown } | null)?.volumes;
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      const p = toWorkspace(book, normalizeDir(String(x)));
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  if (needBackfill) void saveVolumeRegistry(root, out, files);
  return out;
}

// 上面读到「本书那份不存在」时，这里把合并结果补写回去（一次性，之后就是常规双写）
export async function saveVolumeRegistry(root: string, dirs: string[], files?: string[]): Promise<void> {
  if (!root) return;
  for (const book of bookScope(files)) {
    const slice = dirs.map((d) => fromWorkspace(book, d)).filter((x): x is string => x !== null);
    await writeRaw(root, book, VOLUMES_NAME, { volumes: slice });
  }
}

export async function loadChapterOrder(root: string, files?: string[]): Promise<ChapterOrder> {
  if (!root) return {};
  const out: ChapterOrder = {};
  const scope = bookScope(files);
  // 老工作区（或刚搬来的书）只在根目录有这份文件：把每本书那份补出来，
  // 否则「打开一下、什么都没改就把书搬走」会丢掉卷与章顺序。补写是幂等的。
  let needBackfill = false;
  for (const book of scope) {
    const parsed = await readRaw(root, book, CHAPTER_ORDER_NAME);
    if (parsed === null && book) needBackfill = true;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const list = v.map((x) => String(x)).filter(Boolean);
      const key = toWorkspace(book, normalizeDir(k));
      if (key && list.length && !out[key]) out[key] = list;
    }
  }
  if (needBackfill) void saveChapterOrder(root, out, files);
  return out;
}

// 上面读到「本书那份不存在」时，这里把合并结果补写回去（一次性，之后就是常规双写）
export async function saveChapterOrder(root: string, order: ChapterOrder, files?: string[]): Promise<void> {
  if (!root) return;
  for (const book of bookScope(files)) {
    const slice: ChapterOrder = {};
    for (const [dir, list] of Object.entries(order)) {
      const inner = fromWorkspace(book, dir);
      if (inner !== null) slice[inner] = list;
    }
    await writeRaw(root, book, CHAPTER_ORDER_NAME, slice);
  }
}

/** 总纲在书目录里的相对后缀：outline/总纲.md */
const OUTLINE_SUFFIX = `${OUTLINE_DIR}/${BOOK_OUTLINE_NAME}`;

/** 反转显示的书（右键书 →「反转卷与章的顺序」）。只影响左侧显示，不影响导出顺序。 */
export async function loadFlipRegistry(root: string, files?: string[]): Promise<string[]> {
  if (!root) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const scope = bookScope(files);
  // 老工作区（或刚搬来的书）只在根目录有这份文件：把每本书那份补出来，
  // 否则「打开一下、什么都没改就把书搬走」会丢掉卷与章顺序。补写是幂等的。
  let needBackfill = false;
  for (const book of scope) {
    const parsed = await readRaw(root, book, ORDER_FLIP_NAME);
    if (parsed === null && book) needBackfill = true;
    const arr = Array.isArray(parsed) ? parsed : (parsed as { books?: unknown } | null)?.books;
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      const p = toWorkspace(book, normalizeDir(String(x)));
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  if (needBackfill) void saveFlipRegistry(root, out, files);
  return out;
}

// 上面读到「本书那份不存在」时，这里把合并结果补写回去（一次性，之后就是常规双写）
export async function saveFlipRegistry(root: string, books: string[], files?: string[]): Promise<void> {
  if (!root) return;
  for (const book of bookScope(files)) {
    const slice = books.map((b) => fromWorkspace(book, b)).filter((x): x is string => x !== null);
    await writeRaw(root, book, ORDER_FLIP_NAME, { books: slice });
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
    const name = book || basename(root) || "未命名";
    try {
      await api.createFile(root, outlinePath, `# ${name}\n\n`);
      created.push(outlinePath);
    } catch (e) {
      console.error(`自动创建总纲失败 ${outlinePath}`, e);
    }
  }
  return created;
}
