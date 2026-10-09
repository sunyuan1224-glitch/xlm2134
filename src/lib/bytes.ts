/*
 * DOCX / EPUB 导出用的字节与 XML 工具（零依赖：只用平台自带的 TextEncoder/TextDecoder）。
 *
 * 为什么要自带 base64 编解码、XML 转义、图片嗅探：
 *   1. 导出模块必须**离线**且**到处都能跑**（Tauri webview 与 Node 测试），
 *      所以不依赖 atob/btoa（Node 下不一定有）、不依赖 DOM、不依赖 Buffer；
 *   2. DOCX/EPUB 都是 XML 容器。XML 1.0 不允许控制字符（\u0000 之类），
 *      而用户的 Markdown 里什么都可能有，一旦漏进去就是「文件打不开」，
 *      所以文本在进入任何 XML 之前必须先过 sanitizeXmlText；
 *   3. 图片要写进容器必须知道真实类型与像素尺寸（Word 需要图片宽高，
 *      SVG 里没有尺寸时会画出 0×0），这里用文件头嗅探 + 头部尺寸解析，
 *      看不懂的图片一律返回 null，由调用方**明确降级**，绝不瞎猜。
 */

/* ------------------------------------------------------------------ *
 * base64
 * ------------------------------------------------------------------ */

const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 字节 → 标准 base64（带 = 填充，与 Rust 侧 base64_decode 的期望完全一致） */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_TABLE[(n >> 18) & 63];
    out += B64_TABLE[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64_TABLE[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64_TABLE[n & 63] : "=";
  }
  return out;
}

const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_TABLE.length; i++) table[B64_TABLE.charCodeAt(i)] = i;
  return table;
})();

/**
 * 标准 base64 → 字节；不合法返回 null（不抛异常、不做「尽力而为」的猜测解码）。
 * 允许空白（换行/空格），方便接受分块传入的内容。
 */
export function base64ToBytes(input: string): Uint8Array | null {
  const clean: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    if (code === 61) {
      clean.push(-2);
      continue;
    }
    const v = code < 128 ? B64_LOOKUP[code] : -1;
    if (v < 0) return null;
    clean.push(v);
  }
  if (clean.length === 0 || clean.length % 4 !== 0) return null;
  let pad = 0;
  for (let i = clean.length - 1; i >= 0 && clean[i] === -2; i--) pad++;
  if (pad > 2) return null;
  const body = clean.slice(0, clean.length - pad);
  if (body.some((v) => v === -2)) return null;
  if (pad > 0 && body.length % 4 !== 0 && body.length % 4 !== 3 && body.length % 4 !== 2) return null;
  const out: number[] = [];
  for (let i = 0; i < body.length; i += 4) {
    const chunk = body.slice(i, i + 4);
    let n = 0;
    let bits = 0;
    for (const v of chunk) {
      n = (n << 6) | v;
      bits += 6;
    }
    const bytesInChunk = bits >> 3;
    const shift = bits % 8;
    if (shift !== 0 && (n & ((1 << shift) - 1)) !== 0) return null;
    n >>= shift;
    for (let k = bytesInChunk - 1; k >= 0; k--) out.push((n >> (8 * k)) & 0xff);
  }
  return Uint8Array.from(out);
}

/** 解析 data URL（支持 base64 与纯文本两种形式）；不是合法 data URL 时返回 null */
export function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^,]*),([\s\S]*)$/.exec(url.trim());
  if (!m) return null;
  const meta = m[1];
  const body = m[2];
  const isBase64 = /;base64$/i.test(meta);
  const mime = (isBase64 ? meta.slice(0, -7) : meta.split(";")[0]).trim().toLowerCase() || "text/plain";
  if (isBase64) {
    const bytes = base64ToBytes(body);
    return bytes ? { mime, bytes } : null;
  }
  try {
    return { mime, bytes: utf8(decodeURIComponent(body)) };
  } catch {
    return { mime, bytes: utf8(body) };
  }
}

/* ------------------------------------------------------------------ *
 * 字符串 / 字节
 * ------------------------------------------------------------------ */

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * XML / XHTML 文本安全
 * ------------------------------------------------------------------ */

/** XML 1.0 允许的字符：\t \n \r、#x20-#xD7FF、#xE000-#xFFFD、#x10000-#x10FFFF */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/**
 * 去掉 XML 1.0 非法字符（控制字符、单独的代理项、#xFFFE/#xFFFF 等）。
 * 这是写进 DOCX/EPUB 之前的**必经关口**：漏掉一个就足以让整个文件打不开。
 */
export function sanitizeXmlText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      // 落单的高代理：直接丢弃（无法构成合法字符）
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (!isXmlChar(code)) continue;
    out += s[i];
  }
  return out;
}

/** XML 文本转义（& < > 以及属性里会用到的引号） */
export function escapeXml(s: string): string {
  return sanitizeXmlText(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** XML 属性值转义（同时转单双引号） */
export function escapeXmlAttr(s: string): string {
  return sanitizeXmlText(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ *
 * 图片嗅探与尺寸
 * ------------------------------------------------------------------ */

export type ImageKind = "png" | "jpg" | "gif" | "bmp" | "webp" | "svg";

const KIND_MIME: Record<ImageKind, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * 按文件头（magic bytes）判断图片类型。
 * 不看扩展名：文件的真实内容才作数（也防住「.png 里其实是 HTML」这类伪装）。
 */
export function sniffImageKind(bytes: Uint8Array, fallbackMime = ""): ImageKind | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "gif";
  if (bytes.length >= 2 && at(0) === 0x42 && at(1) === 0x4d) return "bmp";
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "webp";
  }
  // SVG 是文本：只在 data URL 的 mime 声明为 svg 时才承认（不靠猜 XML）
  if (fallbackMime.trim().toLowerCase() === "image/svg+xml") return "svg";
  return null;
}

function readU16(bytes: Uint8Array, off: number): number {
  return ((bytes[off] ?? 0) << 8) | (bytes[off + 1] ?? 0);
}

function readU32(bytes: Uint8Array, off: number): number {
  return (
    (((bytes[off] ?? 0) << 24) | ((bytes[off + 1] ?? 0) << 16) | ((bytes[off + 2] ?? 0) << 8) | (bytes[off + 3] ?? 0)) >>>
    0
  );
}

/** SVG 的宽高：优先 width/height，退回 viewBox；都看不懂返回 null */
export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const head = svg.slice(0, 4096);
  const w = /\bwidth\s*=\s*["']?\s*([0-9.]+)(px|pt)?/i.exec(head);
  const h = /\bheight\s*=\s*["']?\s*([0-9.]+)(px|pt)?/i.exec(head);
  if (w && h) {
    const width = Number(w[1]) * (w[2]?.toLowerCase() === "pt" ? 4 / 3 : 1);
    const height = Number(h[1]) * (h[2]?.toLowerCase() === "pt" ? 4 / 3 : 1);
    if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
  }
  const vb = /viewBox\s*=\s*["']\s*([-0-9.eE]+)[,\s]+([-0-9.eE]+)[,\s]+([0-9.eE]+)[,\s]+([0-9.eE]+)/i.exec(head);
  if (vb) {
    const width = Number(vb[3]);
    const height = Number(vb[4]);
    if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
  }
  return null;
}

/**
 * 图片像素尺寸（只解析头部，不解码像素）：
 * PNG IHDR / GIF 逻辑屏 / BMP 头 / JPEG SOFn / SVG viewBox。
 * 解析不出来返回 null —— 由调用方降级（DOCX 里按默认尺寸放，EPUB 里交给阅读器）。
 */
export function imageIntrinsicSize(
  bytes: Uint8Array,
  kind: ImageKind,
): { width: number; height: number } | null {
  if (kind === "png" && bytes.length >= 24) {
    return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
  }
  if (kind === "gif" && bytes.length >= 10) {
    const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
    const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === "bmp" && bytes.length >= 26) {
    const width = readU32(bytes, 18) | 0;
    const height = Math.abs(readU32(bytes, 22) | 0);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === "webp" && bytes.length >= 30) {
    // VP8X（扩展格式）：24 位宽高减一
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
      const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
      return { width, height };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20 && bytes.length >= 30) {
      // VP8（有损）：14 位宽高
      const width = (((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff) || 0;
      const height = (((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff) || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }
  if (kind === "jpg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = readU16(bytes, i + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = readU16(bytes, i + 5);
        const width = readU16(bytes, i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** 从 data URL 解出「可用的图片」：类型按文件头嗅探，尺寸尽量解析；失败返回 null */
export function decodeImageDataUrl(
  url: string,
): { kind: ImageKind; mime: string; bytes: Uint8Array; width: number | null; height: number | null } | null {
  const decoded = decodeDataUrl(url);
  if (!decoded) return null;
  const kind = sniffImageKind(decoded.bytes, decoded.mime);
  if (!kind) return null;
  if (kind === "svg") {
    const size = svgIntrinsicSize(utf8Decode(decoded.bytes));
    return { kind, mime: KIND_MIME[kind], bytes: decoded.bytes, width: size?.width ?? null, height: size?.height ?? null };
  }
  const size = imageIntrinsicSize(decoded.bytes, kind);
  return { kind, mime: KIND_MIME[kind], bytes: decoded.bytes, width: size?.width ?? null, height: size?.height ?? null };
}
