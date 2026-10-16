#!/usr/bin/env python3
"""把 001.png 的半身立绘抠成挂件素材（一次性工具，日后换图可重跑）。

用法：
    python3 scripts/prepare-widget-image.py <源图> <输出图> [尺寸]
    python3 scripts/prepare-widget-image.py source-assets/widget-girl.png src/assets/widget-girl.png 400

背景是纯黑（实测 max(R,G,B) ≤ 1，只有压缩噪点），而人物自身的暗部——描边、眉毛、
帽衫上的猫脸徽章——最暗也在 163 上下，中间隔着一整个数量级。所以这里用**从四边洪水
填充**而不是全局阈值：只有和画面边缘连通的黑色才会被清掉，人物内部的深色结构无论多暗
都动不到。阈值取 60，离两侧都很远。

抠完再做两件收尾：
  · 颜色外渗（color bleed）—— 透明区的 RGB 是黑的，直接缩放会让边缘混出一圈黑边；
    把不透明像素的颜色往外渗几个像素再缩放，边缘就干净了。
  · alpha 收缩 1px —— 去掉描边外侧那圈半黑的反锯齿残留。
"""

import sys
from collections import deque

from PIL import Image, ImageFilter

# 背景判定阈值。背景实测 ≤ 1，人物最暗 ~163，取 60 两边都安全。
BG_MAX = 60
# 颜色外渗的像素宽度，覆盖缩小时被采样的邻域即可
BLEED = 4
EDGE_SHRINK = 1


def background_mask(img: Image.Image) -> bytearray:
    """从四边洪水填充，返回 1 = 背景（应透明）的位图。"""
    w, h = img.size
    px = img.load()
    mask = bytearray(w * h)  # 0 = 保留，1 = 背景
    queue: deque[tuple[int, int]] = deque()

    def is_bg(x: int, y: int) -> bool:
        r, g, b = px[x, y]
        return r <= BG_MAX and g <= BG_MAX and b <= BG_MAX

    for x in range(w):
        for y in (0, h - 1):
            if not mask[y * w + x] and is_bg(x, y):
                mask[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y * w + x] and is_bg(x, y):
                mask[y * w + x] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not mask[ny * w + nx] and is_bg(nx, ny):
                mask[ny * w + nx] = 1
                queue.append((nx, ny))
    return mask


def to_rgba(img: Image.Image, mask: bytearray) -> Image.Image:
    w, h = img.size
    src = img.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dst = out.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if not mask[row + x]:
                r, g, b = src[x, y]
                dst[x, y] = (r, g, b, 255)
    return out


def bleed_colors(img: Image.Image, passes: int) -> None:
    """把不透明像素的颜色往透明区渗出去，避免缩放出黑边。就地修改。"""
    w, h = img.size
    for _ in range(passes):
        px = img.load()
        pending: list[tuple[int, int, tuple[int, int, int]]] = []
        for y in range(h):
            for x in range(w):
                if px[x, y][3] != 0:
                    continue
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        n = px[nx, ny]
                        if n[3] != 0:
                            pending.append((x, y, (n[0], n[1], n[2])))
                            break
        if not pending:
            break
        for x, y, rgb in pending:
            px[x, y] = (rgb[0], rgb[1], rgb[2], 0)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src_path, dst_path = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 400

    img = Image.open(src_path).convert("RGB")
    mask = background_mask(img)
    kept = len(mask) - sum(mask)
    print(f"{src_path}: {img.size[0]}x{img.size[1]}, 保留 {100 * kept / len(mask):.1f}% 像素")

    rgba = to_rgba(img, mask)
    bleed_colors(rgba, BLEED)

    # 收缩 alpha：去掉描边外那圈反锯齿残留
    alpha = rgba.getchannel("A").filter(ImageFilter.MinFilter(2 * EDGE_SHRINK + 1))
    rgba.putalpha(alpha)

    # 按不透明区裁紧，再补成正方形，这样挂件里的人物不留空边
    box = rgba.getbbox()
    if box:
        rgba = rgba.crop(box)
    side = max(rgba.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(rgba, ((side - rgba.size[0]) // 2, (side - rgba.size[1]) // 2), rgba)

    out = square.resize((size, size), Image.LANCZOS)
    out.save(dst_path)
    print(f"→ {dst_path}: {size}x{size}（裁剪后 {square.size[0]}x{square.size[1]}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
