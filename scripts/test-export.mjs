// 复用现有 esbuild 把测试打成单文件再在 Node 里跑，不安装新依赖、不写进项目目录
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'mynovel-export-test-'));
try {
  const outfile = join(dir, 'check.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./html-export.test.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
