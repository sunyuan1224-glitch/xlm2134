/*
 * 输入法组合态与字数：**Editor 组件本体**在真实 GTK/WebKit + 真实 CodeMirror 下的契约。
 *
 * 为什么非要有这一条：字数统计只认「已落定」的正文（组合里是拼音 "nihao"，上屏才是汉字）。
 * 而「哪一次回调算已落定」纯粹是**时序问题**，各引擎里「提交文本进文档」与 compositionend
 * 的先后顺序不一样 —— 只赌「上屏那一下正在组合会变 false」的话，顺序一反过来，上屏那次也被
 * 当成预编辑，汉字就再也进不了字数（实测踩过：用户报「中文不计入字数」）。
 *
 * 所以钉两条不依赖顺序的契约：
 *   A) 组合期间的变化一律 imePending=true（正文照收，但不算字数）；
 *   B) 落定之后**即使再没有新的正文变化**，也必须补报一次 imePending=false ——
 *      由那一次把字数落下来。提交文本先到还是 compositionend 先到，都要补上。
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

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const DOC = "# 统计验收\n\n她推开门。\n";

function composition(el: EventTarget, type: string, data: string) {
  el.dispatchEvent(new CompositionEvent(type, { bubbles: true, cancelable: true, data }));
}

function textInput(el: EventTarget, inputType: string, data: string) {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType, data }));
}

/** 记下每一次 onChange 的内容与「算不算已落定」 */
interface Echo {
  text: string;
  imePending: boolean;
}

interface Harness {
  root: Root;
  view: () => EditorView;
  echoes: Echo[];
  cdom: () => HTMLElement;
}

function mount(): Harness {
  const host = document.createElement("div");
  host.id = "harness";
  document.body.appendChild(host);
  const root = createRoot(host);
  const echoes: Echo[] = [];
  let view: EditorView | null = null;

  function App() {
    // store 侧只当「编辑器的受控正文」：测试不关心它，只关心 onChange 报了什么
    const [store, setStore] = useState(DOC);
    const storeRef = useRef(store);
    storeRef.current = store;
    return createElement(Editor, {
      path: "验收.md",
      initialContent: store,
      onChange: (v: string, imePending: boolean) => {
        echoes.push({ text: v, imePending });
        setStore(v);
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
    echoes,
    cdom: () => host.querySelector<HTMLElement>(".cm-content")!,
  };
}

/** 等一次「落定」（守卫的宽限期 250ms + 余量）之后再看结果 */
const SETTLE_MS = 600;

/** 把一条组合会话跑完：start → 拼音进文档 → 上屏 → 结束。commitFirst 换顺序。 */
async function compositionRound(
  h: Harness,
  opts: { pinyin: string; committed: string; commitFirst: boolean },
): Promise<void> {
  const view = h.view();
  const cdom = h.cdom();
  const at = view.state.doc.length;

  // 组合开始：有的输入法不送 compositionstart，只送 insertCompositionText；
  // 这里两种都走一遍，确保判据不吃引擎的差异
  composition(cdom, "compositionstart", "");
  textInput(cdom, "insertCompositionText", opts.pinyin[0] ?? "");

  // CodeMirror 会把预编辑文本同步进文档（@codemirror/view 的 applyDOMChange 路径）
  view.dispatch({ changes: { from: at, insert: opts.pinyin } });
  await delay(30);
  for (const echo of h.echoes) {
    check(
      !(echo.text.includes(opts.pinyin) && !echo.imePending),
      `拼音不该被当成已落定的正文报出去（"${opts.pinyin}"）：${JSON.stringify(echo)}`,
    );
  }
  check(
    h.echoes.some((e) => e.text.includes(opts.pinyin) && e.imePending),
    `组合中的正文要照报（合成态标记为未落定），实际只有 ${h.echoes.length} 次回调`,
  );

  // 上屏：提交文本替换拼音。两种顺序都要能落下来 —— 这正是这次踩的坑
  const commit = () => view.dispatch({ changes: { from: at, to: at + opts.pinyin.length, insert: opts.committed } });
  if (opts.commitFirst) {
    // 先落提交文本（仍在组合态里），再 compositionend —— 有的引擎就是这顺序
    commit();
    await delay(20);
    composition(cdom, "compositionend", opts.committed);
  } else {
    composition(cdom, "compositionend", opts.committed);
    await delay(20);
    commit();
    textInput(cdom, "insertFromComposition", opts.committed);
  }

  const before = h.echoes.length;
  await delay(SETTLE_MS);
  check(
    h.echoes.length > before,
    "落定之后必须补报一次（否则 store 那边永远等不到可以计数的正文）",
  );
  const last = h.echoes[h.echoes.length - 1];
  check(
    last.imePending === false,
    `补报的那一次必须是「已落定」，实际 ${JSON.stringify(last)}`,
  );
  check(last.text.includes(opts.committed), `补报的应当是上屏后的正文，实际「${last.text}」`);
  check(h.view().state.doc.toString() === last.text, "补报的正文要与文档一致");
}

async function run() {
  const style = document.createElement("style");
  style.textContent =
    ".editor-host{height:320px;display:block} .editor-host .cm-editor{height:100%} .editor-host .cm-scroller{overflow:auto}";
  document.head.appendChild(style);

  const h = mount();
  // React 的挂载是异步的：等 Editor 把视图注册上来再开工
  for (let i = 0; i < 200; i++) {
    try {
      h.view();
      break;
    } catch {
      await delay(20);
    }
  }
  h.view();

  /* A) 常规顺序：compositionend 先到，提交文本随后落进文档 */
  await compositionRound(h, { pinyin: "nihao", committed: "你好", commitFirst: false });
  report("NOTE: 常规顺序（compositionend → 提交落盘）落定后补报成功");

  /* B) 反过来的顺序：提交文本先在组合态里落进文档，然后才 compositionend */
  await compositionRound(h, { pinyin: "zaijian", committed: "再见", commitFirst: true });
  report("NOTE: 反序（提交落盘 → compositionend）同样补报成功");

  /* C) 组合取消（Esc）：正文回到原样，落定后同样要补一次，且内容不含拼音 */
  {
    const view = h.view();
    const cdom = h.cdom();
    const at = view.state.doc.length;
    composition(cdom, "compositionstart", "");
    view.dispatch({ changes: { from: at, insert: "quxiao" } });
    await delay(30);
    view.dispatch({ changes: { from: at, to: at + 6, insert: "" } });
    composition(cdom, "compositionend", "");
    const before = h.echoes.length;
    await delay(SETTLE_MS);
    check(h.echoes.length > before, "组合取消后也要补报一次");
    const last = h.echoes[h.echoes.length - 1];
    check(last.imePending === false, `取消后的补报也要标成已落定，实际 ${JSON.stringify(last)}`);
    check(!last.text.includes("quxiao"), "取消掉的拼音不该留在补报的正文里");
  }

  report(
    "PASS: 组合中的正文只报「未落定」，落定之后必补报一次已落定正文 —— " +
      "提交文本与 compositionend 的先后顺序两种都试过，中文都能进字数。",
  );
}

run().catch((error) =>
  report("FAIL: " + String(error) + "\n" + (error instanceof Error ? error.stack : "")),
);
