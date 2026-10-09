/*
 * 编辑器字体与排版设置。
 *
 * 只有三项：字体族 / 字号(px) / 行距(倍数)，存在 localStorage 的
 * `mynovel:typography` 里，并实时写到 :root 的三个 CSS 变量上。
 * 常规编辑器与沉浸编辑器共用 src/editor/extensions.ts 的 baseTheme，
 * 都读这三个变量，所以改这里两边同时生效（不要再往宿主元素上写同名变量覆盖）。
 */
import { create } from "zustand";

export interface Typography {
  /** CSS font-family 值；空串表示回退到 styles.css 里的默认字体栈 */
  fontFamily: string;
  /** 字号，单位 px */
  fontSize: number;
  /** 行距倍数 */
  lineHeight: number;
}

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 34;
export const LINE_HEIGHT_MIN = 1.3;
export const LINE_HEIGHT_MAX = 2.8;

/** 可选字体预设；第一个 stack 与 styles.css 的 --editor-font-family 默认值一致 */
export const FONT_PRESETS: { key: string; label: string; stack: string }[] = [
  { key: "serif", label: "宋体 / 明朝", stack: '"Noto Serif CJK SC", "Source Han Serif SC", serif' },
  {
    key: "sans",
    label: "黑体 / 无衬线",
    stack: '"Noto Sans CJK SC", "Source Han Sans CN", "Noto Sans SC", system-ui, sans-serif',
  },
  {
    key: "round",
    label: "中圆体",
    stack: '"汉仪中圆B5", "HYZhongYuanB5", "Noto Sans CJK SC", sans-serif',
  },
  {
    key: "mono",
    label: "等宽",
    stack: '"JetBrains Maple Mono", "JetBrains Mono", "Noto Sans Mono CJK SC", monospace',
  },
];

export const DEFAULT_TYPOGRAPHY: Typography = {
  fontFamily: FONT_PRESETS[0].stack,
  /**
   * 内置默认字号：18px（原本 16）。
   * 这样新机器上第一次打开就是这个观感，不必再手动调；
   * 已经存过设置的用户不受影响——localStorage 里的值优先。
   */
  fontSize: 18,
  lineHeight: 1.9,
};

const STORAGE_KEY = "mynovel:typography";
/** 旧版沉浸编辑器的设置键：只用来迁移字号，键名留给打字机设置 */
const LEGACY_KEY = "novel.immersive";

function clampSize(n: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
}

function clampLine(n: number): number {
  // 保留两位小数，避免 1.9000000000000001 这种浮点尾巴写进 CSS 变量
  return Math.round(Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, n)) * 100) / 100;
}

/** 非法（非数字/NaN）返回 null，交给调用方用默认值顶上 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 去掉可能破坏 CSS 声明的字符；空串是合法值（表示用主题默认字体栈） */
function coerceFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[;{}]/g, " ").replace(/[\u0000-\u001f]/g, "").trim();
}

function readStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null; // 隐私模式等场景直接当没有
  }
}

function writeStorage(value: Typography): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 忽略：设置仍然在内存里生效 */
  }
}

/** 加载：新键优先（JSON 坏了/字段非法则回落默认值），没有新键时从旧沉浸字号迁移一次 */
function loadTypography(): Typography {
  const raw = readStorage(STORAGE_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<Typography>;
      if (parsed && typeof parsed === "object") {
        const size = coerceNumber(parsed.fontSize);
        const line = coerceNumber(parsed.lineHeight);
        return {
          fontFamily: coerceFamily(parsed.fontFamily) ?? DEFAULT_TYPOGRAPHY.fontFamily,
          fontSize: clampSize(size ?? DEFAULT_TYPOGRAPHY.fontSize),
          lineHeight: clampLine(line ?? DEFAULT_TYPOGRAPHY.lineHeight),
        };
      }
    } catch {
      /* 坏 JSON：当没存过 */
    }
    return { ...DEFAULT_TYPOGRAPHY };
  }

  // 迁移老用户：novel.immersive 里的 fontSize（旧范围 12~28，落在新范围内直接可用）
  let legacy: number | null = null;
  const old = readStorage(LEGACY_KEY);
  if (old) {
    try {
      const parsed = JSON.parse(old) as { fontSize?: unknown };
      const size = coerceNumber(parsed?.fontSize);
      if (size !== null && size > 0) legacy = clampSize(size);
    } catch {
      /* 旧键坏了，忽略 */
    }
  }
  const next: Typography = { ...DEFAULT_TYPOGRAPHY, ...(legacy === null ? {} : { fontSize: legacy }) };
  // 立刻写回新键：沉浸编辑器以后重写 novel.immersive（只留 typewriter）时旧字号不会丢
  if (legacy !== null) writeStorage(next);
  return next;
}

/** 把设置写到 document.documentElement 的 CSS 变量上；不传参数就用当前设置 */
export function applyTypography(t?: Typography): void {
  if (typeof document === "undefined") return;
  const value = t ?? useTypographyStore.getState().typography;
  const root = document.documentElement;
  if (!root) return;
  try {
    if (value.fontFamily) root.style.setProperty("--editor-font-family", value.fontFamily);
    else root.style.removeProperty("--editor-font-family");
    root.style.setProperty("--editor-font-size", `${value.fontSize}px`);
    root.style.setProperty("--editor-line-height", String(value.lineHeight));
  } catch {
    /* 极端环境下没有 CSSOM：设置仍在内存/localStorage 里 */
  }
}

const useTypographyStore = create<{ typography: Typography }>(() => ({ typography: loadTypography() }));

// 模块加载时立刻应用一次，避免首屏先按 styles.css 的默认值渲染再跳变
if (typeof document !== "undefined") applyTypography(useTypographyStore.getState().typography);

/** 当前排版设置（订阅式） */
export function useTypography(): Typography {
  return useTypographyStore((s) => s.typography);
}

/** 合并补丁：校验 + clamp 后写回状态、持久化并立即应用 */
export function setTypography(patch: Partial<Typography>): void {
  const current = useTypographyStore.getState().typography;
  const family = patch.fontFamily === undefined ? current.fontFamily : coerceFamily(patch.fontFamily) ?? current.fontFamily;
  const size = patch.fontSize === undefined ? current.fontSize : clampSize(coerceNumber(patch.fontSize) ?? current.fontSize);
  const line =
    patch.lineHeight === undefined ? current.lineHeight : clampLine(coerceNumber(patch.lineHeight) ?? current.lineHeight);
  const next: Typography = { fontFamily: family, fontSize: size, lineHeight: line };
  if (family === current.fontFamily && size === current.fontSize && line === current.lineHeight) return;
  applyTypography(next);
  writeStorage(next);
  useTypographyStore.setState({ typography: next });
}

/** 恢复默认设置 */
export function resetTypography(): void {
  setTypography({ ...DEFAULT_TYPOGRAPHY });
}
