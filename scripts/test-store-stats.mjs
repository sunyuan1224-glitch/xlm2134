// 写作统计基准（打开 / 重开 / 切工作区工作区）测试运行器：复用既有 esbuild 打成单文件再在 Node 里跑。
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'mynovel-store-stats-test-'));
try {
  const outfile = join(dir, 'store-writing-stats.test.mjs');
  await build({
    entryPoints: [new URL('./store-writing-stats.test.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
