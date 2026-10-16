// 卷级 + 纲要 测试运行器：复用既有 esbuild 打成单文件再在 Node 里跑，不新增测试依赖。
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'mynovel-volume-test-'));
try {
  const outfile = join(dir, 'volume.test.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./volume.test.ts', import.meta.url))],
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
