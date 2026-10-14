import { api } from "../api";
import { useStore } from "../store";
import type { Foreshadow, LoreEntry, TimelineEvent } from "./types";

/** 侧车文件读写：作品目录下的 .novel/<name>.json */

/**
 * 当前作品（书）目录 —— 侧车落在 `<root>/<work>/.novel/` 下。
 *
 * 规则：**取当前章路径的第一段，但只有在它确实是一本书（该目录下有 outline/）时才算**。
 *   - 「工作区/我见/第一卷/001.md」→ "我见"（书）
 *   - 「工作区/我见/序章.md」      → "我见"（书）
 *   - 「书被单独打开，卷在根下」   → ""（"第一卷" 不是书，是卷 → 侧车落工作区根，也就是书根）
 *
 * 最后那条是这次改的关键：把书目录单独搬到另一台电脑打开时，卷目录的路径就在根下，
 * 若还按"第一段"算，侧车会被塞进卷目录里、与搬来的那份对不上。现在按"是不是书"判断，
 * 侧车始终落在书根，搬走的书能原地续写。
 *
 * 以前这里无条件取 `split("/")[0]`，根级章会得到 `"第一章.md"` 这种「作品名」，
 * 拼出 `<root>/第一章.md/.novel/plot.json`——父目录是个文件，写盘必然失败，
 * 而失败只弹一条状态栏提示，看起来就像伏笔/时间线/专注全都存不上。
 */
export function currentWork(): string | null {
  const st = useStore.getState();
  if (!st.root) return null;
  const p = st.activePath ?? st.files[0];
  if (!p) return null;
  const parts = p.split("/");
  if (parts.length <= 1) return "";
  const book = parts[0];
  // 这个目录下有 outline/ 就算"书"（总纲 / 卷纲 / 章纲都住在那儿）；
  // 另外：整个工作区只有一个顶层目录时也当它是一本书 —— 新书还没建纲要的那一刻
  // 也算数，免得侧车跑到工作区根去。
  const hasOutline = st.files.some((f) => f.startsWith(book + "/outline/"));
  const tops = new Set(st.files.map((f) => f.split("/")[0]));
  const isBook = hasOutline || tops.size === 1;
  return isBook ? book : "";
}

async function load<T>(name: string, fallback: T, work: string | null): Promise<T> {
  const root = useStore.getState().root;
  if (!root || work === null) return fallback;
  try {
    const raw = await api.readSidecar(root, work, name);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as object) } as T;
  } catch (e) {
    console.error("读取 " + name + " 失败", e);
    return fallback;
  }
}

async function save<T>(name: string, data: T, work: string | null): Promise<void> {
  const root = useStore.getState().root;
  if (!root || work === null) return;
  try {
    await api.writeSidecar(root, work, name, JSON.stringify(data, null, 2));
  } catch (e) {
    useStore.getState().setStatus("保存 " + name + " 失败: " + String(e));
  }
}

// ---------- 伏笔 ----------
export const loadForeshadows = (work: string | null) =>
  load<{ items: Foreshadow[] }>("plot", { items: [] }, work).then((d) => d.items);

export const saveForeshadows = (items: Foreshadow[], work: string | null) =>
  save("plot", { items }, work);

// ---------- 时间线 ----------
export const loadTimeline = (work: string | null) =>
  load<{ items: TimelineEvent[] }>("timeline", { items: [] }, work).then((d) => d.items);

export const saveTimeline = (items: TimelineEvent[], work: string | null) =>
  save("timeline", { items }, work);

// ---------- 设定 ----------
export const loadLore = (work: string | null) =>
  load<{ items: LoreEntry[] }>("lore", { items: [] }, work).then((d) => d.items);

export const saveLore = (items: LoreEntry[], work: string | null) => save("lore", { items }, work);

// ---------- 校对忽略记录 ----------
/*
 * 存的是 issueKey（`kind|ruleId|text`），刻意不含行号：
 * 行号会随上文增删而变，存了就等于「改两行之后忽略失效」。
 * 「忽略这一处」和「忽略同类」在面板里本来就是同一个 key，所以一个字符串数组就够。
 */
export const loadProofIgnores = (work: string | null) =>
  load<{ ignores: string[] }>("proof-ignore", { ignores: [] }, work).then((d) => d.ignores ?? []);

export const saveProofIgnores = (ignores: string[], work: string | null) =>
  save("proof-ignore", { ignores }, work);

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
