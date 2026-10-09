/*
 * 卷级：介于「书（工作区里的文件夹）」与「章（.md 文件）」之间的一层。
 *
 * 数据模型（与既有约定一致，不引入新的存储格式）：
 *   - 卷 = 目录名匹配 isVolumeDirectoryName 的目录（「第一卷 风起」「卷二」「Volume 3」…）；
 *   - 章 = 卷目录（或书目录）下的 .md 文件；
 *   - 整本书可以不设卷：章直接放在书目录下，此时所有章都是「松散章」（volume 为 null），
 *     文件树不画卷细线，EPUB 目录保持扁平。
 *
 * 本模块只做纯计算（路径 → 卷信息、按卷分组、卷标题），不碰文件系统，
 * 因此可以被文件树、大纲面板、EPUB 导出和 Node 测试共用。
 *
 * 卷标题只由目录名决定（「第一卷 风起」→「风起」）：卷纲（outline/<卷目录名>.md）是可选的
 * 创作文档，只供人读，不参与卷标题的解析。
 */
import { OUTLINE_DIR, basename, extractVolumeNumber, isVolumeDirectoryName } from "./chapter";

export { OUTLINE_DIR };

/** 书级纲要文件名：放在书目录下的 outline/ 里 */
export const BOOK_OUTLINE_NAME = "总纲.md";

/**
 * 一本书的总纲路径：书目录下的 outline/总纲.md。
 * 工作区根（book === ""）时落在根目录的 outline/总纲.md。
 */
export function bookOutlinePath(book: string): string {
  return book ? `${book}/${OUTLINE_DIR}/${BOOK_OUTLINE_NAME}` : `${OUTLINE_DIR}/${BOOK_OUTLINE_NAME}`;
}

const CN_NUM = "0-9零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟万";
/** 卷号后面常见的分隔符（「第三卷：群星」「第一卷 - 风起」） */
const SEP = "[：:·、.，,\\-—_\u3000\\s]";

/**
 * 卷目录名 → 人类可读的卷标题：去掉「第X卷 / 卷X / Volume N」前缀及其后的分隔符。
 *   「第一卷 风起」→「风起」；「第三卷：群星」→「群星」；「Volume 2 - The Storm」→「The Storm」；
 *   「第二卷」（没有卷名）→「第二卷」，保证永远有可显示的标题。
 */
export function volumeDisplayName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed
    .replace(new RegExp(`^第\\s*[${CN_NUM}]+\\s*[卷部篇](?:${SEP}*)?`), "")
    .replace(new RegExp(`^卷\\s*[${CN_NUM}]+(?:${SEP}*)?`), "")
    .replace(new RegExp(`^vol(?:ume)?\\s*\\d+(?:${SEP}*)?`, "i"), "")
    .trim();
  return stripped || trimmed;
}

/**
 * 章路径所属的卷目录（工作区相对路径）；不在任何卷里返回 ""。
 * 卷判定 = 目录名匹配（第X卷 / 卷X / Volume N）或路径登记在卷注册表 volumes 里。
 * volumes 是「工作区相对目录路径」的集合，可省略（省略时只按目录名识别）。
 */
export function findVolumeDir(path: string, volumes?: ReadonlySet<string>): string {
  const parts = path.replace(/\\/g, "/").split("/");
  parts.pop(); // 去掉文件名，只看祖先目录
  for (let i = parts.length - 1; i >= 0; i--) {
    const prefix = parts.slice(0, i + 1).join("/");
    if (isVolumeDirectoryName(parts[i]) || volumes?.has(prefix)) return prefix;
  }
  return "";
}

export interface VolumeInfo {
  /** 卷目录的工作区相对路径 */
  dir: string;
  /** 目录名（原始） */
  name: string;
  /** 人类可读的卷标题（去掉「第X卷」前缀） */
  display: string;
  /** 卷号（识别不到为 null，例如「序卷」「终卷」） */
  number: number | null;
}

export function volumeInfoOf(dir: string): VolumeInfo {
  const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = norm ? basename(norm) : "";
  return { dir: norm, name, display: volumeDisplayName(name), number: extractVolumeNumber(name) };
}

export interface VolumeGroup<T> {
  /** null = 不在任何卷里的「松散章」（整本书不设卷，或章直接放在书目录下） */
  volume: VolumeInfo | null;
  items: T[];
}

/**
 * 按卷分组，保持入参顺序：同一卷的项归到同一个组（以首次出现的位置为准），
 * 不在卷里的项归到 volume=null 的组。组顺序 = 各卷首次出现顺序。
 */
export function groupItemsByVolume<T>(
  items: T[],
  pathOf: (item: T) => string,
  volumes?: ReadonlySet<string>,
): VolumeGroup<T>[] {
  const groups: VolumeGroup<T>[] = [];
  const index = new Map<string, VolumeGroup<T>>();
  for (const item of items) {
    const dir = findVolumeDir(pathOf(item), volumes);
    let group = index.get(dir);
    if (!group) {
      group = { volume: dir ? volumeInfoOf(dir) : null, items: [] };
      index.set(dir, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** 是否是某个 总纲.md */
export function isBookOutlinePath(path: string): boolean {
  return basename(path.replace(/\\/g, "/")).toLowerCase() === BOOK_OUTLINE_NAME.toLowerCase();
}

/** EPUB 用的卷引用（与 lib/epubExport 的 EpubVolume 结构一致） */
export interface EpubVolumeRef {
  /** 分组键：同一卷的章共享（这里用卷目录路径） */
  key: string;
  /** 目录上显示的卷标题 */
  title: string;
}

/**
 * 卷目录 → EPUB 卷引用：标题取目录名去掉「第X卷」后的可读名。
 * 卷纲是编辑用的文档，不是元数据来源，所以卷标题不从文件里读。
 */
export function epubVolumeRef(info: VolumeInfo): EpubVolumeRef {
  return { key: info.dir, title: info.display || info.name };
}
