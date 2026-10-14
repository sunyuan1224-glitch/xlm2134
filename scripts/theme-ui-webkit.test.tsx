import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { useStore } from "../src/store";
import { api } from "../src/api";
import "../src/main";

const send = (text: string) => (window as any).webkit.messageHandlers.result.postMessage(text);
const wait = () => new Promise((resolve) => setTimeout(resolve, 200));
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
function click(selector: string, label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((b) => b.textContent?.includes(label));
  assert(button, `Missing button: ${label}; available: ${[...document.querySelectorAll(selector)].map((b) => b.textContent?.trim()).join(" | ")}`);
  button!.click();
}
async function run() {
  // Isolated in-memory fixture: never read or write a real workspace.
  useStore.setState({
  root: "/theme-fixture",
    workbenchOpen: false,
    files: ["第一章.md"],
    tree: [{ path: "第一章.md", name: "第一章.md", is_dir: false, children: [] }],
    openTabs: ["第一章.md"],
    activePath: "第一章.md",
    contents: { "第一章.md": "# 春日来信\n\n窗外的花开了。她推开窗，让清晨的风轻轻穿过书页。\n\n**新的章节**，从这里开始。\n\n```ts\nconst message = 'hello';\n```\n" },
  });
  createRoot(document.getElementById("root")!).render(<App />);
  // 字体下拉的数据源：测试里给三款假字体（真实环境由 Tauri 命令 fc-list 提供）
  (api as unknown as Record<string, unknown>).listFonts = async () => ["思源黑体 CN", "Noto Sans", "霞鹜文楷"];
  await wait();
  assert(getComputedStyle(document.documentElement).getPropertyValue("--bg-panel").trim() === "#fbeef3", "Pink-white stylesheet must be loaded");
  assert(!document.querySelector(".pane-right, .pane-handle-right"), "Default right edge must be empty");
  assert(!document.querySelector(".menubar-right button"), "No repeated top-right controls");
  assert(document.querySelector(".cm-editor"), "Editor must render");

  // 回归：反复点「文件 / 大纲 / 搜索」标签（双击、连点都算）一律不收起侧栏。
  // 每一击之后都要立刻断言——否则「先收起再展开」的两连击会被漏掉。
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button")];
  const tab = (label: string) => tabs.find((b) => b.textContent?.includes(label))!;
  const searchBtn = document.querySelector<HTMLButtonElement>(".sidebar-search-btn")!;
  const clicks: HTMLButtonElement[] = [
    tab("文件"),
    tab("文件"),
    tab("大纲"),
    tab("大纲"),
    tab("大纲"),
    searchBtn,
    searchBtn,
    tab("文件"),
  ];
  for (const button of clicks) {
    button.click();
    await wait(60);
    assert(useStore.getState().sidebarOpen, "Clicking a sidebar tab must never collapse the sidebar");
    assert(document.querySelector(".sidebar-capsule"), "Sidebar must stay mounted while clicking its tabs");
  }
  await wait();

  /*
   * 回归：菜单之间切换必须「瞬时」——不许有过渡/动画，且一帧之内就到位。
   *
   * 这条盯的是曾经的 sliding 设计：面板用 transform 过渡滑到下一个菜单下面，配着
   * MenuBar 里的双 requestAnimationFrame 状态机。光标快速扫过菜单栏时动画刚起步就被
   * 打断，看起来卡顿；而且每帧都要重新合成一次带阴影的面板。现在要求：内容立刻换、
   * 位置一帧到位、面板和菜单栏按钮的 computed 过渡时长都是 0s。
   */
  {
    const roots = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")];
    assert(roots.length >= 2, `菜单栏至少该有两个菜单，实际 ${roots.length}`);
    roots[0].click();
    await wait();
    const pop = document.querySelector<HTMLElement>(".menu-pop");
    assert(pop, "点开第一个菜单后应该有面板");
    const panelTransition = getComputedStyle(pop!).transitionDuration;
    assert(panelTransition === "0s", `菜单面板不该有过渡，实际 transition-duration: ${panelTransition}`);
    const panelAnimation = getComputedStyle(pop!).animationName;
    assert(panelAnimation === "none", `菜单面板不该有动画，实际 animation-name: ${panelAnimation}`);
    const rootTransition = getComputedStyle(roots[0]).transitionDuration;
    assert(rootTransition === "0s", `菜单栏按钮不该有过渡，实际 transition-duration: ${rootTransition}`);

    const before = pop!.getBoundingClientRect();
    const firstContent = pop!.textContent;
    // React 的 onMouseEnter 建在 mouseout/mouseover 上，所以这里按浏览器的真实顺序发一对：
    // 先从第一个菜单 out 到第二个（relatedTarget 指明去处），再 over 第二个（指明来处）。
    roots[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: roots[1] }));
    roots[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: roots[0] }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); // 只给一帧
    const after = pop!.getBoundingClientRect();
    assert(pop!.textContent !== firstContent, "悬停到第二个菜单时面板内容应立刻切换");
    const wantLeft = document.querySelectorAll<HTMLButtonElement>(".menu-root")[1].getBoundingClientRect().left;
    assert(
      Math.abs(after.left - wantLeft) <= 2,
      `面板应在一帧内落到第二个菜单正下方（期望约 ${Math.round(wantLeft)}，实际 ${Math.round(after.left)}）`,
    );
    assert(after.left !== before.left, "面板位置确实变了（否则这条用例没验到切换）");

    // 再点一次同一个菜单 → 收起
    roots[1].click();
    await wait(60);
    assert(!document.querySelector(".menu-pop"), "再次点击同一个菜单应把面板收起");
  }

  /*
   * 回归：放大字号必须带着标题一起放大。
   *
   * 曾经预览里的标题写的是 rem —— rem 相对 html 根字号，而根字号并不随「字号」设置变化，
   * 于是放大正文（--editor-font-size）后标题尺寸纹丝不动，h2/h3 反而比正文还小。
   * 现在标题用 em，必须与正文同比例缩放，且任何字号下都不得小于正文。
   *
   * 注意：标题行是「当前行」时按源码显示（.cm-tk-h1），挪开光标后才渲染成
   * .cm-lp-rendered 里的 <h1> —— rem 的坑就在后者，所以用例必须先把光标挪走。
   */
  {
    const px = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      assert(el, `量字号时找不到 ${selector}`);
      return Number.parseFloat(getComputedStyle(el!).fontSize);
    };
    const zoom = (key: string) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );

    for (let i = 0; i < 2; i++) {
      document
        .querySelector(".cm-content")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await wait(80);
    }

    const bodyBefore = px(".cm-content");
    const h1Before = px(".cm-lp-rendered h1");
    assert(h1Before > bodyBefore, `一级标题必须大于正文（标题 ${h1Before}px / 正文 ${bodyBefore}px）`);

    zoom("=");
    await wait(60);
    zoom("=");
    await wait(60);

    const bodyAfter = px(".cm-content");
    const h1After = px(".cm-lp-rendered h1");
    assert(bodyAfter > bodyBefore, `放大字号应生效（前 ${bodyBefore}px / 后 ${bodyAfter}px）`);
    assert(h1After > h1Before, `标题必须跟着放大（前 ${h1Before}px / 后 ${h1After}px）`);
    assert(h1After > bodyAfter, `放大后标题仍须大于正文（标题 ${h1After}px / 正文 ${bodyAfter}px）`);
    const ratio = h1After / bodyAfter;
    assert(Math.abs(ratio - 1.5) < 0.1, `标题与正文的比例应保持约 1.5，实际 ${ratio.toFixed(2)}`);

    // 还原字号，免得影响后面的截图
    zoom("-");
    await wait(40);
    zoom("-");
    await wait(40);
    assert(Math.abs(px(".cm-content") - bodyBefore) < 0.6, "字号应已还原到起点");
  }

  /* ---------------- 字号菜单：改名 + 连点不关菜单 + Ctrl+滚轮 ---------------- */
  {
    const vm = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")].find(
      (b) => b.textContent?.trim() === "视图",
    )!;
    const size = () =>
      Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".cm-content")!).fontSize);
    const items = () => [...document.querySelectorAll<HTMLElement>(".menu-item")];

    vm.click();
    await wait();
    assert(items().some((i) => (i.textContent ?? "").includes("还原默认")), "「实际大小」应改名为「还原默认」");
    assert(!items().some((i) => (i.textContent ?? "").includes("实际大小")), "不该再出现「实际大小」");

    const before = size();
    items().find((i) => (i.textContent ?? "").includes("放大字号"))!.click();
    await wait(150);
    assert(document.querySelector(".menu-pop"), "点「放大字号」后菜单不该关（要能连点调）");
    assert(size() > before, `放大字号应生效（${before} → ${size()}）`);
    items().find((i) => (i.textContent ?? "").includes("缩小字号"))!.click();
    await wait(150);
    assert(Math.abs(size() - before) < 0.6, `缩小字号应回到原值（现在 ${size()}）`);

    vm.click(); // 收起
    await wait();

    // Ctrl + 滚轮：上滑放大、下滑缩小
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(150);
    assert(size() > before, `Ctrl+滚轮上滑应放大（${before} → ${size()}）`);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(150);
    assert(Math.abs(size() - before) < 0.6, `Ctrl+滚轮下滑应缩回（现在 ${size()}）`);
  }

  send("SHOT: default");
  await wait();
  const viewMenu = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")].find((b) => b.textContent?.trim() === "视图")!;

  // 回归：视图菜单里不再有「大纲（纲要）」入口 —— 大纲统一走左侧栏标签，菜单里不再重复一份
  viewMenu.click();
  await wait();
  assert(
    ![...document.querySelectorAll(".menu-item")].some((i) => i.textContent?.includes("大纲")),
    "视图菜单里不该再有「大纲」入口",
  );
  assert(
    [...document.querySelectorAll(".sidebar-tab")].some((t) => t.textContent?.includes("大纲")),
    "大纲的入口应该留在左侧栏标签上",
  );
  viewMenu.click(); // 收起，交回下面的流程
  await wait();

  viewMenu.click();
  await wait();
  click(".menu-item", "源码模式");
  await wait();
  assert(useStore.getState().sourceMode, "View menu must enable source mode");
  send("SHOT: source");
  await wait();
  viewMenu.click();
  await wait();
  click(".menu-item", "小说工作台（右栏）");
  await wait();
  if (!useStore.getState().workbenchOpen) {
    viewMenu.click();
    await wait();
    click(".menu-item", "小说工作台（右栏）");
    await wait();
  }
  assert(document.querySelector(".pane-right"), "View menu must open workbench");
  send("SHOT: workbench");
  await wait();
  viewMenu.click();
  await wait();
  click(".menu-item.on", "小说工作台（右栏）");
  await wait();
  assert(!document.querySelector(".pane-right, .pane-handle-right"), "Closing workbench must leave no placeholder");
  click(".menu-root", "主题");
  await wait();
  assert(document.querySelector(".menu-pop")?.textContent?.includes("粉白（当前）"), "Theme menu must name current palette");
  click(".menu-item", "字体与排版…");
  await wait();
  assert(document.querySelector(".settings-mask"), "Typography must remain available in theme menu");

  /* ---------------- 字体下拉（Word 式 + 可搜索）与「滑块移除」 ---------------- */
  {
    assert(document.querySelector(".font-combo"), "设置里应该有字体下拉");
    // 只去掉「字号」那个滑块；行距的滑块保留，所以按行精确检查
    const sizeRow = document.querySelector(".set-num")?.closest(".set-row");
    assert(sizeRow, "字号那一行应该还在（数值输入 + 加减按钮）");
    assert(!sizeRow!.querySelector('input[type="range"]'), "字号那一行不该再有滑块");
    document.querySelector<HTMLElement>(".font-combo")!.click();
    await wait(250);
    const optNames = () =>
      [...document.querySelectorAll<HTMLElement>(".font-opt")].map((o) => (o.textContent ?? "").trim());
    assert(optNames().includes("主题默认"), `下拉第一项该是「主题默认」，实际：${optNames().join(" | ")}`);
    assert(optNames().includes("思源黑体 CN"), `下拉该列出本机字体，实际：${optNames().join(" | ")}`);

    const search = document.querySelector<HTMLInputElement>(".font-search");
    assert(search, "下拉里应该有搜索框");
    // React 受控输入：直接赋 value 不会触发 onChange，必须走原生 setter 再发 input
    const setInputValue = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setInputValue(search!, "思源");
    await wait(200);
    assert(optNames().includes("思源黑体 CN"), "搜索应保留匹配项");
    assert(!optNames().includes("Noto Sans"), `搜索应过滤掉不匹配项，实际：${optNames().join(" | ")}`);

    [...document.querySelectorAll<HTMLElement>(".font-opt")]
      .find((o) => (o.textContent ?? "").trim() === "思源黑体 CN")!
      .click();
    await wait(200);
    assert(!document.querySelector(".font-drop"), "选完应收起下拉");
    assert(
      (document.querySelector(".font-combo-name")?.textContent ?? "").includes("思源黑体 CN"),
      `下拉框应显示所选字体名，实际 ${document.querySelector(".font-combo-name")?.textContent}`,
    );
  }

  send("SHOT: settings");
  await wait();
  send("PASS: pink-white theme, default empty right edge, source/workbench menus, typography dialog");
}
run().catch((error) => send(`FAIL: ${error.message ?? error}\n${error.stack ?? ""}`));
