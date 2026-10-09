import { api } from "../api";
import { useStore } from "../store";
import type { Foreshadow, LoreEntry, TimelineEvent } from "./types";

/** 侧车文件读写：作品目录下的 .novel/<name>.json */

/**
 * 当前作品目录（侧车落在 `<root>/<work>/.novel/` 下）。
 *
 * - 章放在作品子目录里 → 返回最上层的那一段（`"第一卷"`）；
 * - 章直接放在工作区根   → 返回 `""`，侧车落在工作区根的 `.novel/`；
 * - 没有工作区或一个文件都没有 → 返回 `null`（调用方直接当没有资料处理）。
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
  return parts.length > 1 ? parts[0] : "";
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
