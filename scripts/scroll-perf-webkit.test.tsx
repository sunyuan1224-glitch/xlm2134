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
import {
  textUnits,
  blockHint,
  estimateBlockHeight,
  readBlockMetrics,
  renderCacheSize,
  renderCacheStats,
} from "../src/editor/livePreview";
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
  /**
   * 扣掉「高度修正补偿」之后的残差（px）。
   * CodeMirror 量到新高度后会主动把滚动位置挪那么多，让屏幕上的内容**原地不动**
   * （上游 view 仓库 74e0e0e "Stabilize scroll position for height information changes"
   * 就是干这个的）。那部分位移是补偿、不是「内容不跟手」，判据只看补偿之外的残差。
   */
  lag: number[];
  /** 因为已经拖到底、位置被浏览器夹住（clamp）而不计入偏差的帧数 */
  clamped: number;
  /** 偏差大于 1px 的帧明细：[帧号, 请求位置, 实际位置, 当前最大可滚位置] */
  deviationDetail: [number, number, number, number][];
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
  const from = scroller.scrollTop;
  const gaps: number[] = [];
  const drift: number[] = [];
  const lag: number[] = [];
  let clamped = 0;
  const deviationDetail: [number, number, number, number][] = [];
  const heights: [number, number][] = [];
  const heightBefore = scroller.scrollHeight;
  heights.push([Math.round(from), heightBefore]);
  let requested = from;
  let last = performance.now();
  let prevHeight = scroller.scrollHeight;

  await new Promise<void>((resolve) => {
    let i = 0;
    const step = () => {
      const now = performance.now();
      if (i > 0) gaps.push(now - last);
      last = now;
      // 上一帧请求之后，真实位置有没有被别人改掉（CodeMirror 重算行高就会改）。
      // 已经顶到底（请求位置超过当前可滚范围）时浏览器会把位置夹回来，那是正常的滚动条行为，
      // 不是「内容跟不上」，单独计数，不混进偏差里。
      if (i > 0) {
        const liveMax = scroller.scrollHeight - scroller.clientHeight;
        if (requested > liveMax + 1) clamped++;
        else {
          const dev = Math.abs(scroller.scrollTop - requested);
          drift.push(dev);
          const heightDelta = Math.abs(scroller.scrollHeight - prevHeight);
          lag.push(Math.max(0, dev - heightDelta));
          if (dev > 1) deviationDetail.push([i, requested, scroller.scrollTop, liveMax]);
        }
      }
      prevHeight = scroller.scrollHeight;
      if (i % 10 === 0) heights.push([requested, scroller.scrollHeight]);
      // 每帧重算「最底」：总高在拖动过程中变长时，也要真的能拖到底
      const max = scroller.scrollHeight - scroller.clientHeight;
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
    lag,
    clamped,
    deviationDetail,
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
    `| 位置位移 max=${Math.max(0, ...s.drift).toFixed(1)}px（其中属高度补偿的已扣除）` +
    ` 残差 max=${Math.max(0, ...s.lag).toFixed(1)}px 累计=${s.lag.reduce((a, b) => a + b, 0).toFixed(0)}px ` +
    `（拖到底被夹住 ${s.clamped} 帧）` +
    (s.deviationDetail.length ? ` 偏差明细=[${s.deviationDetail.map(([i, q, a, m]) => `帧${i}: 请求${q} 实际${a} 上限${m}`).join(" | ")}]` : "") +
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

/** 把「未渲染块的估算」和「真量到的高度」摆在一起，用来校准估算公式 */
function calibration(label: string): string {
  const host = document.querySelector<HTMLElement>(".editor-host");
  const m = readBlockMetrics(host);
  const blocks = [...document.querySelectorAll<HTMLElement>(".cm-lp-rendered")];
  const rows = blocks
    .filter((el) => (el.textContent ?? "").length > 20)
    .slice(0, 4)
    .map((el) => {
      const raw = el.textContent ?? "";
      const real = Math.round(el.getBoundingClientRect().height);
      const est = m ? estimateBlockHeight(blockHint(raw), m) : -1;
      return `${raw.length}字 估${est}/实${real}`;
    });
  return `${label}: 可见渲染块 ${blocks.length} 个 [${rows.join(" | ")}] metrics=${m ? JSON.stringify(m) : "null"}`;
}

/**
 * 把整篇文档按块估一遍，和真实总高对账：
 * 估算合计（块 + 空行）应当 ≈ scrollHeight，差了就说明公式对这类块系统性偏了。
 */
function totals(label: string, scrollHeight: number): string {
  const st = useStore.getState();
  const path = st.activePath;
  const text = path ? st.contents[path] : undefined;
  const m = readBlockMetrics(document.querySelector(".editor-host"));
  if (text === undefined || !m) return `${label}: 拿不到正文或排版参数`;
  const lines = text.split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (line.trim()) buf.push(line);
    else if (buf.length) {
      blocks.push(buf.join("\n"));
      buf = [];
    }
  }
  if (buf.length) blocks.push(buf.join("\n"));
  const estSum = blocks.reduce((a, b) => a + estimateBlockHeight(blockHint(b), m), 0);
  const blanks = lines.filter((l) => !l.trim()).length;
  const lineBox = m.fontSize * m.lineHeight;
  return (
    `${label}: 块 ${blocks.length} 个 估算合计=${Math.round(estSum)} + 空行 ${blanks}×${lineBox.toFixed(1)}` +
    `=${Math.round(estSum + blanks * lineBox)}；实际 scrollHeight=${scrollHeight}`
  );
}

/**
 * 打字成本：每个键都会让即时预览重建一次装饰（→ 每个块都会问一次 estimatedHeight），
 * 量一下每键的同步开销，确认给 widget 加估算没有把打字的路径拖慢。
 */
/**
 * 「视觉/排版零变化」检查（源码模式）：逐行高度提示只该影响**没量到**的行的估算，
 * 已经画出来的行必须还是实测高度。这里直接拿 DOM 比：每一行的实际高度应当等于
 * 「这一行按字数折成几行 × 行盒」，任何被 widget 撑高的行都会露馅。
 */
function renderedLineHeights(label: string): { note: string; mismatch: number } {
  const host = document.querySelector<HTMLElement>(".editor-host");
  const m = readBlockMetrics(host);
  if (!m) return { note: `${label}: 拿不到排版参数`, mismatch: -1 };
  const lineBox = m.fontSize * m.lineHeight;
  const perLine = Math.max(1, m.textWidth / m.fontSize);
  const bad: string[] = [];
  let checked = 0;
  for (const el of document.querySelectorAll<HTMLElement>(".cm-line")) {
    const text = el.textContent ?? "";
    if (!text.length) continue; // 空行不参与（它的高度就是行盒，另有 geometry 那行看着）
    const expect = Math.max(1, Math.ceil(textUnits(text) / perLine)) * lineBox;
    const real = el.getBoundingClientRect().height;
    checked++;
    if (Math.abs(real - expect) > 1.5) {
      bad.push(`${text.length}字 实测${real.toFixed(1)}/应${expect.toFixed(1)}`);
    }
  }
  return {
    note:
      `${label}: 抽查 ${checked} 行，实测高度与「字数×行盒」对不上 ${bad.length} 行` +
      (bad.length ? ` —— ${bad.slice(0, 3).join(" | ")}` : "（widget 没有撑高任何一行）"),
    mismatch: bad.length,
  };
}

/**
 * 打字成本：每个键都会让即时预览重建一次装饰（→ 每个块都会问一次 estimatedHeight），
 * 量一下每键的同步开销，确认给 widget 加估算没有把打字的路径拖慢。
 */
function typingCost(label: string, n = 40, where: "end" | "middle" = "end"): string {
  const dom = document.querySelector<HTMLElement>(".cm-content");
  const v = dom ? EditorView.findFromDOM(dom) : null;
  if (!v) return `${label}: 拿不到 EditorView`;
  const end = v.state.doc.length;
  // 章末敲字：后面没有别的块，缓存该全中；章中敲字：后面的块整体位移 ——
  // 缓存键里带不带块位置，这两种情况的差别会直接暴露在数字上
  const at = where === "end" ? end : Math.floor(end / 2);
  const h0 = renderCacheStats.hits;
  const m0 = renderCacheStats.misses;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    v.dispatch({ changes: { from: at + i, insert: "字" } });
  }
  const t1 = performance.now();
  // 把刚敲的字删回去，别影响后面的用例
  v.dispatch({ changes: { from: at, to: at + n, insert: "" } });
  // 再量一次「只量排版参数」的开销（缓存生效时应当接近 0）
  const t2 = performance.now();
  for (let i = 0; i < 1000; i++) readBlockMetrics(document.querySelector(".editor-host"));
  const t3 = performance.now();
  // 以及「给所有块算一遍高度估算提示」的开销：这部分是本轮新加的，要确认只是零头
  const st = useStore.getState();
  const text = st.activePath ? st.contents[st.activePath] ?? "" : "";
  const paras = text.split(/\n{2,}/).filter(Boolean);
  const t4 = performance.now();
  for (let i = 0; i < 5; i++) for (const p of paras) blockHint(p);
  const t5 = performance.now();
  const hits = renderCacheStats.hits - h0;
  const misses = renderCacheStats.misses - m0;
  const rate = hits + misses > 0 ? ((hits / (hits + misses)) * 100).toFixed(1) + "%" : "—";
  return (
    `${label}（${where === "end" ? "章末" : "章中"}）: 连敲 ${n} 次平均 ${((t1 - t0) / n).toFixed(2)}ms/次；` +
    `渲染缓存 命中 ${hits} / 未命中 ${misses}（命中率 ${rate}，表内 ${renderCacheSize()} 条）；` +
    `读 1000 次排版参数 ${(t3 - t2).toFixed(2)}ms；` +
    `给 ${paras.length} 个块算估算提示 ${((t5 - t4) / 5).toFixed(2)}ms`
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
  send(`NOTE: ${calibration("估算校准/即时预览")}`);
  send(`NOTE: ${totals("对账/即时预览(初始估算)", scroller.scrollHeight)}`);
  send(`NOTE: ${typingCost("打字成本/即时预览")}`);
  send(`NOTE: ${typingCost("打字成本/即时预览", 40, "middle")}`);
  // 同一份文档切到源码模式再量一次：源码模式没有即时预览装饰，用来判断上面那份打字开销
  // 是不是来自预览块的重建（已知的「改文档 → 整篇块重渲染」路径，与本轮的高度估算无关）
  useStore.setState({ sourceMode: true });
  await wait(300);
  send(`NOTE: ${typingCost("打字成本/源码模式")}`);
  useStore.setState({ sourceMode: false });
  await wait(300);

  const preview = await dragSweep(scroller, 100);
  send(`NOTE: ${summary("即时预览", preview)}`);

  scroller.scrollTop = 0;
  await wait(200);
  useStore.setState({ sourceMode: true });
  await wait(300);
  const source = await dragSweep(scroller, 100);
  send(`NOTE: ${summary("源码模式", source)}`);
  send(`NOTE: ${geometry("几何/源码模式")}`);
  const lineCheck = renderedLineHeights("排版校验/源码模式");
  send(`NOTE: ${lineCheck.note}`);

  /*
   * 对照组：换一个文件（Editor 按 path 建 key，会整台重建，高度图也从零开始），
   * 内容是「同样段落数、同样字符量的拉丁文正文」。这样才看得出「中文」是不是变量。
   */
  useStore.setState({ sourceMode: false });
  await wait(200);
  // 先把编辑器卸掉再打开拉丁对照文件：否则是同一个 EditorView 换了文档，
  // 高度表会带着上一篇的量好的行，测不出「全新打开一份英文稿」的行为。
  useStore.setState({ activePath: null });
  await wait(300);
  await useStore.getState().openFile(C2);
  await wait(500);
  const sc2 = document.querySelector<HTMLElement>(".cm-scroller")!;
  send(`NOTE: ${geometry("几何/拉丁对照")}`);
  send(`NOTE: ${calibration("估算校准/拉丁对照")}`);
  send(`NOTE: ${totals("对账/拉丁对照(初始估算)", sc2.scrollHeight)}`);
  const latin = await dragSweep(sc2, 100);
  send(`NOTE: ${summary("拉丁对照", latin)}`);

  /*
   * 判定：拖动时滚动位置不许被反复纠正（位置偏差），帧间隔不许掉进肉眼可见的卡顿档。
   * scrollHeight 在拖动过程中变化 = 总高被重算，滑动条本身就会跑。
   */
  const problems: string[] = [];
  const check = (label: string, s: Sweep, maxGrowthRatio: number) => {
    const maxDrift = Math.max(0, ...s.lag);
    const totalDrift = s.lag.reduce((a, b) => a + b, 0);
    const p95 = pct(s.gaps, 95);
    const maxGap = Math.max(0, ...s.gaps);
    const grow = Math.abs(s.scrollHeightAfter - s.scrollHeightBefore);
    if (maxDrift > 2) problems.push(`${label}: 单帧位置残差 ${maxDrift.toFixed(1)}px`);
    if (totalDrift > 40) problems.push(`${label}: 位置残差累计 ${totalDrift.toFixed(0)}px`);
    if (p95 > 32) problems.push(`${label}: 帧间隔 p95=${p95.toFixed(1)}ms`);
    if (maxGap > 60) problems.push(`${label}: 最长帧间隔 ${maxGap.toFixed(1)}ms`);
    if (grow > s.scrollHeightBefore * maxGrowthRatio)
      problems.push(
        `${label}: 拖动中 scrollHeight 变了 ${grow}px（初始 ${s.scrollHeightBefore}，上限 ${(maxGrowthRatio * 100).toFixed(1)}%）`,
      );
  };
  /*
   * 判定：两个模式都要求总高变化 ≤5%（用户定的目标；改前分别是 41% 与 16%）。
   *  - 即时预览：整块渲染的块必须估准（否则屏幕外的高度被按一行算）；
   *  - 源码模式：逐行的高度提示要让每一行成为独立节点，别再让 CodeMirror 把一大片
   *    没画出来的行揉成一个 gap 用粗公式估。
   */
  check("即时预览", preview, 0.01);
  check("源码模式", source, 0.05);
  // 「视觉零变化」：画出来的行必须还是实测高度，不能被行高提示的 widget 撑高
  if (lineCheck.mismatch !== 0) {
    problems.push(
      `源码模式：${lineCheck.mismatch} 行的实测高度与「字数×行盒」对不上（行内 widget 改变了排版）`,
    );
  }

  if (problems.length) send(`FAIL: 拖动滚动条不跟手 —— ${problems.join("；")}`);
  else send("PASS: 拖动滚动条内容跟手（滚动位置稳定、帧间隔无卡顿）");
}

run().catch((error) => send(`FAIL: ${error?.message ?? error}\n${error?.stack ?? ""}`));
