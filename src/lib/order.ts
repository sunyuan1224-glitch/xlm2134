/*
 * 文件树的「单一顺序来源」：卷注册表 + 章节手动顺序。
 *
 * 为什么需要它：
 *   - 卷不再只靠目录名识别。用户用「新建卷」建出来的目录叫「新建卷」，改名成「风起」
 *     之后也不带「第X卷」前缀，所以卷的判定 = 目录名匹配 OR 路径登记在卷注册表里
 *     （工作区侧车 .novel/volumes.json）。
 *   - 章节不再按「第X章 / 001」自动排序，改成每个目录一份手动顺序
 *     （工作区侧车 .novel/chapter-order.json，形如 { "<目录相对路径>": ["a.md","b.md"] }）。
 *     未列入的章排在已列之后；一个目录里谁都没登记时，按「第X章」的章号排。
 *   - 这份列表记的是该目录的**直接子项**：书目录里可以同时列卷目录名与松散章文件名，
 *     于是松散章能夹在卷与卷之间（「第一卷」「第一章」「第二卷」）；卷目录里没有子卷，
 *     值就还是纯章名。只有两个名字都在列表里时才按列表夹层，否则回落到「目录在前」。
 *
 * 这里的函数全是纯计算（不碰文件系统），文件树、store.chapters、大纲面板与 EPUB
 * 导出共用同一份顺序，因此「看到的顺序」「大纲的顺序」「EPUB 的顺序」必然一致。
 * 侧车读写与总纲自动创建在同目录的 orderSidecar.ts（那里才会 import api）。
 *
 * 例外只有一个：右键书 →「反转卷与章的顺序」（isDisplayFlipped）。它是**纯显示**的，
 * 只把左侧文件树和大纲页倒过来看，不写顺序侧车，所以 chapters 的阅读顺序与 EPUB 导出
 * 保持原样；代价是反转状态下拖动排序要换算一下方向（见 FileTree 的拖动落点）。
 */
import type { FileNode } from "../api";
import {
  OUTLINE_DIR,
  basename,
  dirName,
  extractChapterNumber,
  extractVolumeNumber,
  isChapterFile,
  isOutlineFile,
  isVolumeDirectoryName,
} from "./chapter";
import { BOOK_OUTLINE_NAME, bookOutlinePath } from "./volume";

/** 目录（工作区相对路径）→ 该目录内章的文件名顺序 */
export type ChapterOrder = Record<string, string[]>;

/** 「新建卷」的默认目录名：特意不匹配 isVolumeDirectoryName，靠卷注册表保证它还是卷 */
export const DEFAULT_VOLUME_NAME = "新建卷";

/** 「新建书 / 新建文件夹」的默认目录名 */
export const DEFAULT_BOOK_NAME = "新书";

/** 统一成「a/b/c」形式的相对路径（去掉首尾斜杠、反斜杠） */
export function normalizeDir(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 是否是卷目录：目录名匹配（第X卷 / 卷X / Volume N）或路径登记在卷注册表里。
 * name 传目录名，path 传工作区相对路径。
 */
export function isVolumeDir(
  name: string,
  path: string,
  volumes: ReadonlySet<string>,
): boolean {
  return isVolumeDirectoryName(name) || volumes.has(normalizeDir(path));
}

/** 只要工作区相对路径：顶层书层级判定用（basename 是最后一段） */
export function isVolumeDirPath(path: string, volumes: ReadonlySet<string>): boolean {
  const norm = normalizeDir(path);
  if (!norm) return false;
  return isVolumeDirectoryName(basename(norm)) || volumes.has(norm);
}

/**
 * 一个目录内章节文件名的排序：注册表里的顺序优先，其余排在后面。
 * 没登记的用和 compareTreeNodes 同一套兜底：先按「第X章」的章号，再按文件名稳定序。
 * （中文按拼音比大小会把「第二章」排到「第一章」前面，所以章号必须自己算。）
 * names = 该目录里实际存在的章文件名；listed = chapter-order.json 里记的顺序。
 */
export function orderDirChapters(names: string[], listed: readonly string[]): string[] {
  const present = new Set(names);
  const head: string[] = [];
  for (const n of listed) {
    if (present.has(n) && !head.includes(n)) head.push(n);
  }
  const rest = names
    .filter((n) => !head.includes(n))
    .sort((a, b) => {
      const an = extractChapterNumber(a);
      const bn = extractChapterNumber(b);
      if (an !== null && bn !== null && an !== bn) return an - bn;
      return a.localeCompare(b, "zh-CN", { numeric: true });
    });
  return [...head, ...rest];
}

/**
 * 顺序表里的一项是不是目录名（也就是一个卷）。
 * 表里只会写两种东西：卷目录名与 .md 章文件名，所以按扩展名分辨最稳。
 */
function listedIsDir(name: string): boolean {
  return !/\.(?:md|markdown|mdx)$/i.test(name);
}

/**
 * 这份顺序表里登记过卷没有 —— 有就是「卷与章混合排列」的夹层模式，
 * 比较器才允许跨过「目录在前」。
 * 结果按列表对象缓存：列表对象在两次改动之间是同一个引用，而比较器会被调用 O(n log n) 次。
 */
const interleaveCache = new WeakMap<readonly string[], boolean>();
function orderHasDir(list: readonly string[]): boolean {
  let hit = interleaveCache.get(list);
  if (hit === undefined) {
    hit = list.some(listedIsDir);
    interleaveCache.set(list, hit);
  }
  return hit;
}

/**
 * 同一层兄弟节点的比较器（文件树的视觉顺序，也是阅读顺序的来源）：
 *   目录在前；目录里卷在前、卷按卷号排；文件里总纲/卷纲在最前；
 *   其余章按手动顺序，未列入的按文件名。
 *
 * 例外是「夹层」：书目录里的松散章可以夹在卷与卷之间 —— 只要这两个名字都登记在
 * 同一份直接子项列表里（chapter-order.json 的该目录键），就先按列表位置比较。
 */
export function compareTreeNodes(
  a: FileNode,
  b: FileNode,
  volumes: ReadonlySet<string>,
  order: ChapterOrder,
  /**
   * true = 文件排在文件夹前面。
   * 只给工作区根层用：散放在根下的章排到各本书文件夹上面，一眼就能看到。
   */
  filesFirst = false,
): number {
  /*
   * 夹层模式：这份表里登记过卷（卷与章混排），此时「登记过的排在没登记的前面」，
   * 登记过的一律按列表位置排 —— 卷与松散章就是这样夹在一起的。
   *
   * 两个要点，缺一个就会坏：
   *   1. 必须管到**所有**同层兄弟对，不能只管「目录 vs 文件」那些对。
   *      否则没登记的卷仍按卷号与登记过的卷比大小（第一卷 < 第二卷），
   *      而登记过的章又排在没登记的卷前（第二章 < 第一卷），加上列表里的
   *      卷在章前（第二卷 < 第二章），三者绕成环，Array.sort 只能给出乱序。
   *   2. 平行世界里那份「表里没有卷」的旧工作区一点都不能变，所以整块以 orderHasDir 为门。
   *      （`!filesFirst` 同样重要：根层是「书 / 散章」，走的是 filesFirst 那套。）
   */
  const listed = order[dirName(a.path)] ?? [];
  if (!filesFirst && orderHasDir(listed)) {
    const ai = listed.indexOf(a.name);
    const bi = listed.indexOf(b.name);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    // 都没登记 → 落到下面按老规矩比（目录在前、卷按卷号、章按章号）
  }
  if (a.is_dir !== b.is_dir) {
    const dirFirst = a.is_dir ? -1 : 1;
    return filesFirst ? -dirFirst : dirFirst;
  }
  if (a.is_dir) {
    const aVol = isVolumeDir(a.name, a.path, volumes);
    const bVol = isVolumeDir(b.name, b.path, volumes);
    if (aVol !== bVol) return aVol ? -1 : 1;
    if (aVol && bVol) {
      const an = extractVolumeNumber(a.name);
      const bn = extractVolumeNumber(b.name);
      if (an !== null && bn !== null && an !== bn) return an - bn;
    }
  } else {
    const aOutline = isOutlineFile(a.path);
    const bOutline = isOutlineFile(b.path);
    if (aOutline !== bOutline) return aOutline ? -1 : 1;
    if (!aOutline && !bOutline) {
      // 同一层的文件必在同一目录里，所以手动顺序按父目录的 key 取
      const listed = order[dirName(a.path)] ?? [];
      const ai = listed.indexOf(a.name);
      const bi = listed.indexOf(b.name);
      if (ai >= 0 && bi >= 0 && ai !== bi) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      // 两边都没登记手动顺序时，按「第X章」的章号排。
      // 不能交给 localeCompare：中文按拼音比大小，「第二章」会排到「第一章」前面。
      const an = extractChapterNumber(a.name);
      const bn = extractChapterNumber(b.name);
      if (an !== null && bn !== null && an !== bn) return an - bn;
    }
  }
  return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
}

/** 递归排序整棵树（store 计算阅读顺序时用；文件树渲染时逐层用 compareTreeNodes 即可） */
export function sortTreeNodes(
  nodes: FileNode[],
  volumes: ReadonlySet<string>,
  order: ChapterOrder,
  /** 只有根层传 true：根下的文件显示在书文件夹上面 */
  filesFirst = false,
): FileNode[] {
  return [...nodes]
    .sort((a, b) => compareTreeNodes(a, b, volumes, order, filesFirst))
    .map((n) => (n.is_dir ? { ...n, children: sortTreeNodes(n.children, volumes, order, false) } : n));
}

/**
 * 这个路径是不是在「反转显示」的书里（自己就是那本书，或者在那本书下面）。
 * 反转只作用于**左侧显示**（文件树、大纲页）：把这本书子树里每一层兄弟列表倒过来，
 * 磁盘上的顺序、chapters 的阅读顺序、EPUB 导出顺序都不受影响。
 * 拖动排序会遇到它：反着显示的目录里，「插到某章前面」在顺序侧车里是「后面」。
 */
export function isDisplayFlipped(path: string, flippedBooks: ReadonlySet<string>): boolean {
  const norm = normalizeDir(path);
  if (!norm || flippedBooks.size === 0) return false;
  const parts = norm.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (flippedBooks.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

/**
 * 某个目录的**直接子项**在视觉顺序里的名字（卷目录名与章文件名混合）。
 * 拖动落点就是往这份列表里插名字：卷目录里没有子卷，结果自然只剩章名，
 * 与旧的「目录内章的手动顺序」是同一份东西。
 */
export function directChildOrder(
  children: readonly FileNode[],
  volumes: ReadonlySet<string>,
  order: ChapterOrder,
  /** 与 compareTreeNodes 同义：只有工作区根层传 true，保证写回的顺序与看到的顺序一致 */
  filesFirst = false,
): string[] {
  return children
    .filter((n) => isVolumeDir(n.name, n.path, volumes) || isChapterFile(n.path))
    .slice()
    .sort((a, b) => compareTreeNodes(a, b, volumes, order, filesFirst))
    .map((n) => n.name);
}

/**
 * 新建 / 改名一个卷之后，把它摆进父目录的顺序表。
 *
 * 为什么需要：夹层模式下「没登记的名字排在已登记之后」，新卷若不管它，会掉到所有
 * 松散章下面（表尾常常正好是一个松散章）。这里按卷号把它插回卷堆里：
 *   - 有卷号 → 插在第一个卷号更大的卷之前，没有更大的就接在最后一个卷后面；
 *   - 没卷号（刚建出来还叫「新建卷」，或「序卷」这类） → 接在最后一个卷后面。
 * 表里还没有登记过卷（旧工作区只登记章名）时原样返回：不去制造夹层模式，
 * 卷序继续由卷号动态算。
 *
 * 约定：list 传「这一下改完之后」的表 —— 改名时新名字已经在里面（旧名字由调用方删掉），
 * 新建时新名字还不在里面。函数靠这一点区分「挪一个已存在的卷」与「插入一个新卷」。
 */
export function placeVolumeInOrder(list: readonly string[], volName: string): string[] {
  const out = list.filter((n) => n !== volName);
  if (!orderHasDir(list)) return out; // 表里没登记过卷：原样，不去制造夹层模式
  const dirs = out
    .map((name, at) => ({ name, at }))
    .filter((x) => listedIsDir(x.name));
  const lastDirAt = dirs.length ? dirs[dirs.length - 1].at + 1 : out.length;
  const num = extractVolumeNumber(volName);
  const before =
    num === null ? undefined : dirs.find((x) => (extractVolumeNumber(x.name) ?? Infinity) > num);
  if (before) {
    out.splice(before.at, 0, volName);
    return out;
  }
  // 没有卷号更大的卷可挡在前面：接到最后一个卷后面。但如果它**本来就是**最后一个卷
  // （改个卷名、没改号），就让它待在原地 —— 挪到「最后一个卷之后」会越过它后面那些
  // 特意夹在卷之间的松散章。
  if ([...list].reverse().find(listedIsDir) === volName) {
    const kept = [...out];
    kept.splice(list.indexOf(volName), 0, volName);
    return kept;
  }
  out.splice(lastDirAt, 0, volName);
  return out;
}

/** 按树的可视顺序收集章节文件（大纲与 EPUB 的同一阅读顺序来源） */
export function chapterFilesInTreeOrder(nodes: FileNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.is_dir) out.push(...chapterFilesInTreeOrder(n.children));
    else if (isChapterFile(n.path)) out.push(n.path);
  }
  return out;
}

/** 拖动章节时的同目录重排：把 moving 放到 target 的前/后 */
export function moveWithinOrder(
  order: readonly string[],
  moving: string,
  target: string,
  where: "before" | "after",
): string[] {
  const list = order.filter((n) => n !== moving);
  const idx = list.indexOf(target);
  const at = idx < 0 ? list.length : where === "after" ? idx + 1 : idx;
  list.splice(at, 0, moving);
  return list;
}

/**
 * 章属于哪本书（总纲的落点）：
 *   工作区根（""）= 章直接放在根目录，或顶层那一段本身就是卷（卷属于根这本「书」）；
 *   否则取第一段目录名（顶层书文件夹）。
 */
export function bookScopeOf(path: string, volumes: ReadonlySet<string>): string {
  const norm = path.replace(/\\/g, "/");
  const at = norm.indexOf("/");
  if (at < 0) return "";
  const first = norm.slice(0, at);
  return isVolumeDirPath(first, volumes) ? "" : first;
}

/**
 * 需要自动补总纲的书层级：出现任意章节文件、且该书层级没有总纲。
 * 总纲的规范位置是 `<书>/outline/总纲.md`；旧工作区里的 `<书>/总纲.md` 也算有
 * （不重复创建，避免同一本书两份总纲）。
 * 空目录不会触发。
 *
 * 注意：工作区根（bookScopeOf 返回 ""）不建总纲 —— 根目录是「书的上一层」，
 * 在那里放一份纲要只会让人困惑，书级纲要一律放在书文件夹里。
 */
export function missingBookOutlines(files: string[], volumes: ReadonlySet<string>): string[] {
  const scopes = new Set<string>();
  for (const p of files) {
    if (!isChapterFile(p)) continue;
    const book = bookScopeOf(p, volumes);
    if (!book) continue; // 根级的章不触发总纲
    scopes.add(book);
  }
  const missing: string[] = [];
  for (const book of scopes) {
    const outlinePath = bookOutlinePath(book);
    const legacyPath = `${book}/${BOOK_OUTLINE_NAME}`;
    if (!files.includes(outlinePath) && !files.includes(legacyPath)) missing.push(outlinePath);
  }
  return missing.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** 章对应的章节纲要路径（不判断存在与否）；散在根下的章没有纲要，返回 null */
function chapterOutlinePath(chapterPath: string, volumes: ReadonlySet<string>): string | null {
  const book = bookScopeOf(chapterPath, volumes);
  if (!book) return null;
  const stem = basename(chapterPath).replace(/\.md$/i, "");
  return `${book}/${OUTLINE_DIR}/${stem}.md`;
}

/**
 * 删掉某个条目时，**会一并消失**的纲要文件。
 *
 * 纲要挂在书目录的 outline/ 下，不在被删条目的子树里，所以删章、删卷都得显式带上，
 * 否则 outline/ 里会留下一堆对不上任何章的孤儿（大纲页会一直列着它们）。
 *
 *   - 章  → 它所属书里的 outline/<章名>.md
 *   - 卷  → 该卷的卷纲 + 卷里所有章的章节纲要
 *   - 普通子目录 → 里面所有章的章节纲要
 *   - 顶层书文件夹 → []（outline/ 就在它里面，随目录一起删，不必单列）
 *
 * 返回的是纲要文件的相对路径，删不删由调用方决定（删除确认框里也会列出来）。
 */
export function outlinesRemovedWith(
  target: string,
  files: readonly string[],
  volumes: ReadonlySet<string>,
): string[] {
  const present = new Set(files);
  const out = new Set<string>();
  const add = (p: string | null) => {
    if (p && present.has(p)) out.add(p);
  };

  // 文件：只有章才有对应的章节纲要
  if (present.has(target)) {
    if (!isChapterFile(target)) return [];
    add(chapterOutlinePath(target, volumes));
    return [...out];
  }

  const inside = files.filter((p) => p.startsWith(target + "/"));
  if (inside.length === 0) return [];

  const norm = normalizeDir(target);
  // 顶层书文件夹：整份 outline/ 跟着目录走，不需要单独删
  const isTopLevel = !norm.includes("/");
  if (isTopLevel && !isVolumeDirPath(norm, volumes)) return [];

  // 卷纲：卷目录自己那份，挂在所属书上
  if (isVolumeDirPath(norm, volumes)) {
    const book = bookScopeOf(norm, volumes);
    if (book) add(`${book}/${OUTLINE_DIR}/${basename(norm)}.md`);
  }
  // 子树里每个章的章节纲要
  for (const p of inside) {
    if (isChapterFile(p)) add(chapterOutlinePath(p, volumes));
  }
  return [...out].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
