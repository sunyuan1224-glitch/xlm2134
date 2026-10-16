import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "mynovel-widget-ui-"));
// .png 和 .mp3 都要有 loader：挂件同时引用了人物图与小鸭音效（Vite 能处理，esbuild 需要显式声明）
await build({
  entryPoints: [new URL("./widget-ui-webkit.test.tsx", import.meta.url).pathname],
  outfile: join(dir, "check.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: {
    ".woff": "dataurl",
    ".woff2": "dataurl",
    ".ttf": "dataurl",
    ".png": "dataurl",
    ".mp3": "dataurl",
  },
});
await writeFile(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="check.css"></head><body style="margin:0"><div id="root"></div><script src="check.js"></script></body></html>',
);
console.log(`Visual artifacts: ${dir}`);
const child = spawnSync("python3", [new URL("./test-theme-ui-webkit.py", import.meta.url).pathname, join(dir, "index.html")], {
  stdio: "inherit",
  timeout: 45000,
});
process.exitCode = child.status ?? 1;
