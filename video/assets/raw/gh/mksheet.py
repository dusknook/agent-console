import os
from PIL import Image, ImageDraw

SRC = 'dl'
OUT = 'sheet'
os.makedirs(OUT, exist_ok=True)

items = [
    ('whalegirl_mood_delighted.png', 'mood: delighted (cutout)'),
    ('whalegirl_mood_determined.png', 'mood: determined (cutout)'),
    ('whalegirl_mood_sleepy.png', 'mood: sleepy (cutout)'),
    ('whalegirl_icon512.png', 'icon 512'),
    ('whalegirl_maid_left_v5.webp', 'maid LEFT v5'),
    ('whalegirl_maid_right_v7.webp', 'maid RIGHT v7'),
    ('whalegirl_ui_light.webp', 'ui light'),
]

rows = []
for f, lab in items:
    p = os.path.join(SRC, f)
    if not os.path.exists(p):
        print('MISS', f); continue
    im = Image.open(p)
    im.load()
    raw = im.convert('RGBA')
    alpha = raw.getchannel('A')
    amin, amax = alpha.getextrema()
    # 透明像素占比
    hist = alpha.histogram()
    total = sum(hist)
    transp = sum(hist[0:8]) / total if total else 0
    print('%-38s fmt=%-5s size=%sx%s mode=%-4s alpha[%d..%d] transparent=%.1f%% bytes=%d'
          % (f, im.format, im.size[0], im.size[1], im.mode, amin, amax, transp * 100, os.path.getsize(p)))
    rows.append((f, lab, raw))

# 拼图：深底（看透明底）+ 浅底 各一行
S = 380
pad = 16
W = pad + (S + pad) * len(rows)
H = pad + (S + pad) * 2 + 30
cv = Image.new('RGBA', (W, H), (18, 22, 30, 255))
d = ImageDraw.Draw(cv)
for i, (f, lab, raw) in enumerate(rows):
    t = raw.copy()
    t.thumbnail((S, S), Image.LANCZOS)
    # 深底行
    x = pad + i * (S + pad) + (S - t.size[0]) // 2
    y = pad + (S - t.size[1]) // 2
    cv.alpha_composite(t, (x, y))
    # 浅底行
    y2 = pad + S + pad + (S - t.size[1]) // 2
    cv.alpha_composite(t, (x, y2))
    d.text((pad + i * (S + pad), H - 22), lab, fill=(210, 220, 235, 255))

# 中间画一条分隔线
d.line([(0, pad + S + pad // 2), (W, pad + S + pad // 2)], fill=(80, 95, 120, 255), width=2)
cv.convert('RGB').save(os.path.join(OUT, 'whalegirl_sheet.jpg'), quality=93)
print('sheet ->', cv.size)

# 单独导出 delighted 为 PNG（备用）
Image.open(os.path.join(SRC, 'whalegirl_mood_delighted.png')).convert('RGBA').save(os.path.join(OUT, 'whalegirl_delighted.png'))
