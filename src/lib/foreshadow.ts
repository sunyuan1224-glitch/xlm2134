import { loadForeshadows, saveForeshadows, uid, currentWork } from "./sidecar";
import type { Foreshadow } from "./types";
import { basename } from "./chapter";

// 作品目录的判断只有一处（sidecar.ts），这里转出去给既有调用方用
export { currentWork };

export async function fetchForeshadows(): Promise<Foreshadow[]> {
  const work = currentWork();
  if (work === null) return [];
  return loadForeshadows(work);
}

type ForeshadowListener = (items: Foreshadow[]) => void;
const foreshadowListeners = new Set<ForeshadowListener>();

/** 伏笔写盘之后通知已打开的列表，不用等切换文件才重新读取 */
export function subscribeForeshadows(fn: ForeshadowListener): () => void {
  foreshadowListeners.add(fn);
  return () => {
    foreshadowListeners.delete(fn);
  };
}

export async function persistForeshadows(items: Foreshadow[]): Promise<void> {
  const work = currentWork();
  if (work === null) return;
  await saveForeshadows(items, work);
  const snapshot = items.slice();
  for (const fn of foreshadowListeners) fn(snapshot);
}

export interface NewForeshadowInput {
  description: string;
  tags: string[];
  sourcePath: string;
  sourceLine: number;
  sourceText: string;
}

export function makeForeshadow(input: NewForeshadowInput): Foreshadow {
  return {
    id: uid(),
    description: input.description,
    tags: input.tags,
    status: "open",
    sourcePath: input.sourcePath,
    sourceLine: input.sourceLine,
    sourceText: input.sourceText,
    createdAt: new Date().toISOString(),
    stages: [],
    resolvedChapters: [],
  };
}

export function addStage(
  f: Foreshadow,
  note: string,
  chapter: string,
): Foreshadow {
  return {
    ...f,
    stages: [...f.stages, { at: new Date().toISOString(), note, chapter }],
  };
}

export function resolveForeshadow(f: Foreshadow, chapter: string): Foreshadow {
  return {
    ...f,
    status: "done",
    resolvedChapters: [...f.resolvedChapters, chapter],
  };
}

export const STATUS_LABEL = {
  open: "待回收",
  done: "已回收",
  abandoned: "已废弃",
} as const;

export function sourceLabel(f: Foreshadow): string {
  return basename(f.sourcePath) + ":" + f.sourceLine;
}

export const DEFAULT_TAGS = ["人物", "情节", "世界观", "道具", "线索"];
