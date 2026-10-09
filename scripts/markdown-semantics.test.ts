import assert from 'node:assert/strict';
import { markdownToHtml, collectLinkDefs, buildFootnoteIndex } from '../src/lib/mdExport.ts';
import { findAnchorPos, findFootnoteAnchorPos, findLinkDefAnchorPos } from '../src/lib/links.ts';

console.log('--- 开始 Markdown 引用语义与脚注索引导航测试 ---');

/* 1. 跨块引用式链接（full / collapsed / shortcut） */
{
  const doc = `前言段落

段落 A：[全引用][my-link] 与 [折叠引用][] 以及 [shortcut-link]。

段落 B：无关内容。

[my-link]: https://example.com/a "链接标题 A"
[折叠引用]: https://example.com/b "链接标题 B"
[shortcut-link]: https://example.com/c
`;

  const blockA = '段落 A：[全引用][my-link] 与 [折叠引用][] 以及 [shortcut-link]。';
  const offsetA = doc.indexOf(blockA);
  assert.ok(offsetA > 0, '需能找到 blockA 在 doc 中的偏移');

  // 单独按块渲染 blockA，传入 document 与 sourceOffset
  const htmlA = markdownToHtml(blockA, '', {
    standalone: false,
    document: doc,
    sourceOffset: offsetA,
  });

  assert.ok(htmlA.includes('href="https://example.com/a"'), '全引用式链接需跨块解析');
  assert.ok(htmlA.includes('title="链接标题 A"'), '引用式链接需带上 title');
  assert.ok(htmlA.includes('href="https://example.com/b"'), '折叠引用式链接需跨块解析');
  assert.ok(htmlA.includes('href="https://example.com/c"'), 'shortcut 引用式链接需跨块解析');
  console.log('PASS: 跨块引用式链接（full / collapsed / shortcut）解析正确');
}

/* 2. 标签大小写不敏感与空白折叠 */
{
  const doc = `[测试文本][Foo   Bar]

[foo bar]: https://example.com/foobar
`;
  const html = markdownToHtml(doc, '', { standalone: false });
  assert.ok(html.includes('href="https://example.com/foobar"'), '标签匹配需大小写不敏感且折叠内部空白');
  console.log('PASS: 标签大小写与空白折叠规范');
}

/* 3. 引用式图片与 data-md-src（innerHTML 远程资源防加载） */
{
  const doc = `![封面大图][cover]
![logo][]
![shortcut-img]

[cover]: https://example.com/cover.png "书籍封面"
[logo]: /assets/logo.png
[shortcut-img]: https://example.com/icon.png
`;

  // 默认（即时预览 / 片段导出 / standalone 导出都交给 htmlExport 处理）：不得写 src
  const previewHtml = markdownToHtml(doc, '', { standalone: false });
  assert.equal(/(?:^|[\s])src="/.test(previewHtml), false, '预览模式不得输出 src 属性');
  assert.ok(previewHtml.includes('data-md-src="https://example.com/cover.png"'), '需输出 data-md-src');
  assert.ok(previewHtml.includes('alt="封面大图"'), '图片 alt 需正确');
  assert.ok(previewHtml.includes('title="书籍封面"'), '图片 title 需正确');
  assert.ok(previewHtml.includes('data-md-src="/assets/logo.png"'), '折叠引用式图片需输出 data-md-src');
  assert.ok(previewHtml.includes('data-md-src="https://example.com/icon.png"'), 'shortcut 引用式图片需输出 data-md-src');

  // standalone 导出同样不得裸写 src（导出由 lib/htmlExport 把 data-md-src 换成内嵌 data URL）
  const exportHtml = markdownToHtml(doc, 'Export', { standalone: true });
  assert.equal(/(?:^|[\s])src="/.test(exportHtml), false, 'standalone 模式也不得输出裸 src');
  assert.ok(exportHtml.includes('data-md-src="https://example.com/cover.png"'), 'standalone 模式保留 data-md-src');

  // 内联写法与显式请求 src 的开关
  const inlineHtml = markdownToHtml('![图](https://example.com/x.png)', '', { standalone: false });
  assert.ok(inlineHtml.includes('data-md-src="https://example.com/x.png"'), '行内图片也要走 data-md-src');
  const explicit = markdownToHtml('![图](https://example.com/x.png)', '', { inlineImageSrc: true });
  assert.ok(explicit.includes(' src="https://example.com/x.png"'), 'inlineImageSrc: true 时额外输出 src');
  console.log('PASS: 引用式图片与 data-md-src 防自动加载机制');
}

/* 4. 忽略围栏代码与 frontmatter 中的伪定义 */
{
  const doc = `---
title: 测试文档
[fake-fm]: https://example.com/bad-fm
[^fake-fn]: 这是 frontmatter 里的伪脚注
---

正文里的 [fm链接][fake-fm] 和 [代码块链接][fake-code] 以及 [^fake-fn]。

\`\`\`markdown
[fake-code]: https://example.com/bad-code
[^fake-fn2]: 围栏代码里的伪脚注
\`\`\`

~~~
[fake-code-tilde]: https://example.com/bad-tilde
~~~
`;

  const defs = collectLinkDefs(doc);
  assert.equal(defs.has('fake-fm'), false, 'frontmatter 内的伪链接定义必须被忽略');
  assert.equal(defs.has('fake-code'), false, '反引号围栏代码内的伪链接定义必须被忽略');
  assert.equal(defs.has('fake-code-tilde'), false, '波浪号围栏代码内的伪链接定义必须被忽略');

  const fnIdx = buildFootnoteIndex(doc);
  assert.equal(fnIdx.defs.has('fake-fn'), false, 'frontmatter 内的伪脚注必须被忽略');
  assert.equal(fnIdx.defs.has('fake-fn2'), false, '围栏代码内的伪脚注必须被忽略');

  const html = markdownToHtml(doc, '', { standalone: false });
  // 伪定义可以原样出现在 frontmatter/代码块的转义文本里，但绝不能变成可点的超链接
  assert.ok(!html.includes('href="https://example.com/bad-fm'), 'frontmatter 伪定义不得被解析成超链接');
  assert.ok(!html.includes('href="https://example.com/bad-code'), '代码块内伪定义不得被解析成超链接');
  assert.ok(!html.includes('href="https://example.com/bad-tilde'), '波浪号围栏内的伪定义不得生效');
  // 真链接仍然正常生成，证明「忽略」只针对代码/frontmatter
  const withReal = markdownToHtml(`${doc}\n真定义：[ok][real]\n\n[real]: https://example.com/real\n`, '', { standalone: false });
  assert.ok(withReal.includes('href="https://example.com/real"'), '正文里的真定义仍应生效');
  console.log('PASS: 忽略围栏代码与 frontmatter 中的伪定义');
}

/* 5. 任务列表 data-task-pos 指向原文内部绝对位置 */
{
  const doc = `# 任务标题

- [ ] 未完成任务
- [x] 已完成任务
`;

  const html = markdownToHtml(doc, '', { standalone: false });
  const posUnchecked = doc.indexOf('[ ]') + 1;
  const posChecked = doc.indexOf('[x]') + 1;
  assert.equal(doc.charAt(posUnchecked), ' ', '原文中未完成字符应为空格');
  assert.equal(doc.charAt(posChecked), 'x', '原文中已完成字符应为 x');

  assert.ok(
    html.includes(`data-task-pos="${posUnchecked}"`),
    `html 应包含 data-task-pos="${posUnchecked}"`,
  );
  assert.ok(
    html.includes(`data-task-pos="${posChecked}"`),
    `html 应包含 data-task-pos="${posChecked}"`,
  );
  assert.ok(html.includes('disabled'), '复选框依然保持 disabled 状态由上层 widget 控制');

  // 按块渲染带有 sourceOffset 的任务列表
  const block = `- [ ] 块内任务一
- [x] 块内任务二`;
  const blockOffset = 250;
  const blockHtml = markdownToHtml(block, '', {
    standalone: false,
    sourceOffset: blockOffset,
  });
  const expectedPos1 = blockOffset + block.indexOf('[ ]') + 1;
  const expectedPos2 = blockOffset + block.indexOf('[x]') + 1;
  assert.ok(blockHtml.includes(`data-task-pos="${expectedPos1}"`), 'sourceOffset 应正确累加到 taskPos');
  assert.ok(blockHtml.includes(`data-task-pos="${expectedPos2}"`), 'sourceOffset 应正确累加到 taskPos');
  console.log('PASS: 任务列表 data-task-pos 绝对偏移定位');
}

/* 6. links.findAnchorPos 导航支持脚注定义与引用定位 */
{
  const doc = `# 第一章 序幕

这里是正文段落，引用了脚注[^first]，以及第二次引用[^first]。

[^first]: 脚注的详细解说。

[mylink]: https://example.com
`;

  const headingPos = doc.indexOf('# 第一章 序幕');
  const ref1Pos = doc.indexOf('[^first]');
  const ref2Pos = doc.indexOf('[^first]', ref1Pos + 1);
  const defPos = doc.indexOf('[^first]:');
  const linkDefPos = doc.indexOf('[mylink]:');

  // 1. 标题定位（保留旧功能）
  assert.equal(findAnchorPos(doc, '第一章-序幕'), headingPos);

  // 2. 脚注定义定位（支持 #fn-first 或 fn-first）
  assert.equal(findAnchorPos(doc, 'fn-first'), defPos, 'findAnchorPos 应定位脚注定义');
  assert.equal(findAnchorPos(doc, '#fn-first'), defPos, '带井号也能定位脚注定义');
  assert.equal(findFootnoteAnchorPos(doc, 'fn-first'), defPos);

  // 3. 脚注引用定位（首次引用 fnref-first）
  assert.equal(findAnchorPos(doc, 'fnref-first'), ref1Pos, 'findAnchorPos 应定位第 1 次脚注引用');
  assert.equal(findAnchorPos(doc, '#fnref-first'), ref1Pos);

  // 4. 重复脚注引用定位（第 2 次引用 fnref-first-2）
  assert.equal(findAnchorPos(doc, 'fnref-first-2'), ref2Pos, 'findAnchorPos 应定位第 2 次脚注引用');

  // 5. 引用式链接定义定位（ref-mylink / def-mylink 或直接 mylink）
  assert.equal(findAnchorPos(doc, 'ref-mylink'), linkDefPos, 'findAnchorPos 应定位链接定义');
  assert.equal(findLinkDefAnchorPos(doc, 'mylink'), linkDefPos);

  console.log('PASS: links.findAnchorPos 导航定位脚注与定义');
}

/* 7. 安全性保留 */
{
  const unsafeDoc = `[危险链接][bad]

[内联危险](javascript:alert('xss'))

[bad]: javascript:alert('xss')
`;
  const unsafeHtml = markdownToHtml(unsafeDoc, '', { standalone: false });
  assert.ok(!unsafeHtml.includes('href="javascript:'), '不安全协议必须被拦截');
  assert.ok(unsafeHtml.includes('md-link-bad'), '不安全链接应输出安全占位');

  // 正文转义：非白名单的原始 HTML 标签（含其中的属性）必须被完整转义为纯文本，不得进入 DOM
  const escapeHtml = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', '', { standalone: false });
  assert.ok(escapeHtml.includes('&lt;script&gt;'), 'script 标签必须被实体转义');
  assert.ok(!escapeHtml.includes('<script>'), '不得输出可执行的 script 标签');
  assert.ok(escapeHtml.includes('&lt;img'), 'img 标签必须被实体转义为文本');
  assert.ok(!escapeHtml.includes('<img src='), 'raw HTML 里的 img 标签不得作为 DOM 标签透传');

  // 白名单标签（如 <u>）：保留标签结构，但剥离一切自定义属性与事件
  const stripped = markdownToHtml('<u onclick="alert(1)" id="hack">underlined</u>', '', { standalone: false });
  assert.ok(stripped.includes('<u>underlined</u>'), '白名单标签保留');
  assert.ok(!stripped.includes('onclick'), '白名单标签上的属性必须剥离');
  assert.ok(!stripped.includes('id='), '白名单标签上的 id 等属性必须剥离');
  console.log('PASS: 安全转义与协议防御验证');
}

console.log('\nALL PASS: 所有 Markdown 引用语义、图片防加载、任务框定位与脚注索引导航测试通过！');
