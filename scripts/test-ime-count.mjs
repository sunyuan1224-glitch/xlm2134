// 输入法组合态 × 字数的真实 WebKit 运行器（Editor 组件本体，React + 真实 CodeMirror）。
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'mynovel-ime-count-'));
try {
  await build({
    entryPoints: [new URL('./ime-count-webkit.test.ts', import.meta.url).pathname],
    outfile: join(dir, 'check.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.mp3': 'dataurl' },
    logLevel: 'warning',
  });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="check.js"></script></body></html>',
  );
  const child = spawnSync('python', [new URL('./test-webkit.py', import.meta.url).pathname, join(dir, 'index.html')], {
    stdio: 'inherit',
    timeout: 60000,
  });
  process.exitCode = child.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
