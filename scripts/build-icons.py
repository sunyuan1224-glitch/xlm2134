#!/usr/bin/env python3
"""由母版插画生成 MyNovel 全套应用图标（圆角正方形透明蒙版）。

用法：
    python3 scripts/build-icons.py            # 默认圆角比例 14/88
    RADIUS_RATIO=0.2 python3 scripts/build-icons.py

圆角依据：与本机已安装应用 wemeet 的现成数值保持一致，
/usr/share/icons/hicolor/scalable/apps/wemeet.svg
    width=88 height=88 rx=14   →   14/88 ≈ 15.91%
换算到 512px 母版即 rx = 81.45px。只裁剪外轮廓，
母版插画的内容与颜色完全不动。

输出（均为 RGBA，四角 alpha 精确为 0）：
    src-tauri/icons/icon.png         512x512   ← bundle.icon 进包的那个
    src-tauri/icons/128x128@2x.png   256x256
    src-tauri/icons/128x128.png      128x128
    src-tauri/icons/64x64.png         64x64
    src-tauri/icons/32x32.png         32x32
    src-tauri/icons/icon.ico          Windows 多尺寸（256/128/64/48/32/16）

母版：src-tauri/icons/source/icon-master.png（满幅方形插画，勿换成 SVG）。
依赖：Python 3 + Pillow，无其他依赖。
"""

import os
import sys
from PIL import Image, ImageChops, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "src-tauri", "icons")
MASTER = os.path.join(ICONS, "source", "icon-master.png")

# 14/88 来自 wemeet.svg 的 rx=14 / 外框 88（见文件头说明）
RADIUS_RATIO = float(os.environ.get("RADIUS_RATIO", str(14 / 88)))
# 超采样倍数：蒙版按 8 倍画再按面积平均降采样（无振铃）
SUPERSAMPLE = 8

PNG_TARGETS = {
    "icon.png": 512,
    "128x128@2x.png": 256,
    "128x128.png": 128,
    "64x64.png": 64,
    "32x32.png": 32,
}
ICO_SIZES = [256, 128, 64, 48, 32, 16]
ALL_SIZES = sorted(set(PNG_TARGETS.values()) | set(ICO_SIZES))


def rounded_mask(size: int) -> Image.Image:
    """黑白圆角正方形蒙版。

    用 8 倍超采样 + 面积平均（BOX）降采样，得到不产生负向振铃的抗锯齿边缘，
    并把四角像素显式置 0，保证每个尺寸的四个角都严格透明。
    """
    radius_big = max(1, int(round(size * RADIUS_RATIO * SUPERSAMPLE)))
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=radius_big, fill=255
    )
    mask = mask.resize((size, size), Image.Resampling.BOX)
    for x, y in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)):
        mask.putpixel((x, y), 0)
    return mask


def with_rounded_corners(master: Image.Image, size: int) -> Image.Image:
    """保留原 RGB，只把圆角蒙版乘到 alpha 上（母版 alpha 本身全 255）。"""
    out = master.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    alpha = ImageChops.multiply(out.getchannel("A"), rounded_mask(size))
    out.putalpha(alpha)
    return out


def main() -> int:
    if not os.path.exists(MASTER):
        print(f"缺少母版：{MASTER}", file=sys.stderr)
        return 1
    master = Image.open(MASTER).convert("RGBA")
    if master.width != master.height:
        print(f"母版必须是正方形，实际 {master.size}", file=sys.stderr)
        return 1

    # 一律从满幅母版重新生成，不会叠加已有圆角
    rendered = {size: with_rounded_corners(master, size) for size in ALL_SIZES}

    for name, size in PNG_TARGETS.items():
        rendered[size].save(os.path.join(ICONS, name), format="PNG", optimize=True)
        print(f"写出 {name} ({size}x{size}, r={size * RADIUS_RATIO:.2f}px)")

    ico_layers = [rendered[size] for size in ICO_SIZES]
    ico_layers[0].save(
        os.path.join(ICONS, "icon.ico"),
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=ico_layers[1:],
    )
    print(f"写出 icon.ico ({'/'.join(str(s) for s in ICO_SIZES)})")
    print(f"圆角比例 {RADIUS_RATIO:.5f}（512px 时 r={512 * RADIUS_RATIO:.2f}px）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
