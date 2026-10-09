import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'mynovel-complex-webkit-'));
try {
  await build({
    entryPoints: [new URL('./complex-browser.test.ts', import.meta.url).pathname],
    outfile: join(dir, 'check.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
  });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="check.js"></script></body></html>',
  );
  const child = spawnSync('python', [new URL('./test-webkit.py', import.meta.url).pathname, join(dir, 'index.html')], {
    stdio: 'inherit',
    timeout: 45000,
  });
  process.exitCode = child.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
