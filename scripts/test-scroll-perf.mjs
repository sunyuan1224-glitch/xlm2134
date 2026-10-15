// 滚动条拖动手感的真实 WebKit 探针运行器（复用 test-webkit.py 的 GTK/WebKit 宿主）。
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(join(tmpdir(), "mynovel-scroll-perf-"));
await build({
  entryPoints: [new URL("./scroll-perf-webkit.test.tsx", import.meta.url).pathname],
  outfile: join(dir, "check.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".png": "dataurl" },
  logLevel: "warning",
});
await writeFile(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="check.css"></head><body style="margin:0"><div id="root"></div><script src="check.js"></script></body></html>',
);
const child = spawnSync(
  "python3",
  [new URL("./test-webkit.py", import.meta.url).pathname, join(dir, "index.html")],
  { stdio: "inherit", timeout: 60000 },
);
process.exitCode = child.status ?? 1;
