// 外部体检运行器：先打成一个 bundle，再在 Node 里跑（里面会调用 python3 / xmllint）
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'mynovel-verify-run-'));
try {
  const outfile = join(dir, 'run.mjs');
  await build({
    entryPoints: [new URL('./export-external-verify.ts', import.meta.url).pathname],
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
