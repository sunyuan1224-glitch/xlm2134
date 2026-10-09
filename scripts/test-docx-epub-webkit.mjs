/*
 * 真 GTK/WebKit DOCX/EPUB 导出 fixture 的 runner：
 * 与 test-browser.mjs 同一套模式 —— esbuild 打成浏览器 IIFE 单文件，
 * 写一个最小 index.html，交给 scripts/test-webkit.py 在真 webkit2gtk 窗口里跑。
 * test-webkit.py 会顺手复核「全程零外网请求」（任何 http(s) 资源请求都会让这次运行失败）。
 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'mynovel-docx-epub-webkit-'));
const page = (script, extra = '') =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="host"></div>${extra}<script src="${script}"></script></body></html>`;
try {
  // 主 fixture（同一个页面里跑完整断言）
  await build({
    entryPoints: [new URL('./docx-epub-webkit.test.ts', import.meta.url).pathname],
    outfile: join(dir, 'check.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
  });
  // 「没有 Buffer 的干净 realm」探测：单独一份 bundle，被主 fixture 放进 iframe（见下面注释）
  await build({
    entryPoints: [new URL('./docx-epub-webkit-buffer-probe.ts', import.meta.url).pathname],
    outfile: join(dir, 'probe.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
  });
  await writeFile(join(dir, 'index.html'), page('check.js'));
  await writeFile(join(dir, 'probe.html'), page('probe.js', '<p id="probe-host">Buffer probe realm</p>'));
  const child = spawnSync('python3', [new URL('./test-webkit.py', import.meta.url).pathname, join(dir, 'index.html')], {
    stdio: 'inherit',
    timeout: 45000,
  });
  process.exitCode = child.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
