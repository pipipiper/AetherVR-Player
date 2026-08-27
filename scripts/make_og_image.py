#!/usr/bin/env python3
"""生成 og:image 分享图（1200×630）：蓝色渐变底 + VR 眼镜图标 + 中文标题。"""
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]

W, H = 1200, 630
C1 = (77, 132, 255)   # #4d84ff
C2 = (36, 89, 216)    # #2459d8

img = Image.new("RGB", (W, H))
px = img.load()
for y in range(H):
    for x in range(W):
        t = (x / W * 0.6 + y / H * 0.4)
        px[x, y] = tuple(round(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))

d = ImageDraw.Draw(img)

# 装饰圆
d.ellipse([820, -220, 1420, 380], fill=(62, 114, 238))
d.ellipse([-260, 380, 340, 980], fill=(62, 114, 238))

# ── VR 眼镜图标（白色，左侧居中）──
gx, gy, gw, gh = 130, 215, 340, 200
d.rounded_rectangle([gx, gy, gx + gw, gy + gh], radius=70, fill=(255, 255, 255))
notch_w, notch_h = 60, 55
cx = gx + gw // 2
grad_mid = tuple(round(C1[i] + (C2[i] - C1[i]) * ((cx / W * 0.6) + ((gy + gh) / H * 0.4))) for i in range(3))
d.polygon([(cx - notch_w, gy + gh), (cx + notch_w, gy + gh), (cx, gy + gh - notch_h)], fill=grad_mid)
lens_r = 42
for lx in (gx + 105, gx + gw - 105):
    ly = gy + gh // 2 - 10
    d.ellipse([lx - lens_r, ly - lens_r, lx + lens_r, ly + lens_r], fill=C2)

# ── 文字 ──
def font(size):
    configured = os.environ.get("AETHERVR_FONT")
    candidates = (
        configured,
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"),
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "simhei.ttf"),
    )
    for font_path in filter(None, candidates):
        try:
            return ImageFont.truetype(font_path, size, index=0)
        except Exception:
            continue
    raise SystemExit("no CJK font found; set AETHERVR_FONT to a compatible .ttf/.ttc file")

f_title = font(72)
f_sub = font(34)

tx = 540
d.text((tx, 200), "AetherVR Player", font=f_title, fill=(255, 255, 255))
d.text((tx + 4, 345), "本地与在线 360° / SBS 视频", font=f_sub, fill=(219, 233, 255))
d.text((tx + 4, 405), "即点即播 · 无需上传", font=f_sub, fill=(219, 233, 255))

output = ROOT / "background-pic.jpg"
img.save(output, quality=88)
print("saved", output, img.size)
