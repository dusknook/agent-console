# -*- coding: utf-8 -*-
"""
build-assets.py —— 把 characters/ 里的真图预处理成 scene.js 可直接用的 data URI 内嵌包。

为什么要内嵌、不用 file:// 直接加载：
  用 file:// 加载本地图片会（在多数 Chrome 版本下）把 canvas 标记成 cross-origin 污染，
  之后每一次 toDataURL() 都会抛 SecurityError —— 而本管线整条都建立在 toDataURL 上。
  改成 data:image/... 后是同源数据，永不污染。代价只是一次性多读一个 js 文件。

三个处理：
  1) 裁到 alpha 包围盒（+2% padding）—— 透明边不参与绘制，裁掉后
     scene.js 里的 drawImage 定位就是"内容边界"，不用再猜偏移量。
  2) 缩到显示尺寸的 ~2 倍（上限见表）—— 大图每帧重采样是白扔的时间。
  3) PNG(optimize) 与 WebP(lossless) 各编一份，**取体积小的那个**（插画类 webp 通常小 25–35%）。

输出：video/src/assets-data.js   →  window.ASSETS = { happy:"data:...", ... }
用法：python build-assets.py
"""
import os, io, json, base64, hashlib
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))    # video/assets
ROOT = os.path.dirname(HERE)                         # video
SRC = os.path.join(HERE, 'characters')
OUT = os.path.join(ROOT, 'src', 'assets-data.js')

# key → (源文件, 缩放上限 px, 用途)
SPEC = [
    ('happy',  'ds_whalegirl_happy.png',  820,  'Q版·开心'),
    ('focus',  'ds_whalegirl_focus.png',  820,  'Q版·坚定'),
    ('tired',  'ds_whalegirl_tired.png',  820,  'Q版·困倦'),
    ('fullA',  'ds_whalegirl_full_a.png', 1460, '全身·端咖啡'),
    ('fullB',  'ds_whalegirl_full_b.png', 1460, '全身·拿手机'),
    ('doubao', 'doubao_avatar_1024.png',  480,  '豆包官方图标'),
]

PAD = 0.02          # 裁剪后补 2% 边，避免贴上边缘
ALPHA_MIN = 8       # 视为"内容"的 alpha 阈值


def alpha_bbox(im):
    """按 alpha 通道找内容包围盒（比 getbbox() 稳：getbbox 会把近透明的噪点算进去）"""
    a = im.getchannel('A')
    return a.point(lambda v: 255 if v >= ALPHA_MIN else 0).getbbox()


def encode(im):
    """PNG 与无损 WebP 各编一遍，返回 (mime, bytes, ext) 中较小的那个。"""
    cands = []
    b = io.BytesIO(); im.save(b, 'PNG', optimize=True)
    cands.append(('image/png', b.getvalue(), 'png'))
    try:
        b = io.BytesIO(); im.save(b, 'WEBP', lossless=True, quality=100, method=6)
        cands.append(('image/webp', b.getvalue(), 'webp'))
    except Exception as e:
        print('   webp 不可用:', e)
    return min(cands, key=lambda c: len(c[1]))


rows, js = [], []
total = 0
for key, fn, cap, note in SPEC:
    p = os.path.join(SRC, fn)
    im = Image.open(p).convert('RGBA')
    orig = im.size
    bb = alpha_bbox(im)
    if bb:
        im = im.crop(bb)
    cropped = im.size
    im.thumbnail((cap, cap), Image.LANCZOS)
    if PAD:
        pw = max(4, int(im.size[0] * PAD)); ph = max(4, int(im.size[1] * PAD))
        canvas = Image.new('RGBA', (im.size[0] + pw * 2, im.size[1] + ph * 2), (0, 0, 0, 0))
        canvas.paste(im, (pw, ph))
        im = canvas
    mime, data, ext = encode(im)
    uri = 'data:%s;base64,%s' % (mime, base64.b64encode(data).decode('ascii'))
    total += len(uri)
    rows.append(dict(key=key, src=fn, note=note, orig='%dx%d' % orig,
                     cropped='%dx%d' % cropped, out='%dx%d' % im.size,
                     mime=mime, bytes=len(data), uri_chars=len(uri),
                     sha=hashlib.sha256(data).hexdigest()[:16]))
    js.append('  %-8s: "%s",' % (key, uri))
    print('  %-7s %-28s %-12s -> %-11s %-10s %8.1f KB  (原 %6.1f KB)' %
          (key, note, '%dx%d' % orig, '%dx%d' % im.size, ext,
           len(data) / 1024, os.path.getsize(p) / 1024))

body = '\n'.join([
    '/* assets-data.js —— 自动生成，请勿手改（改素材请跑 assets/build-assets.py）',
    ' * 源：video/assets/characters/   生成时间戳见下  共 %d 个资源' % len(rows),
    ' * 为什么内嵌：file:// 加载的图会污染 canvas，toDataURL() 直接抛 SecurityError；',
    ' *             data URI 同源，永不污染。 */',
    'window.ASSETS = {',
] + js + [
    '};',
    'window.ASSETS_META = %s;' % json.dumps(rows, ensure_ascii=False, indent=1).replace('\n', '\n'),
    '',
])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf-8').write(body)

print('\n总内嵌 %.2f MB（js 文件 %s，%.2f MB）' %
      (total / 1048576, os.path.relpath(OUT, ROOT), os.path.getsize(OUT) / 1048576))
if sum(r['bytes'] for r in rows) == 0:
    raise SystemExit('没有产出任何素材，检查 SRC')
