// 快捷键的真实 WebKit 端到端运行器：esbuild 打包成单页，再在 GTK/WebKit 里跑。
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(join(tmpdir(), "mynovel-shortcuts-ui-"));
await build({
  entryPoints: [new URL("./shortcut-ui-webkit.test.tsx", import.meta.url).pathname],
  outfile: join(dir, "check.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".png": "dataurl", ".mp3": "dataurl" },
  logLevel: "warning",
});
await writeFile(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="check.css"></head><body style="margin:0"><div id="root"></div><script src="check.js"></script></body></html>',
);
const child = spawnSync("python3", [new URL("./test-webkit.py", import.meta.url).pathname, join(dir, "index.html")], {
  stdio: "inherit",
  timeout: 60000,
});
process.exitCode = child.status ?? 1;
