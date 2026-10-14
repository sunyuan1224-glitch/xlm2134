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
  /** 段内单换行是否保留（对应 Markdown 设置里的"保留单换行"） */
  preserveLineBreaks?: boolean;
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
function renderBlock(raw: string, doc: string, from: number, preserveLineBreaks = false): string {
  return markdownToHtml(raw, "", {
    standalone: false,
    document: doc,
    sourceOffset: from,
    preserveLineBreaks,
  });
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

function wireWidgetEvents(el: HTMLElement, view: EditorView, from: number, _to: number, options: PreviewOptions) {
  el.addEventListener("mousedown", e => {
    // summary 要走原生 click 才点得开，其它位置不让浏览器抢走光标/选中
    if (!(e.target as HTMLElement).closest("button,summary")) e.preventDefault();
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
  constructor(readonly html: string, readonly from: number, readonly to: number, readonly options: PreviewOptions) { super(); }
  eq(other: PreviewWidget) { return this.html === other.html && this.from === other.from && this.to === other.to; }
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
    const add = (from: number, to: number, html: string) => {
      if (to > from && !active(from, to)) decorations.push(Decoration.replace({
        widget: new PreviewWidget(html, from, to, options), block: true,
      }).range(from, to));
    };
    if (fm) {
      add(fm.from, fm.to, `<details class="cm-lp-frontmatter"><summary>YAML 元数据</summary><pre>${escapeHtml(state.sliceDoc(fm.from, fm.to))}</pre></details>`);
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
        html = renderBlock(raw, doc, from, options.preserveLineBreaks);
        cacheHtml.set(key, html);
      }
      add(from, to, html);
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
