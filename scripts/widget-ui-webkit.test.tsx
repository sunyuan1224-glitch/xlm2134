/*
 * 欧金金（挂件）的真 WebKit 检查：右下角位置 / 尺寸驱动 / 菜单 / 持久化 / 隐藏与唤回。
 *
 * 音频不做「有没有响」的断言（无头环境里那取决于机器），但会验素材本身**能被解码**——
 * widgetAudio 对坏素材是静默降级，不验这一条的话「文件坏了」和「没点中」长得一模一样。
 *
 * 左侧那份贴侧栏的立绘不在这个文件里，另有 companion-ui-webkit.test.tsx。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import squeakUrl from "../src/assets/duck-squeak.mp3";
import { useStore } from "../src/store";
import { getAudioDiagnostics, warmSound } from "../src/lib/widgetAudio";
import { countWords, formatNumber } from "../src/lib/wordcount";
import {
  __resetWritingStatsCache,
  getToday,
  noteEdit,
  noteTotalWords,
  resetToday as resetTodayNow,
} from "../src/lib/writingStats";
import { api } from "../src/api";
import {
  DEFAULT_WIDGET,
  WIDGET_SCALE_MAX,
  WIDGET_SCALE_MIN,
  getWidget,
  levelToScale,
  scaleToLevel,
  fromFraction,
  setWidget,
  toFraction,
  settleWidgetPos,
} from "../src/lib/paperWidget";
import "../src/main";

const send = (text: string) => (window as any).webkit.messageHandlers.result.postMessage(text);
const wait = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

/** React 受控输入：直接赋 value 不会触发 onChange，必须走原生 setter 再发 input */
function setInputValue(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const rootEl = () => document.querySelector<HTMLElement>(".pw-root");
/** 压扁动画作用在 .pw-figure 上（气泡也在这一层，才会跟着一起抖） */
const figureOf = () => rootEl()!.querySelector<HTMLElement>(".pw-figure")!;
const cssVar = () => getComputedStyle(document.documentElement).getPropertyValue("--widget-scale").trim();

async function run() {
  /*
   * 先跟上次运行解耦：挂件设置和伴读立绘开关都存在 localStorage 里，而 WebKit 的
   * file:// 存储是**跨运行保留**的。上一版就栽在这——前一次跑把立绘关了，这一跑
   * 一上来就找不到 .paper-companion，报「立绘应当仍在」。
   */
  setWidget({ ...DEFAULT_WIDGET });
  useStore.setState({ companionVisible: true, sidebarOpen: true });

  // 隔离的内存夹具：绝不读写真实工作区
  useStore.setState({
    root: "/widget-fixture",
    files: ["第一章.md"],
    tree: [{ path: "第一章.md", name: "第一章.md", is_dir: false, children: [] }],
    openTabs: ["第一章.md"],
    activePath: "第一章.md",
    contents: {
      "第一章.md":
        "# 春日来信\n\n" +
        "夜里落了一场很轻的雨。她推开门，听见檐水滴在青石板上，一声，又一声。\n\n" +
        "\"你回来得正好。\"老人把茶推过来，杯口还浮着热气，\"稿子我读过了，第三段该慢一点。\"\n\n" +
        "她点头，把伞靠在门边。雨声从窗缝里钻进来，像一句没写完的对白，等着人去续。\n\n" +
        "天亮时雨停了。院里的石阶被洗得发亮，她坐在门槛上，把昨夜没写完的那一页读完。\n",
    },
  });
  createRoot(document.getElementById("root")!).render(<App />);
  (api as unknown as Record<string, unknown>).listFonts = async () => [];
  await wait();

  /* ---------------- 0. 音效素材真的能解码 ----------------
   * widgetAudio 对素材损坏是**静默降级**（不出声、不报错，学参考项目），
   * 所以「文件坏了」和「没点中」在界面上长得一模一样。这条断言把那个坑堵上：
   * 只要 duration 拿得到，就说明 WebKit 认得这个 mp3、点下去是真会响的。
   */
  {
    const probe = new Audio(squeakUrl);
    probe.preload = "auto";
    const duration = await new Promise<number>((resolve) => {
      const finish = (v: number) => resolve(v);
      probe.addEventListener("loadedmetadata", () => finish(probe.duration));
      probe.addEventListener("error", () => finish(-1));
      setTimeout(() => finish(-1), 5000);
    });
    assert(
      Number.isFinite(duration) && duration > 0,
      `挂件音效必须能被 WebKit 解码，否则点了没声且不会报错（读到 duration=${duration}）`,
    );
  }

  /* ---------------- 1. 在右下角，且让开状态栏 ---------------- */
  {
    const root = rootEl();
    assert(root, "右下角应该有 .pw-root 挂件");
    const rect = root!.getBoundingClientRect();
    const statusbar = document.querySelector<HTMLElement>(".statusbar");
    assert(statusbar, "状态栏应当存在（挂件要按它让位）");

    assert(
      Math.abs(rect.right - window.innerWidth) <= 2,
      `挂件应贴窗口右缘（实际 ${Math.round(rect.right)}）`,
    );
    assert(
      Math.abs(rect.bottom - (window.innerHeight - 24)) <= 2,
      `挂件底边应贴在状态栏上沿（期望 ${window.innerHeight - 24}，实际 ${Math.round(rect.bottom)}）`,
    );
    assert(rect.bottom <= statusbar!.getBoundingClientRect().top + 1, "挂件不该压住状态栏");

    // 宿主方块不吃指针事件，否则透明角落会挡住正文
    assert(getComputedStyle(root!).pointerEvents === "none", "挂件宿主必须 pointer-events:none");
    const img = root!.querySelector<HTMLElement>(".pw-img");
    assert(img, "挂件里应该有人物图");
    assert(getComputedStyle(img!).pointerEvents === "auto", "人物本体要能接点击");

    // 挂件在右、立绘在左：两边各站一个，不该有谁跑到对面去
    const companion = document.querySelector<HTMLElement>(".paper-companion");
    assert(companion, "伴读立绘应当存在");
    assert(
      companion!.getBoundingClientRect().left < rect.left,
      "立绘应当在挂件左边（挂件贴右缘、立绘贴左缘）",
    );
  }

  /* ---------------- 2. 尺寸由 --widget-scale 驱动 ---------------- */
  {
    assert(Math.abs(Number(cssVar()) - 1) < 0.001, `默认 scale 应为 1，实际 ${cssVar()}`);
    const rect = rootEl()!.getBoundingClientRect();
    assert(rect.width >= 120 && rect.width <= 560, `scale=1 时边长应在 120–560，实际 ${rect.width}`);
    assert(Math.abs(rect.width - rect.height) <= 1, "挂件应当是正方形");
  }

  /* ---------------- 3. 菜单：按钮淡入、打开、含基础设置 ---------------- */
  {
    const btn = document.querySelector<HTMLButtonElement>(".pw-menu-btn");
    assert(btn, "右上角应该有菜单按钮（汉堡）");
    assert(getComputedStyle(btn!).opacity === "0", "菜单按钮默认应当是淡出的");
    assert(getComputedStyle(btn!).pointerEvents === "auto", "淡出状态下也必须可点");
    assert(btn!.querySelectorAll("span").length === 3, "菜单按钮应是三横条汉堡");
    // 按钮挪到右上角了：原来在 40% 高度，实测那块 26×26 有 46% 盖在立绘上
    const btnRect = btn!.getBoundingClientRect();
    const rootRect = rootEl()!.getBoundingClientRect();
    assert(
      btnRect.top - rootRect.top <= rootRect.height * 0.2,
      `菜单按钮应当待在挂件顶部一带、别压人物（按钮顶距顶 ${Math.round(btnRect.top - rootRect.top)}px，挂件高 ${Math.round(rootRect.height)}px）`,
    );

    btn!.click();
    await wait(150);
    const menu = document.querySelector<HTMLElement>(".pw-menu");
    assert(menu, "点菜单按钮应该展开菜单");
    assert(btn!.className.includes("is-visible"), "菜单展开时按钮应带 is-visible（否则点不回去）");
    await wait(300);
    assert(
      Number.parseFloat(getComputedStyle(btn!).opacity) > 0.9,
      `菜单展开时按钮应当可见，实际 opacity=${getComputedStyle(btn!).opacity}`,
    );

    const labels = [...menu!.querySelectorAll(".pw-menu-label")].map((e) => e.textContent);
    for (const want of ["大小", "音量", "点击出声"]) {
      assert(labels.includes(want), `基础设置里应该有「${want}」，实际：${labels.join(" | ")}`);
    }
    // 按钮行不重复标签（曾经渲染成「隐藏挂件 | 隐藏挂件」）
    const hideRow = [...menu!.querySelectorAll<HTMLElement>(".pw-menu-row")].find((r) =>
      r.textContent?.includes("隐藏挂件"),
    )!;
    assert(hideRow, "菜单里应该有「隐藏挂件」");
    assert(
      hideRow.textContent?.trim() === "隐藏挂件",
      `按钮行不该重复显示标签，实际「${hideRow.textContent?.trim()}」`,
    );

    /* -------- 大小滑块：拖动即改尺寸 + 写 --widget-scale + 落盘 --------
     * 同时盯住「拖尺寸时菜单不许动」：菜单原来锚在挂件左缘上，挂件一变宽左缘就往左
     * 跑，菜单跟着溜，滑块就在光标底下滑走、根本调不准。
     */
    const scaleRange = menu!.querySelector<HTMLInputElement>(".pw-range")!;
    assert(scaleRange.type === "range", "大小应当是可拖动的进度条");
    assert(
      Number(scaleRange.min) === WIDGET_SCALE_MIN && Number(scaleRange.max) === WIDGET_SCALE_MAX,
      `滑块量程应是 ${WIDGET_SCALE_MIN}–${WIDGET_SCALE_MAX}，实际 ${scaleRange.min}–${scaleRange.max}`,
    );
    const menuLeftBefore = menu!.getBoundingClientRect().left;

    // 拖到最小
    setInputValue(scaleRange, String(WIDGET_SCALE_MIN));
    await wait(150);
    assert(
      Math.abs(Number(cssVar()) - WIDGET_SCALE_MIN) < 0.001,
      `拖到底后 --widget-scale 应为 ${WIDGET_SCALE_MIN}，实际 ${cssVar()}`,
    );
    const widthMin = rootEl()!.getBoundingClientRect().width;

    // 拖到最大
    setInputValue(scaleRange, String(WIDGET_SCALE_MAX));
    await wait(150);
    assert(
      Math.abs(Number(cssVar()) - WIDGET_SCALE_MAX) < 0.001,
      `拖到顶后 --widget-scale 应为 ${WIDGET_SCALE_MAX}，实际 ${cssVar()}`,
    );
    const widthMax = rootEl()!.getBoundingClientRect().width;
    assert(widthMax > widthMin + 50, `拖大滑块挂件应变大（${widthMin} → ${widthMax}）`);

    // 尺寸的放大倍数要和量程对得上（顺带证明 CSS 真在吃 --widget-scale）
    assert(
      Math.abs(widthMax / widthMin - WIDGET_SCALE_MAX / WIDGET_SCALE_MIN) < 0.05,
      `尺寸倍数应与量程一致（期望 ${(WIDGET_SCALE_MAX / WIDGET_SCALE_MIN).toFixed(2)}×，实际 ${(widthMax / widthMin).toFixed(2)}×）`,
    );

    // 缩放到顶的整个过程中，菜单必须钉在原地
    assert(
      Math.abs(menu!.getBoundingClientRect().left - menuLeftBefore) <= 1,
      `拖尺寸时菜单不该跟着动（${menuLeftBefore} → ${menu!.getBoundingClientRect().left}）`,
    );

    // 量程收窄后不该再撑出参考项目那种巨块
    assert(widthMax < 380, `最大档不该超过 380px（实际 ${widthMax}）`);
    assert(widthMin > 100, `最小档不该小于 100px（实际 ${widthMin}）`);

    assert(
      JSON.parse(localStorage.getItem("mynovel:widget")!).scale === WIDGET_SCALE_MAX,
      "尺寸必须落到 localStorage",
    );

    /* -------- 数字框：整数档位与 scale 线性对应，且每档正好一个滑块刻度 -------- */
    const numberBox = menu!.querySelector<HTMLInputElement>(".pw-number")!;
    assert(
      Number(numberBox.min) === 1 && Number(numberBox.max) === 10,
      `档位范围应是 1–10，实际 ${numberBox.min}–${numberBox.max}`,
    );
    // 数字框不该有上下箭头（配着滑块用的，箭头又占地方又容易误点）
    const appearance = getComputedStyle(numberBox).getPropertyValue("-webkit-appearance").trim();
    assert(
      appearance !== "auto" && appearance !== "",
      `尺寸数字框应当去掉上下箭头，实际 -webkit-appearance=${appearance}`,
    );
    assert(
      Math.abs(levelToScale(2) - levelToScale(1) - 0.1) < 1e-9,
      `每一档应当正好等于一个滑块刻度(0.1)，实际 ${levelToScale(2) - levelToScale(1)}`,
    );
    assert(
      numberBox.value === String(scaleToLevel(WIDGET_SCALE_MAX)),
      `数字框应显示对应档位，实际 ${numberBox.value}`,
    );
    setInputValue(numberBox, String(scaleToLevel(2)));
    await wait(150);
    assert(
      Math.abs(Number(cssVar()) - levelToScale(scaleToLevel(2))) < 0.001,
      `数字框应能反向驱动 scale，实际 ${cssVar()}`,
    );
    setInputValue(scaleRange, "1");
    await wait(120);

    /* -------- 音量滑块 + 出声开关 -------- */
    const volRange = [...menu!.querySelectorAll<HTMLInputElement>(".pw-range")][1];
    setInputValue(volRange, "0.5");
    await wait(120);
    assert(JSON.parse(localStorage.getItem("mynovel:widget")!).volume === 0.5, "音量必须落盘");
    assert(menu!.querySelector(".pw-suffix")!.textContent === "50%", "音量百分比应跟着滑块走");

    const check = menu!.querySelector<HTMLInputElement>(".pw-check")!;
    check.click();
    await wait(120);
    assert(getWidget().soundOn === false, "「点击出声」取消勾选后应关掉音效");
    assert(JSON.parse(localStorage.getItem("mynovel:widget")!).soundOn === false, "音效开关必须落盘");

    /* -------- 点击本体：压扁 + 不抛错（静音态） --------
     * 压扁是「按下就压、松手弹回」；而**算不算点击**要等松手才知道（同一个手势还要能拖动 —
     * 挪过就不叫点击，只落位）。
     */
    const img = rootEl()!.querySelector<HTMLElement>(".pw-img")!;
    const clickAt = rootEl()!.getBoundingClientRect();
    img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 400, clientY: 400 }));
    await wait(40);
    // 手感与参考项目一致：**按下就压**（按住不放会一直压着），松手才弹回
    assert(figureOf().classList.contains("is-pressed"), "按下就应当压扁（按住不放要一直压着）");
    img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 400, clientY: 400 }));
    await wait(160);
    assert(!figureOf().classList.contains("is-pressed"), "松手应当回弹");
    const afterClick = rootEl()!.getBoundingClientRect();
    assert(
      Math.abs(afterClick.left - clickAt.left) <= 1 && Math.abs(afterClick.top - clickAt.top) <= 1,
      "点击不该把挂件挪走",
    );

    // 恢复出声，再点一下（验证有声路径同样不抛错）
    check.click();
    await wait(120);
    assert(getWidget().soundOn === true, "再点一次应当恢复音效");
    img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await wait(120);

    /* -------- 连续快速点按：不许报错，也不许把声音弄哑 --------
     * 这是修掉的真 bug：老实现走 <audio> + currentTime=0 + play()，连点会把正在飞的
     * play() 打断，12 下之后元素卡在 paused=true 再也不响。换成 Web Audio 后
     * （预解码 + 每次新建 source，连点=停掉上一条再起一条）这条路不该再有任何异常。
     * 这里能验的是「不报错」；「出不出声」交给耳朵。
     */
    /* -------- 音效素材：能加载 + 失败必须看得见 --------
     * ⚠️ 这个无头环境**根本放不出声**：data: / file: / blob: 三种 URL 都试过，
     * 全都 NotAllowedError、paused 永远 true（无头 WebKit 没有真实用户手势）。
     * 所以这里只验「素材加载得动」和「没有加载类故障」，
     * **「能不能听见」在这个环境里验不了**，只能靠真机 —— 别再拿这里的绿灯当有声的证据。
     */
    {
      warmSound();
      await wait(600);
      const warmed = getAudioDiagnostics();
      assert(warmed.ready, `音效素材应当加载到可播（readyState ≥ 1 且有长度）：${JSON.stringify(warmed.players)}`);
      const press = warmed.players.find((p) => p.slot === "press")!;
      assert(
        press.duration > 0.3 && press.duration < 1,
        `素材时长应当接近真实长度，实际 ${press.duration}`,
      );
      // 前面几段已经点过人物，本环境又没有手势，所以 lastError 里大概率躺着一条
      // NotAllowedError。那不算素材故障；真出了加载/解码类的错，才会在这里露出来。
      if (warmed.lastError !== null) {
        assert(
          /not allowed|NotAllowedError/i.test(warmed.lastError),
          `音效只应出现「本环境缺手势」这类错误，实际：${warmed.lastError}`,
        );
      }
    }

    /* -------- 试听按钮：菜单里点一下就能单独验音效 -------- */
    {
      const preview = [...document.querySelectorAll<HTMLButtonElement>(".pw-btn")].find((b) =>
        b.textContent?.includes("试听音效"),
      );
      assert(preview, "音效设置里应当有「试听音效」按钮");
      preview!.click();
      await wait(500);
      // 报错机制必须通：要么没报错，要么报的只能是「本环境没有用户手势」这一条。
      // 真出现加载/解码类的错，就会在这里露出来。
      const errText = document.querySelector(".pw-menu-err")?.textContent ?? "";
      assert(
        errText === "" || /not allowed|NotAllowedError/i.test(errText),
        `试听后若报错，只应是本环境缺手势导致的 NotAllowedError，实际：${errText}`,
      );
    }

    /* -------- 连续快速点按：不许出现加载类故障，也不许有未捕获的拒绝 ----
     * 「连点会把声音弄哑」那个 bug 的修复（先 pause() 再 currentTime=0）在这个
     * 放不出声的环境里**验不了**，这里只保证连点不会抛错、不会报加载故障。
     */
    {
      const warns: string[] = [];
      const rejections: unknown[] = [];
      const origWarn = console.warn;
      const onRejection = (e: PromiseRejectionEvent) => rejections.push(e.reason);
      console.warn = (...args: unknown[]) => {
        warns.push(args.map((a) => String(a)).join(" "));
      };
      window.addEventListener("unhandledrejection", onRejection);
      try {
        for (let i = 0; i < 20; i++) {
          img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          await wait(12);
        }
        await wait(200);
      } finally {
        console.warn = origWarn;
        window.removeEventListener("unhandledrejection", onRejection);
      }
      // 本环境没有手势，play() 必然被 NotAllowedError 挡下，这条要放行
      const real = warns.filter((w) => !/not allowed|NotAllowedError/i.test(w));
      assert(real.length === 0, `连点 20 次不该有加载类音效故障：${real.join(" | ")}`);
      assert(
        rejections.length === 0,
        `连点 20 次不该有未捕获的 promise 拒绝：${rejections.map(String).join(" | ")}`,
      );
      assert(rootEl()?.querySelector(".pw-img"), "连点之后挂件应当还在");
    }

    /* -------- 点菜单外 / Esc 收起 -------- */
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await wait(120);
    assert(!document.querySelector(".pw-menu"), "点菜单外应当收起菜单");

    btn!.click();
    await wait(120);
    assert(document.querySelector(".pw-menu"), "菜单应能再次打开");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(120);
    assert(!document.querySelector(".pw-menu"), "Esc 应当收起菜单");
  }

  send("SHOT: widget-default");
  await wait();

  /* ---------------- 4. 隐藏 + 从「视图」菜单唤回 ---------------- */
  {
    document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
    await wait(150);
    [...document.querySelectorAll<HTMLButtonElement>(".pw-btn")]
      .find((b) => b.textContent?.includes("恢复默认"))!
      .click();
    await wait(150);
    assert(
      getWidget().scale === DEFAULT_WIDGET.scale && getWidget().volume === DEFAULT_WIDGET.volume,
      "「恢复默认」应把尺寸与音量还原",
    );

    [...document.querySelectorAll<HTMLButtonElement>(".pw-btn")]
      .find((b) => b.textContent?.includes("隐藏挂件"))!
      .click();
    await wait(150);
    assert(!rootEl(), "点「隐藏挂件」后挂件应当消失");
    assert(!getWidget().visible, "隐藏状态应写进设置");

    const viewMenu = [...document.querySelectorAll<HTMLButtonElement>(".menu-root")].find(
      (b) => b.textContent?.trim() === "视图",
    )!;
    viewMenu.click();
    await wait(150);
    const entry = [...document.querySelectorAll<HTMLElement>(".menu-item")].find((i) =>
      (i.textContent ?? "").includes("欧金金"),
    );
    assert(entry, "「视图」菜单里应该有「欧金金」入口");
    entry!.click();
    await wait(200);
    assert(rootEl(), "从「视图」菜单勾选后挂件应当回来");
    assert(getWidget().visible, "唤回状态应写进设置");
    assert(!document.querySelector(".pw-menu"), "隐藏时开着菜单的话，唤回来不能把菜单一起带回来");
    assert(localStorage.getItem("mynovel:widget") !== null, "设置必须落盘");
  }

  /* ---------------- 5. 菜单开在挂件左侧，不越出窗口 ---------------- */
  {
    document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
    await wait(200);
    const menu = document.querySelector<HTMLElement>(".pw-menu")!;
    assert(menu, "菜单应当打开");
    const rect = menu.getBoundingClientRect();
    const rootRect = rootEl()!.getBoundingClientRect();
    assert(
      rect.right <= rootRect.left + 1,
      `菜单应开在挂件左侧（实际 right=${Math.round(rect.right)}，挂件左缘=${Math.round(rootRect.left)}）`,
    );
    assert(rect.left >= 0, `菜单不该越出窗口左缘（实际 ${Math.round(rect.left)}）`);
    assert(rect.bottom <= window.innerHeight && rect.top >= 0, "菜单应完整落在窗口内");

    // 出图要趁菜单开着，否则这张图名不副实
    send("SHOT: widget-menu");
    await wait(120);

    // 收起，别把「开着菜单」的状态漏给下一段
    document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
    await wait(150);
    assert(!document.querySelector(".pw-menu"), "再点一次菜单按钮应当收起");
  }

  /* ---------------- 6. 与伴读立绘共存（互不影响） ---------------- */
  {
    assert(document.querySelector(".paper-companion"), "伴读立绘应当仍在");
    assert(rootEl(), "挂件与立绘应当共存");

    useStore.getState().toggleCompanion();
    await wait(200);
    assert(!document.querySelector(".paper-companion"), "关掉后伴读立绘应当消失");
    assert(rootEl(), "关掉立绘不该影响挂件");

    document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
    await wait(250);
    assert(document.querySelector(".pw-menu"), "关掉立绘后菜单仍应正常打开");
  }

  send("SHOT: widget-alone");
  await wait();

  /* ---------------- 8. 隐藏菜单按钮 + 右键人物唤出 ---------------- */
  {
    const img = rootEl()!.querySelector<HTMLElement>(".pw-img")!;
    const btn = () => document.querySelector(".pw-menu-btn");
    const rightClick = () =>
      img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const toggleOf = (label: string) =>
      [...document.querySelectorAll<HTMLElement>(".pw-menu-row")]
        .find((r) => r.textContent?.includes(label))!
        .querySelector<HTMLInputElement>(".pw-check")!;

    assert(btn(), "默认应当显示菜单按钮");

    // 右键人物就能唤出菜单（不必先有按钮）
    rightClick();
    await wait(250);
    assert(document.querySelector(".pw-menu"), "右键人物应当唤出菜单");
    assert(toggleOf("隐藏按钮"), "菜单里应当有「隐藏按钮」这一项");

    // 勾上 → 按钮消失、菜单不跟着关
    toggleOf("隐藏按钮").click();
    await wait(250);
    assert(getWidget().menuBtnHidden === true, "「隐藏按钮」应当写进设置");
    assert(!btn(), "勾上之后菜单按钮应当从 DOM 里消失");
    assert(document.querySelector(".pw-menu"), "勾选时菜单本身不该跟着关掉");
    assert(
      JSON.parse(localStorage.getItem("mynovel:widget")!).menuBtnHidden === true,
      "该开关必须落盘",
    );

    // 按钮没了，右键仍然要能唤出
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await wait(200);
    assert(!document.querySelector(".pw-menu"), "点菜单外应当收起");
    rightClick();
    await wait(250);
    assert(document.querySelector(".pw-menu"), "按钮藏起来后，右键人物仍应能唤出菜单");

    // 从菜单里取消勾选 → 按钮回来（隐藏按钮之后唯一的退路就是它，必须留）
    toggleOf("隐藏按钮").click();
    await wait(250);
    assert(getWidget().menuBtnHidden === false, "取消勾选应当恢复");
    assert(btn(), "取消勾选后菜单按钮应当回来");

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await wait(150);
  }

  /* ---------------- 9. 拖动（和小鲸鱼一样能拖着走） ---------------- */
  {
    /* 纯函数先单独验：吸附 + 夹进给定区域 */
    {
      // 区域取一组不对齐的数，免得把「夹到 0」和「夹到 bounds.left」混为一谈
      const bounds = { left: 20, top: 36, right: 1000, bottom: 776 };
      const size = { w: 200, h: 200 };
      const at = (pos: { left: number; top: number }) => settleWidgetPos(pos, size, bounds);

      // 靠近左上 → 吸附到区域左上角
      assert(
        JSON.stringify(at({ left: 30, top: 40 })) === JSON.stringify({ left: 20, top: 36 }),
        `靠近左上应当吸附到区域左上，实际 ${JSON.stringify(at({ left: 30, top: 40 }))}`,
      );
      // 靠近右下 → 吸附到区域右下角
      assert(
        JSON.stringify(at({ left: 795, top: 571 })) === JSON.stringify({ left: 800, top: 576 }),
        `靠近右下应当吸附到区域右下，实际 ${JSON.stringify(at({ left: 795, top: 571 }))}`,
      );
      // 四条边之外一律夹住 —— 这就是「不许盖菜单栏 / 状态栏 / 左侧栏」
      assert(at({ left: -900, top: 300 }).left === 20, "往左拖出界应夹在区域左界（不许压到左侧栏）");
      assert(at({ left: 9000, top: 300 }).left === 800, "往右拖出界应夹住");
      assert(at({ left: 300, top: -500 }).top === 36, "往上拖出界应夹在区域上界（不许盖菜单栏）");
      assert(at({ left: 300, top: 9000 }).top === 576, "往下拖出界应夹在区域下界（不许盖状态栏）");
      // 挂件比区域还大时退化为贴左上角，而不是算出负的可用空间
      assert(
        JSON.stringify(settleWidgetPos({ left: 300, top: 300 }, { w: 2000, h: 2000 }, bounds)) ===
          JSON.stringify({ left: 20, top: 36 }),
        "挂件比区域大时应退化为贴区域左上角",
      );
    }

    /* 落点存「比例」：换窗口大小时按比例重算，角落才还在角落 */
    {
      const small = { left: 300, top: 36, right: 954, bottom: 936 };
      const big = { left: 300, top: 36, right: 1400, bottom: 976 };
      const size = { w: 200, h: 200 };
      const corner = { left: small.right - size.w, top: small.bottom - size.h };

      const f = toFraction(corner, size, small);
      assert(
        Math.abs(f.fx - 1) < 1e-6 && Math.abs(f.fy - 1) < 1e-6,
        `右下角应存成 1/1，实际 ${JSON.stringify(f)}`,
      );
      const back = fromFraction(f, size, big);
      assert(
        Math.abs(back.left - (big.right - size.w)) <= 1 && Math.abs(back.top - (big.bottom - size.h)) <= 1,
        `区域变大后应重新落在新的右下角（期望 ${big.right - size.w},${big.bottom - size.h}，实际 ${JSON.stringify(back)}）`,
      );

      const tl = toFraction({ left: small.left, top: small.top }, size, small);
      assert(tl.fx === 0 && tl.fy === 0, `左上角应存成 0/0，实际 ${JSON.stringify(tl)}`);
      assert(
        JSON.stringify(fromFraction(tl, size, big)) === JSON.stringify({ left: big.left, top: big.top }),
        "比例 0/0 应落在新区域的左上角",
      );

      const midX = small.left + (small.right - small.left - size.w) / 2;
      const midF = toFraction({ left: midX, top: small.top }, size, small);
      assert(Math.abs(midF.fx - 0.5) < 1e-6, `正中应存成 0.5，实际 ${midF.fx}`);

      // 区域比挂件还小：退化为 0，不许算出负比例
      const tf = toFraction({ left: -50, top: -50 }, size, { left: 0, top: 0, right: 100, bottom: 100 });
      assert(tf.fx === 0 && tf.fy === 0, `区域装不下时比例应退化为 0，实际 ${JSON.stringify(tf)}`);
    }

    const img = rootEl()!.querySelector<HTMLElement>(".pw-img")!;
    const dragBy = async (fromX: number, fromY: number, dx: number, dy: number) => {
      img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: fromX, clientY: fromY }));
      for (let i = 1; i <= 4; i++) {
        img.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: fromX + (dx * i) / 4, clientY: fromY + (dy * i) / 4 }));
        await wait(20);
      }
      img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: fromX + dx, clientY: fromY + dy }));
      await wait(120);
    };

    // 起步先回到默认角落，量一个基准
    setWidget({ pos: null });
    await wait(150);
    const rect0 = rootEl()!.getBoundingClientRect();

    // 手抖 2px 不算拖动
    await dragBy(rect0.left + 100, rect0.top + 100, 2, 2);
    const rectSlop = rootEl()!.getBoundingClientRect();
    assert(Math.abs(rectSlop.left - rect0.left) <= 1, `位移小于阈值不该算拖动（${rect0.left} → ${rectSlop.left}）`);

    // 真拖动：往左拖 200px
    await dragBy(rect0.left + 120, rect0.top + 100, -200, 0);
    const rect1 = rootEl()!.getBoundingClientRect();
    assert(rect1.left < rect0.left - 100, `拖动应当跟着指针走（${rect0.left} → ${rect1.left}）`);
    assert(getWidget().pos !== null, "拖动后应当记下落点");
    assert(
      JSON.parse(localStorage.getItem("mynovel:widget")!).pos !== null,
      "落点必须落盘，重启后还在拖到的位置",
    );
    assert(!rootEl()!.classList.contains("is-dragging"), "松手后应当收掉拖动态");

    /* ---- 贴边的落点要存成「比例」，这是「换窗口大小还在角落」的前提 ----
     * 窗口 resize 本身在这个夹具里验不了：窗口是 niri 管的平铺窗，客户端
     * `Gtk.Window.resize()` 会被合成器忽略（实测 innerWidth 纹丝不动）。
     * 真·resize 的行为在 Electron 里验（Chromium 的 setBounds 一定生效）。
     */
    {
      const r0 = rootEl()!.getBoundingClientRect();
      await dragBy(r0.left + 60, r0.top + 60, 9999, 9999);
      const stored = getWidget().pos;
      assert(stored !== null, "拖到右下角后应当存下落点");
      assert(
        Math.abs(stored!.fx - 1) < 0.02 && Math.abs(stored!.fy - 1) < 0.02,
        `贴边的落点应当存成比例 1/1（不然换窗口大小就不在角落了），实际 ${JSON.stringify(stored)}`,
      );
      assert(
        JSON.parse(localStorage.getItem("mynovel:widget")!).pos.fx === stored!.fx,
        "比例要落盘",
      );
      const br = rootEl()!.getBoundingClientRect();
      const statusbar = document.querySelector<HTMLElement>(".statusbar")!.getBoundingClientRect();
      assert(Math.abs(br.bottom - statusbar.top) <= 2, "贴边落位本身要对：底边贴状态栏上沿");
      assert(Math.abs(br.right - window.innerWidth) <= 2, "贴边落位本身要对：右缘贴窗口右缘");
    }

    /* ---- 三条拖动边界：上不盖菜单栏、下不盖状态栏、左不压左侧栏 ---- */
    {
      const menubar = document.querySelector<HTMLElement>(".menubar")!.getBoundingClientRect();
      const statusbar = document.querySelector<HTMLElement>(".statusbar")!.getBoundingClientRect();
      const area = document.querySelector<HTMLElement>(".editor-area")!.getBoundingClientRect();

      // 往左上狠拖
      await dragBy(rect1.left + 100, rect1.top + 100, -9999, -9999);
      const tl = rootEl()!.getBoundingClientRect();
      assert(
        tl.top >= menubar.bottom - 1,
        `最上端不得超过菜单栏下沿（菜单栏下沿 ${Math.round(menubar.bottom)}，实际 top ${Math.round(tl.top)}）`,
      );
      assert(
        tl.left >= area.left + 16 - 1,
        `最左端不得压到左侧栏（应与伴读立绘同一条线 ${Math.round(area.left + 16)}，实际 left ${Math.round(tl.left)}）`,
      );

      // 往右下狠拖
      await dragBy(tl.left + 100, tl.top + 100, 9999, 9999);
      const br = rootEl()!.getBoundingClientRect();
      assert(
        br.bottom <= statusbar.top + 1,
        `最下端不得超过状态栏上沿（状态栏上沿 ${Math.round(statusbar.top)}，实际 bottom ${Math.round(br.bottom)}）`,
      );
      assert(br.right <= window.innerWidth + 1, "右端不该越过窗口右缘");

      // 顺带确认：这几条不是「因为拖不动」才成立的 —— 中间地带必须能自由落点
      setWidget({ pos: null });
      await wait(150);
      const mid = rootEl()!.getBoundingClientRect();
      await dragBy(mid.left + 100, mid.top + 100, -60, -40);
      const moved = rootEl()!.getBoundingClientRect();
      assert(
        Math.abs(moved.left - mid.left) > 30 && Math.abs(moved.top - mid.top) > 20,
        `区域中间的拖动应当跟手（${Math.round(mid.left)},${Math.round(mid.top)} → ${Math.round(moved.left)},${Math.round(moved.top)}）`,
      );
    }

    // 拖动之后右键仍要能唤出菜单
    img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await wait(250);
    assert(document.querySelector(".pw-menu"), "拖动之后右键仍应能唤出菜单");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await wait(150);

    // 「回到角落」应当把落点清掉，交回默认右下角
    document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
    await wait(250);
    [...document.querySelectorAll<HTMLButtonElement>(".pw-btn")]
      .find((b) => b.textContent?.includes("回到角落"))!
      .click();
    await wait(250);
    assert(getWidget().pos === null, "「回到角落」应当清掉落点");
    const rect3 = rootEl()!.getBoundingClientRect();
    assert(
      Math.abs(rect3.right - window.innerWidth) <= 2,
      `回到角落后应当贴回右缘（实际 ${Math.round(rect3.right)}）`,
    );
    assert(rootEl()!.style.left === "", "落点清掉后不该再留着内联样式");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await wait(150);
  }

  /* ---------------- 10. 气泡：今日已写（大头）＋ 平均速度（小字） ---------------- */
  {
    /*
     * 先把统计清干净，免得前面那些指针事件（都会走 store.setContent → noteEdit）攒下的
     * 活跃时长影响判断；清完立刻重建基准。
     */
    localStorage.removeItem("mynovel:writing-stats");
    __resetWritingStatsCache();

    const t0 = Date.now();
    noteTotalWords(1000, "/bubble-fixture", t0);
    assert(getToday(t0).added === 0, "第一次观察只建立基准，不该算成今日已写");

    noteTotalWords(1250, "/bubble-fixture", t0 + 1000);
    assert(getToday(t0 + 1000).added === 250, `今日已写应累加净增，实际 ${getToday(t0 + 1000).added}`);

    // 删字不回退：它记的是「今天敲出来的净增之和」，不是「当前总数 − 早上总数」
    noteTotalWords(1200, "/bubble-fixture", t0 + 2000);
    assert(getToday(t0 + 2000).added === 250, "删字不该让今日已写回退");
    noteTotalWords(1250, "/bubble-fixture", t0 + 3000);
    assert(getToday(t0 + 3000).added === 300, `继续写应继续累加，实际 ${getToday(t0 + 3000).added}`);

    // 换工作区只重建基准，不许把两个工作区的字数差算成今日已写
    const beforeSwitch = getToday(t0 + 3000).added;
    noteTotalWords(99999, "/another-workspace", t0 + 4000);
    assert(getToday(t0 + 4000).added === beforeSwitch, "换工作区不该凭空多出今日已写");

    // 活跃时长不够时不给速度（刚写三秒会算出几万字/时这种荒唐数）
    assert(getToday(t0 + 3000).perHour === null, "活跃时长不足时速度应为 null（显示 —）");
    for (let i = 0; i < 60; i++) noteEdit(t0 + 3000 + i * 10000);
    const withTime = getToday(t0 + 3000 + 59 * 10000);
    assert(withTime.activeMs > 60_000, `活跃时长应当累加，实际 ${withTime.activeMs}`);
    assert(withTime.perHour !== null && withTime.perHour > 0, `活跃够久应当给出速度，实际 ${withTime.perHour}`);

    // 点一下人物 → 冒气泡
    const img = rootEl()!.querySelector<HTMLElement>(".pw-img")!;
    const at = rootEl()!.getBoundingClientRect();
    img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }));
    img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }));
    await wait(140);
    const bubble = document.querySelector<HTMLElement>(".pw-bubble");
    assert(bubble, "点一下人物应当冒气泡");
    const text = bubble!.textContent ?? "";
    assert(text.includes("今日已写"), `气泡里应当有「今日已写」，实际「${text}」`);
    assert(text.includes("平均速度"), `气泡里应当有「平均速度」，实际「${text}」`);
    assert(text.includes(formatNumber(getToday().added)), `气泡里的数字应当是当前统计，实际「${text}」`);

    // 大数字要比小字大：今日已写是主角
    const amount = bubble!.querySelector<HTMLElement>(".pw-bubble-amount")!;
    const hint = bubble!.querySelector<HTMLElement>(".pw-bubble-hint")!;
    const amountSize = parseFloat(getComputedStyle(amount).fontSize);
    const hintSize = parseFloat(getComputedStyle(hint).fontSize);
    assert(amountSize > hintSize * 1.5, `「今日已写」字号应当明显大于速度（${amountSize} vs ${hintSize}）`);

    /*
     * 活跃不够时不许只留一条光秃秃的横线（用户报过「平均速度显示不出来，是一条横线」）：
     * 重置完 / 刚换版本、基准归零之后那半分钟里，得把「还要再写几秒」写出来。
     */
    localStorage.removeItem("mynovel:writing-stats");
    __resetWritingStatsCache();
    const t1 = Date.now();
    noteTotalWords(1000, "/bubble-fixture", t1); // 建立基准
    noteTotalWords(1030, "/bubble-fixture", t1 + 500); // +30 字，活跃几乎为 0
    await wait(300); // 气泡开着时每 200ms 重渲染一次，等它刷一下
    const hintCold = bubble!.querySelector<HTMLElement>(".pw-bubble-hint")!;
    const coldText = hintCold.textContent ?? "";
    assert(
      coldText.includes("平均速度") && /秒/.test(coldText),
      `活跃不足时那行要说明在等什么（还要写几秒），实际「${coldText}」`,
    );

    // 可点（点一下切彩蛋）。代价是它显示的那几秒会吃掉底下的点击，这是换来的
    assert(getComputedStyle(bubble!).pointerEvents === "auto", "气泡应当可点（点一下切彩蛋）");

    // 整块在人物外侧，不压在人身上
    const br = bubble!.getBoundingClientRect();
    const wr = rootEl()!.getBoundingClientRect();
    assert(
      br.right <= wr.left + 1 || br.left >= wr.right - 1,
      `气泡应当整块在人物外侧（气泡 ${Math.round(br.left)}–${Math.round(br.right)}，人物 ${Math.round(wr.left)}–${Math.round(wr.right)}）`,
    );

    /* 动效 ①：气泡住在「被压扁的外壳」里 —— 点按时它跟着一起抖 */
    {
      const figure = rootEl()!.querySelector<HTMLElement>(".pw-figure")!;
      assert(figure.contains(bubble!), "气泡应当在 .pw-figure 里（否则压扁带不动它）");
      const before = bubble!.getBoundingClientRect();

      // 指针处理器挂在 .pw-img 上；外壳只是"被测的对象"（压扁类加在它身上）
      img.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }),
      );
      await wait(130);
      const during = bubble!.getBoundingClientRect();
      assert(figure.classList.contains("is-pressed"), "按下时外壳应当带 is-pressed");
      assert(
        Math.abs(during.left - before.left) > 0.5 ||
          Math.abs(during.top - before.top) > 0.5 ||
          Math.abs(during.width - before.width) > 0.5,
        `压扁时气泡应当跟着动（${Math.round(before.left)},${Math.round(before.top)},w${Math.round(before.width)} → ${Math.round(during.left)},${Math.round(during.top)},w${Math.round(during.width)}）`,
      );
      img.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }),
      );
      await wait(260); // 等回弹走完
    }

    /* 动效 ②：分段弹出（尾巴先冒 → 本体带点回弹鼓出来 → 文字最后浮现），不是一次淡入 */
    {
      // 上一次 pointerup 也算点击，气泡已经重建过；重新取一次引用
      const fresh = document.querySelector<HTMLElement>(".pw-bubble");
      assert(fresh, "点完之后气泡应当还在");
      const bodyAnim = getComputedStyle(fresh!).animationName;
      const bodyDelay = parseFloat(getComputedStyle(fresh!).animationDelay);
      const tailAnim = getComputedStyle(fresh!, "::after").animationName;
      const amount = fresh!.querySelector<HTMLElement>(".pw-bubble-amount")!;
      const textDelay = parseFloat(getComputedStyle(amount).animationDelay);

      assert(bodyAnim === "pw-bubble-body", `气泡本体应当有自己的进场动画，实际 ${bodyAnim}`);
      assert(tailAnim === "pw-bubble-tail", `尾巴应当先冒出来（自己的动画），实际 ${tailAnim}`);
      assert(bodyDelay > 0, `本体的动画要晚于尾巴，实际 delay=${bodyDelay}`);
      assert(
        textDelay > bodyDelay,
        `文字应当比本体更晚出现（文字 ${textDelay}s vs 本体 ${bodyDelay}s）`,
      );
    }

    send("SHOT: widget-bubble");
    await wait(120);

    /* 再点人物：已经显示着就不该重建气泡（重建会把进场动画连文字一起重播，看着像被重置） */
    {
      const before = document.querySelector<HTMLElement>(".pw-bubble");
      assert(before, "此时气泡应当还在");
      let restarts = 0;
      const onStart = () => { restarts++; };
      before!.addEventListener("animationstart", onStart, true);

      img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }));
      img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }));
      await wait(120);
      before!.removeEventListener("animationstart", onStart, true);

      const after = document.querySelector<HTMLElement>(".pw-bubble");
      assert(after, "再点一下气泡应当还在");
      assert(after === before, "已经显示着的气泡不该被重建（重建会把文字状态重置）");
      assert(restarts === 0, `再点不该重播进场动画，实际重播了 ${restarts} 次`);
    }

    /* 点气泡 → 正文交叉淡化变成彩蛋「欧金金…」；再点切回来 */
    {
      const el = document.querySelector<HTMLElement>(".pw-bubble")!;
      const stat = el.querySelector<HTMLElement>(".pw-bubble-stat")!;
      const egg = el.querySelector<HTMLElement>(".pw-bubble-egg")!;
      assert(egg.textContent?.includes("欧金金"), `彩蛋文案应当是「欧金金…」，实际「${egg.textContent}」`);
      assert(getComputedStyle(egg).opacity === "0", "没点时彩蛋应当是隐藏的");
      assert(
        getComputedStyle(egg).justifySelf === "center" && getComputedStyle(egg).textAlign === "center",
        `彩蛋文案应当保持居中（justify-self=${getComputedStyle(egg).justifySelf} text-align=${getComputedStyle(egg).textAlign}）`,
      );
      assert(getComputedStyle(stat).opacity === "1", "没点时正文应当是显示的");
      // 两者叠在同一格里，所以气泡尺寸不该在切换时跳。
      // 先等压扁回弹彻底走完再量，否则量到的是「还在弹」的中间态。
      await wait(240);
      const sizeBefore = el.getBoundingClientRect();

      el.click();
      await wait(400); // 交叉淡化 0.24s
      assert(el.classList.contains("is-egg"), "点完气泡应当带上 is-egg");
      assert(getComputedStyle(egg).opacity === "1", "点完彩蛋应当淡入到全显");
      assert(getComputedStyle(stat).opacity === "0", "点完正文应当淡出");
      const sizeAfter = el.getBoundingClientRect();
      assert(
        Math.abs(sizeAfter.width - sizeBefore.width) <= 1 && Math.abs(sizeAfter.height - sizeBefore.height) <= 1,
        `切换不该让气泡跳尺寸（${Math.round(sizeBefore.width)}×${Math.round(sizeBefore.height)} → ${Math.round(sizeAfter.width)}×${Math.round(sizeAfter.height)}）`,
      );

      send("SHOT: widget-bubble-egg");
      await wait(120);

      el.click();
      await wait(400);
      assert(!el.classList.contains("is-egg"), "再点一次应当切回正文");
      assert(getComputedStyle(stat).opacity === "1", "切回来之后正文应当重新显示");
    }

    /*
     * 实时字数：气泡开着的时候继续写，数字要跟着涨。
     *
     * 这里必须走**真链路**：setContent → (400ms 防抖) 重算章节字数 → StatusBar 的全书字数
     * → noteTotalWords → 挂件那次 200ms 轮询重渲染。直接调 noteTotalWords 只能验算术，
     * 验不出「挂件会不会跟着变」——那正是这个功能的全部意义。
     *
     * 前提是 StatusBar 的 total 真的会动：它 = 各章 words 之和，而夹具里 chapters 是空的
     * （total 恒为 0，effect 一次都不会重跑）。所以先给活动章补一条元数据。
     */
    {
      const st0 = useStore.getState();
      const path = st0.activePath!;
      useStore.setState({
        chapters: [
          {
            path,
            name: path,
            title: "第一章",
            status: "草稿",
            summary: "",
            words: countWords(st0.contents[path] ?? ""),
          },
        ],
      });

      /*
       * 补上 chapters 会让 total 从 0 跳到一个真数，统计那边会把这一跳当「今天写的」记下来。
       * 等它落定后清零，从干净的 0 开始量 —— 顺便这也让「数字是现读的」这件事可验：
       * 清完之后气泡里必须是 0，而不是刚才那个跳变值。
       */
      await wait(400);
      resetTodayNow();

      const img = rootEl()!.querySelector<HTMLElement>(".pw-img")!;
      const at = rootEl()!.getBoundingClientRect();
      const clickFigure = async () => {
        img.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }));
        img.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: at.left + 50, clientY: at.top + 50 }));
        await wait(240);
      };
      const readAmount = () => {
        const el = document.querySelector<HTMLElement>(".pw-bubble .pw-bubble-amount");
        if (!el) return null;
        const n = Number((el.textContent ?? "").replace(/[^\d]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      await clickFigure(); // 点一下人物 → 重新冒泡（同时把彩蛋切回正文、把收起计时重新起算）
      const before = readAmount();
      assert(before === 0, `清零之后气泡里应当显示 0，实际 ${before}`);

      // 往正文里续写（走的是真实的 setContent 路径）
      const extra = "这是一段刚刚敲出来的新正文，用来验证气泡里的数字是实时的。".repeat(6);
      const now = useStore.getState();
      now.setContent(path, (now.contents[path] ?? "") + extra);

      await wait(1400); // 章节字数防抖 400ms + StatusBar 这一次 effect + 挂件的 200ms 轮询
      const after = readAmount();
      assert(after !== null, "写完之后气泡应当还在");
      assert(
        after! > before!,
        `继续写之后气泡里的数字应当跟着涨（${before} → ${after}）`,
      );
      assert(
        getToday().added === after,
        `气泡里显示的应当就是统计当前值（气泡 ${after} / 统计 ${getToday().added}）`,
      );

      /* 菜单里的「重置今日已写」：清零 + 冒个气泡显示 0（走按钮，不是直接调函数） */
      document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
      await wait(260);
      const resetBtn = [...document.querySelectorAll<HTMLButtonElement>(".pw-btn")].find((b) =>
        b.textContent?.includes("重置今日已写"),
      );
      assert(resetBtn, "菜单里应当有「重置今日已写」");
      assert(getToday().added > 0, `点之前应当先攒着一些字（实际 ${getToday().added}）`);

      resetBtn!.click();
      await wait(320);
      assert(getToday().added === 0, `点「重置今日已写」后应当清零，实际 ${getToday().added}`);
      const shown = readAmount();
      assert(shown === 0, `重置后顺手冒出的气泡里应当显示 0，实际 ${shown}`);

      // 收起菜单，把气泡留给下面那条「5 秒自动收起」（它按最后一次冒泡起算）
      document.querySelector<HTMLButtonElement>(".pw-menu-btn")!.click();
      await wait(200);
      assert(!document.querySelector(".pw-menu"), "菜单应当收起来了");
    }

    /*
     * 5 秒自动收起（与参考项目的 BUBBLE_MS = 5000 一致）。
     * 注意上面那两次点击（第一次冒泡 + 抖动用例那一下）都会重置这个计时，
     * 所以这两条断言都按「最后一次点击之后」算，并留足余量——
     * 截图是异步的、会占用主循环，卡在 5 秒边界上断言只会得到一条偶发红。
     */
    await wait(3000);
    assert(document.querySelector(".pw-bubble"), "3 秒时不该收（设定是 5 秒）");
    await wait(2600);
    assert(!document.querySelector(".pw-bubble"), "5 秒后应当自动收起");
  }

  send("PASS: 欧金金 位置 / 尺寸 / 菜单 / 音效 / 隐藏按钮 / 拖动 / 气泡");
}

run().catch((error) => send(`FAIL: ${error.message ?? error}\n${error.stack ?? ""}`));
