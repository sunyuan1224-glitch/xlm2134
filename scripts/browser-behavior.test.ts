/*
 * GTK/WebKit 真实 GUI 端到端断言：
 *
 *  1) 跨块引用式链接渲染；图片只读沙箱：只读取 data-md-src，外部 http(s) 图片降级为占位符
 *     不发请求，本地图片经 options.image（全程零外部请求）。
 *  2) 任务框：mdExport 渲染出的禁用复选框带 data-task-pos，且是全文绝对源码偏移
 *     （块级渲染叠加 sourceOffset，不是行内相对位置）。
 *  3) 链接点击：普通点击不打开外部链接（不发请求、不跳转），文档内锚点把光标定位到标题行源码。
 *  4) 中文输入的 Unicode 事务稳定性。
 *
 * （代码高亮、任务框点击切换、脚注正文渲染、mermaid 图表与 KaTeX 公式都已随
 *  「通用 Markdown 编辑器」功能一起移除，这里不再断言。）
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { history } from "@codemirror/commands";
import { livePreview } from "../src/editor/livePreview";

const report = (text: string) => (window as unknown as { webkit: { messageHandlers: { result: { postMessage: (t: string) => void } } } }).webkit.messageHandlers.result.postMessage(text);
const check = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function run() {
  /* ------------------------------------------------------------------ *
   * 断言 1: 跨块引用式链接、图片只读沙箱
   * ------------------------------------------------------------------ */
  const doc =
    "编辑区\n\n" +
    "- [ ] 待办一\n" +
    "- [x] 待办二\n\n" +
    "引用[章节][目标]与普通链接。\n\n" +
    "[目标]: other.md#标题\n\n" +
    "```js\nconst answer = 42;\n```\n\n" +
    "![远程](https://example.invalid/image.png)\n\n" +
    "![本地图](images/pic.png)";

  let requestedLocalImage = "";
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM] }),
        history(),
        livePreview({
          image: async src => {
            requestedLocalImage = src;
            return "data:image/svg+xml;utf8,<svg></svg>";
          },
        }),
      ],
    }),
  });
  await frame();

  check(view.dom.querySelector('a[href="other.md#标题"]'), "cross-block reference must render");
  check(!view.dom.querySelector('img[src^="https:"]'), "remote images must not load");
  check(!view.dom.querySelector('img[data-md-src^="http"]'), "no image element may point at the network");
  check(requestedLocalImage === "images/pic.png", "local image must request through options.image");
  // 代码围栏按普通 <pre> 保留源码（不再有 tokenizer 高亮）
  check(view.dom.querySelector("pre"), "fenced code must render as a <pre>");

  /* ------------------------------------------------------------------ *
   * 断言 2: 中文输入与事务稳定性
   * ------------------------------------------------------------------ */
  view.dispatch({ selection: { anchor: 0 } });
  view.focus();
  view.dispatch({ changes: { from: 0, insert: "中文输入测试" }, selection: { anchor: 6 } });
  check(view.state.doc.toString().startsWith("中文输入测试编辑区"), "Unicode edit must preserve Chinese");

  view.destroy();

  /* ------------------------------------------------------------------ *
   * 断言 3: 任务框的绝对源码偏移（data-task-pos）与块级 sourceOffset
   * ------------------------------------------------------------------ */
  const taskDoc = "- [ ] 第一块\n\n中间段落。\n\n- [ ] 第二块\n";
  const viewTasks = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: taskDoc, extensions: [markdown({ extensions: [GFM] }), history(), livePreview()] }),
  });
  await frame();
  // 光标停在文末空行：两块任务列表都不处于「正在编辑」，才会都渲染成 widget
  viewTasks.dispatch({ selection: { anchor: taskDoc.length } });
  await frame();
  const taskBoxes = Array.from(viewTasks.dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  check(taskBoxes.length === 2, "both task blocks must render a checkbox");
  check(taskBoxes.every(b => b.dataset.taskPos !== undefined), "every rendered checkbox must expose data-task-pos");
  check(taskBoxes[0].dataset.taskPos === String(taskDoc.indexOf("[ ]") + 1), "first checkbox offset is absolute");
  check(
    taskBoxes[1].dataset.taskPos === String(taskDoc.lastIndexOf("[ ]") + 1),
    "second checkbox offset must use its block sourceOffset, not a line-relative position",
  );
  for (const box of taskBoxes) {
    const pos = Number(box.dataset.taskPos);
    check(taskDoc[pos] === " " || taskDoc[pos] === "x", "data-task-pos must point at the marker character");
  }
  viewTasks.destroy();

  /* ------------------------------------------------------------------ *
   * 断言 4: 点击链接绝不发起外部请求；内锚定位到标题行源码
   * ------------------------------------------------------------------ */
  const offlineDoc = "见[外部](https://example.invalid/page)与[本地](#标题)。\n\n## 标题\n";
  let linkCalls = 0;
  const viewOffline = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: offlineDoc,
      extensions: [markdown({ extensions: [GFM] }), history(), livePreview({ onLink: () => { linkCalls++; } })],
    }),
  });
  await frame();
  viewOffline.dispatch({ selection: { anchor: offlineDoc.length } });
  await frame();
  check(!viewOffline.dom.querySelector('img[src], img[data-md-src^="http"]'), "no image element may point at the network");
  const external = viewOffline.dom.querySelector<HTMLAnchorElement>('a[href^="https:"]');
  check(external, "external link must render");
  external!.click();
  await frame();
  check(linkCalls === 0, "a plain click on an external link must not open anything");
  check(location.href.indexOf("example.invalid") === -1, "the page must not navigate to external hosts");
  // 普通点击只把光标移进源码块，所以把光标再挪回文末，让段落重新渲染成 widget
  viewOffline.dispatch({ selection: { anchor: offlineDoc.length } });
  await frame();
  const anchor = viewOffline.dom.querySelector<HTMLAnchorElement>('a[href="#标题"]');
  check(anchor, "in-document anchor must render");
  anchor!.click();
  await frame();
  check(viewOffline.state.selection.main.head === offlineDoc.indexOf("## 标题"), "in-document anchor must select the heading source");
  viewOffline.destroy();

  report(
    "PASS: real GTK/WebKit DOM: cross-block reference link render, data-md-src only image loading " +
      "(remote blocked, local via options.image, zero external requests), " +
      "task checkboxes carry absolute data-task-pos offsets (block sourceOffset applied), " +
      "external link plain click opens nothing, in-document anchor selects the heading source, " +
      "and Chinese Unicode transactions are stable.",
  );
}

run().catch(error => report("FAIL: " + String(error) + "\n" + (error instanceof Error ? error.stack : "")));
