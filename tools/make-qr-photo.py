#!/usr/bin/env python3
"""生成离线测试用的「手机拍电脑屏幕」二维码照片（数据全部虚构）：
税务局「二维码交付」弹窗 → 放大到约 2200 像素、轻微透视和旋转、叠加正弦条纹模拟摩尔纹、压低对比、加噪点、JPEG 压缩。
卖家在旺旺里发来的发票二维码常是这种照片（2026-10 实测：2268×2319、1.7 MB、摩尔纹明显），jsQR 直接读原图读不出。

用法：python tools/make-qr-photo.py        生成 tools/fixtures/qr-photo-dppt.jpg（能识别）和 qr-photo-blur.jpg（糊得识别不出）
需要 segno、Pillow、numpy；字体找不到时弹窗上不写字（不影响识别）
"""
import io
import math
import sys
from pathlib import Path

import numpy as np
import segno
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent / 'fixtures'
# 虚构发票号（2699 开头，真实地区代码里没有）；地址格式照真实的河北二维码：/v/2_<20 位发票号>_<时间串>RC008
INV_NO = '26990000000000000106'
URL = f'https://dppt.hebei.chinatax.gov.cn:8443/v/2_{INV_NO}_20261008103000000RC008'
FONTS = ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', str(Path.home() / '.local/share/fonts/noto-cjk/NotoSansSC-Regular.otf'),
         '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 'C:/Windows/Fonts/msyh.ttc']


def font(size):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return None


def screen(url):
    """电脑屏幕上的弹窗（1400×1440）：灰底页面 + 白色弹窗 + 二维码 + 发票号、购方、金额"""
    W, H = 1400, 1440
    im = Image.new('RGB', (W, H), (226, 229, 234))
    d = ImageDraw.Draw(im)
    d.rectangle([150, 120, W - 150, H - 120], fill=(255, 255, 255), outline=(200, 200, 205), width=3)
    d.rectangle([150, 120, W - 150, 210], fill=(244, 246, 250))
    qr = segno.make(url, error='m')
    q = qr.to_pil(scale=9, border=2).convert('RGB') if hasattr(qr, 'to_pil') else None
    if q is None:
        buf = io.BytesIO(); qr.save(buf, kind='png', scale=9, border=2); buf.seek(0); q = Image.open(buf).convert('RGB')
    im.paste(q, ((W - q.width) // 2, 300))
    f1, f2 = font(44), font(36)
    if f1:
        d.text((210, 140), '请扫描下方二维码进行下载', font=f1, fill=(40, 40, 40))
        y = 300 + q.height + 50
        for line in ['发票号码：' + INV_NO, '购方名称：示例大学', '价税合计（元）：¥72.00']:
            d.text((260, y), line, font=f2, fill=(60, 60, 60)); y += 70
    return im


FINE = [(4.3, 0.62, 26.0), (6.1, -0.9, 18.0)]


def photo(im, seed, size=(2268, 2319), blur=1.1, moire=0.16, noise=11.0, quality=82, fine=FINE):
    rng = np.random.default_rng(seed)
    W, H = size
    # 拍屏：屏幕没占满画面、略斜（透视 + 约 2.5° 旋转）
    big = Image.new('RGB', (W, H), (70, 72, 78))
    s = im.resize((int(im.width * 1.45), int(im.height * 1.45)), Image.BICUBIC).rotate(2.5, resample=Image.BICUBIC, expand=True, fillcolor=(70, 72, 78))
    big.paste(s, ((W - s.width) // 2, (H - s.height) // 2))
    # 透视：输出平面每个点到输入的映射系数（左上略收、右下略张）
    big = big.transform((W, H), Image.PERSPECTIVE, (1.02, 0.025, -40, 0.012, 1.01, -30, 0.000012, 0.000008), resample=Image.BICUBIC, fillcolor=(70, 72, 78))
    a = np.asarray(big).astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # 摩尔纹：两组方向、周期不同的正弦条纹相乘，RGB 相位错开（真实照片上是彩色条纹）
    for k, (period, ang) in enumerate([(9.5, 0.35), (13.0, -1.1)]):
        ph = 2 * math.pi * (xx * math.cos(ang) + yy * math.sin(ang)) / period
        for c in range(3):
            a[..., c] *= 1 + moire * np.sin(ph + c * 2.1 + k)
    # 屏幕亮度不均、对比偏低
    light = 0.82 + 0.18 * np.cos((xx / W - 0.4) * 2.2) * np.cos((yy / H - 0.55) * 1.8)
    a = 55 + (a * light[..., None]) * 0.62
    # 屏幕像素网格和相机感光点叠出的细密条纹：深色格子上也有（加在亮度上，不是乘）
    for period, ang, amp in fine:
        ph = 2 * math.pi * (xx * math.cos(ang) + yy * math.sin(ang)) / period
        for c in range(3):
            a[..., c] += amp * np.sin(ph + c * 1.7)
    a += rng.normal(0, noise, a.shape)
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
    buf = io.BytesIO()
    out.save(buf, 'JPEG', quality=quality)
    return buf.getvalue()


def main():
    OUT.mkdir(exist_ok=True)
    good = photo(screen(URL), 1)
    (OUT / 'qr-photo-dppt.jpg').write_bytes(good)
    # 识别不出的：同一张弹窗糊得很厉害（对焦失败），二维码的格子已经分不清
    bad = photo(screen(URL), 2, blur=14, moire=0.25, noise=18)
    (OUT / 'qr-photo-blur.jpg').write_bytes(bad)
    print('qr-photo-dppt.jpg', len(good), 'bytes；qr-photo-blur.jpg', len(bad), 'bytes')
    try:                                                   # 有 zxing-cpp 就顺便核对：能识别的那张读得出、糊的那张读不出
        import zxingcpp
        for n in ['qr-photo-dppt.jpg', 'qr-photo-blur.jpg']:
            print(n, [r.text for r in zxingcpp.read_barcodes(Image.open(OUT / n))])
    except ImportError:
        pass


if __name__ == '__main__':
    sys.exit(main())
