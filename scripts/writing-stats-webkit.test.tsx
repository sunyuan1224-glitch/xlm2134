/*
 * 「今日已写」的喂数口子：界面上的数字怎么变，都不该算成「今天写的字」。
 *
 * 用户报的现象：在几篇已经写好的文章之间来回切，今日已写会一直往上涨。
 * 根因是喂数点曾经是 StatusBar 里那个「全书」—— 一个**界面数字**：
 *   · 切章节的那一帧，当前章的实时字数还是上一章的值（useDeferredCount 滞后一帧），
 *     全书就先虚高再落回来 —— 落下去再涨回来，就被记成净增；
 *   · 点「本章」切统计模式（字符 → 中+词）会让这个数字整个换口径，同样被记成净增。
 * 现在统计由 store 喂（各章字数之和，见 store.feedBookWords），界面不再参与。
 *
 * （口径是 lib/wordcount 的默认那一套：每个非空白字符算 1，汉字 / 英文 / 数字 / 标点都算。）
 *
 * 所以这里钉三条：切章节、切模式都不许动统计；真打字必须动；
 * 而状态栏那个「全书」得是各章之和、不吃显示模式那一套。
 * 只挂 StatusBar 就够 —— 它是「界面数字」的来源地，统计口子与它的显示都在这一屏上。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { StatusBar } from "../src/components/StatusBar";
import { useStore } from "../src/store";
import { countWords } from "../src/lib/wordcount";
import { __resetWritingStatsCache, getToday } from "../src/lib/writingStats";

const report = (text: string) =>
  (window as unknown as { webkit: { messageHandlers: { result: { postMessage: (t: string) => void } } } })
    .webkit.messageHandlers.result.postMessage(text);

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一篇「已经写好的长文」与一篇「已经写好的短文」：字数差得足够明显 */
const LONG = "# 春日来信\n\n" + "夜里落了一场很轻的雨。她推开门，听见檐水滴在青石板上。\n\n".repeat(20);
const SHORT = "# 短章\n\n" + "她点头，把伞靠在门边。\n\n".repeat(4);

async function run() {
  const host = document.getElementById("root")!;
  const longWords = countWords(LONG);
  const shortWords = countWords(SHORT);
  check(longWords > shortWords * 4, `夹具要长短分明，实际长 ${longWords} / 短 ${shortWords}`);

  /* 先清掉上一次跑剩的统计，再摆夹具 —— 摆夹具 = 打开工作区那一刻
   * （loadChapters 落 chapters，统计就在那里建立基准），这样基准才是真走出来的 */
  localStorage.removeItem("mynovel:writing-stats");
  __resetWritingStatsCache();

  useStore.setState({
    root: "/stats-fixture",
    files: ["春日来信.md", "短章.md", "还没载入.md"],
    openTabs: ["春日来信.md", "短章.md"],
    activePath: "春日来信.md",
    contents: { "春日来信.md": LONG, "短章.md": SHORT }, // 「还没载入.md」故意不在里面
    chapters: [
      { path: "春日来信.md", name: "春日来信.md", title: "春日来信", status: "草稿", summary: "", words: longWords },
      { path: "短章.md", name: "短章.md", title: "短章", status: "草稿", summary: "", words: shortWords },
      // 章节元数据是打开工作区时就算好的：没载入正文 ≠ 字数未知
      { path: "还没载入.md", name: "还没载入.md", title: "还没载入", status: "草稿", summary: "", words: 888 },
    ],
    dirty: new Set(),
    status: "就绪",
  });

  createRoot(host).render(<StatusBar cursor={{ line: 1, col: 1, selLen: 0 }} />);
  await wait(50);
  check(document.querySelector(".statusbar"), "StatusBar 应当挂在页面上");

  const base = getToday().added;
  check(base === 0, `打开工作区只该建立基准，不该算成今日已写，实际 +${base}`);

  /* -------- 1. 反复切换已经写好的文章：一个字没敲，统计不许动 -------- */
  for (let i = 0; i < 6; i++) {
    useStore.setState({ activePath: "短章.md" });
    await wait(30);
    useStore.setState({ activePath: "还没载入.md" }); // 正文还没读进内存的那种切换
    await wait(30);
    useStore.setState({ activePath: "春日来信.md" });
    await wait(30);
  }
  const afterSwitch = getToday().added;
  check(
    afterSwitch === base,
    `在已写好的文章之间反复切换不该增加今日已写，实际 +${afterSwitch - base}（长 ${longWords} / 短 ${shortWords}）`,
  );

  /* -------- 2. 切换统计模式（字符 → 中+词 → 段落）：那是显示口径，不是字数 -------- */
  const modeCell = document.querySelector<HTMLElement>(".sb-click");
  check(modeCell, "状态栏里应当有可点的统计模式格子");
  check(
    modeCell!.textContent!.includes("字符"),
    `默认口径应当是「字符」（含标点，与左侧树 / 全书同一套），实际「${modeCell!.textContent}」`,
  );
  for (let i = 0; i < 3; i++) {
    modeCell!.click(); // 字符 → 中+词 → 段落 → 字符
    await wait(30);
  }
  check(modeCell!.textContent!.includes("字符"), `点了 3 下应当转回「字符」，实际「${modeCell!.textContent}」`);
  check(getToday().added === base, `切统计模式不该增加今日已写，实际 +${getToday().added - base}`);

  /* 模式只作用于「本章」：全书是各章之和（默认口径），不许跟着换成别的口径 */
  const bookItem = [...document.querySelectorAll<HTMLElement>(".sb-item")]
    .map((e) => e.textContent ?? "")
    .find((t) => t.startsWith("全书"));
  check(bookItem, "状态栏里应当有「全书 N」");
  const want = (longWords + shortWords + 888).toLocaleString("zh-CN");
  check(
    bookItem!.includes(want),
    `全书应当是各章之和、不随显示模式变：预期 ${want}，实际「${bookItem!.textContent}」`,
  );

  /* -------- 3. 真打字要算（防「干脆不统计」的假修），而且是连打时一路爬 -------- */
  const typed = "\n\n" + "天亮时雨停了，她把昨夜没写完的那一页读完。\n\n".repeat(3);
  const setDoc = (v: string) => useStore.getState().setContent("春日来信.md", v);

  // 第一段敲完只等 150ms（一个收数周期 100ms + 余量），没停手就该已经爬上去了：
  // 这条正是冲着「字数停下才动」那个观感来的
  setDoc(LONG + typed);
  await wait(150);
  const midway = getToday().added - base;
  check(midway > 0, `连打时数字就该往上爬，不该等停手才动（中途 +${midway}）`);

  // 第二段紧接着敲，同样只等一个周期
  setDoc(LONG + typed + typed);
  await wait(150);
  const later = getToday().added - base;
  check(later > midway, `继续敲就该继续爬（${midway} → ${later}）`);

  // 收尾：停手之后必须落在准确值上，不能欠着
  await wait(300);
  const delta = getToday().added - base;
  check(
    delta >= countWords(typed) * 2 - 5 && delta <= countWords(typed) * 2 + 5,
    `停手后应当落到准数：预期约 +${countWords(typed) * 2}，实际 +${delta}`,
  );

  report(
    `PASS: 写作统计只认正文改动、且连打时一路往上爬 —— 在已写好的文章间反复切换（含正文未载入的那篇）` +
      `与切统计模式都不再计入今日已写，真打字立刻累加并且停手后落在准数上（长 ${longWords} / 短 ${shortWords}）。`,
  );
}

run().catch((error) =>
  report("FAIL: " + String(error) + "\n" + (error instanceof Error ? error.stack : "")),
);
