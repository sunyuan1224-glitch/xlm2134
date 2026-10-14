/*
 * Markdown 渲染偏好。目前只有一项：段内单换行是否保留。
 *
 * 存在 localStorage 的 `mynovel:markdown-prefs`，做法与 typography.ts 一致：
 * React 侧用 useMarkdownPrefs() 订阅，导出流程这类非 React 代码用 getMarkdownPrefs() 直接读。
 *
 * 默认 false，与 Typora 的默认一致：编辑视图保留换行，阅读/导出时把段内单换行折成空格
 * （Markdown 的软换行语义）。打开后，粘贴进来的"一段一行"文本在即时预览、EPUB、自包含 HTML
 * 与 DOCX 里都会各自换行，不再被并成一段 —— 中文小说稿多是一段一行，所以这个开关很实用。
 */
import { create } from "zustand";

export interface MarkdownPrefs {
  /** true = 段内单换行按硬换行处理（渲染成 <br>） */
  preserveLineBreaks: boolean;
}

export const DEFAULT_MARKDOWN_PREFS: MarkdownPrefs = { preserveLineBreaks: false };

const STORAGE_KEY = "mynovel:markdown-prefs";

function load(): MarkdownPrefs {
  if (typeof window === "undefined" || !window.localStorage) return { ...DEFAULT_MARKDOWN_PREFS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MARKDOWN_PREFS };
    const parsed = JSON.parse(raw) as Partial<MarkdownPrefs>;
    return {
      preserveLineBreaks:
        typeof parsed.preserveLineBreaks === "boolean"
          ? parsed.preserveLineBreaks
          : DEFAULT_MARKDOWN_PREFS.preserveLineBreaks,
    };
  } catch {
    // 存储被禁用 / 内容损坏：退回默认值，不让偏好设置拖垮启动
    return { ...DEFAULT_MARKDOWN_PREFS };
  }
}

function persist(value: MarkdownPrefs): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 配额或权限问题：设置仍在内存里生效 */
  }
}

const usePrefsStore = create<{ prefs: MarkdownPrefs }>(() => ({ prefs: load() }));

export function useMarkdownPrefs(): MarkdownPrefs {
  return usePrefsStore((s) => s.prefs);
}

/** 非 React 环境（导出流程）读取当前偏好 */
export function getMarkdownPrefs(): MarkdownPrefs {
  return usePrefsStore.getState().prefs;
}

export function setMarkdownPrefs(patch: Partial<MarkdownPrefs>): void {
  const next: MarkdownPrefs = { ...usePrefsStore.getState().prefs, ...patch };
  usePrefsStore.setState({ prefs: next });
  persist(next);
}

export function resetMarkdownPrefs(): void {
  setMarkdownPrefs({ ...DEFAULT_MARKDOWN_PREFS });
}
