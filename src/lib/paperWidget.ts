/*
 * 「欧金金挂件」的设置。
 *
 * 版式参考 DeepSeek-Balance-Whale-Widget（DSH 右下角的常驻挂件）：右下角一个方块，
 * 尺寸由 scale 驱动、可拖动调节。这里只做第一层——能点击、能出声、有基础设置菜单；
 * 气泡、余额记账那些还没有，所以字段刻意留白，后面加功能时直接往 WidgetSettings
 * 里加字段即可，读写都走「逐字段校验 + 缺省回退」，旧存档不会因为多/少字段而失效。
 *
 * 存 localStorage 的 `mynovel:widget`，scale 同时写到 :root 的 --widget-scale，
 * 和 typography.ts 是同一套做法（那边写的是字号/行距）。
 */
import { create } from "zustand";

export interface WidgetSettings {
  /** 挂件是否显示。「视图 → 挂件 → 欧金金」与菜单里的「隐藏挂件」都改这一项 */
  visible: boolean;
  /** 尺寸倍数，驱动 --widget-scale */
  scale: number;
  /** 音效音量 0–1 */
  volume: number;
  /** 音效总开关 */
  soundOn: boolean;
  /** 藏起右上角的菜单按钮，改由右键点人物唤出菜单（参考项目的 menuBtnHide） */
  menuBtnHidden: boolean;
  /**
   * 拖拽落点（视口坐标，左上角）。null = 没拖过，用默认的右下角。
   * 存的是「位置」而不是「偏移」，换窗口大小时才有东西可夹。
   */
  pos: WidgetFrac | null;
}

export interface WidgetPos {
  left: number;
  top: number;
}

/**
 * 存下来的落点：**自由空间里的比例**，不是绝对像素。
 *
 * 早先存的是 {left, top} 像素，于是「半屏时拖到右下角 → 切全屏」之后它留在原来的
 * 像素坐标上、并不在右下角（用户报的就是这个）。存比例就没这问题：fx=fy=1 永远是
 * 区域右下角，fx=0.5 永远是正中，窗口怎么变都对。
 *
 * 贴边的位置在松手时已经被 settleWidgetPos 吸附成正好贴边，所以比例的 0/1 是精确的，
 * 角落不会因为换尺寸而漂一两个像素。
 */
export interface WidgetFrac {
  fx: number;
  fy: number;
}

/** 松手时离边界这么近就吸附贴边 */
const SNAP_PX = 24;

/**
 * 挂件可以待的区域（视口坐标）。由 PaperWidget 从真实 DOM 量出来：
 * 上界 = 顶部菜单栏的下沿，下界 = 状态栏（字数那条）的上沿，左界 = 编辑区左缘，
 * 右界 = 编辑区右缘。所以挂件永远压在正文区里——不盖菜单栏、不盖状态栏、
 * 也不会滑到左侧栏上去。
 */
export interface WidgetBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 松手落位：先吸附到最近的边界，再整体夹进 bounds 里。
 *
 * 刻意用「完全夹进去」而不是早先那套「至少留 30% 可见」：挂件是个可拖动浮层，
 * 半截挂在菜单栏或左侧栏上既难看又挡操作。窗口小到装不下时退化为贴左上角。
 * 纯函数，用例直接量（不用起窗口）。
 */
/** 自由空间 = 区域尺寸 - 挂件尺寸；区域比挂件还小时退化为 0 */
function freeSpace(size: { w: number; h: number }, bounds: WidgetBounds): { w: number; h: number } {
  return {
    w: Math.max(0, bounds.right - bounds.left - size.w),
    h: Math.max(0, bounds.bottom - bounds.top - size.h),
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 绝对像素 → 比例（存起来用） */
export function toFraction(abs: WidgetPos, size: { w: number; h: number }, bounds: WidgetBounds): WidgetFrac {
  const space = freeSpace(size, bounds);
  return {
    fx: space.w > 0 ? clamp01((abs.left - bounds.left) / space.w) : 0,
    fy: space.h > 0 ? clamp01((abs.top - bounds.top) / space.h) : 0,
  };
}

/**
 * 比例 → 绝对像素。**换窗口大小 / 换挂件尺寸时都走这里重新算**，
 * 这样它才会跟着区域一起动，而不是停在原来的像素位置。
 */
export function fromFraction(
  frac: WidgetFrac,
  size: { w: number; h: number },
  bounds: WidgetBounds,
): WidgetPos {
  const space = freeSpace(size, bounds);
  return {
    left: Math.round(bounds.left + space.w * clamp01(frac.fx)),
    top: Math.round(bounds.top + space.h * clamp01(frac.fy)),
  };
}

export function settleWidgetPos(
  pos: WidgetPos,
  size: { w: number; h: number },
  bounds: WidgetBounds,
): WidgetPos {
  let left = pos.left;
  let top = pos.top;

  /*
   * 贴边吸附：条件是「离贴齐的位置够近」，不是「已经越过边」。
   * 写成 `left <= SNAP_PX` 是错的——任何负数都成立，于是往左拖出边界会被吸到最左，
   * 中间整段落点全被吃掉。
   */
  if (Math.abs(left - bounds.left) <= SNAP_PX) left = bounds.left;
  else if (Math.abs(left + size.w - bounds.right) <= SNAP_PX) left = bounds.right - size.w;
  if (Math.abs(top - bounds.top) <= SNAP_PX) top = bounds.top;
  else if (Math.abs(top + size.h - bounds.bottom) <= SNAP_PX) top = bounds.bottom - size.h;

  const maxLeft = Math.max(bounds.left, bounds.right - size.w);
  const maxTop = Math.max(bounds.top, bounds.bottom - size.h);
  return {
    left: Math.min(maxLeft, Math.max(bounds.left, left)),
    top: Math.min(maxTop, Math.max(bounds.top, top)),
  };
}

/**
 * 尺寸量程。比参考项目的 0.6–2.5 收窄了：那边是给网页端用的，2.5 倍在桌面窗口里
 * 会撑成一个巨大的方块（当前基准约 185px，2.5 倍就是 462px）。
 * 下限从 0.8 又降了一档到 0.7（用户反馈最小档还要更小）；没回到最初的 0.6，
 * 是因为更早一轮明确说过 0.6 太小、要求调大。
 *
 * 档位数刻意与滑块步长对齐：(1.6-0.7)/(10-1) = 0.1，正好等于滑块的 step，
 * 所以数字框的每一档都精确落在一个滑块刻度上，不会出现「拖到 1.2、框里显示 5」。
 */
export const WIDGET_SCALE_MIN = 0.7;
export const WIDGET_SCALE_MAX = 1.6;
/** 整数档位（1–10）与 scale 线性对应，菜单右侧那个数字框用 */
export const WIDGET_LEVEL_MIN = 1;
export const WIDGET_LEVEL_MAX = 10;

export const DEFAULT_WIDGET: WidgetSettings = {
  visible: true,
  scale: 1,
  volume: 0.9,
  soundOn: true,
  menuBtnHidden: false,
  pos: null,
};

const STORAGE_KEY = "mynovel:widget";

function clampScale(n: number): number {
  // 保留一位小数，避免 1.0000000000000002 这种浮点尾巴写进 CSS 变量
  return Math.round(Math.min(WIDGET_SCALE_MAX, Math.max(WIDGET_SCALE_MIN, n)) * 10) / 10;
}

function clampVolume(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

/** 整数档位 → scale */
export function levelToScale(level: number): number {
  const l = Math.min(WIDGET_LEVEL_MAX, Math.max(WIDGET_LEVEL_MIN, Math.round(level)));
  return clampScale(
    WIDGET_SCALE_MIN + (l - WIDGET_LEVEL_MIN) * ((WIDGET_SCALE_MAX - WIDGET_SCALE_MIN) / (WIDGET_LEVEL_MAX - WIDGET_LEVEL_MIN)),
  );
}

/** scale → 最近的整数档位 */
export function scaleToLevel(scale: number): number {
  return Math.round((scale - WIDGET_SCALE_MIN) / ((WIDGET_SCALE_MAX - WIDGET_SCALE_MIN) / (WIDGET_LEVEL_MAX - WIDGET_LEVEL_MIN))) + WIDGET_LEVEL_MIN;
}

/** 非法值（非数字/NaN）返回 null，交给调用方用默认值顶上 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 落点校验：两个比例都是有限数才算数，否则当没拖过（旧版的像素形状会被丢掉 → 回默认角落） */
function coercePos(value: unknown): WidgetFrac | null {
  if (!value || typeof value !== "object") return null;
  const fx = coerceNumber((value as WidgetFrac).fx);
  const fy = coerceNumber((value as WidgetFrac).fy);
  return fx !== null && fy !== null ? { fx, fy } : null;
}

function samePos(a: WidgetFrac | null, b: WidgetFrac | null): boolean {
  if (a === null || b === null) return a === b;
  return a.fx === b.fx && a.fy === b.fy;
}

function readStorage(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null; // 隐私模式等场景直接当没有
  }
}

function writeStorage(value: WidgetSettings): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 忽略：设置仍然在内存里生效 */
  }
}

/** 加载：逐字段校验，坏 JSON / 缺字段一律回落到默认值 */
function loadWidget(): WidgetSettings {
  const raw = readStorage(STORAGE_KEY);
  if (raw === null) return { ...DEFAULT_WIDGET };
  try {
    const parsed = JSON.parse(raw) as Partial<WidgetSettings>;
    if (parsed && typeof parsed === "object") {
      const scale = coerceNumber(parsed.scale);
      const volume = coerceNumber(parsed.volume);
      const fx = coerceNumber(parsed.pos?.fx);
      const fy = coerceNumber(parsed.pos?.fy);
      return {
        visible: coerceBool(parsed.visible, DEFAULT_WIDGET.visible),
        scale: clampScale(scale ?? DEFAULT_WIDGET.scale),
        volume: clampVolume(volume ?? DEFAULT_WIDGET.volume),
        soundOn: coerceBool(parsed.soundOn, DEFAULT_WIDGET.soundOn),
        menuBtnHidden: coerceBool(parsed.menuBtnHidden, DEFAULT_WIDGET.menuBtnHidden),
        pos: fx !== null && fy !== null ? { fx, fy } : null,
      };
    }
  } catch {
    /* 坏 JSON：当没存过 */
  }
  return { ...DEFAULT_WIDGET };
}

/** 把尺寸写到 :root 的 --widget-scale；不传参数就用当前设置 */
export function applyWidget(w?: WidgetSettings): void {
  if (typeof document === "undefined") return;
  const value = w ?? useWidgetStore.getState().widget;
  try {
    document.documentElement.style.setProperty("--widget-scale", String(value.scale));
  } catch {
    /* 极端环境下没有 CSSOM：设置仍在内存/localStorage 里 */
  }
}

const useWidgetStore = create<{ widget: WidgetSettings }>(() => ({ widget: loadWidget() }));

// 模块加载时立刻应用一次，避免首屏先按 CSS 默认值渲染再跳变
if (typeof document !== "undefined") applyWidget(useWidgetStore.getState().widget);

/** 当前挂件设置（订阅式，只能在组件里用） */
export function useWidget(): WidgetSettings {
  return useWidgetStore((s) => s.widget);
}

/** 当前设置的快照（非订阅式：给事件回调、音频层和测试用，不是 hook） */
export function getWidget(): WidgetSettings {
  return useWidgetStore.getState().widget;
}

/** 合并补丁：校验 + clamp 后写回状态、持久化并立即应用 */
export function setWidget(patch: Partial<WidgetSettings>): void {
  const current = useWidgetStore.getState().widget;
  const next: WidgetSettings = {
    visible: patch.visible === undefined ? current.visible : !!patch.visible,
    scale: patch.scale === undefined ? current.scale : clampScale(coerceNumber(patch.scale) ?? current.scale),
    volume: patch.volume === undefined ? current.volume : clampVolume(coerceNumber(patch.volume) ?? current.volume),
    soundOn: patch.soundOn === undefined ? current.soundOn : !!patch.soundOn,
    menuBtnHidden:
      patch.menuBtnHidden === undefined ? current.menuBtnHidden : !!patch.menuBtnHidden,
    // pos 只在显式传了的时候改（传 null = 恢复默认角落）
    pos: patch.pos === undefined ? current.pos : coercePos(patch.pos),
  };
  if (
    next.visible === current.visible &&
    next.scale === current.scale &&
    next.volume === current.volume &&
    next.soundOn === current.soundOn &&
    next.menuBtnHidden === current.menuBtnHidden &&
    samePos(next.pos, current.pos)
  ) {
    return;
  }
  applyWidget(next);
  writeStorage(next);
  useWidgetStore.setState({ widget: next });
}

/** 恢复默认设置 */
export function resetWidget(): void {
  setWidget({ ...DEFAULT_WIDGET });
}

/** 「视图 → 挂件 → 欧金金」用的开关 */
export function toggleWidget(): void {
  setWidget({ visible: !useWidgetStore.getState().widget.visible });
}
