/*
 * 即时预览（Live Preview）。
 *
 * 三条原则：
 *  1) 预览所见 == 导出所得：块级 HTML 全部由 mdExport.markdownToHtml 生成（正文转义 +
 *     无属性标签白名单），这里只做「无害增强」：给图片加交互、把链接点回源码。
 *  2) 渲染只读、写回最小：点击只移动光标，绝不把渲染结果写回文档。
 *  3) 完全离线：不联网，也不执行文档里的任何脚本。
 *
 * 面向小说写作：这一层不再做代码高亮、公式（KaTeX）与图表（Mermaid）；
 * 围栏代码块由 mdExport 输出纯 <pre><code>（仍可复制）。
 * 正文里若还写着 `- [ ] 待办`，mdExport 会照旧渲染成禁用的复选框，本模块不管它。
 */
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdownToHtml, escapeHtml } from "../lib/mdExport";
import { findAnchorPos } from "../lib/links";
import { frontmatterEndLine } from "../lib/outline";
import { blockComplexity } from "../lib/markdownBlocks";

/* ================================================================== *
 * 1. 块渲染：把全文上下文（引用定义）交给 mdExport
 * ================================================================== */

export interface PreviewOptions {
  onLink?: (href: string, mod: boolean) => void;
  image?: (src: string) => Promise<string | null>;
  /**
   * 当前排版参数（字号 / 行高 / 正文栏宽度）。
   * 只给「还没渲染到屏幕上的块」估高度用 —— 那一步会把估算值写进 CodeMirror 的高度表，
   * 也就是滚动条的量程，估错了拖动滚动条时条与内容就会一路错位（见 estimatedHeight）。
   */
  metrics?: () => BlockMetrics | null;
}

/* ================================================================== *
 * 未渲染块的高度估算
 *
 * 为什么必须有这个：
 *   CodeMirror 只测量**已经画出来**的行，屏幕外的高度靠估。整块渲染的段落是 block replace
 *   widget，而 WidgetType.estimatedHeight 默认是 -1（未知），此时它按「一行」计入总高
 *   （@codemirror/view 的 NodeBuilder.point：`if (height < 0) height = this.oracle.lineHeight`）。
 *   一个渲染后 2~3 行的段落被算成 1 行 → 整篇总高被低估三成。
 *
 *   这份估算会以 `.cm-gap` 垫片的形式落到 DOM 上，就是浏览器滚动条的量程：往下拖的时候，
 *   新滚进视口的块被真量、垫片被撑大，量程一路变长 → 滑块和内容越拖越对不上。
 *   实测 8 万字章节：拖动中总高 83655px → 118020px（+41%），而帧间隔一直是正常的 16.4ms ——
 *   手感的根源是量程在变，不是主线程卡。测量脚本：scripts/test-scroll-perf.mjs。
 *
 *   这里的估算不参与真实排版：真量到以后一律以实测高度为准，只影响「还没量到的时候先按多少算」。
 * ================================================================== */

export interface BlockMetrics {
  /** 正文字号 px（--editor-font-size） */
  fontSize: number;
  /** 行高倍数（--editor-line-height），行盒高度 = fontSize × lineHeight */
  lineHeight: number;
  /** 渲染块的**文字**可用宽度 px（已扣掉 .cm-content 与 .cm-lp-rendered 的左右 padding） */
  textWidth: number;
  /** 根字号 px：.cm-lp-rendered 里的 rem 边距按它换算 */
  rem: number;
}

/** 标题字号倍数，与 typora.css 的 .editor-host h1~h6 保持一致 */
const HEADING_SCALE = [0, 1.5, 1.25, 1.15, 1.08, 1.04, 1.04];

/**
 * 一个块源码折算出「几个汉字宽」：汉字与全角标点算 1，其余非空白字符算 0.5（半个字宽）。
 * 折半的依据是字体：中文字体里一个汉字约等于两个 ASCII 字符宽（半个字宽的那类字符
 * 在排版上占位就是一半），Markdown 标记字符（#、*、-）也算 0.5，量少不单独剥。
 */
/*
 * 宽字符（占满一个字宽）：CJK 汉字与标点、假名、谚文、全角符号，外加补充平面汉字。
 * 用码点区间直接比，不逐字符跑正则：改文档时这一趟要给所有块各算一遍（长篇上千块），
 * 每次都比较 + 正则对象都会拖慢打字 —— 虽然相比「重建全部预览块」那一步只是零头。
 * 注意别写成 \u20000 这种没带 u 标志的转义：那会被拆成 "\u2000" + "0"，区间全乱
 * （曾经因此把拉丁字母也按一个字宽算，英文段落每块多估一整行）。
 */
function isWide(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x2e80 && c <= 0x303f) ||
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x20000 && c <= 0x3ffff)
  );
}

function widthUnits(raw: string): number {
  let units = 0;
  for (const ch of raw) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    units += isWide(ch) ? 1 : 0.5;
  }
  return units;
}

/** 一个块的高度估算提示：建 state 时算一次，estimatedHeight 只做乘法 */
export interface BlockHint {
  units: number;
  /** 标题级别（1~6），非标题是 0 */
  heading: number;
  /** 围栏代码块的行数（不含围栏本身），非代码块是 0 */
  codeLines: number;
}

export function blockHint(raw: string): BlockHint {
  const head = /^(#{1,6})[ \t]/.exec(raw);
  if (head) return { units: widthUnits(raw), heading: head[1].length, codeLines: 0 };
  if (/^```/.test(raw)) {
    // 围栏代码块不折行（pre code 是 white-space: pre），行数就是源码行数
    const lines = raw.split("\n");
    return { units: 0, heading: 0, codeLines: Math.max(1, lines.length - 2) };
  }
  return { units: widthUnits(raw), heading: 0, codeLines: 0 };
}

/**
 * 估算这个块渲染出来大概多高。
 *
 * 文字块：折行数 × 行盒 + 段落外边距（.cm-lp-rendered p 是 margin: .45rem 0，合计 0.9rem）。
 * 标题：字号按 typora.css 的倍数放大，再加自己的 margin（.75em / .5em 上边距，-.25em 下边距）。
 * 代码块：等宽 .88em、四周 padding .6rem + 1px 边框。
 * 图片 / 表格 / 分割线等少见块走文字块那条，属于粗估（见交付说明）。
 */
export function estimateBlockHeight(hint: BlockHint, m: BlockMetrics): number {
  const lineBox = m.fontSize * m.lineHeight;
  if (hint.heading > 0) {
    const scale = HEADING_SCALE[hint.heading] ?? 1;
    const em = m.fontSize * scale;
    const top = (hint.heading <= 2 ? 0.75 : 0.5) * em;
    return lineBox * scale + top - 0.25 * em;
  }
  if (hint.codeLines > 0) {
    const box = m.fontSize * 0.88 * m.lineHeight;
    return hint.codeLines * box + 1.2 * m.rem + 2;
  }
  const perLine = Math.max(1, m.textWidth / m.fontSize);
  const lines = Math.max(1, Math.ceil(hint.units / perLine));
  // 故意不取整：整块渲染的块成百上千，每块舍掉 0.3px 叠起来就是几百 px 的量程漂移
  return lines * lineBox + 0.9 * m.rem;
}

/*
 * 排版参数的读取与缓存。
 *
 * 一次高度表重建会把每个块的 estimatedHeight 都问一遍（长篇上千次），逐次读样式 / 布局
 * 太贵；而参数只在「改字号 / 改行高 / 改窗口宽度」时才变，于是按 200ms 缓存一次。
 * 读不到的场合（视图刚建、还没有 .cm-content）不缓存，免得把一次失败缓存成 200ms 的瞎估。
 */
let metricsCache: { at: number; host: Element | null; m: BlockMetrics } | null = null;
const METRICS_TTL_MS = 200;

export function readBlockMetrics(host: Element | null): BlockMetrics | null {
  const now = performance.now();
  if (metricsCache && metricsCache.host === host && now - metricsCache.at < METRICS_TTL_MS) {
    return metricsCache.m;
  }
  const content = host?.querySelector<HTMLElement>(".cm-content");
  if (!content) return null;
  const cs = getComputedStyle(host!);
  const fontSize = parseFloat(cs.getPropertyValue("--editor-font-size"));
  const lineHeight = parseFloat(cs.getPropertyValue("--editor-line-height"));
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // 文字宽度要扣两层左右 padding：.cm-content 的 1rem，以及 .cm-lp-rendered 的 .5rem
  const textWidth = content.clientWidth - 3 * rem;
  if (!fontSize || !lineHeight || textWidth <= 0) return null;
  const m: BlockMetrics = { fontSize, lineHeight, textWidth, rem };
  metricsCache = { at: now, host, m };
  return m;
}

/**
 * 单个顶层块 → HTML。
 *
 * 第三参数必须带上 `document`（整篇正文）：`[a][b]` 这种引用式链接的定义可能写在本块之外，
 * mdExport 是拿 document 去 collectLinkDefs 的，只喂本块源码就查不到定义、链接就散架了。
 *
 * 这里曾经还有一层「先探测 mdExport 支不支持 document，不支持就把全文定义前置进本块源码」的
 * 兼容垫片，**它从来没生效过**：探针里 md 和 document 传的是同一份文本，不跨块也照样能断言成功，
 * 所以探测恒为 true。既然探测是假的、垫片是死的，就一并删了，只留下面这行直接依赖。
 */
function renderBlock(raw: string, doc: string, from: number): string {
  return markdownToHtml(raw, "", { standalone: false, document: doc, sourceOffset: from });
}

/* ================================================================== *
 * 2. 渲染结果的交互增强（只读 DOM；写回永远是「移动光标」）
 * ================================================================== */

/**
 * 图片只从 `data-md-src` 拿路径（没有才退回 src），并立刻摘掉 src：
 * 本地文件必须过工作区的只读图片 API（options.image），http(s) 一律不联网、只显示占位。
 */
function decorateImages(el: HTMLElement, view: EditorView, options: PreviewOptions) {
  el.querySelectorAll<HTMLImageElement>("img").forEach(img => {
    const src = (img.getAttribute("data-md-src") ?? img.getAttribute("src") ?? "").trim();
    img.removeAttribute("src");
    img.classList.add("cm-lp-img");
    if (!src) {
      img.alt = `图片不可用：${img.alt || "路径为空"}`;
      img.classList.add("cm-lp-img-missing");
      return;
    }
    img.dataset.mdSrc = src;
    if (/^data:image\//i.test(src)) {
      // 内嵌 data URL：不会产生任何网络请求
      img.src = src;
      img.onload = () => view.requestMeasure();
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      // 外部协议（http/https/ftp/file…）：离线安全，只显示占位标签
      const chip = document.createElement("span");
      chip.className = "cm-lp-img-external";
      chip.textContent = `🔗 未加载的站外图片：${src}`;
      chip.title = src;
      img.replaceWith(chip);
      return;
    }
    if (!options.image) {
      img.alt = `图片不可用：${img.alt || src}`;
      img.classList.add("cm-lp-img-missing");
      return;
    }
    img.classList.add("cm-lp-img-loading");
    void options.image(src)
      .then(url => {
        img.classList.remove("cm-lp-img-loading");
        if (url) {
          img.src = url;
          img.onload = () => view.requestMeasure();
        } else {
          img.alt = `图片不可用：${img.alt || src}`;
          img.classList.add("cm-lp-img-missing");
        }
        view.requestMeasure();
      })
      .catch(() => {
        img.classList.remove("cm-lp-img-loading");
        img.alt = `图片不可用：${src}`;
        img.classList.add("cm-lp-img-missing");
        view.requestMeasure();
      });
  });
}

function anchorId(href: string): string {
  const raw = href.replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 预览容器内的本地锚点：定位到源码里的对应位置（标题 / 旧文档的脚注锚点）。 */
function revealAnchor(view: EditorView, href: string): boolean {
  const id = anchorId(href);
  if (!id) return false;
  const pos = findAnchorPos(view.state.doc.toString(), id);
  if (pos === null) return false;
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
  return true;
}

function wireWidgetEvents(el: HTMLElement, view: EditorView, from: number, to: number, options: PreviewOptions) {
  el.addEventListener("mousedown", e => {
    const target = e.target as HTMLElement;
    // summary 要走原生 click 才点得开，其它位置不让浏览器抢走光标/选中
    if (target.closest("button,summary")) return;
    e.preventDefault();
    /*
     * 整块渲染的块，按下时自己定落点。
     *
     * CodeMirror 对这种块只知道两端：落在上半截算块首、下半截算块尾，而块尾把换行也算进去
     * （＝下一行的行首）。于是按在长段落的中间往下拖，选区会从下一段开头长出来 ——
     * 用户报的「想选中这一段，结果选中了下一段」就是这么来的。块里的位置 CM 本来就认不出
     * （它只知道整个块），所以：按下先落到块首，按住拖动则把选区从块首拉到手指处。
     * 块首此时已经切回源码可见，posAtCoords 对它是准的；一次普通点击由下面的 click 收起，
     * 仍然是「光标落在本块开头，直接编辑」。
     */
    // 中键/右键、Ctrl+点击链接这些照旧走原生（右键菜单与链接跳转都挂在别处）
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    view.dispatch({ selection: { anchor: from } });
    view.focus();
    // 按下之后本块立刻切回源码，widget 的 DOM 会被换掉：松手事件可能正好落在已被替换
    // 掉的元素上而传不到 document，所以除了 mouseup 还要在 move 里靠 buttons 兜底收尾，
    // 并用按下时的文档核对一下（换章/换文件后这个闭包里的 from 已经没有意义了）。
    const pressedDoc = view.state.doc;
    const ownerDoc = el.ownerDocument;
    const stop = () => {
      ownerDoc.removeEventListener("mousemove", move, true);
      ownerDoc.removeEventListener("mouseup", stop, true);
    };
    const move = (ev: MouseEvent) => {
      if (!ev.buttons || view.state.doc !== pressedDoc) return stop();
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      // 拖到本块里就到本块末尾为止：块首切回源码后行框比渲染块矮，指尖停在原块底部时
      // 那个 y 已经落到下一行了，不夹住的话"拖到这一段末尾"会多选中下一行行首。
      if (pos !== null) view.dispatch({ selection: { anchor: from, head: Math.min(to, pos) } });
    };
    ownerDoc.addEventListener("mousemove", move, true);
    ownerDoc.addEventListener("mouseup", stop, true);
  });
  el.addEventListener("click", e => {
    const target = e.target as HTMLElement;
    if (target.closest("button,summary")) return;
    const link = target.closest("a");
    // 1) 容器内的本地锚点：就地定位源码，绝不发起外部请求
    if (link) {
      const href = link.getAttribute("href") || "";
      if (href.startsWith("#")) {
        e.preventDefault();
        if (revealAnchor(view, href)) return;
      } else if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        options.onLink?.(href, true);
        return;
      }
    }
    e.preventDefault();
    // 2) 其它位置：把光标移到本块源码开头，直接编辑（不改动渲染出来的 DOM）
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
    view.focus();
  });
}

/* ================================================================== *
 * 3. widget 与扩展
 * ================================================================== */

class PreviewWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly from: number,
    readonly to: number,
    readonly options: PreviewOptions,
    readonly hint: BlockHint,
  ) { super(); }
  eq(other: PreviewWidget) { return this.html === other.html && this.from === other.from && this.to === other.to; }
  /**
   * 还没渲染到屏幕上的块，按估算的高度计入总高（默认实现返回 -1＝未知，CodeMirror 会当成
   * 一行，整篇总高因此少算三成，滚动条量程会在拖动过程中一路变长）。真量到以后以实测为准。
   *
   * 排版参数是**懒读**的：widget 建出来的时候（建 state）DOM 还没影，而 estimatedHeight 是
   * 搭高度表时才问的，那时已经能量到样式与宽度了。读不到就返回 -1，退回 CodeMirror 原行为。
   */
  get estimatedHeight() {
    const m = this.options.metrics?.() ?? null;
    return m ? estimateBlockHeight(this.hint, m) : -1;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-lp-rendered";
    // markdownToHtml 已转义正文、只保留无属性白名单行内标签，这里注入是安全的。
    el.innerHTML = this.html;
    decorateImages(el, view, this.options);
    wireWidgetEvents(el, view, this.from, this.to, this.options);
    return el;
  }
  ignoreEvent() { return true; }
}

export function livePreview(options: PreviewOptions = {}): Extension {
  /*
   * 按文档对象缓存的块 HTML。
   *
   * CodeMirror 的 Text 是不可变且结构共享的：文档没动时 `state.doc` 就是同一个引用。
   * 光标移动也会触发重建（激活的块要在「渲染」与「源码」之间切换），但块内容一个字没变，
   * 而重建里最贵的一步是每个块都拿整篇文档跑一遍 markdownToHtml（其中 collectLinkDefs
   * 会扫全文），复杂度是「块数 × 全文行数」——长篇里每按一次方向键都跑一遍就是卡顿的来源。
   * 这里把每个块的渲染结果按区间缓存下来，文档对象没换就直接复用，重建退化成一次树遍历。
   * 缓存以 (from,to) 为键：同一篇文档里相同区间的内容必然相同，所以键本身足够。
   */
  let cacheDoc: EditorState["doc"] | null = null;
  let cacheText = "";
  let cacheFmLine = 0;
  let cacheHtml = new Map<string, string>();

  function build(state: EditorState): DecorationSet {
    const decorations: ReturnType<Decoration["range"]>[] = [];
    if (state.doc !== cacheDoc) {
      cacheDoc = state.doc;
      cacheText = state.doc.toString();
      cacheFmLine = frontmatterEndLine(cacheText.split("\n"));
      cacheHtml = new Map();
    }
    // frontmatter 的范围只随文档变化，跟着上面一起缓存（等价于 frontmatterRange(state)）
    const fm = cacheFmLine ? { from: 0, to: state.doc.line(cacheFmLine).to } : null;
    const doc = cacheText;
    const active = (from: number, to: number) => state.selection.ranges.some(s => {
      const first = state.doc.lineAt(s.from).from;
      const last = state.doc.lineAt(s.to).to;
      return first <= to && last >= from;
    });
    const add = (from: number, to: number, html: string, hint: BlockHint) => {
      if (to > from && !active(from, to)) decorations.push(Decoration.replace({
        widget: new PreviewWidget(html, from, to, options, hint), block: true,
      }).range(from, to));
    };
    if (fm) {
      const fmRaw = state.sliceDoc(fm.from, fm.to);
      add(
        fm.from,
        fm.to,
        `<details class="cm-lp-frontmatter"><summary>YAML 元数据</summary><pre>${escapeHtml(fmRaw)}</pre></details>`,
        blockHint(fmRaw),
      );
    }
    const cursor = (ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state)).cursor();
    if (cursor.firstChild()) do {
      const { to } = cursor;
      const node = cursor.node;
      // 缩进代码块的节点起点在首行缩进之后（Lezer 剥掉了首行缩进），
      // 传块源码时必须回到行首，否则 mdExport 会把它当成「顶格的任务列表」渲染。
      const from = node.name === "CodeBlock" ? state.doc.lineAt(cursor.from).from : cursor.from;
      if (fm && from < fm.to) continue;
      // —— 复杂容器块安全防线：Lezer AST 判定的复杂块不生成 widget，直接保留原生编辑器源码高亮 ——
      // 绝不用正则半吊子递归去破坏嵌套引用/列表/代码，编辑区零失真，光标移入移出完全稳定。
      const complexity = blockComplexity(node);
      if (complexity.fallback) {
        // 只加一个「无渲染、无写回」的提示标记（title 悬停文字 + data 属性，不需要额外 CSS），
        // 源码本身原样留在编辑器里可读可改；光标在块内时连标记也不加。
        if (!active(from, to)) {
          decorations.push(
            Decoration.mark({
              attributes: { "data-md-complex": "1", title: complexity.hint ?? "该块结构复杂，已保留源码" },
            }).range(from, to),
          );
        }
        continue;
      }
      const raw = state.sliceDoc(from, to);
      if (!raw.trim()) continue;
      const key = from + ":" + to;
      let html = cacheHtml.get(key);
      if (html === undefined) {
        html = renderBlock(raw, doc, from);
        cacheHtml.set(key, html);
      }
      add(from, to, html, blockHint(raw));
    } while (cursor.nextSibling());
    return Decoration.set(decorations, true);
  }
  return StateField.define<DecorationSet>({
    create: build,
    update(value, tr) { return tr.docChanged || tr.selection ? build(tr.state) : value; },
    provide: field => EditorView.decorations.from(field),
  });
}

export function isInCode(view: EditorView, pos: number): boolean {
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  for (;;) {
    if (["InlineCode", "FencedCode", "CodeBlock", "Comment"].includes(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

export function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const count = frontmatterEndLine(state.doc.toString().split("\n"));
  return count ? { from: 0, to: state.doc.line(count).to } : null;
}
