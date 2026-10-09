/** 时间线 / 设定模块（M3）的交叉引用解析工具。
 *
 * 存盘约定（写在 sidecar 的 timeline.json / lore.json 里）：
 *  - TimelineEvent.chapters：存「章节标题」，与章节面板、伏笔面板的习惯一致；
 *    同时兼容历史/手输的「路径」「文件名」两种写法；
 *  - TimelineEvent.lore：能从词条下拉里挑到的，存 LoreEntry.id（词条改名不丢关联）；
 *    用户手打的自由文本原样保留，解析不到的引用在界面上标为「未匹配」；
 *  - LoreEntry.relations[].target：同样优先存 id，兼容名称 / 别名 / 自由文本。
 */

import type { LoreEntry } from "./types";

/** 类型为空时的占位分组名 */
export const UNMATCHED = "@";

export function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

export interface ChapterRef {
  path: string;
  title: string;
  name: string;
}

export interface LoreIndex {
  byId: Map<string, LoreEntry>;
  byName: Map<string, LoreEntry>;
}

export function buildLoreIndex(list: LoreEntry[]): LoreIndex {
  const byId = new Map<string, LoreEntry>();
  const byName = new Map<string, LoreEntry>();
  for (const e of list) {
    byId.set(e.id, e);
    for (const k of [e.name, ...e.aliases]) {
      const key = normKey(k);
      if (key && !byName.has(key)) byName.set(key, e);
    }
  }
  return { byId, byName };
}

/** 用 id / 名称 / 别名 解析引用，解析不到返回 undefined */
export function loreByRef(ref: string, index: LoreIndex): LoreEntry | undefined {
  const raw = (ref ?? "").trim();
  if (!raw) return undefined;
  const key = normKey(raw);
  return index.byId.get(raw) ?? index.byName.get(key);
}

export function loreLabel(ref: string, index: LoreIndex): string {
  const e = loreByRef(ref, index);
  if (e) return e.name;
  return (ref ?? "").trim();
}

/** 把名称 / 别名解析成 id，解析不到时返回原文（尽量保证关联稳定） */
export function loreIdOf(ref: string, index: LoreIndex): string {
  const raw = (ref ?? "").trim();
  if (!raw) return "";
  if (index.byId.has(raw)) return raw;
  const e = index.byName.get(normKey(raw));
  return e ? e.id : raw;
}

/** 逗号 / 分号 / 顿号 / 换行分隔的引用串 -> token 数组 */
export function splitTokens(text: string): string[] {
  return (text ?? "")
    .split(/[,，;；、\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinTokens(list: string[]): string {
  return list.join("，");
}

/** 去重 + 拆分，用于把散装字符串数组整理干净 */
export function tokensOf(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    for (const t of splitTokens(raw)) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

function stem(path: string): string {
  return normKey(path.replace(/\.(md|markdown|txt)$/i, ""));
}

/**
 * 章节引用索引：按 chapters 数组的身份缓存。
 *
 * matchChapter 是被「逐条引用」调用的：时间线上每个事件、每个词条都要解析若干次，
 * 同一条引用还会因为 chapterLabel 再解析一次。原实现每次都把整张章节表 normKey 一遍
 * （trim + 小写 + 去空白，每章三次），几百条引用 × 几百章就是几十万次字符串运算，
 * 而章节表只在刷新时才换。数组引用没变就直接复用索引。
 */
interface ChapterIndex {
  /** 归一化后的 path / title / name -> 章节（同键取最先出现的那一章，与原线性扫描一致） */
  byKey: Map<string, ChapterRef>;
  /** 去掉扩展名后的 title / name -> 章节（精确匹配全落空时的兜底） */
  byStem: Map<string, ChapterRef>;
}

const chapterIndexCache = new WeakMap<ChapterRef[], ChapterIndex>();

function chapterIndexOf(chapters: ChapterRef[]): ChapterIndex {
  const cached = chapterIndexCache.get(chapters);
  if (cached) return cached;
  const byKey = new Map<string, ChapterRef>();
  const byStem = new Map<string, ChapterRef>();
  // 键一律照收（不过滤空串）：空的归一化键只可能由空标题产生，
  // 而引用侧的 raw 已经 trim 过、空串在上面就返回了，查不到那个键。
  for (const c of chapters) {
    for (const k of [c.path, c.title, c.name]) {
      const key = normKey(k);
      if (!byKey.has(key)) byKey.set(key, c);
    }
    for (const k of [c.title, c.name]) {
      const key = stem(k);
      if (!byStem.has(key)) byStem.set(key, c);
    }
  }
  const index: ChapterIndex = { byKey, byStem };
  chapterIndexCache.set(chapters, index);
  return index;
}

/** 章节引用 -> 章节；找不到返回 undefined（界面上算「未匹配」） */
export function matchChapter(ref: string, chapters: ChapterRef[]): ChapterRef | undefined {
  const raw = (ref ?? "").trim();
  if (!raw) return undefined;
  const index = chapterIndexOf(chapters);
  return index.byKey.get(normKey(raw)) ?? index.byStem.get(stem(raw));
}

export function chapterLabel(ref: string, chapters: ChapterRef[]): string {
  const c = matchChapter(ref, chapters);
  if (!c) return ref;
  return c.title || c.name || c.path;
}

/** 时间线上出现的引用名（时间 / 标题），用于词条页的「使用情况」 */
export function eventLabel(time: string, title: string): string {
  const t = (time ?? "").trim();
  const ttl = (title ?? "").trim();
  if (t && ttl) return t + " · " + ttl;
  return ttl || t || "(未命名事件)";
}
