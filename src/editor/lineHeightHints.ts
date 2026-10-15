/*
 * 源码模式的「逐行高度提示」。
 *
 * 背景（CodeMirror 的高度表怎么工作，以及它留了哪个公开口子）：
 *   - 编辑器只测量**已经画出来**的行；屏幕外的高度靠估，而估算结果会以 `.cm-gap` 垫片的
 *     形式落到 DOM 上 —— 那正是浏览器滚动条的量程。估得不准，拖动时量程就会一路变，
 *     表现就是「手指往下、条和内容对不上」。
 *   - 估「还没画出来的**行**」只有两条路：整段一起估（HeightMapGap，用
 *     `行数 + 估算折行数` 那条粗公式，@codemirror/view dist/index.js 的 heightForGap），
 *     或者逐行估（HeightMapText：`max(该行行内 widget 的 estimatedHeight, heightForLine(len))`，
 *     见 dist/index.js 的 HeightMapText.updateHeight）。
 *   - **逐行那条路可以从外部触发**：给一行挂一个零宽的行内 widget（非 block）并让它的
 *     `estimatedHeight >= 5`，`Decoration.heightRelevant` 就为真（dist/index.js:352），
 *     NodeBuilder.point 会读到 `deco.widget.estimatedHeight`（dist/index.js:6038）并调用
 *     addLineDeco → `line.widgetHeight = max(..., height)`（dist/index.js:6102），
 *     于是这一行成为一个独立的 HeightMapText，按我们给的数字估高。
 *   - 行装饰（Decoration.line）本身**没有**高度字段：LineDecoration 给基类传的 widget 是
 *     null（dist/index.js:325），而 point() 里的高度只认 `deco.widget`（dist/index.js:6038），
 *     整个包里也没有 `lineEstimatedHeight` 之类的符号。所以「零宽行内 widget」是唯一公开口子。
 *
 * 于是给每一行挂一个零宽的 widget，高度用 estimateLineHeight 按这一行的字宽数算。
 * 为什么每行都要挂：只有每行都成为独立节点，CodeMirror 才不会把一大片没画出来的行揉成
 * 一个 gap 用粗公式估（中文段落普遍两行，那条公式会成段地少算折行，实测漂 16%）。
 *
 * 视觉零变化：widget 是零宽的空 <span>，CodeMirror 给零长行内 widget 配的
 * `.cm-widgetBuffer` 是 `width: 0; height: 1em; display: inline`（dist/index.js:7059），
 * 都不占位；真量到的高度一律以实测为准，这些数字只在「还没量到」时用。
 *
 * 只在源码模式挂（见 Editor.tsx）：即时预览里正文块本身已经是带估算的 widget，
 * 剩下的文本行只有空行，一行的高度本来就是准的，没必要逐行再挂一遍。
 */
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { estimateLineHeight, textUnits, type BlockMetrics } from "./livePreview";

/**
 * 零宽行内 widget，只带「这一行估多高」这一个信息（字宽数在建装饰时算好）。
 * estimatedHeight 是**懒读**排版参数的：widget 建出来时（建 state）DOM 还没影，
 * 而它是在搭高度表时才被问的，那时已经能量到样式与宽度。
 */
class LineHeightHint extends WidgetType {
  constructor(readonly units: number, readonly metrics: () => BlockMetrics | null) { super(); }
  eq(other: LineHeightHint) { return other.units === this.units; }
  get estimatedHeight() {
    const m = this.metrics();
    // 拿不到排版参数就返回 -1：这一行退回 CodeMirror 自己的估算（原行为）
    return m ? estimateLineHeight(this.units, m) : -1;
  }
  /** 占位用的空 span：零宽、无内容，不参与排版 */
  toDOM() { return document.createElement("span"); }
}

function build(state: EditorState, metrics: () => BlockMetrics | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  // 逐行在行首挂一个零宽 widget；RangeSetBuilder 要求按位置递增添加，正好是逐行的顺序
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    builder.add(
      line.from,
      line.from,
      Decoration.widget({ widget: new LineHeightHint(textUnits(line.text), metrics), side: 1 }),
    );
  }
  return builder.finish();
}

export function lineHeightHints(metrics: () => BlockMetrics | null): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, metrics),
    // 一行的估算只跟它自己的文字有关：文档变了重算，光标/选区变化不用动
    update(value, tr) { return tr.docChanged ? build(tr.state, metrics) : value; },
    provide: (field) => EditorView.decorations.from(field),
  });
}
