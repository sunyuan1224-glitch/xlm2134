import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "mynovel-companion-ui-"));
// App 会连带引到挂件的 .mp3 与各处 .png，esbuild 需要显式声明这些 loader
await build({
  entryPoints: [new URL("./companion-ui-webkit.test.tsx", import.meta.url).pathname],
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
