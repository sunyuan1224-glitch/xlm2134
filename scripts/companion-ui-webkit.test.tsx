/*
 * 伴读立绘的真 WebKit 检查：站在稿纸**左侧**、贴着编辑区左缘（= 左侧栏右缘），
 * 并且**跟随左侧栏**——收起、展开、拖分隔条三种动法都要跟。
 *
 * 「跟着动」这一条是这次改动的核心：立绘是 .editor-area 的 absolute 子元素，而
 * .editor-area 排在左侧栏后面，所以侧栏一动编辑区就挪、立绘跟着挪。要是哪天有人把
 * 它改成 position: fixed 或者自己缓存了左缘坐标，这个文件里的断言就会红。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { useStore } from "../src/store";
import { api } from "../src/api";
import { placeCompanion } from "../src/lib/paperCompanion";
import "../src/main";

const send = (text: string) => (window as any).webkit.messageHandlers.result.postMessage(text);
const wait = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

const companion = () => document.querySelector<HTMLElement>(".paper-companion");
const editorArea = () => document.querySelector<HTMLElement>(".editor-area");
/** 立绘左缘相对编辑区左缘的偏移 —— 「贴不贴左缘」看这个数，跟窗口宽度无关 */
const offsetFromEditor = () => {
  const c = companion();
  const a = editorArea();
  assert(c && a, "立绘与编辑区都应当在");
  return Math.round(c!.getBoundingClientRect().left - a!.getBoundingClientRect().left);
};

/** 模拟拖分隔条：mousedown 在分隔条上，然后 window 上 mousemove + mouseup */
async function dragSplitter(dx: number) {
  const splitter = document.querySelector<HTMLElement>(".splitter");
  assert(splitter, "应当有分隔条可拖");
  const startX = splitter!.getBoundingClientRect().left + 2;
  splitter!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: startX }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: startX + dx }));
  await wait(80); // 分隔条用 requestAnimationFrame 批量落位，等一帧
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: startX + dx }));
  await wait(80);
}

async function run() {
  useStore.setState({ companionVisible: true, sidebarOpen: true });
  useStore.setState({
    root: "/companion-fixture",
    files: ["第一章.md"],
    tree: [{ path: "第一章.md", name: "第一章.md", is_dir: false, children: [] }],
    openTabs: ["第一章.md"],
    activePath: "第一章.md",
    contents: {
      "第一章.md":
        "# 春日来信\n\n" +
        "夜里落了一场很轻的雨。她推开门，听见檐水滴在青石板上，一声，又一声。\n\n" +
        "\"你回来得正好。\"老人把茶推过来，杯口还浮着热气，\"稿子我读过了，第三段该慢一点。\"\n\n" +
        "她点头，把伞靠在门边。雨声从窗缝里钻进来，像一句没写完的对白，等着人去续。\n",
    },
  });
  createRoot(document.getElementById("root")!).render(<App />);
  (api as unknown as Record<string, unknown>).listFonts = async () => [];
  await wait();

  /* ---------------- 0. 纯函数：落点算在左边 ----------------
   * 先单独验 placeCompanion，不用管 DOM：两种模式都必须落在编辑区左半边，
   * 右半边是正文，人不能站到那里去。
   */
  {
    const opts = { width: 1400, height: 800, measure: 752, padLeft: 16, padRight: 16, aspect: 328 / 1122 };
    // 宽编辑区：左空白 ≈ (1400-32-752)/2 + 16 = 324 → 够站，走 beside，贴左缘
    const wide = placeCompanion(opts);
    assert(wide, "宽编辑区应当能放下立绘");
    assert(wide!.mode === "beside", `宽编辑区应当是 beside，实际 ${wide!.mode}`);
    assert(wide!.left <= 20, `beside 应当贴左缘，实际 left=${wide!.left}`);
    assert(wide!.left + wide!.width <= wide!.left + 400, "beside 不该宽到压住正文");

    // 窄编辑区：左空白不够 → 退到左下角，仍然贴左缘
    const narrow = placeCompanion({ ...opts, width: 700 });
    assert(narrow, "窄编辑区应当仍能放下（退到角落）");
    assert(narrow!.mode === "tuck", `窄编辑区应当是 tuck，实际 ${narrow!.mode}`);
    assert(narrow!.left === 0, `tuck 应当贴左缘，实际 left=${narrow!.left}`);
    assert(narrow!.width < wide!.width, "退到角落时应当更小，免得压住正文");

    // 两种模式都绝不能跑到右半边去
    for (const laid of [wide, narrow]) {
      assert(
        laid!.left + laid!.width <= opts.width / 2,
        `立绘不该越过编辑区中线（left=${laid!.left} width=${laid!.width}）`,
      );
    }
  }

  /* ---------------- 1. 在编辑区左缘，不在右缘 ---------------- */
  {
    const c = companion();
    assert(c, "伴读立绘应当显示（companionVisible 默认开）");
    // 指针穿透：立绘不能挡住输入、选区和右键
    assert(getComputedStyle(c!).pointerEvents === "none", "立绘必须 pointer-events:none");
    assert(getComputedStyle(c!).opacity === "0.38", `立绘应保持水印透明度，实际 ${getComputedStyle(c!).opacity}`);

    const offset = offsetFromEditor();
    assert(offset >= 0 && offset <= 20, `立绘应当贴在编辑区左缘（偏移 ${offset}px）`);

    // 也确实落在编辑区左半边（正文在中间，人不能站到正文上）
    const a = editorArea()!.getBoundingClientRect();
    const r = c!.getBoundingClientRect();
    assert(r.right < a.left + a.width / 2, "立绘不该越过编辑区中线");

    // 底部对齐：脚踩在编辑区底边（也就是状态栏上沿）
    assert(Math.abs(r.bottom - a.bottom) <= 2, `立绘底边应对齐编辑区底边（${r.bottom} vs ${a.bottom}）`);
  }

  send("SHOT: companion-left");
  await wait();

  /* ---------------- 2. 跟随左侧栏：收起 / 展开 / 拖宽 / 拖窄 ----------------
   * 核心用例。只验「贴左缘」是不够的——固定不动的实现同样能贴上左缘，
   * 一旦侧栏收起就露馅。所以每一动都要同时验两件事：
   *   ① 编辑区真的挪了，且立绘**跟着挪了同样的距离**；
   *   ② 挪完之后立绘依然贴在编辑区左缘。
   *
   * 注意别把「相对编辑区的偏移恒为一个定值」写进断言：编辑区一变宽，左空白就可能
   * 从「不够站」变成「够站」，落点会从 tuck(偏移 0) 翻到 beside(偏移 16)。这是设计
   * 如此、不是漂移，所以这里用「位移差 ≤ 帖边量」来卡，而不是要求偏移完全相等。
   */
  {
    const editorLeft = () => Math.round(editorArea()!.getBoundingClientRect().left);
    const companionLeft = () => Math.round(companion()!.getBoundingClientRect().left);
    /** 不论哪种模式，立绘都该贴在编辑区左缘（偏移 0 或 16） */
    const hugsLeftEdge = (label: string) => {
      const off = offsetFromEditor();
      assert(off >= 0 && off <= 20, `${label}：立绘应当贴编辑区左缘（实际偏移 ${off}px）`);
    };

    const editorLeft0 = editorLeft();
    const companionLeft0 = companionLeft();
    assert(editorLeft0 > 100, `侧栏展开时编辑区不该贴窗口左缘（实际 ${editorLeft0}）`);
    hugsLeftEdge("起步时");

    // ① 收起侧栏 → 编辑区贴到窗口左缘，立绘跟着走
    useStore.getState().toggleSidebar();
    await wait(250);
    assert(!document.querySelector(".pane-left"), "收起后左侧栏应当没了");
    const editorLeft1 = editorLeft();
    const companionLeft1 = companionLeft();
    assert(editorLeft1 < editorLeft0 - 100, `收起侧栏后编辑区应当往左挪（${editorLeft0} → ${editorLeft1}）`);
    assert(
      companionLeft1 < companionLeft0 - 100,
      `收起侧栏后立绘必须跟着往左挪 —— 「不要不动」说的就是这个（${companionLeft0} → ${companionLeft1}）`,
    );
    assert(
      Math.abs(companionLeft1 - companionLeft0 - (editorLeft1 - editorLeft0)) <= 20,
      `立绘挪的幅度应当和编辑区一致（立绘 ${companionLeft0}→${companionLeft1}，编辑区 ${editorLeft0}→${editorLeft1}）`,
    );
    hugsLeftEdge("收起侧栏后");

    // ② 再展开 → 回到原位
    useStore.getState().toggleSidebar();
    await wait(250);
    assert(Math.abs(editorLeft() - editorLeft0) <= 2, "展开后编辑区应回到原处");
    assert(Math.abs(companionLeft() - companionLeft0) <= 2, "展开后立绘应回到原处");
    hugsLeftEdge("展开侧栏后");

    // ③ 拖分隔条把侧栏拖宽 → 立绘跟着往右
    const paneBefore = document.querySelector(".pane-left")!.getBoundingClientRect().width;
    const cBefore = companionLeft();
    const eBefore = editorLeft();
    await dragSplitter(120);
    const paneAfter = document.querySelector(".pane-left")!.getBoundingClientRect().width;
    assert(paneAfter > paneBefore + 50, `拖分隔条应把侧栏拖宽（${paneBefore} → ${paneAfter}）`);
    assert(
      companionLeft() > cBefore + 50,
      `侧栏拖宽后立绘应跟着往右（${cBefore} → ${companionLeft()}）`,
    );
    assert(
      Math.abs(companionLeft() - cBefore - (editorLeft() - eBefore)) <= 20,
      "拖宽时立绘挪的幅度应当和编辑区一致",
    );
    hugsLeftEdge("拖宽后");

    // ④ 再拖窄 → 同样要跟
    const cBefore2 = companionLeft();
    await dragSplitter(-100);
    assert(companionLeft() < cBefore2 - 30, `侧栏拖窄后立绘应跟着往左（${cBefore2} → ${companionLeft()}）`);
    hugsLeftEdge("拖窄后");

    // 停在「侧栏收起」这一态出图：位移最大，一眼能看出人跟着侧栏走了
    useStore.getState().toggleSidebar();
    await wait(250);
    assert(companionLeft() < 60, `侧栏收起后立绘应贴到窗口左缘（实际 ${companionLeft()}）`);
    hugsLeftEdge("出图时（侧栏已收起）");
  }

  send("SHOT: companion-collapsed-sidebar");
  await wait();

  /* ---------------- 3. 隐藏立绘不影响挂件 ---------------- */
  {
    useStore.getState().toggleCompanion();
    await wait(200);
    assert(!companion(), "关掉后立绘应当消失");
    assert(document.querySelector(".pw-root"), "关掉立绘不该影响右下角的挂件");

    useStore.getState().toggleCompanion();
    await wait(200);
    assert(companion(), "再开一次应当回来");
  }

  send("PASS: 伴读立绘 站左侧 / 贴编辑区左缘 / 跟随左侧栏收起·展开·拖宽·拖窄");
}

run().catch((error) => send(`FAIL: ${error.message ?? error}\n${error.stack ?? ""}`));
