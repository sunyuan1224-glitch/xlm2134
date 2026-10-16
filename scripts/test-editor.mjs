import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'mynovel-editor-test-'));
try {
  const outfile = join(dir, 'check.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./editor-behavior.test.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
