/*
 * GTK/WebKit 真实 DOM 端到端测试（真实 WebKitGTK 窗口，真实 contenteditable / 真实 CodeMirror）：
 *
 *  A) 组合态判定与推迟：
 *     - compositionstart 触发后 view.composing 仍是 false，守卫必须立刻进入组合态；
 *     - 模式重配（Compartment.reconfigure）、打字机 scrollIntoView、外部正文回写
 *       在组合期间一律不得执行；
 *     - 组合结束后（含 WebKit 迟到提交事件的宽限窗口）再按顺序落定，
 *       打字机滚动必须补上，视图焦点与选择区不被破坏。
 *
 *  B) 结束后的合理同步与「不丢用户正文」：
 *     - 组合期间外部工具改的是别的段落：同步时把外部改动合并到已提交的正文上，
 *       用户刚上屏的汉字与外部改动同时保留；
 *     - 外部推的是组合前的旧文本：拒绝覆盖，保住用户刚输入的文字；
 *     - compositionend 之后迟到的 insertCompositionText 事件不能把守卫永久锁死。
 */
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installImeGuard, planExternalSync } from "../src/editor/ime";

const report = (text: string) =>
  (
    window as unknown as {
      webkit: { messageHandlers: { result: { postMessage: (t: string) => void } } };
    }
  ).webkit.messageHandlers.result.postMessage(text);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function composition(el: EventTarget, type: "compositionstart" | "compositionupdate" | "compositionend", data: string) {
  el.dispatchEvent(new CompositionEvent(type, { bubbles: true, cancelable: true, data }));
}

function textInput(el: EventTarget, type: "input" | "beforeinput", inputType: string, data: string) {
  el.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data }));
}

/** 记录每一次 view.dispatch 的时机，用来判定「组合期间到底有没有动过视图」。 */
interface DispatchLog {
  readonly marks: Array<{ at: number; composerBusy: boolean }>;
}

function makeView(host: HTMLElement, doc: string): { view: EditorView; log: DispatchLog } {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [EditorView.lineWrapping] }),
    parent: host,
  });
  const log: DispatchLog = { marks: [] };
  const original = view.dispatch.bind(view);
  (view as unknown as { dispatch: (spec: unknown) => unknown }).dispatch = (spec: unknown) => {
    log.marks.push({ at: Date.now(), composerBusy: view.composing || view.compositionStarted });
    return original(spec as never);
  };
  return { view, log };
}

const duringComposition = (log: DispatchLog) => log.marks.filter((m) => m.composerBusy).length;

async function blockA() {
  const host = document.createElement("div");
  host.className = "editor-host";
  document.body.appendChild(host);

  const { view, log } = makeView(host, "段落一：起初神创造天地。\n段落二：地是空虚混沌。\n");
  view.focus();
  if (!view.hasFocus) throw new Error("EditorView must gain focus in real WebKit");
  report("NOTE: EditorView focused in WebKit contenteditable");

  const guard = installImeGuard(view, { settleMs: 60 });
  let immediate = false;
  guard.whenIdle(() => {
    immediate = true;
  }, "now");
  if (!immediate || !guard.idle()) throw new Error("guard must start idle and run immediately");

  /* 真实输入法事件顺序：start -> update -> insertCompositionText */
  const cdom = view.contentDOM;
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionupdate", "ni");
  textInput(cdom, "beforeinput", "insertCompositionText", "ni");
  textInput(cdom, "input", "insertCompositionText", "ni");

  if (guard.idle() || !guard.composing) throw new Error("guard must report composing right after compositionstart");
  // CodeMirror 自身的组合标记在 compositionstart 时还是 false：这正是旧实现漏判的窗口
  report("NOTE: view.composing=" + view.composing + " view.compositionStarted=" + view.compositionStarted + " while guard says composing");

  // 清除预编辑阶段 DOM 模拟产生的内部 dispatch 记录，以便准确统计推迟的动作
  log.marks.length = 0;

  let modeRan = false;
  let typewriterRan = false;
  let externalRan = false;
  guard.whenIdle(() => {
    modeRan = true;
    view.dispatch({ selection: { anchor: 0 } });
  }, "mode");
  guard.whenIdle(() => {
    typewriterRan = true;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
  }, "typewriter");
  guard.whenIdle(() => {
    externalRan = true;
  }, "external");

  await frame();
  await delay(120);
  if (modeRan || typewriterRan || externalRan) throw new Error("no deferred action may run while composing");
  if (log.marks.length !== 0) throw new Error("nothing may reach view.dispatch during composition, got " + log.marks.length);
  const focusDuringComposition = view.hasFocus;
  report("NOTE: deferred mode/typewriter/external during preedit; editing focus kept: " + focusDuringComposition);

  /* 选词上屏：compositionend + 真实插入提交文本 */
  composition(cdom, "compositionupdate", "你");
  composition(cdom, "compositionend", "你");
  const endedAt = Date.now();
  textInput(cdom, "beforeinput", "insertFromComposition", "你");
  view.dispatch({ changes: { from: view.state.selection.main.from, insert: "你" } });
  textInput(cdom, "input", "insertFromComposition", "你");

  if (guard.idle()) throw new Error("guard must stay in the settle window right after compositionend");
  // 提交本身是输入法结果，不算编辑器主动打断；这里只关心「推迟的动作」有没有抢跑。
  log.marks.length = 0;

  await delay(400);
  if (!guard.idle())
    throw new Error(
      "guard must be idle after settle (composing=" + guard.composing + " view.composing=" + view.composing + ")"
    );
  if (!modeRan || !typewriterRan || !externalRan) throw new Error("deferred actions must all run after settle");
  const deferredMarks = log.marks.length;
  if (deferredMarks < 2) throw new Error("mode + typewriter must both dispatch after settle, got " + deferredMarks);
  const lateEnough = log.marks.every((m) => m.at - endedAt >= 40);
  if (!lateEnough) throw new Error("deferred actions must wait for the settle window");
  if (!view.state.doc.toString().includes("你")) throw new Error("user input 你 must not be lost");
  if (!view.hasFocus) throw new Error("focus must survive the whole composition session");

  guard.dispose();
  view.destroy();
  host.remove();
  report("NOTE: block A passed (deferral, settle, focus, no data loss)");
}

async function blockB() {
  const host = document.createElement("div");
  host.className = "editor-host";
  document.body.appendChild(host);

  // 组合中的文档：光标处就是预编辑 "ni"（CodeMirror 会把预编辑读进文档）
  const base = "第一段。\nni\n第三段。\n";
  const { view } = makeView(host, base);
  view.focus();
  const guard = installImeGuard(view, { settleMs: 60 });
  const cdom = view.contentDOM;

  let synced: ReturnType<typeof planExternalSync> | null = null;
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionupdate", "ni");
  textInput(cdom, "input", "insertCompositionText", "ni");

  // 组合进行中，外部（校对替换）推来第一段的修订：此时必须排队，不能动文档
  const external = "第一段，\nni\n第三段。\n";
  guard.whenIdle(() => {
    const current = view.state.doc.toString();
    const plan = planExternalSync(base, current, external);
    synced = plan;
    if (plan.kind === "replace") view.dispatch({ changes: { from: 0, to: current.length, insert: external } });
    else if (plan.kind === "merge") view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert } });
  }, "external");

  await delay(150);
  if (view.state.doc.toString() !== base) throw new Error("external sync must not touch the doc while composing");

  // 选词上屏：预编辑 "ni" 变成 "你好"
  composition(cdom, "compositionupdate", "你好");
  composition(cdom, "compositionend", "你好");
  view.dispatch({ changes: { from: base.indexOf("ni"), to: base.indexOf("ni") + 2, insert: "你好" } });
  textInput(cdom, "input", "insertFromComposition", "你好");

  await delay(400);
  const settled = view.state.doc.toString();
  if (settled !== "第一段，\n你好\n第三段。\n")
    throw new Error("disjoint external edit must merge onto the committed text, got: " + JSON.stringify(settled));
  if (!synced || synced.kind !== "merge") throw new Error("expected a merge plan, got " + JSON.stringify(synced));
  report("NOTE: disjoint external rewrite merged into committed text: " + JSON.stringify(settled));

  /* 第二个组合：外部这次推的是组合前的旧文本 —— 必须保留用户刚输入的字 */
  const before = view.state.doc.toString();
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionupdate", "hao");
  textInput(cdom, "input", "insertCompositionText", "hao");
  const staleDoc = before.replace("你好", "你好hao");
  view.dispatch({ changes: { from: before.indexOf("你好") + 2, insert: "hao" } });
  let staleKept = false;
  guard.whenIdle(() => {
    const current = view.state.doc.toString();
    const plan = planExternalSync(before, current, before); // 外部内容比本地还旧
    staleKept = plan.kind === "keepLocal";
    if (plan.kind === "replace") view.dispatch({ changes: { from: 0, to: current.length, insert: before } });
  }, "external");
  // 上屏：hao -> 好
  composition(cdom, "compositionend", "好");
  view.dispatch({ changes: { from: staleDoc.indexOf("hao"), to: staleDoc.indexOf("hao") + 3, insert: "好" } });
  textInput(cdom, "input", "insertFromComposition", "好");

  await delay(400);
  const finalDoc = view.state.doc.toString();
  if (!staleKept) throw new Error("stale external content must be refused");
  if (!finalDoc.includes("你好好")) throw new Error("committed text must survive a stale external rewrite, got: " + JSON.stringify(finalDoc));
  report("NOTE: stale external content refused, committed text kept: " + JSON.stringify(finalDoc));

  /* compositionend 之后迟到的 insertCompositionText（WebKit 常见）不能把守卫锁死 */
  composition(cdom, "compositionstart", "");
  composition(cdom, "compositionend", "");
  guard.whenIdle(() => undefined, "late");
  textInput(cdom, "beforeinput", "insertCompositionText", "x");
  await delay(800);
  if (!guard.idle()) throw new Error("a late insertCompositionText after compositionend must not lock the guard");

  guard.dispose();
  view.destroy();
  host.remove();
  report("NOTE: block B passed (merge on settle, stale refusal, late commit event)");
}

async function run() {
  await blockA();
  await blockB();
  report(
    "PASS: WebKit IME fixture: composition lifecycle detection (incl. the compositionstart window where view.composing is false), strict deferral of reconfigure/typewriter-scroll/external-write during preedit, post-composition settling, focus preservation, disjoint external merge, stale-external refusal, and no loss of committed Chinese text."
  );
}

run().catch((e) => {
  console.error(e);
  report("FAIL: " + (e?.message || String(e)));
});
