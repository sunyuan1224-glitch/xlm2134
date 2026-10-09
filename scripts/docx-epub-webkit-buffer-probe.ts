/*
 * 「页面里没有 Node 的 Buffer」这个前提下的 DOCX 打包探测。
 *
 * 为什么必须单独一个 realm（由 scripts/docx-epub-webkit.test.ts 放进 iframe 里跑）：
 *   docx 的 Packer → JSZip 会在**第一次用到时**把 `typeof Buffer !== "undefined"` 缓存进
 *   support.nodebuffer，之后再也不重新判断。所以同一个页面里「先失败一次、再装垫片重试」
 *   是行不通的；要测「没有 Buffer 时产品会怎样」，就必须在一个全新的 window 里跑，
 *   而主 fixture 那个 realm 从一开始就装好测试垫片，用来把 OOXML 结构验完。
 *
 * 本文件只做一件事：在独立 realm 里调一次真实的 buildDocx（不注入任何 Buffer），
 * 把结果 postMessage 回父页面。它不判定 PASS/FAIL —— 判定由父 fixture 写进报告。
 */
import { buildDocx } from "../src/lib/docxExport";

interface ProbeResult {
  kind: "mynovel-buffer-probe";
  /** 这个 realm 里有没有 Node 兼容的全局 Buffer */
  hasBuffer: boolean;
  /** 打包是否成功 */
  ok: boolean;
  /** 失败原因（失败时是产品侧真实抛出的异常消息） */
  error: string;
  /** 成功时的字节数 */
  bytes: number;
}

async function main(): Promise<void> {
  const result: ProbeResult = {
    kind: "mynovel-buffer-probe",
    hasBuffer: typeof (globalThis as unknown as { Buffer?: unknown }).Buffer !== "undefined",
    ok: false,
    error: "",
    bytes: 0,
  };
  try {
    // 最小输入：只测「打包这一步」在真浏览器里能不能过
    const res = await buildDocx("# Buffer 探测\n\n正文一段。\n", "Buffer 探测", { root: null });
    result.bytes = res.bytes.length;
    result.ok = res.bytes.length > 0 && res.bytes[0] === 0x50 && res.bytes[1] === 0x4b;
    if (!result.ok) result.error = "buildDocx 返回的字节不是 ZIP（PK 头不对）";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  parent.postMessage(result, "*");
}

void main();
