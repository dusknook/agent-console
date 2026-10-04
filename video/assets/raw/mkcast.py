# -*- coding: utf-8 -*-
"""生成《一个 AI 的自白》角色定妆板（真实素材版）"""
import os
from PIL import Image, ImageDraw, ImageFont

W = 2400
PAD = 56
CH = 'video/assets/characters'

# ---------- 字体 ----------
def font(sz, bold=False):
    cands = [
        'C:/Windows/Fonts/msyhbd.ttc' if bold else 'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
    ]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, sz)
            except Exception:
                pass
    return ImageFont.load_default()

F_TITLE = font(62, True)
F_SUB = font(30)
F_NAME = font(34, True)
F_META = font(25)
F_USE = font(27)
F_SEC = font(40, True)
F_FOOT = font(26)

# ---------- 数据 ----------
WHALE = [
    ('ds_whalegirl_happy.png', 'Q版 · 开心', '说话 / 被肯定 / 收尾', '1254×1254'),
    ('ds_whalegirl_focus.png', 'Q版 · 坚定', '审核 / 提出质疑 / 结论', '912×981'),
    ('ds_whalegirl_tired.png', 'Q版 · 困倦', '被打断 / 深夜返工', '1254×1254'),
    ('ds_whalegirl_full_a.png', '全身 A · 端咖啡', '出场 / 站位（左）', '1122×2019'),
    ('ds_whalegirl_full_b.png', '全身 B · 拿手机', '出场 / 站位（右）', '1077×2048'),
]
DOUBAO = [
    ('doubao_avatar_1024.png', '官方 App 图标', '头像 / 气泡签', '1024×1024'),
    ('ds_official_whale_225.png', 'DeepSeek 官方鲸鱼', '品牌参照（非角色用）', '225×225'),
]

C_BG = (250, 250, 252)
C_CARD = (255, 255, 255)
C_LINE = (216, 222, 232)
C_TXT = (24, 30, 44)
C_DIM = (108, 118, 134)
C_DS = (56, 82, 190)      # DeepSeek 蓝
C_DB = (36, 130, 220)     # 豆包 蓝
C_TAG = (240, 244, 250)

# ---------- 画布 ----------
TILE_H = 470
SEC_GAP = 300
TOP = 250
H = TOP + TILE_H + 70 + 240 + 70 + TILE_H + 190
cv = Image.new('RGB', (W, H), C_BG)
d = ImageDraw.Draw(cv)

# 标题
d.text((PAD, 70), '《一个 AI 的自白》· 角色定妆板', font=F_TITLE, fill=C_TXT)
d.text((PAD, 152), '全部素材来自网络真实形象 —— 非手绘、非拟合；鲸鱼娘为透明底成品立绘，可直接合成',
       font=F_SUB, fill=C_DIM)

def section(y, label, color, note):
    d.rectangle([PAD, y + 6, PAD + 10, y + 52], fill=color)
    d.text((PAD + 26, y + 4), label, font=F_SEC, fill=C_TXT)
    tw = d.textlength(label, font=F_SEC)
    d.text((PAD + 26 + tw + 22, y + 18), note, font=F_META, fill=C_DIM)
    return y + 70

def tile(x, y, w, h, path, name, use, size, accent):
    d.rounded_rectangle([x, y, x + w, y + h], 18, fill=C_CARD, outline=C_LINE, width=2)
    # 图像区（棋盘格示意透明底）
    ix, iy = x + 16, y + 16
    iw, ih = w - 32, h - 168
    for gy in range(iy, iy + ih, 22):
        for gx in range(ix, ix + iw, 22):
            if ((gx - ix) // 22 + (gy - iy) // 22) % 2 == 0:
                d.rectangle([gx, gy, min(gx + 21, ix + iw), min(gy + 21, iy + ih)], fill=(238, 241, 246))
    p = os.path.join(CH, path)
    if os.path.exists(p):
        im = Image.open(p).convert('RGBA')
        im.thumbnail((iw - 20, ih - 20), Image.LANCZOS)
        cv.paste(im, (ix + (iw - im.size[0]) // 2, iy + (ih - im.size[1]) // 2), im)
    else:
        d.text((ix + 20, iy + 20), 'MISSING ' + path, font=F_META, fill=(220, 60, 60))
    # 文本区
    ty = y + h - 142
    d.text((x + 22, ty), name, font=F_NAME, fill=C_TXT)
    d.text((x + 22, ty + 46), use, font=F_USE, fill=accent)
    d.text((x + 22, ty + 88), size, font=F_META, fill=C_DIM)

# --- 第一区：鲸鱼娘 ---
y = section(TOP, '① 鲸鱼娘（DeepSeek 拟人）', C_DS, '上善（原作 OC 溟月）· ZipZipPipe（DeepSeek 元素二创）· CC BY-NC-SA 4.0')
n = len(WHALE)
gap = 26
tw_ = (W - PAD * 2 - gap * (n - 1)) // n
for i, (f, nm, use, sz) in enumerate(WHALE):
    tile(PAD + i * (tw_ + gap), y, tw_, TILE_H, f, nm, use, sz, C_DS)

# --- 第二区：豆包 ---
y2 = y + TILE_H + 110
y2 = section(y2, '② 豆包（官方经典形象）', C_DB, '字节跳动官方 App 图标 · 浅蓝圆底 + 3D 短发形象')
n2 = len(DOUBAO)
tw2 = (W - PAD * 2 - gap * (n2 - 1)) // (n2 + 1)
for i, (f, nm, use, sz) in enumerate(DOUBAO):
    tile(PAD + i * (tw2 + gap), y2, tw2, TILE_H, f, nm, use, sz, C_DB)

# 右侧说明卡
bx = PAD + n2 * (tw2 + gap)
bw = W - PAD - bx
d.rounded_rectangle([bx, y2, W - PAD, y2 + TILE_H], 18, fill=C_TAG, outline=C_LINE, width=2)
lines = [
    ('※ 对我上一版脚本的两处更正', C_TXT, F_NAME),
    ('', C_TXT, F_META),
    ('DeepSeek 形象：', C_DIM, F_USE),
    ('  我说"蓝色单线描边、尾鳍是光标"', C_TXT, F_META),
    ('  → 实际是【实心蓝鲸】，无单线', C_DS, F_META),
    ('', C_TXT, F_META),
    ('豆包形象：', C_DIM, F_USE),
    ('  我说"浅蓝圆底 + 白色小包子"', C_TXT, F_META),
    ('  → 官方 App 图标是【3D 短发女孩】', C_DB, F_META),
    ('', C_TXT, F_META),
    ('两处都以官方素材为准，已在脚本更正。', C_TXT, F_META),
]
ly = y2 + 30
for t, c, f in lines:
    d.text((bx + 28, ly), t, font=f, fill=c)
    ly += 42

# --- 页脚 ---
fy = y2 + TILE_H + 46
d.line([(PAD, fy), (W - PAD, fy)], fill=C_LINE, width=2)
foot = [
    '授权：鲸鱼娘美术素材 CC BY-NC-SA 4.0 —— 须署名「上善 / ZipZipPipe」· 禁止商业使用 · 衍生须同协议共享。',
    '来源：github.com/Small-tailqwq/dsh-deep-whale（maid-atelier 皮肤）。豆包 / DeepSeek 图标为各自官方商标，仅作指代使用。',
    '复用：画布直接 drawImage 载入 PNG（Chrome 加 --allow-file-access-from-files），透明底原样保留，不做抠图、不做换色。',
]
for i, t in enumerate(foot):
    d.text((PAD, fy + 24 + i * 40), t, font=F_FOOT, fill=C_DIM if i else C_TXT)

cv.save('video/assets/raw/_cast_sheet.jpg', quality=94)
print('cast sheet ->', cv.size)
