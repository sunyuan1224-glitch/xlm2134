/*
 * 界面主题：粉白（默认）/ 暗色。
 *
 * 与 typography.ts 同一套做法：zustand + localStorage + React hook + setter。
 * 生效方式是把主题名写到 <html data-theme="…">，颜色由 styles.css 里两套变量接管
 * （:root 是粉白，:root[data-theme="dark"] 优先级更高、整块覆盖）。
 * 默认必须是 light：升级上来的用户界面不能有任何变化。
 */
import { create } from "zustand";

export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "light";

const STORAGE_KEY = "mynovel:theme";

function loadTheme(): Theme {
  if (typeof window === "undefined" || !window.localStorage) return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "dark" ? "dark" : raw === "light" ? "light" : DEFAULT_THEME;
  } catch {
    // 存储被禁用 / 内容损坏：退回默认主题，不让它拖垮启动
    return DEFAULT_THEME;
  }
}

function persist(value: Theme): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* 配额或权限问题：主题仍在内存里生效 */
  }
}

const useThemeStore = create<{ theme: Theme }>(() => ({ theme: loadTheme() }));

/** 把主题写到 <html data-theme>；CSS 变量两套切在这里 */
export function applyTheme(t?: Theme): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  try {
    document.documentElement.dataset.theme = t ?? useThemeStore.getState().theme;
  } catch {
    /* 极端环境下没有 DOM：主题仍在内存/localStorage 里 */
  }
}

// 模块加载即生效：保证首帧就是正确主题，避免先闪一下浅色
if (typeof document !== "undefined") applyTheme(useThemeStore.getState().theme);

export function useTheme(): Theme {
  return useThemeStore((s) => s.theme);
}

/** 非 React 环境（测试、导出流程）读取当前主题 */
export function getTheme(): Theme {
  return useThemeStore.getState().theme;
}

export function setTheme(next: Theme): void {
  const value: Theme = next === "dark" ? "dark" : "light";
  if (value === useThemeStore.getState().theme) return;
  useThemeStore.setState({ theme: value });
  applyTheme(value);
  persist(value);
}

export function resetTheme(): void {
  setTheme(DEFAULT_THEME);
}
