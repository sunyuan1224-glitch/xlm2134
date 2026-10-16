/**
 * 伴读立绘相对编辑区的落点。
 *
 * 正文栏居中，宽度是 --editor-measure（当前 752px）。稿纸**左侧**还有空白时，
 * 人贴编辑区最左缘（也就是左侧栏的右缘），不挨着稿纸停在中间。
 * 窄窗口把空白挤没时，改贴编辑区左下角并缩小，只压住稿纸角落。
 * 两种位置都贴着底部，打字滚动时人还在。
 *
 * 左缘之所以天然「跟着左侧栏走」：这块立绘是 .editor-area 的子元素，而 .editor-area
 * 在 .pane-main 里、排在左侧栏后面，侧栏收起或拖宽时 pane 自己就挪了，absolute 的
 * 子元素跟着挪——不需要在这里读侧栏宽度，也不需要监听什么。
 */

export type CompanionMode = "beside" | "tuck";

export interface CompanionLayout {
  mode: CompanionMode;
  left: number;
  width: number;
  height: number;
}

/**
 * 贴左缘时留一点边，免得人物紧贴在侧栏的分隔线上。
 * 导出是因为挂件的拖拽左界也要用同一条线（用户要求「和左边人物立绘一样」），
 * 免得两处各写一个 16 然后慢慢走偏。
 */
export const COMPANION_EDGE = 16;
const EDGE = COMPANION_EDGE;
/**
 * 左侧空白窄于这个值时，不再缩成一条站在稿纸旁边，改去左下角。
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
  // 站立的地方在稿纸左边，所以量的是左空白（原来量的是右空白）
  const gutter = paperLeft;

  if (gutter >= BESIDE_MIN_GUTTER) {
    const maxW = gutter - EDGE;
    const maxH = Math.min(height * 0.72, 480);
    const fitted = fit(maxW, maxH, aspect);
    if (fitted.width < 72) return null;
    return {
      mode: "beside",
      left: EDGE,
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
    left: 0,
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
