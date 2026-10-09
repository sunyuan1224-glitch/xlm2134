/*
 * 就地编译 scripts/ime-wtype.c（只链接系统已有的 wayland-client / xkbcommon）。
 * 生成的二进制放在临时目录，不写入项目、不写入用户目录。
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function pkg(flag) {
  const out = spawnSync('pkg-config', [flag, 'wayland-client', 'xkbcommon'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error('pkg-config failed: ' + out.stderr);
  return out.stdout.trim().split(/\s+/).filter(Boolean);
}

/** @returns {Promise<string>} 编译好的 ime-wtype 可执行文件路径 */
export async function buildImeWtype() {
  const dir = await mkdtemp(join(tmpdir(), 'mynovel-ime-wtype-'));
  const xml = new URL('./ime-virtual-keyboard.xml', import.meta.url).pathname;
  const header = join(dir, 'virtual-keyboard-client-protocol.h');
  const code = join(dir, 'virtual-keyboard-protocol.c');
  for (const [mode, out] of [
    ['client-header', header],
    ['private-code', code],
  ]) {
    const scan = spawnSync('wayland-scanner', [mode, xml, out], { encoding: 'utf8' });
    if (scan.status !== 0) throw new Error('wayland-scanner ' + mode + ' failed: ' + scan.stderr);
  }
  const binary = join(dir, 'ime-wtype');
  const cc = spawnSync(
    'cc',
    [
      '-O2',
      '-Wall',
      '-o',
      binary,
      new URL('./ime-wtype.c', import.meta.url).pathname,
      code,
      '-I' + dir,
      ...pkg('--cflags'),
      ...pkg('--libs'),
    ],
    { encoding: 'utf8' }
  );
  if (cc.status !== 0) throw new Error('cc failed: ' + cc.stderr);
  await writeFile(join(dir, '.built'), 'ok');
  return binary;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(await buildImeWtype());
}
