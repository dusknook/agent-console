# -*- coding: utf-8 -*-
"""
qc.py —— 成片客观体检（深色信息图短片口径）

为什么口径要单独定：原始那套阈值（暗段 <70、亮段 >150）是给**水彩 MV** 定的，
底色是纸白；本片底色是 #080c11（lum≈12），套那套阈值会把每一帧都判成"暗段"，
量出来全是噪音。这里换成三个对本媒介真正有判据力的量：

  1) 分章亮度带 —— 每章的平均亮度是否落在合理区间（深色片基线 22–48）
  2) 章内闪烁   —— 相邻采样帧亮度突变 > 25（不是剪辑点）⇒ 有闪烁 / 状态没收敛
  3) 章间断崖   —— 章节切换处分位（设计过的剪辑点是允许的，但要**知道**它在哪）
  4) 视觉重心   —— 中心区边缘密度 / 全图（<1 = 主体不在中间，信息图应 > 1）

用法：python qc.py [--frames=out/frames] [--md=out/qc.md]
"""
import os, sys, glob, json
import numpy as np
from PIL import Image

args = {}
for a in sys.argv[1:]:
    k, _, v = a.lstrip('-').partition('=')
    args[k] = v or True

FR = args.get('frames', 'out/frames')
FPS = 30.0
STEP = 3                                   # 每 3 帧采 1（10 Hz 足够抓闪烁）
DUR = float(args.get('dur', 60.0))
# ⚠ 必须与 src/scene.js 的 CHAPTERS 逐项对齐（id/起止秒）。改了片子就得同步这里，否则分章判定全是错位的。
CHAPTERS = [
    ('s1 自白', 0.0, 4.0), ('s2 痛点·被打断3次', 4.0, 8.0), ('ctx 上下文入场费·12175t', 8.0, 12.5),
    ('s3 处境·缺工具', 12.5, 16.0), ('s4 初心·你问我', 16.0, 19.5), ('s5 答案·一号用户', 19.5, 23.5),
    ('idx 索引·690t→29路由', 23.5, 28.0), ('s6 不服·请豆包审', 28.0, 31.5), ('s7 交锋·5认4驳', 31.5, 35.0),
    ('s8 危机·搜不到', 35.0, 38.5), ('s9 立住·撕报告', 38.5, 42.7), ('s10 结果·25→19', 42.7, 46.7),
    ('bill 实测账单·19/24510t', 46.7, 51.2), ('s11 盲区·通配符', 51.2, 54.5), ('s12 命题', 54.5, 60.0),
]

# 护栏：章节必须首尾相接、无重叠、且最后一段的出口 == DUR。
# 之所以要这条 —— 时间轴一错位，下面所有分章判定都会"看起来 PASS"但全是错的（静默失败最贵）。
for _i, (_n, _a, _b) in enumerate(CHAPTERS):
    if _b <= _a:
        raise SystemExit('CHAPTERS[%d] %s 区间非法: %s–%s' % (_i, _n, _a, _b))
    if _i and abs(_a - CHAPTERS[_i - 1][2]) > 1e-6:
        raise SystemExit('CHAPTERS[%d] %s 与上一段不接: 上段止 %s / 本段起 %s'
                         % (_i, _n, CHAPTERS[_i - 1][2], _a))
if abs(CHAPTERS[-1][2] - DUR) > 1e-6:
    raise SystemExit('CHAPTERS 末段出口 %s != dur %s（--dur= 传错，或 scene.js 的时间轴改了）'
                     % (CHAPTERS[-1][2], DUR))

files = sorted(glob.glob(os.path.join(FR, 'f*.jpg')))
if not files:
    raise SystemExit('no frames in ' + FR)

rows = []
for i, f in enumerate(files):
    if i % STEP: continue
    im = Image.open(f).convert('RGB')
    sm = np.asarray(im.resize((240, 135)), dtype=np.float32)
    g = np.asarray(im.convert('L'), dtype=np.float32)
    lum = 0.299 * sm[:, :, 0] + 0.587 * sm[:, :, 1] + 0.114 * sm[:, :, 2]
    mx, mn = sm.max(2), sm.min(2)
    sat = ((mx - mn) / (mx + 1e-6)).mean() * 255
    # 边缘密度：中心 50% 区 vs 全图（信息图的主体应在中间）
    gg = np.asarray(im.convert('L').resize((480, 270)), dtype=np.float32)
    e = (np.abs(np.diff(gg, axis=1)).mean() + np.abs(np.diff(gg, axis=0)).mean()) / 2
    h, w = gg.shape
    c = gg[h // 4:h * 3 // 4, w // 4:w * 3 // 4]
    ec = (np.abs(np.diff(c, axis=1)).mean() + np.abs(np.diff(c, axis=0)).mean()) / 2
    rows.append(dict(i=i, t=i / FPS, lum=float(lum.mean()), p90=float(np.percentile(lum, 90)),
                     sat=float(sat), edge=float(e), ratio=float(ec / (e + 1e-6)),
                     dark=float((lum < 24).mean() * 100)))

L = np.array([r['lum'] for r in rows])
T = np.array([r['t'] for r in rows])

out = []
out.append('# 成片客观体检 · 深色信息图短片口径\n')
out.append(f'- 帧目录：`{FR}`  ·  采样 {len(rows)}/{len(files)} 帧（每 {STEP} 帧取 1）')
out.append(f'- 全片亮度：均值 **{L.mean():.1f}** · p10 {np.percentile(L,10):.1f} · p50 {np.percentile(L,50):.1f} · p90 {np.percentile(L,90):.1f} · 标准差 {L.std():.2f}')
out.append(f'- 平均饱和度 {np.mean([r["sat"] for r in rows]):.1f}/255  ·  近黑像素占比 {np.mean([r["dark"] for r in rows]):.1f}%')
out.append(f'- 视觉重心（中心边缘密度/全图）：均值 **{np.mean([r["ratio"] for r in rows]):.2f}**（>1 = 主体在中间）\n')

# ---- 1) 分章亮度带
out.append('## 1) 分章亮度带\n')
out.append('| 章节 | 入点 | 均值 | p10 | p90 | 极差 | 判定 |')
out.append('|---|---:|---:|---:|---:|---:|---|')
for name, a, b in CHAPTERS:
    m = (T >= a) & (T < b)
    if not m.any(): continue
    s = L[m]
    rng = s.max() - s.min()
    ok = (20 <= s.mean() <= 60) and rng < 30
    out.append(f'| {name} | {a:.1f}s | {s.mean():.1f} | {np.percentile(s,10):.1f} | '
               f'{np.percentile(s,90):.1f} | {rng:.1f} | {"PASS" if ok else "CHECK"} |')

# ---- 2) 章内闪烁（相邻采样帧突变）
out.append('\n## 2) 章内闪烁（|Δ亮度| > 25 且非章节边界）\n')
bounds = [a for _, a, _ in CHAPTERS if a > 0]
flk = []
for k in range(1, len(rows)):
    d = rows[k]['lum'] - rows[k - 1]['lum']
    if abs(d) > 25 and not any(abs(rows[k]['t'] - b) < 0.35 for b in bounds):
        flk.append((rows[k]['t'], d))
out.append(f'- 命中 **{len(flk)}** 处' + ('（无 ⇒ 章内没有未收敛的状态切换）' if not flk else ''))
for t0, d in flk[:12]:
    out.append(f'  - t={t0:.2f}s  Δ={d:+.1f}')

# ---- 3) 章节断崖（设计过的剪辑点，登记备查）
out.append('\n## 3) 章节切换处亮度分位（剪辑点登记）\n')
out.append('| 切换点 | 前一采样 | 后一采样 | Δ |')
out.append('|---:|---:|---:|---:|')
for b in bounds:
    k = int(np.argmin(np.abs(T - b)))
    if 0 < k < len(rows):
        out.append(f'| {b:.1f}s | {rows[k-1]["lum"]:.1f} | {rows[k]["lum"]:.1f} | {rows[k]["lum"]-rows[k-1]["lum"]:+.1f} |')

# ---- 4) ASCII 曲线
out.append('\n## 4) 逐帧亮度曲线（10 Hz）\n')
out.append('```')
lo, hi = L.min(), L.max()
CH = ' .:-=+*#%@'
for k in range(0, len(rows), 3):                 # 每 3 个采样画一行 ≈ 每 0.9s 一行
    seg = L[k:k + 3]
    ch = CH[min(9, int((seg.mean() - lo) / (hi - lo + 1e-6) * 9.99))]
    mark = '|' if any(abs(rows[k]['t'] - b) < 0.5 for b in bounds) else ' '
    out.append(f'{rows[k]["t"]:5.1f}s {mark}{ch * 60} {seg.mean():5.1f}')
out.append('```')

txt = '\n'.join(out)
print(txt)
if args.get('md'):
    os.makedirs(os.path.dirname(args['md']) or '.', exist_ok=True)
    open(args['md'], 'w', encoding='utf-8').write(txt + '\n')
    print('\n→ ' + args['md'])
