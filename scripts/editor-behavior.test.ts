import assert from 'node:assert/strict';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { history, undo } from '@codemirror/commands';
import {
  livePreview,
  frontmatterRange,
} from '../src/editor/livePreview.ts';
import { markdownToHtml, inlineMarkdownToHtml } from '../src/lib/mdExport.ts';
import { resolveLink, findAnchorPos } from '../src/lib/links.ts';
import { applyFormatToText } from '../src/lib/format.ts';
const mode = new Compartment();
const doc = 'active\n\n# **Title**\n\n```js\n# not heading\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n';
let state = EditorState.create({doc, extensions: [markdown({extensions:[GFM]}), history(), mode.of(livePreview())]});
const ranges = (s: EditorState) => { const out: any[] = []; for (const set of s.facet(EditorView.decorations)) if (typeof set !== 'function') set.between(0,s.doc.length,(from,to,d)=>{out.push({from,to,html:d.spec.widget?.html})}); return out; };
let decos = ranges(state);
assert.equal(decos.length,4);
assert.ok(!decos.some(d=>d.html.includes('<table')), '手写表格不再渲染为 <table>，只按普通段落显示');
assert.ok(decos.some(d=>d.html.includes('| A | B |')), '表格文本仍按普通段落出现在预览里');
assert.ok(decos.some(d=>d.html.includes('# not heading') && d.html.includes('<pre')));
assert.ok(decos.some(d=>d.html.includes(' checked')));
assert.ok(decos.some(d=>d.html.includes('<strong>Title</strong>')));
state = state.update({selection:{anchor:doc.indexOf('| A')}}).state;
assert.ok(!ranges(state).some(d=>d.html.includes('| A | B |')), '光标进入表格段落时预览消失、露出源码');
state = state.update({selection:{anchor:0,head:state.doc.length}}).state;
assert.equal(ranges(state).length,0);
state = state.update({selection:{anchor:0},changes:{from:0,insert:'X'}}).state;
state = state.update({effects:mode.reconfigure([])}).state;
assert.equal(ranges(state).length,0);
assert.ok(undo({state,dispatch:tr=>{state=tr.state;}}));
assert.equal(state.doc.toString(),doc);
state = state.update({selection:{anchor:0},effects:mode.reconfigure(livePreview())}).state;
assert.equal(ranges(state).length,4);
assert.deepEqual(frontmatterRange(EditorState.create({doc:'---\ntitle: A\n---\n正文'})),{from:0,to:16});
assert.ok(inlineMarkdownToHtml('***bold italic***').includes('<strong><em>bold italic</em></strong>'));
assert.ok(!inlineMarkdownToHtml('[x](javascript:alert)').includes('href='));
assert.ok(!markdownToHtml('[x][ref]\n\n[ref]: javascript:alert','').includes('href="javascript:'));
assert.ok(!inlineMarkdownToHtml('<u onclick="x">safe</u>').includes('onclick'));
const formatted = applyFormatToText('hello',0,5,{k:'inline',style:'bold'});
assert.ok(JSON.stringify(formatted).includes('**hello**'));
console.log('PASS: editor behavior: syntax blocks, table-as-paragraph, code isolation, checked tasks, nested formatting, active block/selection reveal, mode undo, YAML, unsafe links, HTML attributes, formatting.');

const large = EditorState.create({doc: 'start\n\n' + '# Heading\n\ntext **bold**\n\n'.repeat(1000), extensions:[markdown({extensions:[GFM]}),livePreview()]});
assert.ok(ranges(large).length > 0);
console.log('PASS: large document initialization');

assert.deepEqual(resolveLink('../other.md#标题', 'book/chapter.md', ['other.md']), {kind:'file',path:'other.md',anchor:'标题'});
assert.equal(resolveLink('#bad%escape', 'chapter.md', []).kind, 'anchor');
assert.equal(findAnchorPos('# Hello\n', 'hello'), 0);
assert.equal(findAnchorPos('# Hello\n', 'bad%escape'), null);
console.log('PASS: relative and malformed links, heading anchors');
