/*
 * DOCX / EPUB 导出测试的公共工具（不是测试本体，被三个测试文件共用）。
 *
 * 这里刻意**不引入新的断言框架**：只用 node:assert + fflate 解包 + 手写的小型 XML 体检，
 * 让测试在纯 Node 里就能跑（与项目既有测试一致：esbuild 打包后直接 node 执行）。
 *
 * 注意：这里的 XML 检查是「快速体检」（标签配对、实体、控制字符、脚本特征），
 * 严格的外部校验由 scripts/verify-docx-epub.mjs 调 python3 + xmllint 完成。
 */
import assert from "node:assert/strict";
import { unzipSync, strFromU8, zlibSync } from "fflate";

/** 真 PNG 生成器：用 fflate 的 zlib 打出真实 PNG（要验「按文件头读宽高」，假数据不行） */
export function makePng(width: number, height: number, rgb: [number, number, number] = [200, 30, 60]): Uint8Array {
  const raw: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(1 + width * 3);
    row[0] = 0; // filter type
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    raw.push(row);
  }
  const idat = zlibSync(concatBytes(raw), { level: 6 });
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return concatBytes([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(concatBytes([typeBytes, data])));
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return Buffer.from(s, "binary").toString("base64");
}

/** data URL：2×3 小图（宽度/高度都从 PNG 头里读出来） */
export const PNG_2X3 = "data:image/png;base64," + toBase64(makePng(2, 3));

/** data URL：1200×300 超宽图（必须被等比缩放到正文宽度内） */
export const PNG_1200X300 = "data:image/png;base64," + toBase64(makePng(1200, 300));

/** 带 viewBox 的简单 SVG（模拟内联 SVG 图片） */
export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect x="1" y="1" width="198" height="98" fill="#eef"/><text x="10" y="30">A → B</text></svg>';

/** 解包（fflate）：拿不到内容就抛，测试里不吞异常 */
export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

export function textOf(zip: Record<string, Uint8Array>, name: string): string {
  const entry = zip[name];
  assert.ok(entry, `压缩包里应存在条目 ${name}（实际：${Object.keys(zip).join(", ")}）`);
  return strFromU8(entry);
}

/** ZIP 头：PK\x03\x04 */
export function assertZipMagic(bytes: Uint8Array, label: string): void {
  assert.equal(bytes[0], 0x50, `${label}: 第 1 字节应为 P`);
  assert.equal(bytes[1], 0x4b, `${label}: 第 2 字节应为 K`);
  assert.equal(bytes[2], 0x03, `${label}: 应为本地文件头`);
  assert.equal(bytes[3], 0x04, `${label}: 应为本地文件头`);
}

/**
 * 检查第一个 ZIP 条目：名字 + 压缩方式。
 * EPUB（OCF）要求 mimetype 是第一项且必须 stored（method 0），所以这里要精确读本地头：
 *   偏移 26-27 = 压缩方式，28-29 = 修改时间，30… = 文件名。
 */
export function firstEntry(bytes: Uint8Array): { name: string; method: number } {
  const nameLen = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8);
  const method = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  return { name: strFromU8(bytes.slice(30, 30 + nameLen)), method };
}

/** XML 体检：标签配对（忽略自闭合与注释）、属性有引号 */
export function assertBalancedXml(xml: string, label: string): void {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(xml))) {
    seen++;
    const closing = m[1] === "/";
    const name = m[2];
    const selfClosing = m[4] === "/";
    if (closing) {
      const open = stack.pop();
      assert.equal(open, name, `${label}: </${name}> 与 <${open ?? "空"}> 不匹配`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.ok(seen > 0, `${label}: 没有解析到任何标签`);
  assert.equal(stack.length, 0, `${label}: 有未闭合标签 ${stack.join(", ")}`);
}

/** & 必须构成合法实体（否则 XML 打不开） */
export function assertNoBareAmpersand(xml: string, label: string): void {
  const bad = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(xml);
  assert.equal(bad, null, `${label}: 发现未转义的 & ：${JSON.stringify(xml.slice(Math.max(0, (bad?.index ?? 0) - 30), (bad?.index ?? 0) + 30))}`);
}

/** XML 1.0 非法字符（\t \n \r 之外的控制字符 + 落单代理） */
export function findIllegalXmlChars(xml: string): string[] {
  const out = new Set<string>();
  for (const ch of xml) {
    const code = ch.codePointAt(0) ?? 0;
    const illegal =
      (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xfffe ||
      code === 0xffff ||
      (code >= 0xd800 && code <= 0xdfff);
    if (illegal) out.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return [...out];
}

/**
 * 恶意内容体检：不允许脚本、事件属性、危险协议。
 *
 * 注意「网络引用」的判定只针对**资源加载**属性（src/srcset/poster/data、<link href>），
 * 因为用户自己的外链 <a href="https://…"> 是正当内容，必须保留；
 * 导出包绝不能主动去加载任何远端资源，两者不能混为一谈。
 */
export function assertNoScriptTraces(content: string, label: string): void {
  const lower = content.toLowerCase();
  for (const needle of ["<script", "javascript:", "onerror=", "onload=", "onclick=", "data:text/html"]) {
    assert.ok(!lower.includes(needle), `${label}: 不应出现 ${needle}`);
  }
  const remoteResource = /(?:\bsrc|\bsrcset|\bposter|\bdata)\s*=\s*["']?(?:https?:)?\/\//i.exec(content);
  assert.equal(remoteResource, null, `${label}: 资源属性不得指向网络（${remoteResource?.[0] ?? ""}）`);
  const remoteStylesheet = /<link\b[^>]*href\s*=\s*["']?(?:https?:)?\/\//i.exec(content);
  assert.equal(remoteStylesheet, null, `${label}: 外部样式表不得指向网络`);
  assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(content), `${label}: CSS 不得 @import 网络资源`);
}
