/*
 * 右侧滚动条「拖动跟不跟手」的性能探针（真实 GTK/WebKit，不碰真实工作区）。
 *
 * 为什么要单独量：用户报的是「拖右侧滑动条，光标下去了、条还没下去」——这是手感问题，
 * 用眼睛看不出量化差异，也说不清是「CSS 慢」还是「CodeMirror 每帧重建」。所以这里挂上
 * 真实 App + 真实长章节（约 8 万字 / 2400 行），用**程序化拖动滚动条**复现：
 *
 *   每一帧把 scroller.scrollTop 设到这一帧该在的位置（＝手指拖到哪），
 *   下一帧读回真实 scrollTop 并和请求值比对。两者不一致说明「有人在中途改了滚动位置」。
 *   同时记录逐帧 rAF 间隔（间隔大＝主线程被别的活占住）、以及总高 scrollHeight 怎么变。
 *
 * 三个工况对比，用来定位：
 *   1) 即时预览（默认）：能看出预览渲染有没有额外代价；
 *   2) 源码模式（同样的文档、同样的编辑器，只是没有预览装饰）：
 *      如果两边一样糟，问题就不在预览渲染，而在「CodeMirror 对总高的估算」；
 *   3) 拉丁文对照（同样段落数、同样字符量的英文正文）：
 *      如果英文不再抽风，说明这是「中文正文 + 换行」特有的估算偏差。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import App from "../src/App";
import { useStore } from "../src/store";
import { api, type FileNode } from "../src/api";
import "../src/styles.css";
import "../src/shell.css";

const send = (text: string) => (window as any).webkit.messageHandlers.result.postMessage(text);
const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const ROOT = "/scroll-perf";
const BOOK = "书";
const C1 = `${BOOK}/001-长篇.md`;
const C2 = `${BOOK}/002-latin.md`;
const PARA_COUNT = 1200;

/** 一篇「几万字」的中文手稿：段与段之间留空行，和真实写法一致 */
function buildLongDoc(paras: number): string {
  const out = ["# 第一章 长篇", ""];
  for (let i = 0; i < paras; i++) {
    out.push(
      `第 ${i + 1} 段。这是一段用来撑起滚动条长度的正文，字数不多不少，` +
        `正好让它在稿纸上占上两三行，带一点标点，好让预览渲染真的做点事。`,
    );
    out.push("");
  }
  return out.join("\n");
}

/** 对照组：同样段数、每段同样长度的拉丁文正文 */
function buildLatinDoc(paras: number): string {
  const out = ["# Chapter One", ""];
  const para =
    "This paragraph exists only to make the scrollbar long enough, with a few words in it so that the preview renderer has something to do. ";
  for (let i = 0; i < paras; i++) {
    out.push(para);
    out.push("");
  }
  return out.join("\n");
}

const DOC = buildLongDoc(PARA_COUNT);
const LATIN = buildLatinDoc(PARA_COUNT);
const memFiles = new Map<string, string>([
  [C1, DOC],
  [C2, LATIN],
]);

function installApiMocks() {
  const a = api as unknown as Record<string, (...args: any[]) => Promise<any>>;
  a.scan = async () => ({
    root: ROOT,
    tree: [
      {
        path: BOOK,
        name: BOOK,
        is_dir: true,
        children: [
          { path: C1, name: "001-长篇.md", is_dir: false, children: [] },
          { path: C2, name: "002-latin.md", is_dir: false, children: [] },
        ],
      } as FileNode,
    ],
    files: [...memFiles.keys()],
  });
  a.readFile = async (_root: string, path: string) =>
    memFiles.has(path) ? { path, content: memFiles.get(path)! } : null;
  a.writeFile = async (_root: string, path: string, content: string) => {
    memFiles.set(path, content);
  };
  a.readSidecar = async () => null;
  a.writeSidecar = async () => {};
  a.readImageDataUrl = async () => null;
  a.listFonts = async () => [];
}

interface Sweep {
  /** 逐帧 rAF 间隔（ms） */
  gaps: number[];
  /** 每帧「上帧请求的位置」vs「本帧读回的真实位置」的偏差（px） */
  drift: number[];
  /** 每 10 帧记一次 scrollTop → scrollHeight，看总高是不是随着往下滚一路长 */
  heights: [number, number][];
  scrollHeightBefore: number;
  scrollHeightAfter: number;
  /** 视口里真的建出来的预览块数量（拖动过程中反复建/拆 DOM 的规模） */
  widgets: number;
  lines: number;
}

/** 模拟一次「从当前位置拖到底」：每帧把滚动位置推到该到的地方 */
async function dragSweep(scroller: HTMLElement, frames: number): Promise<Sweep> {
  const max = scroller.scrollHeight - scroller.clientHeight;
  const from = scroller.scrollTop;
  const gaps: number[] = [];
  const drift: number[] = [];
  const heights: [number, number][] = [];
  const heightBefore = scroller.scrollHeight;
  heights.push([Math.round(from), heightBefore]);
  let requested = from;
  let last = performance.now();

  await new Promise<void>((resolve) => {
    let i = 0;
    const step = () => {
      const now = performance.now();
      if (i > 0) gaps.push(now - last);
      last = now;
      // 上一帧请求之后，真实位置有没有被别人改掉（CodeMirror 重算行高就会改）
      if (i > 0) drift.push(Math.abs(scroller.scrollTop - requested));
      if (i % 10 === 0) heights.push([requested, scroller.scrollHeight]);
      const t = Math.min(1, i / frames);
      requested = Math.round(from + (max - from) * t);
      scroller.scrollTop = requested;
      if (++i <= frames) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });

  await wait(200);
  return {
    gaps,
    drift,
    heights,
    scrollHeightBefore: heightBefore,
    scrollHeightAfter: scroller.scrollHeight,
    widgets: document.querySelectorAll(".cm-lp-rendered").length,
    lines: document.querySelectorAll(".cm-line").length,
  };
}

function pct(list: number[], p: number): number {
  if (list.length === 0) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function summary(label: string, s: Sweep): string {
  const avg = s.gaps.reduce((a, b) => a + b, 0) / Math.max(1, s.gaps.length);
  return (
    `${label}: 帧间隔 avg=${avg.toFixed(1)} p95=${pct(s.gaps, 95).toFixed(1)} max=${Math.max(0, ...s.gaps).toFixed(1)}ms ` +
    `超过32ms=${s.gaps.filter((g) => g > 32).length}帧 ` +
    `| 位置偏差 max=${Math.max(0, ...s.drift).toFixed(1)}px 累计=${s.drift.reduce((a, b) => a + b, 0).toFixed(0)}px ` +
    `| scrollHeight ${s.scrollHeightBefore}→${s.scrollHeightAfter} ` +
    `| 总高序列 [${s.heights.map(([y, h]) => `${y}:${h}`).join(" ")}] ` +
    `| 视口内 .cm-line=${s.lines} .cm-lp-rendered=${s.widgets}`
  );
}

/** 关键几何：CM 的高度估算全靠这几个量，量出来才知道估偏了多少 */
function geometry(label: string): string {
  const scroller = document.querySelector<HTMLElement>(".cm-scroller")!;
  const content = document.querySelector<HTMLElement>(".cm-content")!;
  const line = document.querySelector<HTMLElement>(".cm-line")!;
  const cs = getComputedStyle(line);
  const heights = [...document.querySelectorAll<HTMLElement>(".cm-line")]
    .slice(0, 6)
    .map((el) => `${el.textContent!.length}字/${Math.round(el.getBoundingClientRect().height)}px`)
    .join(" ");
  // 直接读 CodeMirror 内部的 HeightOracle：它拿什么字宽/行高估屏幕外的高度，一目了然
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-content")!);
  const o = (view as any)?.viewState?.heightOracle;
  const oracle = o
    ? `oracle[lineWrapping=${o.lineWrapping} lineHeight=${o.lineHeight?.toFixed(1)} charWidth=${o.charWidth?.toFixed(1)} lineLength=${o.lineLength?.toFixed(1)}]`
    : "oracle[拿不到]";
  return (
    `${label}: 中文校准=${document.querySelector(".editor-host.cm-cjk-wrap") ? "开" : "关"} ` +
    `fontSize=${cs.fontSize} lineHeight=${cs.lineHeight} 换行=${cs.whiteSpace} ` +
    `contentWidth=${content.clientWidth} scroller=${scroller.clientWidth}×${scroller.clientHeight} ` +
    `前 6 行[${heights}] ${oracle}`
  );
}

async function run() {
  installApiMocks();
  useStore.setState({
    root: ROOT,
    files: [C1, C2],
    tree: [
      {
        path: BOOK,
        name: BOOK,
        is_dir: true,
        children: [
          { path: C1, name: "001-长篇.md", is_dir: false, children: [] },
          { path: C2, name: "002-latin.md", is_dir: false, children: [] },
        ],
      } as FileNode,
    ],
    expanded: new Set([BOOK]),
    chapters: [
      { path: C1, name: "001-长篇.md", title: "第一章 长篇", status: "草稿", summary: "", words: 60000 },
      { path: C2, name: "002-latin.md", title: "Chapter One", status: "草稿", summary: "", words: 25000 },
    ],
    contents: { [C1]: DOC, [C2]: LATIN },
    openTabs: [C1, C2],
    activePath: C1,
    volumes: [],
    chapterOrder: {},
    flippedBooks: [],
    sidebarTab: "files",
    sidebarOpen: true,
    sourceMode: false,
    focusMode: false,
    typewriterMode: false,
  });
  createRoot(document.getElementById("root")!).render(<App />);
  await wait(400);

  const scroller = document.querySelector<HTMLElement>(".cm-scroller");
  if (!scroller) {
    send("FAIL: 编辑器没有挂载起来，探针跑不了");
    return;
  }
  send(
    `NOTE: 中文文档 ${DOC.length} 字符 / ${DOC.split("\n").length} 行，` +
      `拉丁对照 ${LATIN.length} 字符，滚动区 ${scroller.scrollHeight}px（可视 ${scroller.clientHeight}px）`,
  );
  // 先空转 2.5s：总高到底是「一开始就定死」还是「越滚越长」，这两者修法完全不同
  const h0 = scroller.scrollHeight;
  await wait(2500);
  send(`NOTE: 空闲 2.5s 后 scrollHeight ${h0} → ${scroller.scrollHeight}（无人操作）`);
  send(`NOTE: ${geometry("几何/即时预览")}`);

  const preview = await dragSweep(scroller, 100);
  send(`NOTE: ${summary("即时预览", preview)}`);

  scroller.scrollTop = 0;
  await wait(200);
  useStore.setState({ sourceMode: true });
  await wait(300);
  const source = await dragSweep(scroller, 100);
  send(`NOTE: ${summary("源码模式", source)}`);
  send(`NOTE: ${geometry("几何/源码模式")}`);

  /*
   * 对照组：换一个文件（Editor 按 path 建 key，会整台重建，高度图也从零开始），
   * 内容是「同样段落数、同样字符量的拉丁文正文」。这样才看得出「中文」是不是变量。
   */
  useStore.setState({ sourceMode: false });
  await wait(200);
  await useStore.getState().openFile(C2);
  await wait(500);
  const sc2 = document.querySelector<HTMLElement>(".cm-scroller")!;
  send(`NOTE: ${geometry("几何/拉丁对照")}`);
  const latin = await dragSweep(sc2, 100);
  send(`NOTE: ${summary("拉丁对照", latin)}`);

  /*
   * 判定：拖动时滚动位置不许被反复纠正（位置偏差），帧间隔不许掉进肉眼可见的卡顿档。
   * scrollHeight 在拖动过程中变化 = 总高被重算，滑动条本身就会跑。
   */
  const problems: string[] = [];
  const check = (label: string, s: Sweep) => {
    const maxDrift = Math.max(0, ...s.drift);
    const totalDrift = s.drift.reduce((a, b) => a + b, 0);
    const p95 = pct(s.gaps, 95);
    const maxGap = Math.max(0, ...s.gaps);
    const grow = Math.abs(s.scrollHeightAfter - s.scrollHeightBefore);
    if (maxDrift > 2) problems.push(`${label}: 单帧滚动位置偏了 ${maxDrift.toFixed(1)}px`);
    if (totalDrift > 40) problems.push(`${label}: 滚动位置累计偏了 ${totalDrift.toFixed(0)}px`);
    if (p95 > 32) problems.push(`${label}: 帧间隔 p95=${p95.toFixed(1)}ms`);
    if (maxGap > 60) problems.push(`${label}: 最长帧间隔 ${maxGap.toFixed(1)}ms`);
    if (grow > s.scrollHeightBefore * 0.01)
      problems.push(`${label}: 拖动中 scrollHeight 变了 ${grow}px（初始 ${s.scrollHeightBefore}）`);
  };
  check("即时预览", preview);
  check("源码模式", source);

  if (problems.length) send(`FAIL: 拖动滚动条不跟手 —— ${problems.join("；")}`);
  else send("PASS: 拖动滚动条内容跟手（滚动位置稳定、帧间隔无卡顿）");
}

run().catch((error) => send(`FAIL: ${error?.message ?? error}\n${error?.stack ?? ""}`));
