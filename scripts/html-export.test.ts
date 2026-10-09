/*
 * 本地图片自包含 HTML 导出的行为测试（纯 helper + 现有 esbuild，不安装依赖）。
 *
 * 覆盖：
 *  - 工作区内的本地图片被读成 data URL 并写入 src，成功后删除 data-md-src；
 *  - 远程图片只占位、绝不下载（readImage 不会被调用）；
 *  - 本地图片读取失败 / 缺失 / 越界 / 绝对路径 → errors 里明确报错，HTML 里留可见错误占位；
 *  - 完整文档注入安全 CSP（default-src 'none'、img-src data:）；
 *  - 片段模式（剪贴板复制）不注入 CSP；
 *  - 百分号编码、查询串、协议相对地址、data: 地址、属性转义等边界。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  EXPORT_CSP,
  attrOf,
  buildSelfContainedHtml,
  classifyImageRef,
  describeIssues,
  embedWorkspaceImages,
  findImgTags,
  injectCsp,
  parseImgAttrs,
  resolveLocalImagePath,
  summarizeExport,
  unescapeEntities,
} from "../src/lib/htmlExport.ts";

const PNG_A = "data:image/png;base64,QUJD";
const PNG_B = "data:image/png;base64,REVG";

function imgSrcsOf(html: string): string[] {
  return findImgTags(html).map(
    (it) => attrOf(parseImgAttrs(it.tag.replace(/^<img/i, "").replace(/>$/, "")), "src") ?? "",
  );
}

/** 记录调用参数的假 readImage：只认工作区内的这几个文件 */
function fakeReader(files: Record<string, string | null>) {
  const calls: string[] = [];
  const readImage = async (_root: string, path: string): Promise<string | null> => {
    calls.push(path);
    return files[path] ?? null;
  };
  return { calls, readImage };
}

/* ---------------- 纯函数：属性解析与地址分类 ---------------- */

assert.deepEqual(parseImgAttrs(` class="md-img" src="a b.png" alt='图' hidden/`), [
  { name: "class", value: "md-img" },
  { name: "src", value: "a b.png" },
  { name: "alt", value: "图" },
  { name: "hidden", value: null },
]);
assert.equal(unescapeEntities("a&lt;b&gt;&amp;&quot;c&quot;&#39;d&#x4E2D;"), `a<b>&"c"'d中`);
assert.equal(attrOf(parseImgAttrs(` data-md-src="assets/a.png"`), "data-md-src"), "assets/a.png");
assert.equal(attrOf(parseImgAttrs(` alt`), "alt"), null);

assert.equal(classifyImageRef("data:image/png;base64,AA"), "inline");
assert.equal(classifyImageRef("https://example.com/a.png"), "remote");
assert.equal(classifyImageRef("//cdn.example.com/a.png"), "remote");
assert.equal(classifyImageRef("http://127.0.0.1/a.png"), "remote");
assert.equal(classifyImageRef("file:///home/x/a.png"), "unsupported");
assert.equal(classifyImageRef("javascript:alert(1)"), "unsupported");
assert.equal(classifyImageRef("/etc/passwd.png"), "absolute");
assert.equal(classifyImageRef("C:\\pics\\a.png"), "absolute");
assert.equal(classifyImageRef("assets/a.png"), "local");
assert.equal(classifyImageRef("./assets/../assets/a.png"), "local");

assert.equal(resolveLocalImagePath("book", "assets/a.png").path, "book/assets/a.png");
assert.equal(resolveLocalImagePath("book", "../outside.png").path, "outside.png");
assert.ok(resolveLocalImagePath("book", "../../outside.png").error);
assert.ok(resolveLocalImagePath("", "../outside.png").error);
assert.equal(resolveLocalImagePath("book", "assets/a%20b.png").path, "book/assets/a b.png");
assert.equal(resolveLocalImagePath("book", "assets/a.png?v=2#top").path, "book/assets/a.png");
assert.equal(resolveLocalImagePath("", "assets/a.png").path, "assets/a.png");
assert.ok(resolveLocalImagePath("book", "   ").error);
assert.ok(resolveLocalImagePath("book", "?only-query").error);
assert.ok(resolveLocalImagePath("book", "assets/%zz.png").path, "非法百分号编码按原样使用");
assert.equal(resolveLocalImagePath("book", "assets/%zz.png").path, "book/assets/%zz.png");

/* ---------------- 标签扫描 ---------------- */

const scanned = findImgTags(`<p>x</p><img class="a" alt="1 > 0" data-md-src="a.png"><IMG SRC="b.png">tail`);
assert.equal(scanned.length, 2);
assert.equal(scanned[0].tag, `<img class="a" alt="1 > 0" data-md-src="a.png">`);
assert.equal(scanned[1].tag, `<IMG SRC="b.png">`);
assert.deepEqual(findImgTags("<image src='a.png'>"), []);

/* ---------------- CSP 注入 ---------------- */

const doc = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>t</title>\n</head>\n<body><main>hi</main></body>\n</html>\n`;
const withCsp = injectCsp(doc);
assert.ok(withCsp.includes(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`));
assert.ok(withCsp.indexOf("Content-Security-Policy") < withCsp.indexOf("</head>"));
assert.ok(withCsp.includes("<meta charset=\"utf-8\">"));
assert.ok(EXPORT_CSP.includes("default-src 'none'"));
assert.ok(EXPORT_CSP.includes("img-src data:"));
assert.equal(injectCsp(withCsp), withCsp, "CSP 不能重复注入");
assert.ok(injectCsp("<p>无 head 片段</p>").startsWith("<meta http-equiv"));

/* ---------------- 片段：本地图片内嵌 ---------------- */

const seg = await embedWorkspaceImages(
  `<p><img class="md-img" data-md-src="assets/a.png" alt="图A"></p>` +
    `<p><img class="md-img" src="assets/b.png" alt="图B"></p>`,
  { root: "/ws", baseDir: "book", readImage: fakeReader({ "book/assets/a.png": PNG_A, "book/assets/b.png": PNG_B }).readImage },
);
assert.equal(seg.embedded, 2);
assert.equal(seg.errors.length, 0);
assert.equal(seg.remote, 0);
assert.ok(seg.html.includes(`<img src="${PNG_A}" class="md-img" alt="图A">`));
assert.ok(seg.html.includes(`<img src="${PNG_B}" class="md-img" alt="图B">`));
assert.ok(!seg.html.includes("data-md-src"), "嵌入成功后必须删除 data-md-src");
assert.ok(!seg.html.includes('src="assets/'), "本地路径不能留在 src 里");

/* ---------------- 主流程：本地 / 远程 / 内嵌 / 错误 ---------------- */

const md = [
  "# 第一章",
  "",
  "![本地图](assets/a.png)",
  "",
  "![子目录图](assets/sub/b.png)",
  "",
  "![空白图](assets/a%20b.png)",
  "",
  "![内嵌图](data:image/gif;base64,R0lGOD)",
  "",
  "![远程图](https://example.com/remote.png)",
  "",
  "![协议相对图](//cdn.example.com/x.png)",
  "",
  "![缺图](assets/missing.png)",
  "",
  "![越界图](../../outside.png)",
  "",
  "![绝对路径图](/etc/passwd.png)",
  "",
  "![远<程>图](https://example.com/y.png)",
].join("\n");

const reader = fakeReader({
  "book/assets/a.png": PNG_A,
  "book/assets/sub/b.png": PNG_B,
  "book/assets/a b.png": PNG_A,
});
const res = await buildSelfContainedHtml(md, "第一章", {
  root: "/ws",
  baseDir: "book",
  readImage: reader.readImage,
});

// 1. 本地图片内嵌，且只读了明确引用的文件
assert.equal(res.embedded, 3);
assert.equal(res.inline, 1);
assert.equal(res.remote, 3);
assert.equal(res.errors.length, 3);
assert.deepEqual(reader.calls, [
  "book/assets/a.png",
  "book/assets/sub/b.png",
  "book/assets/a b.png",
  "book/assets/missing.png",
]);
assert.ok(reader.calls.every((p) => !/^[a-z]+:/i.test(p) && !p.startsWith("//")));
assert.ok(res.html.includes(`src="${PNG_A}"`));
assert.ok(res.html.includes(`src="${PNG_B}"`));
assert.ok(!res.html.includes("data-md-src"));

// 2. 远程图片只占位：没有可加载的 src，也没有网络地址留在 src 里
assert.equal(res.remote, 3);
assert.equal(res.html.match(/class="[^"]*md-img-remote/g)?.length, 3);
const imgTags = findImgTags(res.html);
const imgSrcs = imgSrcsOf(res.html);
assert.equal(imgTags.length, 4, "本地图片与 data: 图片仍是 <img>，远程图片换成了占位块");
assert.ok(imgSrcs.every((s) => s.startsWith("data:")), `只有 data: 才允许写进 src：${imgSrcs.join(" | ")}`);
// 整篇 HTML 里只有这 4 个 src=，且没有一个是网络地址（data-remote-src / data-md-error-src 不算）
assert.equal((res.html.match(/(?:^|[\s"'])src\s*=/gi) ?? []).length, 4);
assert.ok(!/(?:^|[\s"'])src\s*=\s*["']?(?:https?:)?\/\//im.test(res.html), "远程地址不能出现在 src 属性里");
assert.ok(res.html.includes('data-remote-src="https://example.com/remote.png"'));
assert.ok(res.html.includes("远程图片，未下载"));
assert.ok(res.html.includes("远&lt;程&gt;"), "占位文字必须转义，不能把 Markdown 里的尖括号原样写进 HTML");
assert.ok(!res.html.includes("远<程>"));

// 3. 本地失败明确报错，并在 HTML 里留下可见的错误占位（不静默丢图）
assert.equal(res.errors.length, 3);
assert.equal(res.html.match(/class="[^"]*md-img-error/g)?.length, 3);
const byPath = new Map(res.errors.map((e) => [e.path ?? e.src, e.reason]));
assert.ok(byPath.get("book/assets/missing.png")?.includes("未找到"));
assert.ok(res.errors.some((e) => e.reason.includes("越出工作区")));
assert.ok(res.errors.some((e) => e.src === "/etc/passwd.png" && e.reason.includes("工作区外")));
assert.ok(res.html.includes("图片未能内嵌"));
assert.ok(describeIssues(res.errors).includes("book/assets/missing.png"));
assert.ok(!describeIssues(res.errors).includes("等 "), "3 项错误全部列出时不写省略");
assert.ok(describeIssues(res.errors, 2).includes("等 3 项"), "只列前 2 项时给出剩余数量");
assert.equal(describeIssues([], 2), "");
assert.ok(summarizeExport("已导出", res).includes("已内嵌本地图片 3 张"));
assert.ok(summarizeExport("已导出", res).includes("远程图片 3 张仅占位未下载"));
assert.ok(summarizeExport("已导出", res).includes("本地图片失败 3 张"));

// 4. 完整文档注入安全 CSP 与占位样式
assert.ok(res.csp === EXPORT_CSP);
assert.ok(res.html.startsWith("<!DOCTYPE html>"));
assert.ok(res.html.includes(`content="${EXPORT_CSP}"`));
assert.ok(res.html.includes(".md-img-placeholder"));
assert.ok(res.html.includes(".md-img-error"));

// 5. 片段模式（复制为 HTML 源码）不带 CSP，也不改文档结构
const frag = await buildSelfContainedHtml("![本地图](assets/a.png)", "t", {
  root: "/ws",
  baseDir: "book",
  standalone: false,
  readImage: fakeReader({ "book/assets/a.png": PNG_A }).readImage,
});
assert.equal(frag.csp, null);
assert.ok(!frag.html.includes("Content-Security-Policy"));
assert.ok(!frag.html.includes("<html"));
assert.ok(frag.html.includes(`src="${PNG_A}"`));

/* ---------------- 边界：没有工作区 / 读取抛错 / 图片复读一次 ---------------- */

const noRoot = await buildSelfContainedHtml("![图](assets/a.png)", "t", {
  root: null,
  baseDir: "",
  standalone: false,
  readImage: fakeReader({}).readImage,
});
assert.equal(noRoot.errors.length, 1);
assert.equal(noRoot.errors[0].path, null);
assert.ok(noRoot.errors[0].reason.includes("工作区"));
assert.ok(noRoot.html.includes("md-img-error"));

const boom = await buildSelfContainedHtml("![图](assets/a.png)", "t", {
  root: "/ws",
  baseDir: "",
  standalone: false,
  readImage: async () => {
    throw new Error("路径超出工作区范围: ../x.png");
  },
});
assert.equal(boom.errors.length, 1);
assert.ok(boom.errors[0].reason.includes("读取本地图片失败"));
assert.ok(boom.errors[0].reason.includes("路径超出工作区范围"));

const twice = fakeReader({ "a.png": PNG_A });
const dedup = await embedWorkspaceImages(
  `<img src="a.png" alt="一"><img src="a.png" alt="二">`,
  { root: "/ws", baseDir: "", readImage: twice.readImage },
);
assert.equal(dedup.embedded, 2);
assert.deepEqual(twice.calls, ["a.png"], "同一个图片文件只读一次");

const emptyDoc = await buildSelfContainedHtml("没有图片的正文。", "t", { root: "/ws" });
assert.equal(emptyDoc.embedded, 0);
assert.equal(emptyDoc.errors.length, 0);
assert.equal(emptyDoc.remote, 0);
assert.ok(emptyDoc.html.includes("没有图片的正文。"));
assert.ok(emptyDoc.html.includes("Content-Security-Policy"));

const noSrc = await embedWorkspaceImages(`<img alt="无地址">`, { root: "/ws" });
assert.equal(noSrc.html, `<img alt="无地址">`, "没有地址的图片原样保留");
assert.equal(noSrc.errors.length, 0);

// DOMParser（浏览器/Tauri 环境）可用时，再确认生成的文档结构里没有任何可联网的图片
if (typeof DOMParser !== "undefined") {
  const parsed = new DOMParser().parseFromString(res.html, "text/html");
  const imgs = Array.from(parsed.querySelectorAll("img"));
  assert.equal(imgs.length, 4);
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    assert.ok(src.startsWith("data:"), `img 的 src 必须是 data:，实际是 ${src}`);
  }
}

/* ---------------- 真实文件往返：磁盘字节 → data URL → HTML → 字节 ---------------- */

const ws = await mkdtemp(join(tmpdir(), "mynovel-export-ws-"));
try {
  // 1×1 透明 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(ws, "assets-real.png"), png);
  const realRead = async (root: string, path: string): Promise<string | null> => {
    try {
      const bytes = await readFile(join(root, path));
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  };
  const real = await buildSelfContainedHtml("![真实图片](assets-real.png)", "真图", {
    root: ws,
    baseDir: "",
    readImage: realRead,
  });
  assert.equal(real.embedded, 1);
  assert.equal(real.errors.length, 0);
  const embeddedUrl = imgSrcsOf(real.html)[0];
  assert.ok(embeddedUrl.startsWith("data:image/png;base64,"));
  const roundTrip = Buffer.from(embeddedUrl.slice("data:image/png;base64,".length), "base64");
  assert.deepEqual(roundTrip, png, "内嵌的 data URL 必须还原出原始图片字节");
  assert.ok(real.html.includes("Content-Security-Policy"));
} finally {
  await rm(ws, { recursive: true, force: true });
}

console.log(
  "PASS: html export: local images embedded as data URLs, data-md-src removed, remote images placeholdered without download, explicit errors for local failures, CSP injected, fragments untouched.",
);
