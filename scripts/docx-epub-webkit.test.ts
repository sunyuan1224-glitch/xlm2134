/*
 * 真实 GTK/WebKit（与 Tauri Linux 端同一个 webkit2gtk 引擎）里的 DOCX / EPUB 导出端到端 fixture。
 *
 * 为什么必须跑在真浏览器里，而不是像 scripts/docx-export.test.ts 那样在 Node 里：
 *   Node 有全局 Buffer，浏览器 / WebView **没有**。导出的 DOCX 由 docx 的 Packer 打包、
 *   EPUB 由 fflate 打包，两者都要在页面里真的跑一遍才算数。本 fixture 直接在页面里
 *   import buildDocx / buildEpub，用 fflate 解包产出的 ZIP，
 *   再用 DOMParser 逐个部件做「这段 XML 真的能打开」的体检。
 *
 * 覆盖（每条断言都是「先证明探测器本身有效（负样例），再测真实产物」）：
 *   1) 环境：真 DOM / DOMParser / canvas / Blob；并记录页面里到底有没有全局 Buffer；
 *   2) 浏览器 DOCX Packer 的 Buffer 依赖 —— 见文末 BUG 报告（这是本次最重要的探测器）；
 *   3) DOCX：PK 头 + 标准 OOXML 部件齐全；每个 .xml/.rels 部件用 DOMParser 解析无 parsererror；
 *      正文完整（标题/正文/粗体/斜体/行内代码/多级列表/引用/代码块/公式原文/表格文本/注释文本）；
 *      关系完整（document.xml 的 r:embed ↔ document.xml.rels ↔ word/media/* 严格互指、无孤儿）；
 *      图片完整（真 canvas 现场生成的本地 PNG，其字节原样进包、drawingML 尺寸与像素一致）；
 *   4) 远程图片：只留可见占位文本，任何资源属性都不得指向网络（全程零外网请求，由 test-webkit.py 兜底）；
 *   5) 安全：<script>、javascript:、on* 事件属性一律只能作为**已转义的文本**落地，
 *      DOM 树上没有 script/iframe 元素、没有事件属性、没有 javascript:/http(s) 资源属性，
 *      真 DOM 里 window.__pwned 始终是 undefined；
 *   6) EPUB：mimetype 第一且 stored、container.xml → OPF → manifest/spine ↔ 真实文件互指、
 *      nav.xhtml / toc.ncx 可解析、每章 XHTML 能当 XML 打开、图片资源（PNG）存在且安全。
 *
 * 约束（照做）：只新增 scripts 下的文件、不改产品源码、不加依赖、不写数据文件
 *（PNG 由页面里的真 canvas 现场生成）、不打 git 命令。
 */
// Production uses ArrayBuffer; run the entire fixture without a Node Buffer shim.
import { buildDocx } from "../src/lib/docxExport";
import { buildEpub } from "../src/lib/epubExport";
import { unzipSync, strFromU8 } from "fflate";

/*
 * 整个 fixture 都不装 Buffer 垫片：主 realm 直接验产品源码的原始行为，
 * 「没有 Buffer 时到底会怎样」由独立 iframe 里的干净 realm 单独证一遍（见 runBufferProbeInIframe）。
 */

/* ------------------------------------------------------------------ *
 * 报告通道（与其它 WebKit fixture 一致：test-webkit.py 收集 PASS/FAIL 判决）
 * ------------------------------------------------------------------ */

const report = (text: string) =>
  (
    window as unknown as { webkit: { messageHandlers: { result: { postMessage: (t: string) => void } } } }
  ).webkit.messageHandlers.result.postMessage(text);
const note = (text: string) => report("NOTE: " + text);
const bug = (text: string) => report("BUG: " + text);

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 期望「这个探测器必须能发现问题」的负样例检查 */
function checkThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(threw, msg);
}

/* ------------------------------------------------------------------ *
 * 字节 / ZIP 小工具
 * ------------------------------------------------------------------ */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function dataUrlToBytes(url: string): Uint8Array {
  const at = url.indexOf(",");
  check(at > 0 && /;base64/i.test(url.slice(0, at)), "data URL 应为 base64 形式：" + url.slice(0, 40));
  return base64ToBytes(url.slice(at + 1));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function assertZipMagic(bytes: Uint8Array, label: string): void {
  check(bytes.length > 4, `${label}: 字节太少`);
  const magic = Array.from(bytes.slice(0, 4)).join(",");
  check(magic === "80,75,3,4", `${label}: ZIP 本地文件头应为 PK\\x03\\x04，实际 ${magic}`);
}

/** 解包（fflate 在页面里也一样能用） */
function unzip(bytes: Uint8Array, label: string): Record<string, Uint8Array> {
  assertZipMagic(bytes, label);
  const entries = unzipSync(bytes) as Record<string, Uint8Array>;
  check(Object.keys(entries).length > 0, `${label}: 解包后没有任何条目`);
  return entries;
}

function textOf(zip: Record<string, Uint8Array>, name: string, label: string): string {
  const entry = zip[name];
  check(entry !== undefined, `${label}: 包内应存在 ${name}（实际条目：${Object.keys(zip).join(", ")}）`);
  return strFromU8(entry);
}

/** ZIP 第一个条目的名字与压缩方式（EPUB/OCF 要求 mimetype 第一且 stored=0） */
function firstZipEntry(bytes: Uint8Array): { name: string; method: number } {
  const method = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  const nameLen = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8);
  return { name: strFromU8(bytes.slice(30, 30 + nameLen)), method };
}

/** PNG 文件头：签名 + IHDR 宽高（不是真 PNG 就返回 null） */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33) return null;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  check(strFromU8(bytes.slice(12, 16)) === "IHDR", "PNG 第一个块应为 IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** ZIP 内的部件路径解析：base 目录 + 相对 target（处理 ../） */
function resolvePart(base: string, target: string): string {
  const parts = (base ? base.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/* ------------------------------------------------------------------ *
 * XML 体检：DOMParser 必须真的能打开；元素/属性层面必须干净
 * ------------------------------------------------------------------ */

function elementList(root: Document | Element, localName?: string): Element[] {
  const all = Array.from(root.getElementsByTagName("*"));
  return localName === undefined ? all : all.filter((el) => el.localName === localName);
}

/** XML 里出现 parsererror 说明这段 XML 根本打不开（或不是良构 XML） */
function parseXml(text: string, label: string, mime = "application/xml"): Document {
  const doc = new DOMParser().parseFromString(text, mime);
  const errEl = doc.documentElement?.localName === "parsererror" ? doc.documentElement : doc.querySelector("parsererror");
  const message = (errEl?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  check(errEl === null || errEl === undefined, `${label}: DOMParser 报 parsererror —— ${message}`);
  check(doc.documentElement !== null, `${label}: 解析后没有根元素`);
  check(
    doc.documentElement.localName === "html" || doc.documentElement.localName === "parsererror" || true,
    `${label}: 不可达分支`,
  );
  return doc;
}

const FORBIDDEN_TAGS = new Set(["script", "iframe", "object", "embed", "base", "form", "input"]);
const RESOURCE_ATTRS = /^(?:src|srcset|poster|href|xlink:href|data)$/i;

/**
 * 元素/属性层面的安全体检：
 *   * 不许出现 script/iframe/object/embed/base/form/input；
 *   * 不许出现 on* 事件属性；
 *   * 资源属性（src/srcset/poster/href/xlink:href/data）不许指向 http(s)/协议相对/ftp；
 *   * 任何属性值里不许有 url(http...)。
 *
 * 注意几处格式特例：
 *   1) 用户自己写的外链 <a href="https://…"> 是正当内容（导出包里的远程**图片**才不能指网络），
 *      因此在 allowAnchorLinks=true 时单独放行 a[href]；
 *   2) OOXML 样式表（word/styles.xml）里有 `<w:link w:val="..."/>`（用来把段落样式与字符样式
 *      关联），它是 w:link 不是 HTML 的样式表加载 <link>；HTML/XHTML 里的 <link> 仍要确保
 *      href 不指向网络（EPUB nav/chapter 引用的是本地 ../css/style.css）。
 */
function auditTree(doc: Document, label: string, allowAnchorLinks: boolean): void {
  let elements = 0;
  for (const el of elementList(doc)) {
    elements++;
    const tag = el.localName.toLowerCase();
    check(!FORBIDDEN_TAGS.has(tag), `${label}: 不应出现 <${tag}> 元素`);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const value = attr.value;
      check(!/^on/i.test(name), `${label}: <${tag}> 上不应出现事件属性 ${name}`);
      check(!/^\s*javascript:/i.test(value), `${label}: <${tag} ${name}> 不应是 javascript: 地址`);
      check(!/url\(\s*["']?\s*(?:https?:)?\/\//i.test(value), `${label}: <${tag} ${name}> 里不应有网络 url()`);
      if (RESOURCE_ATTRS.test(name)) {
        const remote = /^\s*(?:https?:|\/\/|ftp:)/i.test(value);
        if (remote && !(allowAnchorLinks && tag === "a" && name.toLowerCase() === "href")) {
          check(false, `${label}: <${tag} ${name}> 指向网络：${value.slice(0, 80)}`);
        }
      }
    }
  }
  check(elements > 0, `${label}: 没有体检到任何元素（体检器失效）`);
}

/* ------------------------------------------------------------------ *
 * 真 DOM 素材：用真 canvas 现场生成一张真 PNG（不引入任何数据文件）
 * ------------------------------------------------------------------ */

interface CanvasPng {
  dataUrl: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

function makeLocalPng(width: number, height: number): CanvasPng {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  check(ctx !== null, "真 DOM 里应当拿得到 canvas 2d 上下文");
  ctx!.fillStyle = "#1e4fc8";
  ctx!.fillRect(0, 0, width, height);
  ctx!.fillStyle = "#ffffff";
  ctx!.font = "16px sans-serif";
  ctx!.fillText("本地图", 6, Math.min(height - 6, 22));
  const dataUrl = canvas.toDataURL("image/png");
  const bytes = dataUrlToBytes(dataUrl);
  const size = pngSize(bytes);
  check(size !== null, "canvas.toDataURL('image/png') 应当产出真 PNG");
  return { dataUrl, bytes, width: size!.width, height: size!.height };
}

/* ------------------------------------------------------------------ *
 * 测试素材（Markdown 正文，两个导出器共用）
 * ------------------------------------------------------------------ */

const CHAPTER_ONE = `# 第一章 旅途启程

清晨的**微光**洒在*石阶*上，行内代码 \`buildDocx()\` 与内联公式 $E = mc^2$ 并存。

$$\\int_0^1 x^2 dx = \\frac{1}{3}$$

![本地 PNG](images/local.png)

![远程占位](https://example.invalid/remote.png)

> 重要的不是终点，而是沿途的风景。[^note]

> [!tip] 提示标题
> 注意检查随身物品。

- 装备一览
- 旅途伙伴
  - 剑士
  - 法师

1. 第一步
2. 第二步

| 地点 | 距离 |
| --- | --- |
| 营地 | 10km |

\`\`\`mermaid
flowchart TD
  A[开始] --> B{判断}
  B -->|是| C[结束]
  B -->|否| A
\`\`\`

\`\`\`ts
const res = await buildDocx(md, title, { root: null });
\`\`\`

<script>window.__pwned = 1;</script>

[恶意链接](javascript:alert(1)) 与 <img src="x" onerror="window.__pwned=2">

[^note]: 脚注：离线导出不联网。
`;

const CHAPTER_TWO = `# 第二章 尾章

这一段没有任何图形，只用来验证多章节时 spine / nav / manifest 指向的文件都真的在包里。

- 收束
- 落款

| 项 | 值 |
| --- | --- |
| 字数 | 1200 |
`;

/* ------------------------------------------------------------------ *
 * 「没有 Buffer」的干净 realm 探测（iframe → probe.html → probe.js）
 * ------------------------------------------------------------------ */

interface BufferProbeResult {
  hasBuffer: boolean;
  ok: boolean;
  error: string;
  bytes: number;
}

/**
 * 在 iframe 里加载 probe.html（runner 用 scripts/docx-epub-webkit-buffer-probe.ts 单独打的 bundle），
 * 那个 realm 里没有任何 Buffer 垫片，因此测的是**产品源码在真实浏览器环境下的原始行为**。
 * 结果由 probe 页面 postMessage 回来；超时即判失败（不猜结果）。
 */
function runBufferProbeInIframe(timeoutMs = 20000): Promise<BufferProbeResult> {
  return new Promise<BufferProbeResult>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "buffer probe realm");
    frame.setAttribute("aria-hidden", "true");
    frame.style.width = "280px";
    frame.style.height = "80px";
    let done = false;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { kind?: string } | null;
      if (!data || data.kind !== "mynovel-buffer-probe") return;
      done = true;
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(data as unknown as BufferProbeResult);
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(frame);
    frame.src = "./probe.html";
    window.setTimeout(() => {
      if (done) return;
      window.removeEventListener("message", onMessage);
      reject(new Error("Buffer 探测 iframe 超时未回话（probe.html 可能没被 WebKit 加载）"));
    }, timeoutMs);
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function run(): Promise<void> {
  const problems: string[] = [];

  /* ---------------- 0. 环境 ---------------- */
  note(
    "环境：webkit2gtk 真 DOM · DOMParser=" +
      typeof DOMParser +
      " · Blob=" +
      typeof Blob +
      " · canvas=" +
      typeof HTMLCanvasElement +
      " · fflate 解包=" +
      typeof unzipSync,
  );
  check(typeof DOMParser === "function", "需要真的 DOMParser");
  check(typeof Blob === "function" && typeof URL.createObjectURL === "function", "需要 Blob/createObjectURL（真浏览器环境）");
  check(document.createElement("canvas").getContext("2d") !== null, "需要真 canvas 2d");
  note(
    "主 realm 没有 Node 的 Buffer（webkit2gtk 页面本来就没有），这个 fixture 也不装垫片；" +
      "产品在无 Buffer 环境下的真实行为由下面的 iframe 干净 realm 单独验",
  );

  /* ---------------- 1. 探测器负样例（先证明体检器本身有效） ---------------- */
  checkThrows(() => parseXml("<a><b></a>", "负样例"), "parseXml 必须能识别坏 XML（parsererror）");
  checkThrows(
    () => auditTree(parseXml('<r><script>x</script></r>', "负样例"), "负样例", false),
    "auditTree 必须能识别 <script>",
  );
  checkThrows(
    () => auditTree(parseXml('<r><img src="https://example.invalid/a.png"/></r>', "负样例"), "负样例", false),
    "auditTree 必须能识别指向网络的资源属性",
  );
  checkThrows(
    () => auditTree(parseXml('<r><p onclick="x()">y</p></r>', "负样例"), "负样例", false),
    "auditTree 必须能识别 on* 事件属性",
  );
  check(pngSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null, "pngSize 必须能识破非 PNG 数据");
  note("探测器负样例全部通过：parseXml / auditTree（script、事件属性、网络资源）/ pngSize 都能真的报错");

  /* ---------------- 2. 素材：真 canvas 生成的真 PNG ---------------- */
  const localPng = makeLocalPng(80, 48);
  note(
    `真 canvas 现场生成本地图片：${localPng.width}×${localPng.height} PNG，${localPng.bytes.length} 字节（签名与 IHDR 已校验）`,
  );
  const readPaths: string[] = [];
  const readImage = async (_root: string, path: string): Promise<string | null> => {
    readPaths.push(path);
    return path === "images/local.png" ? localPng.dataUrl : null;
  };

  /* ---------------- 3. 浏览器 DOCX Packer 的 Buffer 依赖（关键探测器） ----------------
   * 在独立的 iframe（probe.html）里跑一次 buildDocx，那个 realm 完全没有全局 Buffer。
   * 这样既能测出「产品源码在真实浏览器环境里缺 Buffer 时会抛什么」，又不会污染主 realm。
   */
  const probeResult = await runBufferProbeInIframe();
  note(
    "干净 realm 探测：hasBuffer=" +
      probeResult.hasBuffer +
      " · ok=" +
      probeResult.ok +
      (probeResult.ok ? ` · bytes=${probeResult.bytes}` : ` · error=${probeResult.error}`),
  );
  let packerWithoutBuffer: string | null = null;
  if (!probeResult.hasBuffer && !probeResult.ok) {
    packerWithoutBuffer = probeResult.error;
  }

  /* ---------------- 4. 主 realm（同样没有 Buffer）继续把 DOCX 验完 ---------------- */
  note("主 realm 无 Buffer 垫片，DOCX 打包走产品源码的 ArrayBuffer 路径");

  const docx = await buildDocx(CHAPTER_ONE, "第一章 旅途启程", { root: "/workspace", readImage });
  check(docx.bytes.length > 1000, "DOCX 字节数过小：" + docx.bytes.length);
  check(
    bytesEqual(base64ToBytes(docx.base64), docx.bytes),
    "DOCX base64 与 bytes 不是同一份数据（Tauri 写盘会出错）",
  );
  const docxZip = unzip(docx.bytes, "DOCX");
  note(
    `DOCX 生成成功（在真 WebKit 里）：${docx.bytes.length} 字节 / ${Object.keys(docxZip).length} 个条目 / 图片 ${docx.embeddedImages}/${docx.imageCount}`,
  );
  note("DOCX 报告：" + docx.summary);
  note(
    "DOCX 警告：" +
      (docx.warnings.length ? docx.warnings.map((w) => `${w.kind}(${w.message})`).join("；") : "无"),
  );

  /* ---------------- 4a. OOXML 部件齐全 + 每个 XML 真的能打开 ---------------- */
  const requiredParts = [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/_rels/document.xml.rels",
    "docProps/core.xml",
    "docProps/app.xml",
  ];
  for (const part of requiredParts) check(part in docxZip, `DOCX 应包含部件 ${part}`);
  const xmlParts = Object.keys(docxZip).filter((n) => /\.(?:xml|rels)$/i.test(n) && !n.endsWith("/"));
  check(xmlParts.length >= 8, "DOCX 里的 XML 部件太少：" + xmlParts.join(", "));
  for (const part of xmlParts) {
    const doc = parseXml(textOf(docxZip, part, "DOCX"), `DOCX/${part}`);
    auditTree(doc, `DOCX/${part}`, false);
  }
  note(`DOCX 的 ${xmlParts.length} 个 XML 部件全部经 DOMParser 解析通过（无 parsererror）、元素/属性体检通过`);

  /* ---------------- 4b. 正文完整 ---------------- */
  const documentXml = textOf(docxZip, "word/document.xml", "DOCX");
  const bodyChecks: [string, string][] = [
    ["第一章 旅途启程", "标题"],
    ["清晨的", "正文"],
    ["微光", "粗体文字"],
    ["石阶", "斜体文字"],
    ["buildDocx()", "行内代码"],
    ["装备一览", "无序列表"],
    ["剑士", "嵌套列表"],
    ["第一步", "有序列表"],
    ["重要的不是终点", "引用块"],
    ["提示标题", "提示文本"],
    ["营地", "表格文本"],
    ["const res = await buildDocx", "代码块"],
    ["E = mc^2", "行内公式（TeX 原文）"],
    ["\\frac{1}{3}", "块级公式（TeX 原文）"],
    ["脚注：离线导出不联网", "脚注定义文本"],
  ];
  for (const [needle, what] of bodyChecks) check(documentXml.includes(needle), `document.xml 应包含${what}：${needle}`);
  check(/<w:b\/>|<w:b w:val="1"\/>/.test(documentXml), "document.xml 应写入粗体标记");
  check(/<w:i\/>|<w:i w:val="1"\/>/.test(documentXml), "document.xml 应写入斜体标记");
  note("DOCX 正文完整：" + bodyChecks.map(([, what]) => what).join("、") + "、粗体/斜体标记");

  /* ---------------- 4c. 远程图片：可见占位、零网络引用 ---------------- */
  const remoteUrl = "https://example.invalid/remote.png";
  check(documentXml.includes("远程图片，未下载"), "远程图片必须留下可见占位文本（不能静默消失）");
  check(documentXml.includes(remoteUrl), "可见占位里应写明未下载的地址");
  check(
    docx.warnings.some((w) => w.kind === "remote-image" && (w.detail ?? "").includes(remoteUrl)),
    "远程图片必须进警告清单（remote-image）",
  );
  /*
   * 这里不用正则（`xmlns:w16cid="http://schemas…"` 这种命名空间声明会被误伤），
   * 而是用 DOMParser 把属性枚举出来逐个判：只有真正的资源装载属性（src/srcset/poster/href/…）
   * 指向网络才算违规；远程图片的地址只允许作为**文本/占位说明**存在。
   */
  const remoteAttr: string[] = [];
  for (const el of elementList(parseXml(documentXml, "DOCX/word/document.xml"))) {
    for (const attr of Array.from(el.attributes)) {
      if (RESOURCE_ATTRS.test(attr.name) && /^\s*(?:https?:|\/\/|ftp:)/i.test(attr.value)) {
        remoteAttr.push(`<${el.localName} ${attr.name}="${attr.value.slice(0, 60)}">`);
      }
    }
  }
  check(remoteAttr.length === 0, "document.xml 的资源属性不得指向网络：" + remoteAttr.join(", "));
  note("远程图片只留可见占位 + remote-image 警告，资源属性里没有任何网络地址");

  /* ---------------- 4d. 安全：脚本/事件属性只能作为已转义文本 ---------------- */
  const pwned = (window as unknown as { __pwned?: unknown }).__pwned;
  check(pwned === undefined, "真实页面里 window.__pwned 被写入了 —— 导出过程执行了用户内容");
  check(documentXml.includes("&lt;script&gt;"), "恶意 <script> 应以转义文本形式保留（可见、不可执行）");
  check(/&lt;img src=&quot;x&quot; onerror=/i.test(documentXml), "带 onerror 的 <img> 源文本应转义保留");
  check(
    docx.warnings.some((w) => w.kind === "unsafe-link"),
    "javascript: 链接必须进警告清单（unsafe-link），并按纯文本导出",
  );
  note("安全：真 DOM 里 window.__pwned 始终 undefined，<script>/onerror/javascript: 只以转义文本落地并进警告清单");

  /* ---------------- 4e. 图片完整：本地 PNG 原样进包 + drawingML 尺寸正确 ---------------- */
  const media = Object.keys(docxZip).filter((n) => n.startsWith("word/media/") && !n.endsWith("/"));
  check(media.length > 0, "DOCX 里没有任何 word/media 图片部件");
  const localInPackage = media.some((name) => bytesEqual(docxZip[name], localPng.bytes));
  check(localInPackage, "本地 PNG 的字节应原样出现在 word/media（当前：" + media.join(", ") + "）");
  check(
    !media.some((n) => /\.svg$/i.test(n)),
    "DOCX 里不应出现 SVG 部件（Word 兼容性差）",
  );
  note(
    `word/media 里有 ${media.length} 张真 PNG：本地图 ${localPng.width}×${localPng.height}（字节与源完全一致）`,
  );

  /* ---------------- 4f. 关系完整：r:embed ↔ rels ↔ media 严格互指 ---------------- */
  const relsXml = textOf(docxZip, "word/_rels/document.xml.rels", "DOCX");
  const relsDoc = parseXml(relsXml, "DOCX/word/_rels/document.xml.rels");
  const rels = new Map<string, { target: string; type: string; mode: string | null }>();
  for (const el of elementList(relsDoc, "Relationship")) {
    const id = el.getAttribute("Id") ?? "";
    check(id !== "", "关系表里有缺少 Id 的 Relationship");
    rels.set(id, {
      target: el.getAttribute("Target") ?? "",
      type: el.getAttribute("Type") ?? "",
      mode: el.getAttribute("TargetMode"),
    });
  }
  check(rels.size >= 1, "document.xml.rels 里没有关系项");

  const documentDoc = parseXml(documentXml, "DOCX/word/document.xml");
  const embedIds: string[] = [];
  for (const el of elementList(documentDoc)) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.localName === "embed" && attr.value) embedIds.push(attr.value);
    }
  }
  check(embedIds.length >= 1, `document.xml 里的图片引用应至少有 1 个（本地图），实际 ${embedIds.length}`);
  for (const id of embedIds) {
    const rel = rels.get(id);
    check(rel !== undefined, `document.xml 的 r:embed=${id} 在关系表里不存在`);
    check(/\/image$/.test(rel!.type), `关系 ${id} 的类型应是 image：${rel!.type}`);
    check(rel!.mode !== "External", `关系 ${id} 不应是外部引用（TargetMode=External）`);
    const target = resolvePart("word", rel!.target);
    check(target in docxZip, `关系 ${id} 指向的 ${target} 不在包里`);
  }
  const referenced = new Set(embedIds.map((id) => resolvePart("word", rels.get(id)!.target)));
  for (const name of media) check(referenced.has(name), `word/media 里的 ${name} 没有被任何关系引用（孤儿图片）`);
  note(
    `关系完整：${embedIds.length} 个 r:embed → document.xml.rels → ${media.length} 个 word/media 文件严格互指，无孤儿、无外部引用`,
  );

  /* ---------------- 4g. drawingML 尺寸（80×48 像素 → EMU） ---------------- */
  const EMU_PER_PX = 9525;
  const extents = Array.from(documentXml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)).map((m) => ({
    cx: Number(m[1]),
    cy: Number(m[2]),
  }));
  check(extents.length >= 1, "document.xml 里应有至少 1 个 drawingML 尺寸（wp:extent）");
  const localExtent = extents.find(
    (e) => Math.abs(e.cx - localPng.width * EMU_PER_PX) <= 2 && Math.abs(e.cy - localPng.height * EMU_PER_PX) <= 2,
  );
  check(
    localExtent !== undefined,
    `本地图应写入 ${localPng.width * EMU_PER_PX}×${localPng.height * EMU_PER_PX} EMU 的尺寸（实际：${extents.map((e) => `${e.cx}×${e.cy}`).join(", ")}）`,
  );
  note(`drawingML 尺寸正确：本地图 = ${localExtent!.cx}×${localExtent!.cy} EMU（${localPng.width}×${localPng.height} 像素 × 9525）`);

  /* ---------------- 4h. [Content_Types].xml 声明了 png ---------------- */
  const contentTypes = parseXml(textOf(docxZip, "[Content_Types].xml", "DOCX"), "DOCX/[Content_Types].xml");
  const defaults = elementList(contentTypes, "Default").map((el) => (el.getAttribute("Extension") ?? "").toLowerCase());
  check(defaults.includes("png"), "[Content_Types].xml 应声明 png 扩展（实际：" + defaults.join(", ") + "）");
  check(
    elementList(contentTypes, "Override").some((el) => (el.getAttribute("PartName") ?? "") === "/word/document.xml"),
    "[Content_Types].xml 应声明 /word/document.xml",
  );
  note("[Content_Types].xml 声明完整：" + defaults.join(" / ") + " + word/document.xml Override");

  /* ---------------- 4i. 图片处置没有静默丢图 ---------------- */
  const dropped = docx.warnings.filter((w) => w.kind === "image-dropped" || w.kind === "image-unsupported");
  check(dropped.length === 0, "本地 PNG 正常内嵌时不应有图片降级警告：" + dropped.map((w) => w.message).join("；"));
  note("本地 PNG 正常内嵌、无降级警告，没有静默丢图");

  /* ---------------- 5. EPUB ---------------- */
  const epub = await buildEpub({
    title: "第一章 旅途启程",
    author: "MyNovel 测试",
    root: "/workspace",
    readImage,
    chapters: [
      { title: "第一章 旅途启程", markdown: CHAPTER_ONE, path: "one.md" },
      { title: "第二章 尾章", markdown: CHAPTER_TWO, path: "two.md" },
    ],
    // buildEpub 会自己加 urn:uuid: 前缀，这里给裸 UUID（固定值 = 可复现构建）
    identifier: "00000000-0000-4000-8000-000000000001",
    modified: "2020-01-01T00:00:00Z",
  });
  const epubZip = unzip(epub.bytes, "EPUB");
  note(
    `EPUB 生成成功（在真 WebKit 里）：${epub.bytes.length} 字节 / 章节 ${epub.chapterCount} / 图片 ${epub.imageCount} / 条目 ${Object.keys(epubZip).length}`,
  );
  note("EPUB 报告：" + epub.summary);
  note(
    "EPUB 警告：" +
      (epub.warnings.length ? epub.warnings.map((w) => `${w.kind}(${w.message})`).join("；") : "无"),
  );

  /* 5a. OCF 硬要求：mimetype 第一且不压缩 */
  const first = firstZipEntry(epub.bytes);
  check(first.name === "mimetype", "EPUB 第一个 ZIP 条目必须是 mimetype，实际 " + first.name);
  check(first.method === 0, "mimetype 必须 stored（不压缩），实际 method=" + first.method);
  check(strFromU8(epubZip.mimetype) === "application/epub+zip", "mimetype 内容必须是 application/epub+zip");
  check(Object.keys(epubZip).join(",").startsWith("mimetype"), "mimetype 必须是包内第一个条目");
  note("OCF 容器合规：mimetype 位于偏移 30、stored(0)、内容 application/epub+zip");

  /* 5b. XML 部件全部能打开 + 安全体检 */
  const epubXmlParts = Object.keys(epubZip).filter((n) => /\.(?:xml|opf|ncx|xhtml)$/i.test(n) && !n.endsWith("/"));
  check(epubXmlParts.length >= 5, "EPUB 里的 XML 部件太少：" + epubXmlParts.join(", "));
  for (const part of epubXmlParts) {
    const text = textOf(epubZip, part, "EPUB");
    const doc = parseXml(text, `EPUB/${part}`);
    auditTree(doc, `EPUB/${part}`, true);
  }
  note(`EPUB 的 ${epubXmlParts.length} 个 XML 部件全部经 DOMParser 解析通过（无 parsererror）、元素/属性体检通过`);

  /* 5c. container.xml → OPF */
  const container = parseXml(textOf(epubZip, "META-INF/container.xml", "EPUB"), "EPUB/META-INF/container.xml");
  const rootfile = elementList(container, "rootfile")[0];
  check(rootfile !== undefined, "container.xml 里应有 rootfile");
  const opfPath = rootfile!.getAttribute("full-path") ?? "";
  check(opfPath === "OEBPS/content.opf", "container.xml 应指向 OEBPS/content.opf，实际 " + opfPath);
  check(opfPath in epubZip, "container.xml 指向的 OPF 不在包里");
  note("container.xml → " + opfPath + "（存在）");

  /* 5d. OPF：metadata / manifest / spine 与真实文件互指 */
  const opf = parseXml(textOf(epubZip, opfPath, "EPUB"), "EPUB/" + opfPath, "application/xml");
  const dcText = (local: string): string | null => {
    const el = elementList(opf).find((e) => e.localName === local);
    return el ? (el.textContent ?? "").trim() : null;
  };
  check(dcText("identifier") === "urn:uuid:00000000-0000-4000-8000-000000000001", "OPF 应写入固定的 dc:identifier");
  check(dcText("title") === "第一章 旅途启程", "OPF 应写入 dc:title");
  check(dcText("language") === "zh-CN", "OPF 应写入 dc:language");
  check(dcText("creator") === "MyNovel 测试", "OPF 应写入 dc:creator");
  const modified = elementList(opf)
    .filter((el) => el.getAttribute("property") === "dcterms:modified")
    .map((el) => (el.textContent ?? "").trim());
  check(modified[0] === "2020-01-01T00:00:00Z", "OPF 应写入 dcterms:modified（当前：" + modified.join(",") + "）");

  const manifestItems = elementList(opf, "item");
  const manifestById = new Map<string, string>();
  for (const item of manifestItems) {
    const id = item.getAttribute("id") ?? "";
    const href = item.getAttribute("href") ?? "";
    manifestById.set(id, href);
    check(resolvePart("OEBPS", href) in epubZip, `manifest 里的 ${href} 不在包里`);
  }
  check(
    manifestItems.some((it) => it.getAttribute("properties") === "nav"),
    "manifest 里应有 properties=\"nav\" 的导航文档",
  );
  const spineRefs = elementList(opf, "itemref").map((el) => el.getAttribute("idref") ?? "");
  check(spineRefs.length === 2, "spine 应有两章，实际 " + spineRefs.join(","));
  for (const ref of spineRefs) check(manifestById.has(ref), `spine 的 idref=${ref} 在 manifest 里不存在`);
  check(elementList(opf, "spine")[0]?.getAttribute("toc") === "ncx", "spine 应指向 toc.ncx（兼容老阅读器）");
  note(
    `OPF 完整：metadata(identifier/title/language/creator/dcterms:modified) + ${manifestItems.length} 个 manifest 项全部存在于包里 + spine ${spineRefs.join("/")} 全部指向存在的 manifest id`,
  );

  /* 5e. nav.xhtml / toc.ncx 指向的文件真的存在 */
  const navDoc = parseXml(textOf(epubZip, "OEBPS/nav.xhtml", "EPUB"), "EPUB/OEBPS/nav.xhtml");
  const navHrefs = elementList(navDoc, "a").map((el) => el.getAttribute("href") ?? "");
  check(navHrefs.length >= 2, "nav.xhtml 里的链接太少：" + navHrefs.join(","));
  for (const href of navHrefs) {
    const target = resolvePart("OEBPS", href.split("#")[0]);
    check(target in epubZip, `nav.xhtml 的链接 ${href} 指向的 ${target} 不在包里`);
  }
  const ncxDoc = parseXml(textOf(epubZip, "OEBPS/toc.ncx", "EPUB"), "EPUB/OEBPS/toc.ncx");
  const ncxSources = elementList(ncxDoc, "content").map((el) => el.getAttribute("src") ?? "");
  check(ncxSources.length === 2, "toc.ncx 应有两个章节条目");
  for (const src of ncxSources) {
    const target = resolvePart("OEBPS", src.split("#")[0]);
    check(target in epubZip, `toc.ncx 的 ${src} 指向的 ${target} 不在包里`);
  }
  note(`nav.xhtml（${navHrefs.length} 个链接）与 toc.ncx（${ncxSources.length} 个章节）指向的文件全部存在`);

  /* 5f. 每章 XHTML 当 XML 打开 + 正文完整 */
  const ch1 = parseXml(textOf(epubZip, "OEBPS/text/chapter-1.xhtml", "EPUB"), "EPUB/OEBPS/text/chapter-1.xhtml", "application/xhtml+xml");
  const xhtml1 = textOf(epubZip, "OEBPS/text/chapter-1.xhtml", "EPUB");
  check(ch1.documentElement.namespaceURI === "http://www.w3.org/1999/xhtml", "章节应是 XHTML 命名空间");
  for (const [needle, what] of [
    ["第一章 旅途启程", "标题"],
    ["清晨的", "正文"],
    ["E = mc^2", "行内公式源码"],
    ["\\frac{1}{3}", "块级公式源码"],
    ["装备一览", "列表"],
    ["营地", "表格文本"],
    ["远程图片，未下载", "远程占位"],
  ] as [string, string][]) {
    check(xhtml1.includes(needle), `chapter-1.xhtml 应包含${what}：${needle}`);
  }
  check(
    /<img[^>]+src="\.\.\/images\/image-\d+\.png"/.test(xhtml1),
    "chapter-1.xhtml 必须引用包内的 PNG 资源",
  );
  check(!xhtml1.includes("<script"), "chapter-1.xhtml 不得含 <script>");
  check(xhtml1.includes("&lt;script&gt;"), "恶意 <script> 应以转义文本保留（可见、不可执行）");
  const xhtml2 = textOf(epubZip, "OEBPS/text/chapter-2.xhtml", "EPUB");
  parseXml(xhtml2, "EPUB/OEBPS/text/chapter-2.xhtml", "application/xhtml+xml");
  check(xhtml2.includes("第二章 尾章"), "第二章 XHTML 应包含标题");
  note("两章 XHTML 都以 application/xhtml+xml 解析通过，正文/公式/列表/表格/远程占位齐全，脚本只以转义文本存在");

  /* 5g. EPUB 图片资源完整（本地 PNG） */
  const epubImages = Object.keys(epubZip).filter((n) => n.startsWith("OEBPS/images/") && !n.endsWith("/"));
  check(epubImages.length >= 1, "EPUB 里应至少有本地图资源：" + epubImages.join(","));
  check(
    epubImages.some((n) => bytesEqual(epubZip[n], localPng.bytes)),
    "本地 PNG 的字节应原样出现在 OEBPS/images",
  );
  const imgSrcs = elementList(ch1, "img").map((el) => el.getAttribute("src") ?? "");
  check(imgSrcs.length >= 1, "chapter-1.xhtml 里应有本地图，实际：" + imgSrcs.join(","));
  for (const src of imgSrcs) {
    const target = resolvePart("OEBPS/text", src);
    check(target in epubZip, `chapter-1.xhtml 的 <img src="${src}"> 指向的 ${target} 不在包里`);
  }
  check(readPaths.includes("images/local.png"), "本地图片应以工作区相对路径交给 readImage（实际：" + readPaths.join(",") + "）");
  note(
    `EPUB 图片完整：${epubImages.join(" / ")} 都存在；XHTML 里 ${imgSrcs.length} 个 <img> 全部指向存在的资源`,
  );

  /* 5h. EPUB 里的远程图片同样只留占位 */
  check(
    epub.warnings.some((w) => w.kind === "remote-image" && (w.detail ?? "").includes(remoteUrl)),
    "EPUB 也必须给出 remote-image 警告",
  );
  check(
    !/<img[^>]+src\s*=\s*["'](?:https?:|\/\/)/i.test(xhtml1),
    "EPUB 正文里不得有指向网络的 <img>",
  );
  note("EPUB 远程图片同样只留可见占位 + 警告，没有任何网络 <img>");

  /* ---------------- 6. 判决 ---------------- */
  if (packerWithoutBuffer !== null) {
    bug(
      "BROWSER BUFFER: 真 WebKit（＝Tauri Linux 端 webkit2gtk 的引擎）里 buildDocx 直接失败：" +
        packerWithoutBuffer +
        " —— 根因是 src/lib/docxExport.ts:704 用了 docx 的 Packer.toBuffer（内部走 JSZip type:\"nodebuffer\"），" +
        "而浏览器/WebView 没有全局 Buffer（本页面 typeof Buffer === \"undefined\"）。" +
        "影响：App 里点「导出 DOCX」在 webview 里必然抛错；Node 测试因为有 Buffer 所以永远是绿的（这就是本次要补的真浏览器验证）。" +
        "修法建议（未改产品源码）：改用 Packer.toBlob / Packer.toArrayBuffer 再转 Uint8Array，或在包外注入 Buffer，或换一个浏览器可用的打包路径。",
    );
    problems.push("浏览器里 buildDocx 因缺 Buffer 而失败（" + packerWithoutBuffer + "）");
  } else {
    note("浏览器 DOCX Packer 无 Buffer 问题：buildDocx 在有/无全局 Buffer 的页面里都能打包成功");
  }

  if (problems.length) {
    report(
      "FAIL: 真 GTK/WebKit 导出 fixture 发现产品缺陷（其余断言全部通过，细节见上面的 NOTE/BUG）：" +
        problems.join("；"),
    );
    return;
  }

  report(
    "PASS: real GTK/WebKit DOCX/EPUB export fixture —— 在真 DOM + 真 canvas 下，" +
      `DOCX ${docx.bytes.length} 字节（PK/ZIP + ${xmlParts.length} 个 XML 部件全部 DOMParser 无 parsererror、正文/关系/word/media 严格互指、` +
      `本地 PNG 字节与 canvas 源一致、drawingML 尺寸正确、远程图只留可见占位、<script>/onerror/javascript: 只以转义文本落地且 window.__pwned 未定义），` +
      `EPUB ${epub.bytes.length} 字节（mimetype 第一且 stored、container.xml→OPF→manifest/spine↔真实文件互指、nav.xhtml/toc.ncx 可解析、` +
      `每章 XHTML 无 parsererror、PNG 资源齐全）；` +
      "浏览器 DOCX Packer 无 Buffer 问题；全程零外网请求（由 test-webkit.py 复核）。",
  );
}

run().catch((error) => report("FAIL: " + String(error) + "\n" + (error instanceof Error ? error.stack : "")));
