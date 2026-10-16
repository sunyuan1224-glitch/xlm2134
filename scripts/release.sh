#!/usr/bin/env bash
#
# MyNovel 发版流程。
#
#   scripts/release.sh 0.1.1 [release 说明文件]
#
# 一次做完：同步两处版本号（package.json / AboutDialog）→ 跑测试 → 打包 → 覆盖安装到 ~/AppImages
#          → 提交并打 tag → 推送 → 建 GitHub release（只挂 AppImage）
#
# 前置：git 工作区干净；已装 gh 且 gh auth login 过；
#       代理默认走 127.0.0.1:7897（本机直连 GitHub 不通）。
set -euo pipefail

VER="${1:-}"
NOTES_FILE="${2:-}"
if [ -z "$VER" ]; then
  echo "用法: scripts/release.sh <版本号> [release 说明文件]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APPIMAGES="${HOME}/AppImages"
BUNDLE="release"

export https_proxy="${https_proxy:-http://127.0.0.1:7897}"
export http_proxy="${http_proxy:-http://127.0.0.1:7897}"

step() { printf '\n== %s ==\n' "$*"; }

step "0/6 前置检查"
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，先提交或 stash：" >&2
  git status --short >&2
  exit 1
fi
command -v gh >/dev/null || { echo "缺 gh CLI（sudo pacman -S github-cli）" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 未登录（gh auth login）" >&2; exit 1; }
echo "  工作区干净 / gh 已登录 / 代理 $https_proxy"

step "1/6 同步版本号 -> $VER"
python3 - "$VER" <<'PY'
import json, re, sys, pathlib

ver = sys.argv[1]

def patch_json(path):
    p = pathlib.Path(path)
    d = json.loads(p.read_text(encoding="utf-8"))
    d["version"] = ver
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  {path} -> {ver}")

patch_json("package.json")

p = pathlib.Path("src/components/AboutDialog.tsx")
s = p.read_text(encoding="utf-8")
s2 = re.sub(r'(const VERSION = ")[^"]+(")', r"\g<1>" + ver + r"\g<2>", s, count=1)
assert s2 != s, "AboutDialog.tsx 里没找到 VERSION"
p.write_text(s2, encoding="utf-8")
print(f"  src/components/AboutDialog.tsx -> {ver}")
PY

step "2/6 跑测试"
npm test

step "3/6 离线打包"
npm run app:build

step "4/6 覆盖安装到 $APPIMAGES"
APPIMAGE="$(ls -t "$BUNDLE"/*.AppImage | head -1)"
if [ -z "$APPIMAGE" ]; then
  echo "没找到 AppImage 产物" >&2
  exit 1
fi
mkdir -p "$APPIMAGES"
cp "$APPIMAGE" "$APPIMAGES/mynovel.appimage.new"
if [ -f "$APPIMAGES/mynovel.appimage" ]; then
  mv "$APPIMAGES/mynovel.appimage" "$APPIMAGES/mynovel.appimage.bak-$(date +%Y%m%d-%H%M)"
fi
mv "$APPIMAGES/mynovel.appimage.new" "$APPIMAGES/mynovel.appimage"
chmod +x "$APPIMAGES/mynovel.appimage"
# 备份只留最近一个，其余送回收站
ls -t "$APPIMAGES"/mynovel.appimage.bak-* 2>/dev/null | tail -n +2 | while read -r old; do
  gio trash "$old" 2>/dev/null || true
done
ls -la "$APPIMAGES"/mynovel*

step "5/6 提交 + 打 tag + 推送"
git add -A
git commit -m "chore(release): v$VER"
git tag "v$VER"
git push origin HEAD --tags

step "6/6 建 GitHub release"
ARGS=(--title "MyNovel v$VER")
if [ -n "$NOTES_FILE" ] && [ -f "$NOTES_FILE" ]; then
  ARGS+=(--notes-file "$NOTES_FILE")
else
  ARGS+=(--notes "MyNovel v$VER")
fi
gh release create "v$VER" "$APPIMAGE" "${ARGS[@]}"

echo
echo "v$VER 发完了"
gh release view "v$VER" | head -14
