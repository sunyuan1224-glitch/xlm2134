/** 伏笔 */
export interface Foreshadow {
  id: string;
  description: string;
  tags: string[];
  status: "open" | "done" | "abandoned";
  sourcePath: string;
  sourceLine: number;
  sourceText: string;
  createdAt: string;
  stages: ForeshadowStage[];
  resolvedChapters: string[];
}

export interface ForeshadowStage {
  at: string;
  note: string;
  chapter: string;
}

/** 时间线事件 */
export interface TimelineEvent {
  id: string;
  time: string;
  title: string;
  type: string;
  chapters: string[];
  lore: string[];
  note: string;
}

/** 设定词条 */
export interface LoreEntry {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  content: string;
  sourcePath: string;
  relations: { target: string; label: string }[];
}
