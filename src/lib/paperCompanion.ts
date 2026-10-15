/**
 * 伴读立绘相对「稿纸」的落点。
 *
 * 正文栏居中，宽度是 --editor-measure（当前 752px）。稿纸右侧还有空白时，
 * 人贴编辑区最右缘（窗口右缘），不挨着稿纸停在中间。
 * 窄窗口把空白挤没时，改贴编辑区右下角并缩小，只压住稿纸角落。
 * 两种位置都贴着底部，打字滚动时人还在。
 */

export type CompanionMode = "beside" | "tuck";

export interface CompanionLayout {
  mode: CompanionMode;
  left: number;
  width: number;
  height: number;
}

/** 贴右缘时留一点边，避免脚贴死在窗口边上 */
const EDGE = 16;
/**
 * 右侧空白窄于这个值时，不再缩成一条站在稿纸旁边，改去右下角。
 * 88px 大约还能放下一个约 72px 宽的全身；再窄就会压到正文，不如让到角落。
 */
const BESIDE_MIN_GUTTER = 88;

export function placeCompanion(opts: {
  /** 编辑区宽度（稿纸所在的那一栏） */
  width: number;
  height: number;
  /** 稿纸最大宽度，对应 --editor-measure */
  measure: number;
  /** .cm-scroller 左右 padding，稿纸是在扣掉它之后的内容区里居中的 */
  padLeft: number;
  padRight: number;
  /** 立绘固有宽高比 width / height */
  aspect: number;
}): CompanionLayout | null {
  const { width, height, measure, padLeft, padRight, aspect } = opts;
  if (width < 240 || height < 180 || measure <= 0 || aspect <= 0) return null;

  const contentBox = Math.max(0, width - padLeft - padRight);
  const paper = Math.min(measure, contentBox);
  const paperLeft = padLeft + (contentBox - paper) / 2;
  const paperRight = paperLeft + paper;
  const gutter = width - paperRight;

  if (gutter >= BESIDE_MIN_GUTTER) {
    const maxW = gutter - EDGE;
    const maxH = Math.min(height * 0.72, 480);
    const fitted = fit(maxW, maxH, aspect);
    if (fitted.width < 72) return null;
    return {
      mode: "beside",
      left: Math.max(0, Math.round(width - fitted.width - EDGE)),
      width: fitted.width,
      height: fitted.height,
    };
  }

  const maxW = Math.min(200, width * 0.3);
  const maxH = Math.min(height * 0.56, 420);
  const fitted = fit(maxW, maxH, aspect);
  if (fitted.width < 64) return null;
  return {
    mode: "tuck",
    left: Math.max(0, Math.round(width - fitted.width)),
    width: fitted.width,
    height: fitted.height,
  };
}

function fit(maxW: number, maxH: number, aspect: number): { width: number; height: number } {
  let h = maxH;
  let w = h * aspect;
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  return { width: Math.max(0, Math.round(w)), height: Math.max(0, Math.round(h)) };
}
