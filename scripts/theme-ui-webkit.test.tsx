import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { useStore } from "../src/store";
import { api } from "../src/api";
import { getTheme } from "../src/lib/theme";
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
   * 菜单之间的过渡：现在是**故意**有动画的（在菜单之间滑过去 + 打开时淡入一次）。
   *
   * 这里原先恰好相反——断言「不许有过渡、不许有动画、一帧内必须到位」，理由是
   * WebKitGTK 只给 31fps，动画刚起步就被下一次悬停打断，看着卡。换到 Electron 之后
   * 那个前提没了，所以这条回归也跟着反过来：要验的不再是「没有动画」，而是
   * 「内容立刻切换、面板确实在滑动、并且滑到位」。
   */
  {
    const roots = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")];
    assert(roots.length >= 2, `菜单栏至少该有两个菜单，实际 ${roots.length}`);
    roots[0].click();
    await wait();
    const pop = document.querySelector<HTMLElement>(".menu-pop");
    assert(pop, "点开第一个菜单后应该有面板");

    const style = getComputedStyle(pop!);
    assert(
      /transform/.test(style.transitionProperty) && parseFloat(style.transitionDuration) > 0,
      `菜单面板应当有 transform 过渡（否则切换时滑不动），实际 property=${style.transitionProperty} duration=${style.transitionDuration}`,
    );
    assert(style.animationName !== "none", "菜单打开时应当有一次淡入");
    // 菜单栏按钮本身仍然不做过渡 —— 这条没变，别顺手给它加上
    const rootTransition = getComputedStyle(roots[0]).transitionDuration;
    assert(rootTransition === "0s", `菜单栏按钮不该有过渡，实际 ${rootTransition}`);

    const before = pop!.getBoundingClientRect();
    const firstContent = pop!.textContent;
    const wantLeft = roots[1].getBoundingClientRect().left;

    // React 的 onMouseEnter 建在 mouseout/mouseover 上，所以这里按浏览器的真实顺序发一对：
    // 先从第一个菜单 out 到第二个（relatedTarget 指明去处），再 over 第二个（指明来处）。
    roots[0].dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: roots[1] }));
    roots[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: roots[0] }));


    /*
     * ⚠️ 「过渡中间那一帧的面板位置」这一层**在这个测试环境里验不了**，别在这儿断言：
     * 实测这个 WebKitGTK 里 transform 过渡根本不跑（面板瞬移到位；直接写 style 也一样），
     * 连对照 div 的 opacity 过渡也只走了一帧就跳完。也就是说这套夹具只能验
     * 「过渡声明存在」和「最终落点对不对」，验不了「动得顺不顺」。
     * 流畅度是在 Electron（Chromium）里量的：scripts/ 下没有对应脚本，
     * 结论记在 README 的「渲染帧率」一节。
     */
    // 内容仍应「立刻」切换：给一帧让 React 把重渲染落下来
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    assert(pop!.textContent !== firstContent, "悬停到第二个菜单时面板内容应立刻切换");

    // 过渡走完 → 准确落在第二个菜单正下方
    await wait(300);
    const after = pop!.getBoundingClientRect();
    assert(
      Math.abs(after.left - wantLeft) <= 2,
      `过渡结束后面板应落在第二个菜单正下方（期望 ${Math.round(wantLeft)}，实际 ${Math.round(after.left)}）`,
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
  // 右侧「小说工作台」整块已移除：视图菜单里不该再留下这个入口（右缘为空的断言在上面）
  assert(
    ![...document.querySelectorAll(".menu-item")].some((i) => i.textContent?.includes("工作台")),
    "视图菜单里不该再有「小说工作台」入口",
  );
  viewMenu.click(); // 收起，交回下面的流程
  await wait();
  click(".menu-root", "主题");
  await wait();
  assert(
    (document.querySelector(".menu-pop")?.textContent ?? "").includes("粉白"),
    "Theme menu must list the palettes",
  );
  click(".menu-item", "字体与排版…");
  await wait();
  assert(document.querySelector(".settings-mask"), "Typography must remain available in theme menu");

  /*
   * 弹窗右下角的小人：与右下角挂件换成同一张图，并且整块待在弹窗**右侧之外**、
   * 与边框留出间隙（原来那张 dialog-thinker 是骑在边框上的）。
   */
  {
    const thinker = document.querySelector<HTMLImageElement>(".modal-thinker");
    assert(thinker, "弹窗右下角应当有思考角色");
    if (!thinker!.complete) {
      await new Promise<void>((resolve) => {
        thinker!.addEventListener("load", () => resolve(), { once: true });
        setTimeout(resolve, 2000);
      });
    }
    const ratio = thinker!.naturalWidth / thinker!.naturalHeight;
    assert(
      Number.isFinite(ratio) && Math.abs(ratio - 1) < 0.02,
      `应当用新的方形挂件角色图（旧的 dialog-thinker 是 603×771，比例 0.78），实际 ${thinker!.naturalWidth}×${thinker!.naturalHeight}`,
    );
    const modal = document.querySelector<HTMLElement>(".modal");
    assert(modal, "应当有弹窗");
    const tr = thinker!.getBoundingClientRect();
    const mr = modal!.getBoundingClientRect();
    assert(
      tr.left >= mr.right + 6,
      `小人应当整块在弹窗右侧之外、与边框留缝（弹窗右缘 ${Math.round(mr.right)}，小人左缘 ${Math.round(tr.left)}）`,
    );
    assert(
      tr.right <= window.innerWidth && tr.bottom <= window.innerHeight && tr.top >= 0,
      `小人应当完整落在窗口内（right ${Math.round(tr.right)} / innerWidth ${window.innerWidth}）`,
    );
  }

  /* ---------------- 字体下拉（Word 式 + 可搜索）与「滑块移除」 ---------------- */

  /* ---------------- 主题切换：粉白 ⇄ 暗色，纸面必须跟着变 ---------------- */
  {
    const rgbOf = (css: string) => (css.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const paper = () => {
      for (const sel of [".cm-editor", ".cm-content", ".cm-scroller"]) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) continue;
        const bg = getComputedStyle(el).backgroundColor;
        if (!/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
      }
      return "transparent";
    };
    const dark = (css: string) => Math.max(...rgbOf(css)) < 90;
    const light = (css: string) => Math.min(...rgbOf(css)) > 200;

    const themeMenu = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")].find(
      (b) => b.textContent?.trim() === "主题",
    )!;
    const itemOf = (label: string) =>
      [...document.querySelectorAll<HTMLElement>(".menu-item")].find((i) => (i.textContent ?? "").includes(label));

    assert(getTheme() === "light", `默认主题应为 light，实际 ${getTheme()}`);
    assert(light(paper()), `粉白下纸面应是浅色，实际 ${paper()}`);

    themeMenu.click();
    await wait();
    assert(itemOf("粉白") && itemOf("暗色"), "主题菜单里应该有「粉白」与「暗色」两项");
    itemOf("暗色")!.click();
    await wait(300);
    assert(document.documentElement.dataset.theme === "dark", "切到暗色后 <html data-theme> 应为 dark");
    assert(dark(paper()), `暗色下纸面必须变深（R/G/B 都要 < 90），实际 ${paper()}`);
    const menubarBg = getComputedStyle(document.querySelector<HTMLElement>(".menubar")!).backgroundColor;
    assert(dark(menubarBg), `暗色下面板也该变深，实际 ${menubarBg}`);
    send("SHOT: dark");
    await wait(300);

    themeMenu.click();
    await wait();
    itemOf("粉白")!.click();
    await wait(300);
    assert(document.documentElement.dataset.theme === "light", "切回粉白后应为 light");
    assert(light(paper()), `切回后纸面应恢复浅色，实际 ${paper()}`);
  }
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
  send("PASS: pink-white theme, default empty right edge, source menu, typography dialog");
}
run().catch((error) => send(`FAIL: ${error.message ?? error}\n${error.stack ?? ""}`));
