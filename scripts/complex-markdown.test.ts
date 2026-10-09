import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { history, undo, redo } from "@codemirror/commands";
import {
  livePreview,
} from "../src/editor/livePreview.ts";
import {
  markdownToHtml,
  SOURCE_FALLBACK_ATTR,
  SOURCE_FALLBACK_KIND,
} from "../src/lib/mdExport.ts";
import {
  topBlocks,
  codeRanges,
} from "../src/lib/markdownBlocks.ts";

console.log("=== 开始复杂 Markdown 安全兼容测试 ===");

/* ------------------------------------------------------------------ *
 * 1. Setext 标题与缩进代码块修复
 * ------------------------------------------------------------------ */

// Setext H1 (=====) 与 H2 (-----) 不被段落循环吞并下划线
const setextH1 = markdownToHtml("主标题\n======\n\n正文段落。\n", "");
assert.ok(setextH1.includes('<h1 id="主标题">主标题</h1>'), "Setext H1 必须渲染为 h1");
assert.ok(!setextH1.includes("<mark>"), "Setext 等号下划线不得被误认为高亮标签");
assert.ok(setextH1.includes("<p>正文段落。</p>"), "后续段落正常独立排版");

const setextH2 = markdownToHtml("二级标题\n------\n\n段落。\n", "");
assert.ok(setextH2.includes('<h2 id="二级标题">二级标题</h2>'), "Setext H2 必须渲染为 h2");
assert.ok(!setextH2.includes("---"), "Setext 减号下划线不得作为文本残留在段落中");

// 缩进代码块（4 空格 / 制表符缩进）必须渲染为代码块，不得失真为普通段落
const indentedCodeDoc = "前导段落。\n\n    const a = 100;\n    const b = 200;\n\n后续段落。\n";
const indentedHtml = markdownToHtml(indentedCodeDoc, "");
assert.ok(indentedHtml.includes('<pre class="md-pre"><code>const a = 100;\nconst b = 200;</code></pre>'), "缩进代码块必须渲染为 pre code");
assert.ok(!indentedHtml.includes("<p>    const a = 100;"), "缩进代码块不得被当作缩进段落");

console.log("PASS: Setext 标题与 4 空格缩进代码块正确解析与渲染");

/* ------------------------------------------------------------------ *
 * 2. 手写表格按普通段落显示：绝不被吞进后续的列表行与引用行
 * ------------------------------------------------------------------ */

const tableThenListDoc =
  "| 标题甲 | 标题乙 |\n" +
  "| --- | --- |\n" +
  "| 内容1 | 内容2 |\n" +
  "- 列表项一 | 含竖线\n" +
  "- 列表项二\n";
const tableListHtml = markdownToHtml(tableThenListDoc, "");
assert.ok(!tableListHtml.includes("<table"), "渲染器不再有表格分支");
assert.ok(tableListHtml.includes("<p>| 标题甲 | 标题乙 |"), "手写表格按普通段落原样显示");
assert.ok(!tableListHtml.includes("<p>| 标题甲 | 标题乙 | | --- | --- | | 内容1 | 内容2 | | - 列表项一"), "表格段落绝不得吞入后续的列表项");
assert.ok(tableListHtml.includes("<ul><li>列表项一 | 含竖线</li><li>列表项二</li></ul>"), "后续列表项必须生成合法的 ul 列表");

const tableThenQuoteDoc =
  "| A | B |\n" +
  "| - | - |\n" +
  "| 1 | 2 |\n" +
  "> 引用行 | 也含竖线\n";
const tableQuoteHtml = markdownToHtml(tableThenQuoteDoc, "");
assert.ok(tableQuoteHtml.includes("<p>| A | B | | - | - | | 1 | 2 |</p>"), "表格段落在引用前结束");
const quoteFirstP = tableQuoteHtml.slice(0, tableQuoteHtml.indexOf("</p>"));
assert.ok(!quoteFirstP.includes("引用行"), "表格段落绝不得吞入引用行");
assert.ok(tableQuoteHtml.includes("<blockquote><p>引用行 | 也含竖线</p></blockquote>"), "引用行正常渲染为 blockquote");

console.log("PASS: 手写表格按普通段落显示，不吞后续列表与引用");

/* ------------------------------------------------------------------ *
 * 3. 列表体系：嵌套列表、混合类型分组、宽松列表
 * ------------------------------------------------------------------ */

// 嵌套无序列表
const nestedListDoc = "- 第一层A\n  - 第二层A1\n    - 第三层A1a\n- 第一层B\n";
const nestedListHtml = markdownToHtml(nestedListDoc, "");
assert.ok(
  nestedListHtml.includes("<ul><li>第一层A<ul><li>第二层A1<ul><li>第三层A1a</li></ul></li></ul></li><li>第一层B</li></ul>"),
  "多层嵌套列表层级结构保持严格闭合",
);

// 混合类型列表（无序后接有序）：不得吞进同一个 <ul>，必须分裂为 <ul> 与 <ol>
const mixedListDoc = "- 无序甲\n- 无序乙\n1. 有序一\n2. 有序二\n";
const mixedListHtml = markdownToHtml(mixedListDoc, "");
assert.ok(mixedListHtml.includes("<ul><li>无序甲</li><li>无序乙</li></ul>"), "无序项单独成 ul");
assert.ok(mixedListHtml.includes("<ol><li>有序一</li><li>有序二</li></ol>"), "有序项单独成 ol，不与无序项混同");
assert.ok(!mixedListHtml.includes("<ul><li>无序甲</li><li>无序乙</li><li>有序一</li>"), "不得将有序项并入无序 ul");

// 宽松列表（项之间带空行）生成带 <p> 的列表项，同一个列表不被切散
const looseListDoc = "- 第一项\n\n- 第二项\n";
const looseListHtml = markdownToHtml(looseListDoc, "");
assert.ok(looseListHtml.includes("<ul><li><p>第一项</p></li><li><p>第二项</p></li></ul>"), "宽松列表各项包装 p 标签且同属一个 ul");
assert.equal((looseListHtml.match(/<ul/g) || []).length, 1, "宽松列表不拆散成多个独立 ul");

// 列表中内嵌围栏代码块
const listWithFenceDoc = "- 任务A\n  ```js\n  const codeInside = true;\n  ```\n- 任务B\n";
const listFenceHtml = markdownToHtml(listWithFenceDoc, "");
assert.ok(listFenceHtml.includes('data-lang="js"'), "列表项内部代码块保留语言标记");
assert.ok(listFenceHtml.includes("const codeInside = true;"), "列表项内部代码内容完整");
assert.ok(listFenceHtml.includes("<li>任务B</li>"), "后续同级列表项继续属于该列表");

console.log("PASS: 列表嵌套/混合类型/宽松列表/内嵌围栏正确结构化");

/* ------------------------------------------------------------------ *
 * 4. 复杂块保守回退：嵌套引用、引用内列表/表格/代码完整转义回退
 * ------------------------------------------------------------------ */

const nestedQuoteDoc = "> 第一级引用\n> > 第二级嵌套引用\n";
const nestedQuoteHtml = markdownToHtml(nestedQuoteDoc, "");
assert.ok(nestedQuoteHtml.includes(SOURCE_FALLBACK_ATTR), "复杂嵌套引用必须打上 fallback 属性");
assert.ok(nestedQuoteHtml.includes(SOURCE_FALLBACK_KIND), "fallback 类型必须是 complex-block");
assert.ok(nestedQuoteHtml.includes("&gt; &gt; 第二级嵌套引用"), "嵌套引用源码必须被完整转义回退，不破坏字符");
assert.ok(nestedQuoteHtml.includes("为保证不丢源码已按原文保留"), "带有明确中文安全提示");

const quoteWithListDoc = "> 引用文字\n> - 列表项一\n> - 列表项二\n";
const quoteListHtml = markdownToHtml(quoteWithListDoc, "");
assert.ok(quoteListHtml.includes(SOURCE_FALLBACK_ATTR), "引用内嵌列表回退为源码");
assert.ok(quoteListHtml.includes("&gt; - 列表项一"), "源码完全保留未失真");

const quoteWithFenceDoc = "> 引用说明\n> ```python\n> import os\n> ```\n";
const quoteFenceHtml = markdownToHtml(quoteWithFenceDoc, "");
assert.ok(quoteFenceHtml.includes(SOURCE_FALLBACK_ATTR), "引用内嵌代码回退为源码");
assert.ok(quoteFenceHtml.includes("&gt; ```python"), "引用代码源码未丢失");

// 引用块的惰性续行（"> a\nb"）属于同一个引用，不得被切成分离的两块
const lazyQuoteHtml = markdownToHtml("> 引用首行\n惰性续行\n\n普通段落。\n", "");
assert.ok(lazyQuoteHtml.includes("<blockquote><p>引用首行 惰性续行</p></blockquote>"), "惰性续行必须留在同一个引用块内");
assert.equal((lazyQuoteHtml.match(/<blockquote>/g) || []).length, 1, "惰性续行不得被拆成第二个引用块");

// 引用块的两段（中间空引用行）仍然是一个引用里的两个段落
const twoParaQuoteHtml = markdownToHtml("> 第一段\n>\n> 第二段\n", "");
assert.ok(twoParaQuoteHtml.includes("<blockquote><p>第一段</p><p>第二段</p></blockquote>"), "同一引用内的两个段落保持在一个 blockquote 内");

console.log("PASS: 复杂嵌套容器安全回退完整源码并提示，杜绝正则猜测与失真");

/* ------------------------------------------------------------------ *
 * 4b. 回退块本身必须是安全 HTML：复杂容器里的恶意内容只能作纯文本保留
 * ------------------------------------------------------------------ */
const hostileComplexDoc = "> 外层引用\n> > <script>alert(1)</script><img src=x onerror=alert(2)>\n";
const hostileComplexHtml = markdownToHtml(hostileComplexDoc, "");
assert.ok(hostileComplexHtml.includes(SOURCE_FALLBACK_ATTR), "含恶意内容的复杂块同样回退源码");
assert.ok(!/<script/i.test(hostileComplexHtml), "回退块不得出现 script 标签");
assert.ok(!/<img[\s>]/i.test(hostileComplexHtml), "回退块不得出现可执行/联网的 img 标签");
assert.ok(!/<[a-z][^>]*onerror/i.test(hostileComplexHtml), "回退块不得出现事件属性");
assert.ok(hostileComplexHtml.includes("&lt;script&gt;"), "恶意内容只能作为已转义纯文本保留");

console.log("PASS: 复杂块回退输出是安全纯文本，脚本 / 事件属性 / 标签都不落地");

/* ------------------------------------------------------------------ *
 * 5. 语法树代码区间识别：覆盖顶层围栏、缩进代码与引用内围栏
 * ------------------------------------------------------------------ */

const codeContaminationDoc =
  "```js\n" +
  "- [ ] fake in fence\n" +
  "[^fake1]: note in fence\n" +
  "```\n\n" +
  "    - [ ] fake in indented code\n" +
  "    [^fake2]: note in indented code\n\n" +
  "> ```\n" +
  "> - [ ] fake in quote fence\n" +
  "> ```\n\n" +
  "- [ ] real task 1\n" +
  "- [x] real task 2\n";

// 语法树代码区间识别覆盖所有代码块（包含缩进代码和引用内代码）
const ranges = codeRanges(codeContaminationDoc);
assert.ok(ranges.length >= 3, "必须捕获顶层围栏、缩进代码与引用内围栏");

console.log("PASS: 代码区（顶层围栏 / 缩进 / 引用内围栏）被 Lezer AST 准确识别");

/* ------------------------------------------------------------------ *
 * 5b. 任务框准确定位：块渲染（带 sourceOffset）时的 data-task-pos 仍是绝对偏移
 * ------------------------------------------------------------------ */
const blockDoc = "- [ ] 父任务\n  - [x] 子任务\n";
const fullDoc = "前缀段落。\n\n" + blockDoc + "\n后续段落。\n";
const blockFrom = fullDoc.indexOf("- [ ] 父任务");
const blockHtml = markdownToHtml(blockDoc, "", {
  standalone: false,
  document: fullDoc,
  sourceOffset: blockFrom,
});
const declaredPositions = [...blockHtml.matchAll(/data-task-pos="(\d+)"/g)].map(m => Number(m[1]));
assert.equal(declaredPositions.length, 2, "嵌套列表里的两个任务框都要带 data-task-pos");
assert.deepEqual(
  declaredPositions,
  [blockFrom + blockDoc.indexOf("[ ]") + 1, blockFrom + blockDoc.indexOf("[x]") + 1],
  "data-task-pos 必须是整篇文档里的绝对偏移（含 sourceOffset）",
);
for (const pos of declaredPositions) {
  assert.ok(fullDoc[pos] === " " || fullDoc[pos] === "x", "每个 data-task-pos 都必须指向全文里真实任务框内的那个字符");
}
// 按这些偏移改写源码后，重新渲染必须反映新的勾选状态
const toggledFull = fullDoc.slice(0, declaredPositions[0]) + "x" + fullDoc.slice(declaredPositions[0] + 1);
const toggledHtml = markdownToHtml(toggledFull.slice(blockFrom, blockFrom + blockDoc.length), "", {
  standalone: false,
  document: toggledFull,
  sourceOffset: blockFrom,
});
assert.equal(
  (toggledHtml.match(/ checked/g) || []).length,
  2,
  "按 data-task-pos 改写一个字符后，重新渲染的两个任务框都应为已勾选",
);

console.log("PASS: 任务框 data-task-pos 在块渲染下仍是全文绝对偏移，改一个字符即可准确切换");

/* ------------------------------------------------------------------ *
 * 6. 编辑器 livePreview 交互验证：
 *    - 活动块源码完整可见，绝不替换为 widget，不可将渲染结果写回
 *    - 复杂容器块在编辑器中保持原生源码高亮，不生成失真 widget
 * ------------------------------------------------------------------ */

const editorDoc =
  "段落甲\n\n" +
  "- [ ] 任务一\n" +
  "- [x] 任务二\n\n" +
  "> 复杂引用\n" +
  "> > 内层引用\n\n" +
  "    缩进代码行一\n" +
  "    缩进代码行二\n";

const state = EditorState.create({
  doc: editorDoc,
  extensions: [markdown({ extensions: [GFM] }), history(), livePreview()],
});

const getWidgets = (s: EditorState) => {
  const out: { from: number; to: number; html: string }[] = [];
  for (const set of s.facet(EditorView.decorations)) {
    if (typeof set !== "function") {
      set.between(0, s.doc.length, (from, to, d) => {
        if (d.spec.widget?.html) out.push({ from, to, html: d.spec.widget.html });
      });
    }
  }
  return out;
};

// 初始光标在 0（段落甲）：
// 1) 段落甲处于激活状态，保持原生源码（无 widget）；
// 2) 复杂嵌套引用（> 复杂引用 > > 内层引用）作为复杂块，直接保留原生编辑器高亮源码，绝不添加失真 widget！
const initialWidgets = getWidgets(state);
assert.ok(!initialWidgets.some((w) => w.html.includes("段落甲")), "光标所在活动块必须保留完整源码不隐藏");
assert.ok(
  !initialWidgets.some((w) => w.html.includes("内层引用")),
  "复杂嵌套引用块不得生成破坏性 widget，必须保留源码供编辑",
);
assert.ok(initialWidgets.some((w) => w.html.includes("任务一")), "非激活的任务列表正常渲染为 widget");
assert.ok(initialWidgets.some((w) => w.html.includes("缩进代码行一")), "缩进代码块正常渲染为 widget");

// 光标移动到任务列表时：任务列表的 widget 消失，源码完全展现；离开后重新预览
const taskLinePos = editorDoc.indexOf("- [ ] 任务一");
const stateOnTask = state.update({ selection: { anchor: taskLinePos } }).state;
assert.ok(
  !getWidgets(stateOnTask).some((w) => w.html.includes("任务一")),
  "光标移入任务列表时立即暴露完整源码供编辑",
);
assert.ok(
  getWidgets(stateOnTask).some((w) => w.html.includes("段落甲")),
  "前一个段落脱离激活态后渲染为预览",
);

console.log("PASS: 活动块源码完整可见、复杂容器保留原生源码不隐藏、光标进出无缝切换");

console.log("\nALL PASS: 复杂 Markdown 安全兼容、回退、代码区间识别与编辑器交互全部通过！");
