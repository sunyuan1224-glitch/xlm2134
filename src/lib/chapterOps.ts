import { api } from "../api";
import { useStore } from "../store";
import { isChapterFile, basename, dirName, nextChapterName } from "./chapter";
import { chapterFilesInTreeOrder, sortTreeNodes } from "./order";

/**
 * 新建章节的兜底名字。
 * 目录里的章是「第X章」风格时，默认名会顺着排成「第X+1章」（见 defaultChapterName）；
 * 其它情况就是普通的 Untitled，建之前也能改。
 */
export const DEFAULT_CHAPTER_NAME = "Untitled";

/**
 * 新建章节的默认名：看目标目录里**阅读顺序最后的那一章**叫什么。
 *   第二章 → 第三章、第IX章 → 第X章、第四章之后 → 第五章（哪怕缺了第二、三章）
 * 不是「第X章」风格（或目录里还没有章）就回落到 Untitled。
 */
export function defaultChapterName(dir: string): string {
  const inDir = sortedChapters().filter((p) => dirName(p) === dir);
  const prev = inDir.length > 0 ? basename(inDir[inDir.length - 1]).replace(/\.md$/i, "") : null;
  return nextChapterName(prev) ?? DEFAULT_CHAPTER_NAME;
}

/**
 * 新建章节的初始内容：**空白正文**。
 * 章节名由文件名管理（文件树、章列表、EPUB 目录都取文件名），
 * 正文里不再生成 `# 标题` —— 否则改名后两处标题会打架，正文第一行也要额外维护。
 */
export const CHAPTER_TEMPLATE = "";

/** 在同一目录里找不重名的名字：<base>、<base> 2、<base> 3… */
function freeChapterName(dir: string, files: string[], base: string): string {
  const taken = (name: string) => files.includes(dir ? `${dir}/${name}` : name);
  if (!taken(`${base}.md`)) return base;
  for (let i = 2; i < 500; i++) {
    const n = `${base} ${i}`;
    if (!taken(`${n}.md`)) return n;
  }
  return `${base} ${Date.now()}`;
}

/**
 * 新建下一章：延续当前命名风格。
 * 可指定 targetDir（显式目录）或 refPath（参考文件）。
 * 右键某一目录或文件时优先以其作为上下文，不偏离目标目录。
 */
export async function createNextChapter(options?: {
  dir?: string;
  refPath?: string;
}): Promise<string | null> {
  const st = useStore.getState();
  const { root, activePath, chapters } = st;
  if (!root) return null;

  // 1. 确定目录上下文与参考章节
  const explicitDir = options?.dir !== undefined ? options.dir : null;
  let targetDir = "";
  let refPath: string | null = null;

  if (explicitDir !== null) {
    targetDir = explicitDir;
    // 在该目录下找最后一个章节作为参考
    const inDir = chapters.filter((c) => dirName(c.path) === targetDir);
    if (inDir.length > 0) refPath = inDir[inDir.length - 1].path;
  } else if (options?.refPath) {
    refPath = options.refPath;
    targetDir = dirName(refPath);
  } else if (activePath && isChapterFile(activePath)) {
    refPath = activePath;
    targetDir = dirName(activePath);
  } else if (chapters.length > 0) {
    refPath = chapters[chapters.length - 1].path;
    targetDir = dirName(refPath);
  }

  // 命名接着目录里最后一章的章号往下排；不是「第X章」风格就回落到 Untitled，
  // 再在当前文件列表里避开重名。章号只由上一个章名决定，不看书里的编号是否连着。
  const base = defaultChapterName(targetDir);
  const baseName = freeChapterName(targetDir, useStore.getState().files, base);
  const newName = `${baseName}.md`;
  const targetPath = targetDir ? `${targetDir}/${newName}` : newName;
  // refPath 现在只用来决定目录上下文，不参与命名
  void refPath;

  try {
    await api.createFile(root, targetPath, CHAPTER_TEMPLATE);
    await useStore.getState().refresh();
    if (targetDir) useStore.getState().ensureExpanded(targetDir);
    await useStore.getState().openFile(targetPath);
    useStore.getState().setStatus("已新建 " + newName);
    return targetPath;
  } catch (e) {
    useStore.getState().setStatus("新建失败: " + String(e));
    return null;
  }
}

/** 光标处拆分 */
export async function splitCurrent(cursorOffset: number): Promise<void> {
  const st = useStore.getState();
  if (!st.root || !st.activePath) return;
  const path = st.activePath;
  const content = st.contents[path] ?? "";
  if (cursorOffset <= 0 || cursorOffset >= content.length) {
    st.setStatus("请把光标放在要拆分的位置");
    return;
  }
  try {
    await st.saveFile(path);
    const r = await api.splitAtCursor(st.root, path, cursorOffset, "");
    await useStore.getState().refresh();
    // 前半段被就地截短了，内存副本还是拆分前的整篇，不重读会把后半段又写回去
    await useStore.getState().reloadFromDisk(r.firstPath);
    await useStore.getState().openFile(r.secondPath);
    useStore
      .getState()
      .setStatus(`已拆分为 ${basename(r.firstPath)} 和 ${basename(r.secondPath)}`);
  } catch (e) {
    st.setStatus("拆分失败: " + String(e));
  }
}

/** 按文件树顺序排序的章节列表（卷按卷号、章按手动顺序，与大纲/EPUB 同一来源） */
export function sortedChapters(): string[] {
  const st = useStore.getState();
  const sorted = sortTreeNodes(st.tree, new Set(st.volumes), st.chapterOrder);
  return chapterFilesInTreeOrder(sorted);
}
