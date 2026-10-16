// DOCX / EPUB 导出测试运行器：复用既有 esbuild 打成单文件再在 Node 里跑，不新增测试依赖。
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const FILES = ['./export-blocks.test.ts', './docx-export.test.ts', './epub-export.test.ts'];
const dir = await mkdtemp(join(tmpdir(), 'mynovel-docx-epub-test-'));
try {
  for (const file of FILES) {
    const outfile = join(dir, file.replace(/\.ts$/, '.mjs'));
    await build({
      entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning',
    });
    await import(pathToFileURL(outfile).href);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
