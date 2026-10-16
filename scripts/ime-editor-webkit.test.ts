/*
 * 真实 GTK/WebKit 下对**补丁后的 Editor 组件本体**做集成测试（React + 真实 CodeMirror + 真实 DOM）：
 *
 *  A) 组合态期间 sourceMode 切换（Ctrl+/ 那条路径，Compartment.reconfigure）被推迟：
 *     组合期间不重配、view.compositionStarted 保持、正文一字不丢；
 *     组合结束后重配才落下（判据是「有没有新的 dispatch」，为什么不用装饰数量见 spyDispatches）。
 *  B) 组合态期间打字机模式不再滚动：组合中的选择变化不产生 scrollIntoView，
 *     焦点与滚动位置稳定；组合结束后打字机对齐补上（焦点仍在编辑器里）。
 *  C) 组合态期间外部正文回写被推迟；结束后按「不丢本地文字」的规则合并/拒绝。
 *  D) 非组合态的竞态：store 还停在旧快照时外部工具回写，
 *     绝不把用户刚敲进去的字整篇冲掉。
 */
import { createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { Editor } from "../src/editor/Editor.tsx";

const report = (text: string) =>
  (
    window as unknown as {
      webkit: { messageHandlers: { result: { postMessage: (t: string) => void } } };
    }
  ).webkit.messageHandlers.result.postMessage(text);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const DOC = [
  "# 验收文档",
  "",
  "第一段：外部工具会改这里。",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "第二段：用户在这里输入。",
  ...Array.from({ length: 160 }, (_, i) => ""),
  ...Array.from({ length: 160 }, (_, i) => "填充行 " + (i + 1) + "：打字机模式会让光标居中。"),
  "",
].join("\n");

function composition(el: EventTarget, type: string, data: string) {
  el.dispatchEvent(new CompositionEvent(type, { bubbles: true, cancelable: true, data }));
}

function textInput(el: EventTarget, type: "input" | "beforeinput", inputType: string, data: string) {
  el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data }));
}

interface Harness {
  root: Root;
  view: () => EditorView;
  setSource: (v: boolean) => void;
  setStore: (v: string) => void;
  muteStore: (v: boolean) => void;
  store: () => string;
}

function mount(): Harness {
  const host = document.createElement("div");
  host.id = "harness";
  document.body.appendChild(host);
  const root = createRoot(host);
  let view: EditorView | null = null;
  let setSourceFn: (v: boolean) => void = () => undefined;
  let setStoreFn: (v: string) => void = () => undefined;
  let muted = false;
  let storeValue = DOC;

  function App() {
    const [store, setStore] = useState(DOC);
    const [source, setSource] = useState(false);
    const storeRef = useRef(store);
    storeRef.current = store;
    setSourceFn = setSource;
    setStoreFn = (v: string) => {
      storeValue = v;
      setStore(v);
    };
    return createElement(Editor, {
      path: "验收.md",
      initialContent: store,
      sourceMode: source,
      typewriterMode: true,
      onChange: (v: string) => {
        storeValue = v;
        if (!muted) setStore(v);
      },
      onSave: () => undefined,
      onCursor: () => undefined,
      registerView: (v: EditorView | null) => {
        view = v;
      },
    });
  }

  root.render(createElement(App));
  return {
    root,
    view: () => {
      if (!view) throw new Error("editor view not registered");
      return view;
    },
    setSource: (v) => setSourceFn(v),
    setStore: (v) => setStoreFn(v),
    muteStore: (v) => {
      muted = v;
    },
    store: () => storeValue,
  };
}

/*
 * 「切到源码模式了没」怎么判：**不能用装饰数量**。
 *
 * 这条用例原来等的是 `decorations(view) === 0`，但源码模式**不是**没有装饰 ——
 * lineHeightHints（逐行高度提示，给源码滚动条兜高的那个）也往 EditorView.decorations 里
 * 塞一份，两种模式都是 1，所以那个条件永远等不到，用例一直卡在超时上（跟输入法无关）。
 * 也不能数 `.cm-lp-rendered`：这个夹具的光标在中部那一大段里，而「光标所在块显示源码」，
 * 视口里根本没有渲染出来的预览块。
 *
 * 直接盯**动作**：推迟的重配是靠 view.dispatch 落下去的（见 Editor.tsx 的 whenImeIdle），
 * 所以「组合期间不该有 dispatch、组合结束后该来一次」既好观察，又正好是要验的东西。
 * 测试自己那几次 dispatch 会先记下基数再比增量。
 */
function spyDispatches(view: EditorView): () => number {
  const calls: number[] = [];
  const original = view.dispatch.bind(view);
  (view as unknown as { dispatch: (...a: unknown[]) => unknown }).dispatch = (...args: unknown[]) => {
    calls.push(Date.now());
    return (original as unknown as (...a: unknown[]) => unknown)(...args);
  };
  return () => calls.length;
}

/** 实时预览的装饰数量（预览 / 源码模式都可能 &gt; 0，别拿它当模式判据，见上面）。 */
function decorations(view: EditorView): number {
  let count = 0;
  for (const set of view.state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    set.between(0, view.state.doc.length, () => {
      count++;
      return false;
    });
  }
  return count;
}

async function waitFor(ready: () => boolean, what: string, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (ready()) return;
    await delay(20);
  }
  throw new Error("timeout waiting for " + what);
}

async function run() {
  const style = document.createElement("style");
  style.textContent =
    ".editor-host{height:320px;display:block} .editor-host .cm-editor{height:100%} .editor-host .cm-scroller{overflow:auto}";
  document.head.appendChild(style);

  const app = mount();
  await waitFor(() => {
    try {
      return !!app.view();
    } catch {
      return false;
    }
  }, "editor view to mount", 4000);
  const view = app.view();
  view.focus();
  if (!view.hasFocus) throw new Error("editor must be focusable in real WebKit");
  // 光标放到文档中部，让打字机滚动真的有活干
  const middle = view.state.doc.line(300).from;
  view.dispatch({ selection: { anchor: middle }, effects: EditorView.scrollIntoView(middle, { y: "center" }) });
  await frame();
  await waitFor(() => decorations(view) > 0, "live preview decorations");
  const dispatchCount = spyDispatches(view);
  const dispatchesBeforeComposition = dispatchCount();
  report("NOTE: editor mounted, live preview decorations = " + decorations(view) + ", doc length = " + view.state.doc.length);

  const cdom = view.contentDOM;

  /* ---------------------------------------------------------------- *
   * A) 组合态期间切换 sourceMode：重配必须推迟
   * ---------------------------------------------------------------- */
  const selectionBefore = view.state.selection.main.head;
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionupdate", "ni");
  textInput(cdom, "input", "insertCompositionText", "ni");
  report(
    "NOTE: after compositionstart view.composing=" +
      view.composing +
      " compositionStarted=" +
      view.compositionStarted +
      " activeElement=" +
      (document.activeElement ? document.activeElement.className : "null")
  );
  await delay(120); // 预编辑期间外部（例如 Ctrl+/ 快捷键）切到源码模式
  const scrollBefore = view.scrollDOM.scrollTop;
  report(
    "NOTE: before mode switch: composing=" +
      view.composing +
      " compositionStarted=" +
      view.compositionStarted +
      " activeElement=" +
      (document.activeElement ? document.activeElement.className : "null")
  );
  app.setSource(true);
  await frame();
  await delay(150);
  if (!view.compositionStarted) throw new Error("composition must still be alive after a mode switch request");
  if (dispatchCount() !== dispatchesBeforeComposition)
    throw new Error("mode reconfigure must be deferred while composing (a dispatch went through mid-composition)");
  if (view.scrollDOM.scrollTop !== scrollBefore)
    throw new Error("typewriter scroll must not fire while composing");
  report("NOTE: source-mode switch deferred during preedit, decorations and scroll unchanged");

  /* 选词上屏：预编辑 "ni" -> "你" */
  const commit = view.state.selection.main.from;
  composition(cdom, "compositionupdate", "你");
  composition(cdom, "compositionend", "你");
  textInput(cdom, "beforeinput", "insertFromComposition", "你");
  view.dispatch({ changes: { from: commit, insert: "你" } });
  textInput(cdom, "input", "insertFromComposition", "你");
  const dispatchesAtCommit = dispatchCount(); // 测试自己那次改文档的 dispatch 之后起算
  await waitFor(() => dispatchCount() > dispatchesAtCommit, "deferred mode switch to land after composition");
  if (decorations(view) === 0)
    throw new Error(
      "源码模式下 decorations 不该是 0 —— lineHeightHints（逐行高度提示）也挂装饰；" +
        "这条要是红了，说明有人删了它，请把上面的判据说明一起改掉",
    );
  if (view.state.doc.toString()[commit] !== "你") throw new Error("committed character must stay in the document");
  if (view.state.selection.main.head !== selectionBefore + 1 && !view.state.doc.toString().includes("你"))
    throw new Error("committed character lost");
  report("NOTE: deferred source-mode switch landed after composition ended");

  /* ---------------------------------------------------------------- *
   * B) 组合态期间打字机不滚，结束后补上
   * ---------------------------------------------------------------- */
  app.setSource(false);
  const dispatchesBeforeBack = dispatchCount();
  await waitFor(() => dispatchCount() > dispatchesBeforeBack, "back to preview mode (reconfigure dispatched)");
  const lineAfter = view.state.doc.line(305);
  view.dispatch({ selection: { anchor: lineAfter.from } });
  await frame();
  const settledScroll = view.scrollDOM.scrollTop;

  // 组合中把光标挪到很远处（输入法在编辑点附近的典型行为），打字机此时必须按兵不动
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionupdate", "hao");
  textInput(cdom, "input", "insertCompositionText", "hao");
  const far = view.state.doc.line(view.state.doc.lines - 8).from;
  view.dispatch({ selection: { anchor: far } });
  await frame();
  await delay(120);
  if (view.scrollDOM.scrollTop !== settledScroll)
    throw new Error("typewriter must not scroll the caret to center while composing");
  if (!view.composing && !view.compositionStarted) throw new Error("editor must still be in composition state");
  report("NOTE: typewriter kept still during preedit (scrollTop " + settledScroll + " unchanged)");

  composition(cdom, "compositionend", "");
  textInput(cdom, "input", "insertFromComposition", "");
  await waitFor(() => view.scrollDOM.scrollTop !== settledScroll, "typewriter alignment to catch up after composition", 3000);
  if (!view.hasFocus) throw new Error("focus must survive the composition session");
  report("NOTE: typewriter alignment caught up after composition, focus kept");

  /* ---------------------------------------------------------------- *
   * C) 组合态期间外部回写：推迟 + 结束后合并
   * ---------------------------------------------------------------- */
  const storeNow = app.store();
  const userLine = view.state.doc.line(306).from;
  view.dispatch({ selection: { anchor: userLine } });
  await delay(120);
  const baseDoc = view.state.doc.toString();
  const externalFix = baseDoc.replace("# 验收文档", "# 验收文档（外部修订）");
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionupdate", "ni");
  textInput(cdom, "input", "insertCompositionText", "ni");
  app.setStore(externalFix); // 外部工具（校对/排版）回写
  await delay(200);
  if (view.state.doc.toString() !== baseDoc) throw new Error("external write must not touch the doc while composing");
  report("NOTE: external rewrite deferred while composing");

  const preeditAt = view.state.doc.line(9).from;
  composition(cdom, "compositionupdate", "你好");
  composition(cdom, "compositionend", "你好");
  view.dispatch({ changes: { from: preeditAt, insert: "你好" } });
  textInput(cdom, "input", "insertFromComposition", "你好");
  await waitFor(() => view.state.doc.toString().includes("外部修订"), "external fix to merge after composition", 3000);
  const merged = view.state.doc.toString();
  if (!merged.includes("你好")) throw new Error("committed text must survive the external merge, got: " + merged.slice(0, 200));
  if (view.state.doc.toString().length < baseDoc.length)
    throw new Error("document shrank unexpectedly (data loss)");
  report("NOTE: external fix merged, committed text kept (store in sync: " + (app.store() === storeNow) + ")");

  /* ---------------------------------------------------------------- *
   * D) 非组合态竞态：store 还是旧快照时外部回写，不许冲掉用户刚敲的字
   * ---------------------------------------------------------------- */
  const preDoc = view.state.doc.toString();
  const at = view.state.selection.main.from;
  app.muteStore(true); // 模拟 store 还没收到这次输入（外部工具拿的是旧正文）
  view.dispatch({ changes: { from: at, insert: "用户刚敲的字" } });
  app.muteStore(false);
  await delay(60);
  const withUserText = view.state.doc.toString();
  if (withUserText === preDoc) throw new Error("user typing must reach the document");
  // 外部工具基于旧快照（preDoc）推出修订：只在标题里加个字
  app.setStore(preDoc.replace("# 验收", "# 验收!"));
  await delay(250);
  const afterRace = view.state.doc.toString();
  if (!afterRace.includes("用户刚敲的字"))
    throw new Error("stale external rewrite must not wipe the user's fresh typing, got: " + afterRace.slice(0, 200));
  if (!afterRace.includes("# 验收!")) throw new Error("disjoint external revision should still be applied");
  report("NOTE: stale-snapshot external rewrite merged; user typing preserved");

  app.root.unmount();
  report(
    "PASS: real WebKit editor integration: deferred source-mode reconfigure during preedit, no typewriter scroll while composing (aligned right after), deferred external write merged on settle, stale-snapshot external write never wipes fresh user input, focus preserved, no data loss."
  );
}

run().catch((e) => {
  console.error(e);
  report("FAIL: " + (e?.message || String(e)));
});
