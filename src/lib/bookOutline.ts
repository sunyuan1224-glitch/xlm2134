/*
 * 整本书的纲要树：「总纲 → 卷 → 章 → 章内标题」。
 *
 * 纯函数：给一组文件路径、章节列表和「路径 → 文本」的映射，
 * 拼出左侧「大纲」标签页要显示的树。文本没加载时只少标题层级，不报错，
 * 面板可以按需懒加载后再重算（见 components/OutlinePanel）。
 *
 * 层级关系（与文件树一一对应）：
 *   总纲.md（书级）    → 它的标题层级
 *   卷目录            → 该卷的章
 *   章 .md            → 章标题（点击打开）+ 章内 extractOutline 标题（点击跳转到行）
 * 没有卷时（整本书不设卷）：只有 总纲 + 章。
 * 卷纲已取消：卷标题直接取目录名的可读名。
 */
import { basename } from "./chapter";
import { extractOutline, type OutlineItem } from "./outline";
import { groupItemsByVolume, isBookOutlinePath, type VolumeInfo } from "./volume";

export interface BookOutlineChapter {
  path: string;
  /** 章标题（优先用 store 里的 ChapterMeta.title） */
  title: string;
  /** 章内标题；章文本还没加载时为空数组 */
  headings: OutlineItem[];
}

export interface BookOutlineVolume {
  info: VolumeInfo;
  /** 卷标题：卷目录名的可读名（去掉「第X卷」前缀） */
  title: string;
  chapters: BookOutlineChapter[];
}

export interface BookOutlineDoc {
  path: string;
  /** H1（其次首个标题）；没有则用「总纲」 */
  title: string;
  /** 所在目录（多本书工作区里用于区分） */
  dir: string;
  headings: OutlineItem[];
}

export interface BookOutline {
  /** 总纲.md（可以有多个：一个工作区里放多本书时） */
  books: BookOutlineDoc[];
  volumes: BookOutlineVolume[];
  /** 不在任何卷里的章 */
  /** 直接放在工作区根下的章：大纲里排在最前面，和文件树保持一致 */
  rootChapters: BookOutlineChapter[];
  loose: BookOutlineChapter[];
  /** 需要读取文本才能显示标题层级的纲要文件（面板预读这些路径） */
  outlinePaths: string[];
}

export interface BuildBookOutlineInput {
  /** 工作区里的全部文件（api.scan 的 files） */
  files: string[];
  /** 卷注册表（工作区相对目录路径）；省略时只按「第X卷」这类目录名识别卷 */
  volumes?: string[];
  /** 章节列表（顺序即期望的阅读顺序；通常来自 store.chapters） */
  chapters: { path: string; title?: string }[];
  /** 路径 → 文本；未加载的可以缺 */
  texts?: Record<string, string | undefined>;
}

function headingsOf(texts: Record<string, string | undefined>, path: string | null): OutlineItem[] {
  if (!path) return [];
  const text = texts[path];
  if (text === undefined) return [];
  return extractOutline(text);
}

/** 层级标题：H1 优先，其次首个标题，都没有就用兜底名 */
function titleFrom(
  texts: Record<string, string | undefined>,
  path: string | null,
  fallback: string,
): string {
  const items = headingsOf(texts, path);
  return items.find((h) => h.level === 1)?.text ?? items[0]?.text ?? fallback;
}

export function buildBookOutline(input: BuildBookOutlineInput): BookOutline {
  const texts = input.texts ?? {};

  const bookPaths = input.files.filter(isBookOutlinePath).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const books: BookOutlineDoc[] = bookPaths.map((path) => ({
    path,
    title: titleFrom(texts, path, "总纲"),
    dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    headings: headingsOf(texts, path),
  }));

  const groups = groupItemsByVolume(
    input.chapters,
    (c) => c.path,
    input.volumes ? new Set(input.volumes) : undefined,
  );

  const chapterNode = (item: { path: string; title?: string }): BookOutlineChapter => ({
    path: item.path,
    title: item.title?.trim() || basename(item.path).replace(/\.md$/i, ""),
    headings: headingsOf(texts, item.path),
  });

  const volumes: BookOutlineVolume[] = [];
  const loose: BookOutlineChapter[] = [];
  for (const group of groups) {
    if (!group.volume) {
      loose.push(...group.items.map(chapterNode));
      continue;
    }
    const info = group.volume;
    volumes.push({
      info,
      title: info.display || info.name,
      chapters: group.items.map(chapterNode),
    });
  }

  // 根下的章（路径里没有 "/"）单独一组：它们不属于任何书，理应排在最上面
  const rootChapters = loose.filter((c) => !c.path.includes("/"));
  const bookLoose = loose.filter((c) => c.path.includes("/"));

  return {
    books,
    volumes,
    rootChapters,
    loose: bookLoose,
    outlinePaths: bookPaths,
  };
}

/** 总纲 H1 → 书名；没有总纲或没有标题时用兜底名（导出整本书时的 dc:title） */
export function bookTitleFrom(outlineText: string | undefined, fallback: string): string {
  if (!outlineText) return fallback;
  const items = extractOutline(outlineText);
  return items.find((h) => h.level === 1)?.text ?? items[0]?.text ?? fallback;
}
