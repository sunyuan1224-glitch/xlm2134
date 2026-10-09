/*
 * 复杂 Markdown 安全兼容的**真实 GTK/WebKit DOM** 端到端断言：
 *
 *  1) 嵌套列表 / 表格 / 围栏代码 / 缩进代码：块边界与结构正确（表格按普通段落显示，
 *     不吞后续列表行；缩进代码是 pre 而不是段落；嵌套列表在一棵完整的 DOM 子树里）。
 *  2) 复杂嵌套容器（引用套引用/列表/代码）：编辑器**保留完整源码**，不生成 widget，
 *     只挂一个带中文提示的标记属性；源码一字不改（不写回、不隐藏）。
 *  3) 任务框：mdExport 渲染出的禁用复选框带 data-task-pos，且指向全文里的真任务框偏移；
 *     代码区里的伪任务不渲染成复选框（预览侧不再有点击切换）。
 *  4) 活动块（光标所在块）永远是完整源码，移出后才变预览。
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { history } from "@codemirror/commands";
import { livePreview } from "../src/editor/livePreview.ts";

declare const window: {
  webkit: { messageHandlers: { result: { postMessage: (text: string) => void } } };
};

const report = (text: string) => window.webkit.messageHandlers.result.postMessage(text);
const check = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** 文档：覆盖嵌套列表 / 表格后接列表 / 围栏 + 缩进代码 / 复杂嵌套引用。 */
const doc =
  "段前文字。\n\n" +
  "- [ ] 列表任务\n" +
  "  - [x] 子任务\n" +
  "- 普通项\n\n" +
  "```js\n" +
  "- [ ] 围栏伪任务\n" +
  "```\n\n" +
  "    - [ ] 缩进伪任务\n\n" +
  "| A | B |\n" +
  "| --- | --- |\n" +
  "| 1 | 2 |\n" +
  "- 表格后列表项\n\n" +
  "> 外层引用\n" +
  "> > 嵌套引用\n\n" +
  "段后文字。\n";

async function run() {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] }), history(), livePreview()] }),
  });
  // 光标停在文末空白处：所有块都处于「非激活」预览态
  view.dispatch({ selection: { anchor: doc.length } });
  await frame();

  /* ---------------------------------------------------------------- *
   * 断言 1: 嵌套列表是一个完整 widget（不散架）
   * ---------------------------------------------------------------- */
  const rendered = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-lp-rendered"));
  const listWidget = rendered.find(el => el.textContent?.includes("列表任务"));
  check(listWidget, "嵌套列表必须渲染成 widget");
  check(
    listWidget!.querySelectorAll("ul ul > li.task").length === 1,
    "子任务必须嵌在外层列表项内部（ul ul > li.task）",
  );
  check(
    !rendered.some(el => el === listWidget!.parentElement && el.textContent?.includes("普通项") && el !== listWidget),
    "嵌套列表不得被拆成多个 widget",
  );

  /* ---------------------------------------------------------------- *
   * 断言 2: 表格按普通段落渲染；表格后面的列表行没有被吞进表格
   * ---------------------------------------------------------------- */
  check(
    !rendered.some(el => el.querySelector("table")),
    "渲染器不再有表格分支：不得生成 <table>",
  );
  const tablePara = rendered.find(el => el.textContent?.includes("| A | B |"));
  check(tablePara, "手写表格必须按普通段落渲染成 widget");
  check(
    !tablePara!.textContent!.includes("表格后列表项"),
    "表格段落绝不得吞掉后面的列表行",
  );
  check(
    rendered.some(el => el.textContent?.trim() === "表格后列表项"),
    "表格后的列表行必须渲染成独立列表",
  );

  /* ---------------------------------------------------------------- *
   * 断言 3: 缩进代码块渲染为 pre（不是段落），围栏代码同理
   * ---------------------------------------------------------------- */
  const codeWidgets = rendered.filter(el => el.querySelector("pre"));
  check(codeWidgets.length >= 2, "围栏代码与缩进代码都必须是 pre");
  check(
    codeWidgets.some(el => el.textContent?.includes("- [ ] 缩进伪任务")),
    "缩进代码块的源码必须原样出现在 pre 里",
  );
  check(
    !rendered.some(el => el.tagName === "P" && el.textContent?.includes("缩进伪任务")),
    "缩进代码不得退化成分段",
  );

  /* ---------------------------------------------------------------- *
   * 断言 4: 复杂嵌套引用保留完整源码，不生成 widget、带提示标记
   * ---------------------------------------------------------------- */
  check(
    !rendered.some(el => el.textContent?.includes("嵌套引用")),
    "复杂嵌套引用不得生成 widget（不做正则猜测渲染）",
  );
  const complexMark = view.dom.querySelector<HTMLElement>("[data-md-complex]");
  check(complexMark !== null, "复杂块必须带 data-md-complex 提示标记");
  check(
    (complexMark!.getAttribute("title") ?? "").includes("保留"),
    "复杂块提示必须说明「已按原文保留」",
  );
  check(
    view.dom.textContent!.includes("> > 嵌套引用"),
    "复杂块源码必须原样可见可编辑（不得隐藏）",
  );

  /* ---------------------------------------------------------------- *
   * 断言 5: 只有真任务框渲染成复选框；代码区伪任务不渲染
   * ---------------------------------------------------------------- */
  const boxes = Array.from(view.dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  check(boxes.length === 2, "全文只有 2 个真任务框（围栏/缩进代码里的伪任务被屏蔽）");
  check(
    boxes.every(b => b.dataset.taskPos !== undefined),
    "每个复选框都必须带 data-task-pos",
  );
  for (const box of boxes) {
    const pos = Number(box.dataset.taskPos);
    check(pos === doc.indexOf("[ ]") + 1 || pos === doc.indexOf("[x]") + 1, "data-task-pos 必须是绝对源码偏移");
    check(doc[pos] === " " || doc[pos] === "x", "data-task-pos 必须指向任务框内的那个字符");
  }

  /* ---------------------------------------------------------------- *
   * 断言 6: 活动块（光标所在块）始终是完整源码，移出后变预览
   * ---------------------------------------------------------------- */
  const listPos = doc.indexOf("- [ ] 列表任务");
  view.dispatch({ selection: { anchor: listPos + 2 } });
  await frame();
  check(
    view.dom.textContent!.includes("- [ ] 列表任务"),
    "光标进入列表块时必须暴露完整源码（活动块不隐藏、不替换成 widget）",
  );
  check(
    !Array.from(view.dom.querySelectorAll(".cm-lp-rendered")).some(el => el.textContent?.includes("列表任务")),
    "活动块不得同时存在预览 widget",
  );
  view.dispatch({ selection: { anchor: doc.length } });
  await frame();
  check(
    Array.from(view.dom.querySelectorAll(".cm-lp-rendered")).some(el => el.textContent?.includes("列表任务")),
    "光标移出后重新渲染成预览 widget",
  );

  view.destroy();

  report(
    "PASS: real GTK/WebKit DOM: nested list stays one intact subtree, table renders as a plain paragraph and never swallows the following list row, " +
      "fenced/indented code render as pre, complex nested quote keeps its source (no widget, no hidden text, hint mark), " +
      "only real task boxes become checkboxes carrying absolute data-task-pos, " +
      "and the active block always shows its complete source.",
  );
}

run().catch(error => report("FAIL: " + String(error) + "\n" + (error instanceof Error ? error.stack : "")));
