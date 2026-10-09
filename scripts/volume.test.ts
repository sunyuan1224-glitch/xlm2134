/*
 * 卷级 + 纲要 的行为测试（纯 Node，复用既有 esbuild，不新增依赖）。
 *
 * 覆盖：
 *   1. 卷识别：findVolumeDir / volumeDisplayName（「第一卷 风起」「卷三」「Volume 2 - The Storm」）；
 *   2. 按卷分组：groupItemsByVolume 的顺序与「无卷」分支；
 *   3. 纲要树：buildBookOutline 的「总纲 → 卷 → 章」结构，以及无卷时没有卷层；
 *   4. EPUB 卷嵌套：nav 里卷 li 包住嵌套 ol 的章、ncx 嵌套 navPoint 且 playOrder 递增、
 *      分卷页进 manifest/spine、OCF 结构（mimetype 第一且未压缩）不破；
 *   5. 无卷时 EPUB 目录仍是扁平章列表（不能因为加了卷功能而改变旧行为）；
 *   6. 新建章节的默认名 nextChapterName：接着前一章的章号排，数字体系跟着前一章走，
 *      不是「第X章」风格就没有默认名（调用方回落到 Untitled）；
 *   7. 章顺序按「第X章」的章号排（中文交给 localeCompare 会按拼音，第二章跑到第一章前面）；
 *   8. 反转显示 isDisplayFlipped：只认书自己与它的子孙，名字前缀相同的另一本不能误判；
 *   9. outlinesRemovedWith：删章 / 删卷时一并消失的纲要（否则 outline/ 里留下孤儿）；
 *  10. 松散章夹在卷与卷之间：chapter-order.json 记的是「直接子项」的混合顺序
 *      （卷目录名 + 章文件名），两个名字都登记时才夹层，否则回落「目录在前」。
 */
import assert from "node:assert/strict";
import {
  bookOutlinePath,
  findVolumeDir,
  groupItemsByVolume,
  volumeDisplayName,
  volumeInfoOf,
  epubVolumeRef,
  isBookOutlinePath,
} from "../src/lib/volume";
import { extractChapterNumber, isOutlineFile, nextChapterName } from "../src/lib/chapter";
import { buildBookOutline, bookTitleFrom } from "../src/lib/bookOutline";
import { buildEpub } from "../src/lib/epubExport";
import {
  bookScopeOf,
  chapterFilesInTreeOrder,
  directChildOrder,
  isDisplayFlipped,
  isVolumeDir,
  missingBookOutlines,
  moveWithinOrder,
  orderDirChapters,
  outlinesRemovedWith,
  placeVolumeInOrder,
  sortTreeNodes,
  type ChapterOrder,
} from "../src/lib/order";
import {
  assertZipMagic,
  assertBalancedXml,
  assertNoBareAmpersand,
  firstEntry,
  textOf,
  unzip,
} from "./export-test-kit";

console.log("=== 卷级 + 纲要 测试开始 ===");

/* ------------------------------------------------------------------ *
 * 1. 卷识别
 * ------------------------------------------------------------------ */

assert.equal(findVolumeDir("我的书/第一卷 风起/001-第一章.md"), "我的书/第一卷 风起");
assert.equal(findVolumeDir("第一卷/001.md"), "第一卷");
assert.equal(findVolumeDir("我的书/第二卷：群星/上/002.md"), "我的书/第二卷：群星", "嵌套子目录也算在该卷里");
assert.equal(findVolumeDir("我的书/第一章.md"), "", "直接放在书目录下的章不属于任何卷");

assert.equal(volumeDisplayName("第一卷 风起"), "风起");
assert.equal(volumeDisplayName("第三卷：群星"), "群星");
assert.equal(volumeDisplayName("第二卷"), "第二卷", "没有卷名时保留原名");
assert.equal(volumeDisplayName("卷三 风云"), "风云");
assert.equal(volumeDisplayName("Volume 2 - The Storm"), "The Storm");

assert.ok(isBookOutlinePath("我的书/总纲.md"), "识别总纲.md");
assert.ok(isBookOutlinePath("我的书/outline/总纲.md"), "新位置 outline/总纲.md 也是书级纲要");
assert.ok(!isBookOutlinePath("我的书/第一卷/卷纲.md"), "卷纲.md 不再是书级纲要");

// 纲要模型：所有纲要都是书目录 outline/ 下的 .md；总纲名固定「总纲.md」
assert.equal(bookOutlinePath("我的书"), "我的书/outline/总纲.md", "总纲落在 outline/ 下");
assert.equal(bookOutlinePath(""), "outline/总纲.md", "根级总纲落在根的 outline/ 下");
assert.ok(isOutlineFile("我的书/outline/总纲.md"), "outline/ 下的总纲算纲要");
assert.ok(isOutlineFile("我的书/outline/风起.md"), "卷纲（默认名取卷名）算纲要");
assert.ok(isOutlineFile("我的书/outline/第一章.md"), "章节纲要（默认名取章名）算纲要");
assert.ok(!isOutlineFile("我的书/第一卷 风起/第一章.md"), "普通章不算纲要");
assert.ok(isOutlineFile("我的书/第一卷/卷纲.md"), "旧位置的 卷纲.md 仍按纲要处理");
assert.ok(isOutlineFile("我的书/总纲.md"), "旧位置的 总纲.md 仍按纲要处理");

/* ------------------------------------------------------------------ *
 * 2. 按卷分组
 * ------------------------------------------------------------------ */

const files = [
  "书/总纲.md",
  "书/第一卷 风起/001-第一章.md",
  "书/第一卷 风起/002-第二章.md",
  "书/第二卷 群星/003-第三章.md",
  "书/楔子.md",
];
const chapterPaths = [
  "书/第一卷 风起/001-第一章.md",
  "书/第一卷 风起/002-第二章.md",
  "书/第二卷 群星/003-第三章.md",
  "书/楔子.md",
];
const groups = groupItemsByVolume(chapterPaths, (p) => p);
assert.equal(groups.length, 3, "两个卷 + 一个无卷分组");
assert.equal(groups[0].volume?.dir, "书/第一卷 风起");
assert.equal(groups[0].volume?.display, "风起");
assert.equal(groups[0].items.length, 2);
assert.equal(groups[1].volume?.display, "群星");
assert.equal(groups[2].volume, null, "不在卷里的章归入 volume=null");
assert.deepEqual(groups[2].items, ["书/楔子.md"]);

// 同一卷的章即使被别的章隔开，也归到同一个组（以首次出现为准）
const interleaved = groupItemsByVolume(
  ["书/第一卷 风起/001.md", "书/楔子.md", "书/第一卷 风起/002.md"],
  (p) => p,
);
assert.equal(interleaved.length, 2, "同卷不因隔断而重复出现");
assert.equal(interleaved[0].items.length, 2);

// 目录名不匹配「第X卷」时，靠卷注册表也能归组
const registeredGroups = groupItemsByVolume(
  ["书/新建卷/001.md", "书/楔子.md"],
  (p) => p,
  new Set(["书/新建卷"]),
);
assert.equal(registeredGroups[0].volume?.dir, "书/新建卷", "注册表里的目录算一卷");
assert.equal(registeredGroups[1].volume, null);

const volInfo = volumeInfoOf("书/第一卷 风起");
assert.equal(volInfo.number, 1, "卷号从目录名解析");
assert.equal(volInfo.name, "第一卷 风起");

/* ------------------------------------------------------------------ *
 * 3. 纲要树（总纲 → 卷 → 章）
 * ------------------------------------------------------------------ */

const texts: Record<string, string> = {
  "书/总纲.md": "# 测试之书\n\n## 主题\n\n## 人物\n",
  "书/第一卷 风起/001-第一章.md": "# 第一章 启程\n\n## 第一节 出发\n\n## 第二节 夜宿\n",
  "书/第二卷 群星/003-第三章.md": "# 第三章 群星\n",
};
const chapters = [
  { path: "书/第一卷 风起/001-第一章.md", title: "第一章 启程" },
  { path: "书/第二卷 群星/003-第三章.md", title: "第三章 群星" },
  { path: "书/楔子.md", title: "楔子" },
];
const outline = buildBookOutline({ files, chapters, texts });

assert.equal(outline.books.length, 1, "识别到一个总纲");
assert.equal(outline.books[0].title, "测试之书", "总纲标题取 H1");
assert.deepEqual(
  outline.books[0].headings.map((h) => h.text),
  ["测试之书", "主题", "人物"],
  "总纲的标题层级完整",
);
assert.equal(outline.volumes.length, 2);
assert.equal(outline.volumes[0].title, "风起", "卷标题取目录名的可读名");
assert.equal(outline.volumes[1].title, "群星", "卷标题取目录名的可读名");
assert.deepEqual(
  outline.volumes[0].chapters[0].headings.map((h) => h.text),
  ["第一章 启程", "第一节 出发", "第二节 夜宿"],
  "章内标题来自 extractOutline",
);
assert.deepEqual(outline.loose.map((c) => c.title), ["楔子"], "无卷的章单独列出");
assert.deepEqual(outline.outlinePaths, ["书/总纲.md"], "纲要文件清单只有总纲.md（面板按需预读）");

// 没有卷的输入：不产生卷层
const noVolumeOutline = buildBookOutline({
  files: ["书/001-第一章.md"],
  chapters: [{ path: "书/001-第一章.md", title: "第一章" }],
  texts: {},
});
assert.equal(noVolumeOutline.volumes.length, 0, "无卷时没有卷层");
assert.equal(noVolumeOutline.loose.length, 1, "章直接列在书下");
assert.equal(noVolumeOutline.books.length, 0, "没有总纲时 books 为空（面板会提示）");

// 卷标题一律用目录名去掉「第X卷」的可读部分
const bareVol = buildBookOutline({
  files: ["书/第一卷 风起/001.md"],
  chapters: [{ path: "书/第一卷 风起/001.md", title: "第一章" }],
  texts: {},
});
assert.equal(bareVol.volumes[0].title, "风起", "没有卷纲.md 时用目录名去掉「第X卷」");

assert.equal(bookTitleFrom("# 我的长篇小说\n\n正文", "书目"), "我的长篇小说");
assert.equal(bookTitleFrom(undefined, "书目"), "书目");

// EPUB 卷引用：标题取目录名的可读名，key 为卷目录
const ref = epubVolumeRef(volInfo);
assert.equal(ref.title, "风起");
assert.equal(ref.key, "书/第一卷 风起");

/* ------------------------------------------------------------------ *
 * 4. EPUB：按卷分组（nav 嵌套 / ncx 嵌套 / 分卷页）
 * ------------------------------------------------------------------ */

const ID = "99999999-8888-4777-8666-555555555555";
const MODIFIED = "2026-10-07T00:00:00Z";

const book = await buildEpub({
  title: "测试之书",
  root: null,
  identifier: ID,
  modified: MODIFIED,
  chapters: [
    {
      title: "第一章 启程",
      markdown: "# 第一章 启程\n\n启程了。\n",
      path: "书/第一卷 风起/001-第一章.md",
      volume: epubVolumeRef(volumeInfoOf("书/第一卷 风起")),
    },
    {
      title: "第二章 夜宿",
      markdown: "# 第二章 夜宿\n\n夜宿。\n",
      path: "书/第一卷 风起/002-第二章.md",
      volume: epubVolumeRef(volumeInfoOf("书/第一卷 风起")),
    },
    {
      title: "第三章 群星",
      markdown: "# 第三章 群星\n\n群星。\n",
      path: "书/第二卷 群星/003-第三章.md",
      volume: epubVolumeRef(volumeInfoOf("书/第二卷 群星")),
    },
  ],
});

assertZipMagic(book.bytes, "按卷 EPUB");
const first = firstEntry(book.bytes);
assert.equal(first.name, "mimetype", "mimetype 仍是第一个条目");
assert.equal(first.method, 0, "mimetype 仍未压缩");
assert.equal(book.volumeCount, 2, "两卷");
assert.equal(book.chapterCount, 3);

const zip = unzip(book.bytes);
assert.ok("OEBPS/text/volume-1.xhtml" in zip && "OEBPS/text/volume-2.xhtml" in zip, "生成两个分卷页");

const opf = textOf(zip, "OEBPS/content.opf");
assertBalancedXml(opf, "content.opf（按卷）");
assertNoBareAmpersand(opf, "content.opf（按卷）");
const manifestHrefs = [...opf.matchAll(/<item\b[^>]*href="([^"]+)"/g)].map((m) => m[1]);
for (const href of manifestHrefs) {
  assert.ok(`OEBPS/${href}` in zip, `manifest 声明的 ${href} 必须真实存在于包内`);
}
const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(
  spineIds,
  ["volume-1", "chapter-1", "chapter-2", "volume-2", "chapter-3"],
  "阅读顺序：分卷页 → 该卷的章",
);

// 分卷页：卷标题（取目录名可读名，经过同样的清洗与转义）
const vol1Page = textOf(zip, "OEBPS/text/volume-1.xhtml");
assertBalancedXml(vol1Page, "volume-1.xhtml");
assert.ok(vol1Page.includes('class="volume-title">风起'), "分卷页显示卷标题");

// nav：卷 li 里嵌套 ol 的章
const nav = textOf(zip, "OEBPS/nav.xhtml");
assertBalancedXml(nav, "nav.xhtml（按卷）");
assertNoBareAmpersand(nav, "nav.xhtml（按卷）");
// nav 里卷是 li，章是它内部嵌套 ol 的 li：从 volume-1 到 volume-2 之间正好是「第一卷」这一整个 li
const vol1Slice = nav.slice(nav.indexOf("text/volume-1.xhtml"), nav.indexOf("text/volume-2.xhtml"));
assert.ok(vol1Slice.startsWith("text/volume-1.xhtml"), "卷 li 以卷链接开头");
assert.ok(vol1Slice.includes('href="text/chapter-1.xhtml"'), "第一卷第 1 章在卷里");
assert.ok(vol1Slice.includes('href="text/chapter-2.xhtml"'), "第一卷第 2 章在卷里");
assert.ok(!vol1Slice.includes("chapter-3.xhtml"), "第二卷的章不能混进第一卷");
assert.ok((vol1Slice.match(/<ol>/g) ?? []).length >= 1, "卷内有嵌套 ol（章列表）");
assert.ok(
  nav.indexOf("风起") < nav.indexOf("第二章 夜宿") && nav.indexOf("第二章 夜宿") < nav.indexOf("群星"),
  "nav 顺序：卷 → 卷内章 → 下一卷",
);
// nav 里每个链接都指向包内真实文件
for (const href of [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
  const file = `OEBPS/${href.replace(/^\.\.\//, "").split("#")[0]}`;
  assert.ok(file in zip, `nav 的 ${href} 必须指向包内文件`);
}

// ncx：嵌套 navPoint + 递增 playOrder
const ncx = textOf(zip, "OEBPS/toc.ncx");
assertBalancedXml(ncx, "toc.ncx（按卷）");
assert.ok(ncx.includes('<meta name="dtb:depth" content="2"/>'), "有卷时目录深度为 2");
const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1]));
assert.deepEqual(orders, [1, 2, 3, 4, 5], "playOrder 在阅读顺序上严格递增");
assert.ok(
  /<navPoint id="navPoint-volume-1" playOrder="1">[\s\S]*?<navLabel><text>风起<\/text><\/navLabel>[\s\S]*?<navPoint id="navPoint-1" playOrder="2">/.test(ncx),
  "ncx 的卷 navPoint 内部嵌套章 navPoint",
);
assert.ok(ncx.indexOf("第三章 群星") > ncx.indexOf("第二章 夜宿"), "ncx 章节顺序与输入一致");

/* ------------------------------------------------------------------ *
 * 5. 无卷时：目录必须保持原来的扁平结构
 * ------------------------------------------------------------------ */

const flat = await buildEpub({
  title: "无卷之书",
  root: null,
  identifier: ID,
  modified: MODIFIED,
  chapters: [
    { title: "第一章", markdown: "# 第一章\n\n正文。\n", path: "书/001-第一章.md" },
    { title: "第二章", markdown: "# 第二章\n\n正文。\n", path: "书/002-第二章.md" },
  ],
});
assert.equal(flat.volumeCount, 0, "不传 volume 时没有卷");
const flatZip = unzip(flat.bytes);
const flatNav = textOf(flatZip, "OEBPS/nav.xhtml");
assertBalancedXml(flatNav, "nav.xhtml（无卷）");
assert.ok(!flatNav.includes("text/volume-"), "无卷不生成分卷页链接");
assert.deepEqual(
  [...flatNav.matchAll(/href="(text\/chapter-\d+\.xhtml)"/g)].map((m) => m[1]),
  ["text/chapter-1.xhtml", "text/chapter-2.xhtml"],
  "无卷时 nav 是扁平的章列表",
);
const flatNcx = textOf(flatZip, "OEBPS/toc.ncx");
assert.ok(flatNcx.includes('<meta name="dtb:depth" content="1"/>'), "无卷时目录深度为 1");
assert.deepEqual(
  [...flatNcx.matchAll(/playOrder="(\d+)"/g)].map((m) => Number(m[1])),
  [1, 2],
  "无卷时 playOrder 从 1 连续递增",
);
const flatOpf = textOf(flatZip, "OEBPS/content.opf");
assert.deepEqual(
  [...flatOpf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]),
  ["chapter-1", "chapter-2"],
  "无卷时 spine 保持输入顺序",
);

/* ------------------------------------------------------------------ *
 * 6. 卷注册表 + 章手动顺序（本次「新建卷 / 拖动排序」需求的纯逻辑）
 * ------------------------------------------------------------------ */

// 卷注册表：目录名不匹配「第X卷」也能被识别为卷
const registry = new Set(["书/新建卷", "风起"]);
assert.equal(findVolumeDir("书/新建卷/001.md", registry), "书/新建卷", "注册表里的目录识别为卷");
assert.equal(findVolumeDir("书/新建卷/001.md"), "", "不传注册表时「新建卷」不是卷（必须靠登记）");
assert.equal(findVolumeDir("风起/001.md", registry), "风起", "改名为「风起」后仍靠注册表识别为卷");
assert.equal(findVolumeDir("书/第一卷 风起/001.md", registry), "书/第一卷 风起", "名字匹配的卷不需要登记");
assert.ok(isVolumeDir("新建卷", "书/新建卷", registry), "isVolumeDir 认注册表");
assert.ok(!isVolumeDir("新建卷", "书/新建卷", new Set()), "isVolumeDir 没有注册表时不认「新建卷」");

// 书层级判定：顶层是卷时归属工作区根，否则取第一段目录名
assert.equal(bookScopeOf("书/新建卷/001.md", registry), "书", "顶层书文件夹不是卷");
assert.equal(bookScopeOf("新建卷/001.md", new Set(["新建卷"])), "", "顶层那一段是卷 → 属于根这本「书」");
assert.equal(bookScopeOf("001.md", registry), "", "根级章属于根这本「书」");

// 总纲自动创建判定：有章没总纲才补，空目录/已有总纲不补
assert.deepEqual(
  missingBookOutlines(["书/第一卷 风起/001.md"], new Set()),
  ["书/outline/总纲.md"],
  "总纲的规范位置是 书/outline/总纲.md",
);
assert.deepEqual(missingBookOutlines(["书/总纲.md", "书/第一卷 风起/001.md"], new Set()), [], "旧位置已有总纲不重复创建");
assert.deepEqual(
  missingBookOutlines(["书/outline/总纲.md", "书/第一卷 风起/001.md"], new Set()),
  [],
  "新位置已有总纲不重复创建",
);
assert.deepEqual(
  missingBookOutlines(["001.md"], new Set()),
  [],
  "根级（工作目录）不自动建总纲",
);
assert.deepEqual(
  missingBookOutlines(["新建卷/001.md"], new Set(["新建卷"])),
  [],
  "顶层就是卷时也不在根建总纲",
);
assert.deepEqual(missingBookOutlines([], new Set()), [], "空工作区不触发");
assert.deepEqual(missingBookOutlines(["书/总纲.md"], new Set()), [], "只有总纲没有章也不触发");

// 目录内章顺序：注册表顺序优先，未列入的按文件名兜底
assert.deepEqual(
  orderDirChapters(["a.md", "b.md", "c.md"], ["b.md"]),
  ["b.md", "a.md", "c.md"],
  "列出的章在最前，其余按文件名",
);
assert.deepEqual(moveWithinOrder(["a", "b", "c"], "c", "a", "before"), ["c", "a", "b"], "拖到 a 之前");
assert.deepEqual(moveWithinOrder(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"], "拖到 c 之后");

// 树排序 + 阅读顺序：卷按卷号、章按手动顺序、目录在文件前
const fileNode = (path: string, is_dir: boolean, children: any[] = []) => ({
  path,
  name: path.split("/").pop() as string,
  is_dir,
  children,
});

// 根层排序：散放在工作区根的文件显示在书文件夹上面（默认仍是目录在前）
{
  const rootNodes = [
    fileNode("书", true, [fileNode("书/001.md", false)]),
    fileNode("楔子.md", false),
  ];
  assert.equal(
    sortTreeNodes(rootNodes, new Set(), {}, true)[0].name,
    "楔子.md",
    "根层传 filesFirst 时文件排在书文件夹上面",
  );
  assert.equal(
    sortTreeNodes(rootNodes, new Set(), {})[0].name,
    "书",
    "默认（非根层）仍是文件夹在前",
  );
}

const orderTree = [
  fileNode("书", true, [
    fileNode("书/总纲.md", false),
    fileNode("书/第一卷 风起", true, [fileNode("书/第一卷 风起/b.md", false), fileNode("书/第一卷 风起/a.md", false)]),
    fileNode("书/新建卷", true, [fileNode("书/新建卷/c.md", false)]),
    fileNode("书/楔子.md", false),
  ]),
];
const chapterOrder: ChapterOrder = {
  "书/第一卷 风起": ["b.md", "a.md"],
  "书/新建卷": ["c.md"],
};
const sortedOrderTree = sortTreeNodes(orderTree, registry, chapterOrder);
const dirNames = sortedOrderTree[0].children.map((n) => n.name);
assert.deepEqual(
  dirNames.filter((n) => n !== "总纲.md" && n !== "楔子.md"),
  ["第一卷 风起", "新建卷"],
  "卷按卷号排（有号的在前，注册表卷靠后）",
);
assert.deepEqual(
  sortedOrderTree[0].children.find((n) => n.name === "第一卷 风起")!.children.map((n) => n.name),
  ["b.md", "a.md"],
  "章不再按数字排序，改按手动顺序",
);
const manualPaths = chapterFilesInTreeOrder(sortedOrderTree);
assert.deepEqual(
  manualPaths,
  ["书/第一卷 风起/b.md", "书/第一卷 风起/a.md", "书/新建卷/c.md", "书/楔子.md"],
  "阅读顺序 = 文件树视觉顺序（卷 → 卷内手动章序 → 松散章）",
);

/* ------------------------------------------------------------------ *
 * 7. 手动顺序贯穿纲要树与 EPUB（共用同一份顺序来源）
 * ------------------------------------------------------------------ */

const manualChapters = manualPaths.map((path) => ({
  path,
  title: path.split("/").pop()!.replace(/\.md$/, ""),
}));
const manualFiles = [
  "书/总纲.md",
  "书/第一卷 风起/b.md",
  "书/第一卷 风起/a.md",
  "书/新建卷/c.md",
  "书/楔子.md",
];
const manualOutline = buildBookOutline({
  files: manualFiles,
  volumes: [...registry],
  chapters: manualChapters,
  texts: { "书/总纲.md": "# 测试之书\n" },
});
assert.equal(manualOutline.volumes.length, 2, "注册表卷 + 名字卷共两个卷");
assert.equal(manualOutline.volumes[0].info.dir, "书/第一卷 风起");
assert.deepEqual(
  manualOutline.volumes[0].chapters.map((c) => c.path),
  ["书/第一卷 风起/b.md", "书/第一卷 风起/a.md"],
  "纲要第一卷里的章保持手动顺序 b → a",
);
assert.equal(manualOutline.volumes[1].info.dir, "书/新建卷", "注册表卷进入纲要卷层");
assert.deepEqual(manualOutline.loose.map((c) => c.path), ["书/楔子.md"], "松散章照常列出");

const manualBook = await buildEpub({
  title: "测试之书",
  root: null,
  identifier: ID,
  modified: MODIFIED,
  chapters: manualChapters.map((c) => ({
    title: c.title,
    markdown: `# ${c.title}\n\n正文。\n`,
    path: c.path,
    volume:
      findVolumeDir(c.path, registry) === "书/第一卷 风起" || findVolumeDir(c.path, registry) === "书/新建卷"
        ? epubVolumeRef(volumeInfoOf(findVolumeDir(c.path, registry)))
        : undefined,
  })),
});
const manualZip = unzip(manualBook.bytes);
const manualNav = textOf(manualZip, "OEBPS/nav.xhtml");
assert.deepEqual(
  [...manualNav.matchAll(/href="(text\/chapter-\d+\.xhtml)"/g)].map((m) => m[1]),
  ["text/chapter-1.xhtml", "text/chapter-2.xhtml", "text/chapter-3.xhtml", "text/chapter-4.xhtml"],
  "EPUB 章 href 按输入顺序",
);
// nav 的阅读顺序：b(第一卷) → a(第一卷) → c(新建卷) → 楔子
const manualTitles = [...manualNav.matchAll(/<a href="text\/chapter-\d+\.xhtml">([^<]+)<\/a>/g)].map((m) => m[1]);
assert.deepEqual(manualTitles, ["b", "a", "c", "楔子"], "EPUB 目录顺序 = 手动顺序（b→a→c→楔子）");

/* ------------------------------------------------------------------ *
 * 6. 新建章节的默认名：接着前一章的章号往下排
 * ------------------------------------------------------------------ */

// 中文数字：一路递进，含 十 / 百 的进位
assert.equal(nextChapterName("第一章"), "第二章", "中文数字顺延");
assert.equal(nextChapterName("第九章"), "第十章");
assert.equal(nextChapterName("第十章"), "第十一章", "十九以后读作「十一」不是「一十一」");
assert.equal(nextChapterName("第十九章"), "第二十章");
assert.equal(nextChapterName("第九十九章"), "第一百章");
assert.equal(nextChapterName("第一章.md"), "第二章", "带着扩展名也能认");

// 阿拉伯数字与罗马数字：沿用前一章的数字体系，不混用
assert.equal(nextChapterName("第3章"), "第4章", "阿拉伯数字沿用阿拉伯");
assert.equal(nextChapterName("第 12 章"), "第13章");
assert.equal(nextChapterName("第I章"), "第II章", "罗马数字沿用罗马");
assert.equal(nextChapterName("第IV章"), "第V章");
assert.equal(nextChapterName("第IX章"), "第X章");
assert.equal(nextChapterName("第X章"), "第XI章");

// 章号后面带标题：数字照样递进，标题不跟过来
assert.equal(nextChapterName("第一章 启程"), "第二章", "标题不跟过来");
assert.equal(nextChapterName("第三章：群星"), "第四章");

// 不是「第X章」格式就没有默认名 —— 调用方回落到 Untitled
assert.equal(nextChapterName("楔子"), null, "「楔子」不是第X章");
assert.equal(nextChapterName("序章"), null);
assert.equal(nextChapterName("第四次修改"), null, "「第…次」不算章号");
assert.equal(nextChapterName("第一章后记"), null, "章号后面直接接字（没有分隔）不算标题");
assert.equal(nextChapterName("第一回"), null, "「第X回 / 第X节」这类其它格式不认");
assert.equal(nextChapterName(null), null, "目录里还没有章");
assert.equal(nextChapterName(""), null);

/* ------------------------------------------------------------------ *
 * 7. 一个目录里的章按章号排 —— 不能交给中文拼音
 *
 * localeCompare("zh-CN") 给中文按拼音比大小：二 < 三 < 十 < 四 < 一，
 * 于是新建的「第二章」会排到「第一章」上面。章号得自己算出来比。
 * ------------------------------------------------------------------ */

const chapterDirOrder = (names: string[], listed: string[] = []): string[] =>
  sortTreeNodes(
    [fileNode("书", true, names.map((n) => fileNode(`书/${n}`, false)))],
    new Set(),
    listed.length ? { 书: listed } : {},
  )[0].children.map((n) => n.name);

assert.deepEqual(
  chapterDirOrder(["第三章.md", "第一章.md", "第十章.md", "第二章.md"]),
  ["第一章.md", "第二章.md", "第三章.md", "第十章.md"],
  "没登记手动顺序时按章号排（拼音序会排成 二/三/十/一）",
);
assert.deepEqual(
  chapterDirOrder(["第一章.md", "第二章.md", "第三章.md", "第四章.md"]),
  ["第一章.md", "第二章.md", "第三章.md", "第四章.md"],
  "新建的章落在已有章后面（「新章节显示在上一章上侧」就是这条坏了）",
);
assert.deepEqual(
  chapterDirOrder(["第一章.md", "第四章.md", "第二章.md"]),
  ["第一章.md", "第二章.md", "第四章.md"],
  "顺序乱了也按章号摆正，不看文件名的排法",
);
assert.deepEqual(
  chapterDirOrder(["第X章.md", "第II章.md", "第I章.md"]),
  ["第I章.md", "第II章.md", "第X章.md"],
  "罗马数字章号也按数值排",
);
assert.deepEqual(
  chapterDirOrder(["第一章.md", "第二章.md"], ["第二章.md", "第一章.md"]),
  ["第二章.md", "第一章.md"],
  "手动拖过的顺序优先于章号",
);
assert.deepEqual(
  orderDirChapters(["第二章.md", "第一章.md", "第十章.md"], []),
  ["第一章.md", "第二章.md", "第十章.md"],
  "orderDirChapters 的兜底同理（第一次拖动写回的种子顺序不能是拼音序）",
);
assert.equal(extractChapterNumber("第IX章"), 9, "罗马数字章号算得出数");

/* ------------------------------------------------------------------ *
 * 8. 反转显示（右键书 →「反转卷与章的顺序」）
 *
 * 只有「书自己 + 它的子孙」算在里面；反转是纯显示的，sortTreeNodes 根本不认识它，
 * 所以磁盘顺序、chapters 的阅读顺序、EPUB 导出都不受影响。
 * ------------------------------------------------------------------ */

const isFlipped = (path: string, books: string[]): boolean =>
  isDisplayFlipped(path, new Set(books));

assert.equal(isFlipped("书", ["书"]), true, "书自己");
assert.equal(isFlipped("书/第一卷 风起", ["书"]), true, "书下面的卷");
assert.equal(isFlipped("书/第一卷 风起/第一章.md", ["书"]), true, "卷里面的章");
assert.equal(isFlipped("另一本/第一章.md", ["书"]), false, "别的书不受影响");
assert.equal(isFlipped("书稿/第一章.md", ["书"]), false, "名字以「书」开头的另一本不能被误判");
assert.equal(isFlipped("书/第一章.md", []), false, "没有书被反转时处处为假");
assert.equal(isFlipped("", ["书"]), false, "工作区根自己不是书");

/* ------------------------------------------------------------------ *
 * 9. 删章 / 删卷时一并消失的纲要
 *
 * 纲要挂在书的 outline/ 下，不在被删条目的子树里，所以必须显式带上，
 * 否则 outline/ 里会留下一堆对不上任何章的孤儿（大纲页会一直列着）。
 * ------------------------------------------------------------------ */

const OUTLINE_WORLD = [
  "书/outline/总纲.md",
  "书/outline/第一卷 风起.md",
  "书/outline/第一章.md",
  "书/outline/第二章.md",
  "书/第一章.md",
  "书/第九章.md",
  "书/第一卷 风起/第一章.md",
  "书/第二卷/第二章.md",
  "散章.md",
];
const removedOutlines = (target: string, volumes: string[] = []): string[] =>
  outlinesRemovedWith(target, OUTLINE_WORLD, new Set(volumes)).slice().sort();

assert.deepEqual(
  removedOutlines("书/第一章.md"),
  ["书/outline/第一章.md"],
  "删章 → 连带删掉它的章节纲要",
);
assert.deepEqual(
  removedOutlines("书/第一卷 风起"),
  ["书/outline/第一卷 风起.md", "书/outline/第一章.md"],
  "删卷 → 卷纲 + 卷里各章的章节纲要",
);
assert.deepEqual(
  removedOutlines("书/第二卷"),
  ["书/outline/第二章.md"],
  "卷纲文件不存在就不列，只删实际存在的",
);
assert.deepEqual(
  removedOutlines("书"),
  [],
  "删整本书不用单列：outline/ 就在书目录里，跟着一起走",
);
assert.deepEqual(
  removedOutlines("书/第九章.md"),
  [],
  "章没有对应纲要时什么都不删",
);
assert.deepEqual(
  removedOutlines("散章.md"),
  [],
  "散在工作区根下的章不属于任何书，也就没有纲要",
);
assert.deepEqual(
  removedOutlines("书/outline/第一章.md"),
  [],
  "删纲要自己不会再牵连别的纲要",
);
assert.deepEqual(
  removedOutlines("书/没有这个条目"),
  [],
  "工作区里压根没有的路径，安全返回空",
);

/* ------------------------------------------------------------------ *
 * 10. 松散章夹在卷与卷之间
 *
 * 书目录那份列表里可以同时出现卷目录名与松散章文件名，松散章因此能插进两卷之间；
 * 只有两个名字都登记在列表里时才按列表夹层，否则回落到「目录在文件前」——
 * 旧工作区（列表里只有章名）的排列因此完全不变。
 * ------------------------------------------------------------------ */

const interleavedTree = [
  fileNode("书", true, [
    fileNode("书/第一卷 风起", true, [fileNode("书/第一卷 风起/第一章.md", false)]),
    fileNode("书/第二卷 惊蛰", true, [fileNode("书/第二卷 惊蛰/第三章.md", false)]),
    fileNode("书/第二章.md", false),
  ]),
];
const interleavedOrder: ChapterOrder = {
  "书": ["第一卷 风起", "第二章.md", "第二卷 惊蛰"],
};

const interleavedSorted = sortTreeNodes(interleavedTree, new Set(), interleavedOrder);
assert.deepEqual(
  interleavedSorted[0].children.map((n) => n.name),
  ["第一卷 风起", "第二章.md", "第二卷 惊蛰"],
  "松散章夹在两卷之间（卷不再一律排在文件前）",
);
assert.deepEqual(
  chapterFilesInTreeOrder(interleavedSorted),
  ["书/第一卷 风起/第一章.md", "书/第二章.md", "书/第二卷 惊蛰/第三章.md"],
  "阅读顺序（也是大纲与 EPUB 的顺序）跟着夹层走",
);

// 旧侧车：列表里只有章名 → 卷仍在文件前
assert.deepEqual(
  sortTreeNodes(interleavedTree, new Set(), { "书": ["第二章.md"] })[0].children.map((n) => n.name),
  ["第一卷 风起", "第二卷 惊蛰", "第二章.md"],
  "列表里没有卷名时，卷照旧排在松散章前面",
);

// 表里登记过卷 = 夹层模式：只登记一边时，登记过的排在前面（未登记的排在已登记之后，
// 与 orderDirChapters 同一套约定）。这条必须是全序 —— 否则 Array.sort 会给出乱序。
assert.deepEqual(
  sortTreeNodes(interleavedTree, new Set(), {
    "书": ["第二卷 惊蛰", "第二章.md"],
  })[0].children.map((n) => n.name),
  ["第二卷 惊蛰", "第二章.md", "第一卷 风起"],
  "夹层模式下：登记过的在前，没登记的 第一卷 落到最后",
);

// 登记过的表里若还有隐藏目录（outline/）也不会把比较器绕成环：
// 同一层排序必须是全序，否则每次刷新都可能是另一个顺序。
{
  const withOutline = [
    fileNode("书", true, [
      fileNode("书/第一卷 风起", true, [fileNode("书/第一卷 风起/第一章.md", false)]),
      fileNode("书/第二卷 惊蛰", true, [fileNode("书/第二卷 惊蛰/第三章.md", false)]),
      fileNode("书/outline", true, [fileNode("书/outline/总纲.md", false)]),
      fileNode("书/第二章.md", false),
    ]),
  ];
  const once = sortTreeNodes(withOutline, new Set(), interleavedOrder)[0].children.map((n) => n.name);
  const twice = sortTreeNodes(
    [{ ...withOutline[0], children: [...withOutline[0].children].reverse() }],
    new Set(),
    interleavedOrder,
  )[0].children.map((n) => n.name);
  assert.deepEqual(once, ["第一卷 风起", "第二章.md", "第二卷 惊蛰", "outline"], "有 outline 目录时仍按夹层排");
  assert.deepEqual(twice, once, "换个输入顺序结果必须一样（比较器是全序，不是碰运气）");
}

// 反转显示：整层倒过来之后，松散章仍夹在同样两卷之间
assert.deepEqual(
  [...interleavedSorted[0].children].reverse().map((n) => n.name),
  ["第二卷 惊蛰", "第二章.md", "第一卷 风起"],
  "反转显示只是把夹层跟着倒过来，仍在这两卷之间",
);

// 拖动落点写回的就是这份「卷名 + 章名」的顺序
assert.deepEqual(
  directChildOrder(interleavedTree[0].children, new Set(), interleavedOrder),
  ["第一卷 风起", "第二章.md", "第二卷 惊蛰"],
  "直接子项顺序 = 文件树这一层的视觉顺序",
);
assert.deepEqual(
  directChildOrder(interleavedTree[0].children, new Set(), {}),
  ["第一卷 风起", "第二卷 惊蛰", "第二章.md"],
  "没有侧车时兜底：卷按卷号在前，松散章在后",
);

// 新建 / 改名卷：插进已登记的卷堆里，而不是掉到表尾的松散章下面
assert.deepEqual(
  placeVolumeInOrder(["第一卷 风起", "第二卷 惊蛰", "第二章.md"], "第三卷 群山"),
  ["第一卷 风起", "第二卷 惊蛰", "第三卷 群山", "第二章.md"],
  "新卷接在最后一个已登记的卷后面，不越过表尾的松散章",
);
assert.deepEqual(
  placeVolumeInOrder(["第二卷 惊蛰", "第二章.md"], "第一卷 风起"),
  ["第一卷 风起", "第二卷 惊蛰", "第二章.md"],
  "卷号更小 → 插到第一个卷号更大的卷之前",
);
assert.deepEqual(
  placeVolumeInOrder(["第一卷 风起", "第二章.md"], "新建卷"),
  ["第一卷 风起", "新建卷", "第二章.md"],
  "还没有卷号（刚建出来叫「新建卷」）→ 也接在卷堆后面",
);
assert.deepEqual(
  placeVolumeInOrder(["第二章.md"], "第一卷 风起"),
  ["第二章.md"],
  "表里没登记过卷（旧工作区）→ 原样返回，不去制造夹层模式",
);
assert.deepEqual(
  placeVolumeInOrder(["第一卷 风起", "第二章.md", "第二卷 惊雷"], "第二卷 惊雷"),
  ["第一卷 风起", "第二章.md", "第二卷 惊雷"],
  "只改卷名、没改号（本来就是最后一个卷）→ 原地不动，不越过夹在它前面的松散章",
);
assert.deepEqual(
  placeVolumeInOrder(["第一卷 风起", "第二章.md", "第五卷 星海"], "第五卷 星海"),
  ["第一卷 风起", "第二章.md", "第五卷 星海"],
  "改名没改号、已经不是最后一个卷 → 也待在原地",
);

console.log("=== 所有 卷级 + 纲要 测试通过 ===");
