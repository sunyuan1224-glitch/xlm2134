import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { useStore } from "../src/store";
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

  send("SHOT: default");
  await wait();
  const viewMenu = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")].find((b) => b.textContent?.trim() === "视图")!;
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
  send("SHOT: settings");
  await wait();
  send("PASS: pink-white theme, default empty right edge, source/workbench menus, typography dialog");
}
run().catch((error) => send(`FAIL: ${error.message ?? error}\n${error.stack ?? ""}`));
