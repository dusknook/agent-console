/* ============================================================================
   scene.js —《本轮：一次改动，五步落地》

   内容 = 2026-10-03 这一轮真实做过的五步：
     01  §4 三条建议 → 判定（① 不做 / ② ③ 做）
     02  幂等强度四档：safe 13 · optional 12 · fingerprint_dedup 3 · required 1
     03  一个档位只能由一处实现（第一版整片 500 的教训）
     04  审批单可选 TTL：approval_ttl_s → EXPIRED
     05  线上同步 · 13 文件逐字节核验

   纪律：
   - 画面里出现的每个数字都是实测值，不是估的（同步核验报告 / .tests-summary.json）。
   - 所有运动是 t 的纯函数 —— 同一 t 永远同一帧（断点续渲的前提）。
   - 零外部资源：只用系统字体，不引 Google Fonts（断网会静默退化成 sans-serif）。
   ========================================================================= */
(() => {
'use strict';

const W = 1920, H = 1080;

/* ------------------------------------------------------------------ 调色 */
const C = {
  bg:     '#080c11',
  panel:  'rgba(27,38,53,0.94)',
  grid:   'rgba(120,140,170,0.095)',
  fg:     '#e6edf3',
  dim:    '#8b949e',
  faint:  '#4d5761',
  edge:   'rgba(139,148,158,0.18)',
  green:  '#3fb950',
  blue:   '#58a6ff',
  orange: '#d29922',
  red:    '#f85149',
  purple: '#a371f7',
  teal:   '#39c5cf',
  slate:  '#9aa5b1',   // safe 档：要在深底上看得见，太暗会整列消失
};

const MONO = '"Cascadia Mono","Consolas","SF Mono","DejaVu Sans Mono",monospace';
const SANS = '"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif';
const fM = (px, wt) => (wt ? wt + ' ' : '') + px + 'px ' + MONO;
const fS = (px, wt) => (wt ? wt + ' ' : '') + px + 'px ' + SANS;

/* ------------------------------------------------------------------ 数学 */
const cl = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const eOut = k => 1 - Math.pow(1 - k, 3);
const eOut5 = k => 1 - Math.pow(1 - k, 5);
const eIn = k => k * k * k;
const win = (t, a, b) => cl((t - a) / (b - a));   // 时间窗 → 0..1
const app = (t, a, d = 0.55) => eOut(win(t, a, a + d));  // 淡入进度
const rnd = (i, s = 127.1) => { const x = Math.sin(i * s + 311.7) * 43758.5453; return x - Math.floor(x); };

/* ------------------------------------------------------------------ 绘图原语 */
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 统一文本入口：s=文字 · x,y · o={font,color,align,base,alpha,ls,ls0} */
function T(ctx, s, x, y, o = {}) {
  ctx.save();
  ctx.font = o.font || fS(30);
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.base || 'alphabetic';
  if (o.ls != null) ctx.letterSpacing = o.ls + 'px';
  ctx.globalAlpha = cl(o.alpha == null ? 1 : o.alpha);
  ctx.fillStyle = o.color || C.fg;
  ctx.fillText(s, x, y);
  ctx.restore();
}
function tw(ctx, s, font, ls) {
  ctx.save(); ctx.font = font; if (ls != null) ctx.letterSpacing = ls + 'px';
  const w = ctx.measureText(s).width; ctx.restore(); return w;
}

/** 带底的数值：数字用等宽、右对齐，读起来像仪表 */
function num(ctx, v, x, y, o = {}) {
  T(ctx, String(v), x, y, Object.assign({ font: fM(34, '600'), align: 'right' }, o));
}

function panel(ctx, x, y, w, h, o = {}) {
  ctx.save();
  ctx.globalAlpha = cl(o.alpha == null ? 1 : o.alpha);
  ctx.fillStyle = o.fill || C.panel;
  rr(ctx, x, y, w, h, o.r == null ? 12 : o.r); ctx.fill();
  if (o.edge !== false) {
    ctx.strokeStyle = o.edgeColor || C.edge;
    ctx.lineWidth = o.lw || 1.5;
    rr(ctx, x, y, w, h, o.r == null ? 12 : o.r); ctx.stroke();
  }
  ctx.restore();
}

/** 圆点徽章 */
function badge(ctx, x, y, text, color, alpha = 1, fs = 26) {
  ctx.save();
  ctx.globalAlpha = cl(alpha);
  const w = tw(ctx, text, fM(fs, '600')) + 40, h = fs + 26;
  ctx.fillStyle = color.replace(')', ',0.14)').replace('rgb', 'rgba');
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  rr(ctx, x, y, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x + h / 2 - 2, y + h / 2, 4, 0, 7); ctx.fill();
  ctx.font = fM(fs, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + h / 2 + 10, y + h / 2 + 1);
  ctx.restore();
  return w;
}

/* ------------------------------------------------------------------ 背景 */
function bg(ctx, t) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // 缓慢游走的环境光（让「静止」的镜头也有呼吸）
  const cx = W * 0.5 + Math.sin(t * 0.13) * 110;
  const cy = H * 0.44 + Math.cos(t * 0.11) * 46;
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1200);
  g.addColorStop(0, 'rgba(56,110,180,0.16)');
  g.addColorStop(0.5, 'rgba(40,70,120,0.07)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 网格：横向慢速漂移
  const gs = 64, off = (t * 6) % gs;
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -off; x < W; x += gs) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, H); }
  for (let y = -off; y < H; y += gs) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(W, Math.round(y) + .5); }
  ctx.stroke();

  // 上层薄雾：均匀抬升底子。纯黑（#080c11, lum≈11）在 1080p 上是"一坨洞"，
  // 加一层极淡的蓝能把暗部变成"深蓝黑"，画面立刻有层次 —— 实测让近黑像素从 90.6% 降到 ~62%。
  ctx.fillStyle = 'rgba(30,52,84,0.10)'; ctx.fillRect(0, 0, W, H);

  // 暗角
  g = ctx.createRadialGradient(W / 2, H / 2, H * 0.38, W / 2, H / 2, H * 1.08);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

/* ------------------------------------------------------------------ 章节头 */
function head(ctx, t, n, kicker, title) {
  const a = app(t, 0.04, 0.42);
  const x = 140;
  ctx.save(); ctx.globalAlpha = a;
  ctx.fillStyle = C.blue; ctx.fillRect(x, 96, 5, 52);
  ctx.restore();
  T(ctx, String(n).padStart(2, '0'), x + 24, 140, { font: fM(34, '700'), color: C.blue, alpha: a, ls: 1 });
  const nw = tw(ctx, String(n).padStart(2, '0'), fM(34, '700'), 1);
  T(ctx, kicker, x + 24 + nw + 26, 140, { font: fM(25), color: C.faint, alpha: a, ls: 3 });
  T(ctx, title, x, 214, { font: fS(56, '700'), color: C.fg, alpha: a });
  // 侧线
  ctx.save(); ctx.globalAlpha = a * 0.9;
  ctx.strokeStyle = C.edge; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(x, 250); ctx.lineTo(W - 140, 250); ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ HUD */
function fmtTC(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * 30);
  return '00:' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ':' + String(f).padStart(2, '0');
}
function hud(ctx, t, cur) {
  // 顶部进度条
  ctx.fillStyle = 'rgba(139,148,158,0.13)'; ctx.fillRect(0, 0, W, 3);
  ctx.fillStyle = C.blue; ctx.fillRect(0, 0, W * (t / DUR), 3);

  T(ctx, 'agent-console-eval  ·  本轮制作', 60, H - 44, { font: fM(22), color: C.faint });
  T(ctx, fmtTC(t), W - 60, H - 44, { font: fM(22), color: C.faint, align: 'right' });

  // 章节刻度
  const cw = 46, total = CHAPTERS.length * cw - 12, x0 = W / 2 - total / 2;
  CHAPTERS.forEach((c, i) => {
    const on = c === cur;
    ctx.save();
    ctx.globalAlpha = on ? 0.95 : 0.3;
    ctx.fillStyle = on ? c.dot : C.faint;
    rr(ctx, x0 + i * cw, H - 52, on ? 34 : 12, 4, 2); ctx.fill();
    ctx.restore();
  });
}

/* ==================================================================== 01 开场 */
function s1(ctx, t) {
  const cx = W / 2;

  const a0 = app(t, 0.10, 0.5);
  ctx.save(); ctx.globalAlpha = a0;
  ctx.strokeStyle = C.blue; ctx.lineWidth = 2;
  const sw = 240 * eOut5(win(t, 0.10, 1.1));
  ctx.beginPath(); ctx.moveTo(cx - sw / 2, 300); ctx.lineTo(cx + sw / 2, 300); ctx.stroke();
  ctx.restore();

  T(ctx, 'A G E N T - C O N S O L E   E V A L   ·   2 0 2 6 - 1 0 - 0 3',
    cx, 374, { font: fM(24, '600'), color: C.dim, align: 'center', alpha: app(t, 0.25, 0.55), ls: 5 });

  // 主标题：起始值取负 —— 让第 0 帧就有 55% 亮度，首帧即可当封面（skill §19）
  const a2 = app(t, -0.23, 1.0);
  ctx.save(); ctx.globalAlpha = a2;
  ctx.translate(0, (1 - a2) * 24);
  T(ctx, '一次改动，五步落地', cx, 500, { font: fS(104, '800'), color: C.fg, align: 'center' });
  ctx.restore();

  T(ctx, '① 判定  ·  ② 四档  ·  ③ 一档一处  ·  ④ TTL  ·  ⑤ 同步',
    cx, 592, { font: fS(34), color: C.dim, align: 'center', alpha: app(t, 0.95, 0.6), ls: 1 });

  const a4 = app(t, 1.45, 0.65);
  ctx.save(); ctx.globalAlpha = a4;
  ctx.strokeStyle = 'rgba(139,148,158,0.28)'; ctx.lineWidth = 1.4;
  const lw = 820 * eOut5(win(t, 1.45, 2.3));
  ctx.beginPath(); ctx.moveTo(cx - lw / 2, 668); ctx.lineTo(cx + lw / 2, 668); ctx.stroke();
  ctx.restore();

  T(ctx, '本片由「绘画代码 → 无头 Chrome 逐帧 → ffmpeg」渲染 · 零模型 · 零 API · 完全可复现',
    cx, 742, { font: fM(25), color: C.faint, align: 'center', alpha: app(t, 1.90, 0.7) });
  T(ctx, '画面里出现的每个数字都来自这一轮的真实运行，没有一个是估的',
    cx, 790, { font: fM(25), color: C.faint, align: 'center', alpha: app(t, 2.30, 0.7) });

  // 收束线：与收尾章同款，首尾呼应；也顺手把画面下三分之一从"纯黑"里拉回来
  const bz = eOut(win(t, 2.30, 3.2));
  ctx.save(); ctx.globalAlpha = app(t, 2.30, 0.7) * 0.75;
  ctx.strokeStyle = C.blue; ctx.lineWidth = 4; ctx.lineCap = 'round';
  const half = (W - 280) / 2 * bz;
  ctx.beginPath(); ctx.moveTo(cx - half, 880); ctx.lineTo(cx + half, 880); ctx.stroke();
  ctx.restore();
}

/* ==================================================================== 02 判定表 */
const ROWS = [
  { n: '①', text: '补全 OpenAPI Envelope schema，与实际响应字段对齐',
    verdict: '不做', color: C.slate, why: '回归实测逐字段一致 —— 评测者误读' },
  { n: '②', text: '给所有写端点增加可选幂等校验（复用 idem_keys）',
    verdict: '做', color: C.green, why: '通用中间件 + 第四档 optional' },
  { n: '③', text: '审批单增加可选 TTL 超时机制',
    verdict: '做', color: C.green, why: 'approval_ttl_s → 到期转 EXPIRED' },
];
function s2(ctx, t) {
  head(ctx, t, 1, 'JUDGEMENT', '§4 三条建议 → 三条判定');

  ROWS.forEach((r, i) => {
    const t0 = 0.45 + i * 0.5;
    const a = app(t, t0, 0.5);
    const x = 190, y = 320 + i * 148, w = 1540, h = 116;
    const dx = (1 - a) * -46;

    ctx.save(); ctx.globalAlpha = a; ctx.translate(dx, 0);
    panel(ctx, x, y, w, h, { r: 14, lw: 1.5, edgeColor: i === 0 ? C.edge : r.color + '55' });

    // 序号圆
    ctx.fillStyle = i === 0 ? 'rgba(125,133,144,0.16)' : r.color;
    ctx.beginPath(); ctx.arc(x + 62, y + h / 2, 25, 0, 7); ctx.fill();
    T(ctx, r.n, x + 62, y + h / 2 + 1, { font: fS(30, '700'), color: i === 0 ? C.dim : '#04140a', align: 'center', base: 'middle' });

    T(ctx, r.text, x + 112, y + h / 2 + 1, { font: fS(33), color: C.fg, base: 'middle' });
    ctx.restore();

    // 判定徽章（晚一拍盖下来）
    const b0 = 0.78 + i * 0.5;
    const ba = app(ctx, 0, 0) === 0 ? app(t, b0, 0.45) : app(t, b0, 0.45);
    const scale = lerp(1.35, 1, eOut4(win(t, b0, b0 + 0.45)));
    const bw = 132, bx = x + w - bw - 46, by = y + 24;
    ctx.save();
    ctx.globalAlpha = ba;
    ctx.translate(bx + bw / 2, by + (h - 48) / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(bx + bw / 2), -(by + (h - 48) / 2));
    ctx.fillStyle = i === 0 ? 'rgba(125,133,144,0.12)' : r.color + '22';
    ctx.strokeStyle = i === 0 ? C.faint : r.color;
    ctx.lineWidth = 2;
    rr(ctx, bx, by, bw, h - 48, 10); ctx.fill(); ctx.stroke();
    T(ctx, r.verdict, bx + bw / 2, by + (h - 48) / 2 + 1,
      { font: fS(34, '700'), color: i === 0 ? C.dim : r.color, align: 'center', base: 'middle' });
    ctx.restore();

    T(ctx, r.why, x + w - bw - 76, y + h + 32,
      { font: fM(24), color: C.dim, align: 'right', alpha: ba });
  });

  T(ctx, '两者都做成「可选 / 向后兼容」—— 不带新参数的行为逐字节不变',
    W / 2, 838, { font: fS(36, '600'), color: C.fg, align: 'center', alpha: app(t, 2.65, 0.6) });

  T(ctx, '落地后独立验证 23 项全 PASS：A 组 可选幂等 10  ·  B 组 TTL 12  ·  C 组 向后兼容 1',
    W / 2, 894, { font: fM(26), color: C.teal, align: 'center', alpha: app(t, 3.15, 0.7) });

  T(ctx, '验证脚本是临时写的，跑完即删 —— 它只负责在「声称」和「实测」之间当一次证人',
    W / 2, 944, { font: fM(24), color: C.dim, align: 'center', alpha: app(t, 3.9, 0.8) });
}
function eOut4(k) { return 1 - Math.pow(1 - k, 4); }

/* ==================================================================== 03 四档分布 */
const TIERS = [
  { key: 'safe',              n: 13, color: C.slate,  note: '只读端点',       sub: '重发天然无害' },
  { key: 'optional',          n: 12, color: C.green,  note: '带键才生效',     sub: '不带键 ⇒ 从前行为什么都不变' },
  { key: 'fingerprint_dedup', n: 3,  color: C.purple, note: '门控端点',       sub: '按内容指纹合并，不开第二张待批单' },
  { key: 'required',          n: 1,  color: C.orange, note: 'handler 自管',   sub: 'act / queue —— 中间件不许插脚' },
];
function s3(ctx, t) {
  head(ctx, t, 2, 'IDEMPOTENCY', '幂等强度：四档，29 条路由，同一处派生');

  const X0 = 140, COLW = 380, GAP = 40, perRow = 7, bw = 46, bh = 28, gx = 7, gy = 8;
  let gi = 0;

  TIERS.forEach((tr, ci) => {
    const x = X0 + ci * (COLW + GAP);
    const ta = app(t, 0.22 + ci * 0.14, 0.5);

    // 档位名
    T(ctx, tr.key, x, 336, { font: fM(26, '600'), color: tr.color, alpha: ta, ls: 0.5 });

    // 大数字（滚动到位）
    const ka = win(t, 0.75 + ci * 0.16, 1.65 + ci * 0.16);
    const shown = Math.round(tr.n * eOut(ka));
    T(ctx, String(shown), x, 424, { font: fM(72, '700'), color: tr.color, alpha: ta });

    // 说明
    T(ctx, tr.note, x, 462, { font: fS(22), color: C.dim, alpha: ta });

    // 方块：一块 = 一条路由
    ctx.save();
    for (let i = 0; i < tr.n; i++) {
      const row = Math.floor(i / perRow), col = i % perRow;
      const bx = x + col * (bw + gx), by = 496 + row * (bh + gy);
      const k = app(t, 1.15 + gi * 0.045, 0.5);
      gi++;
      ctx.globalAlpha = k;
      const yy = by + (1 - k) * 30;
      ctx.fillStyle = tr.color;
      rr(ctx, bx, yy, bw, bh, 5); ctx.fill();
      ctx.globalAlpha = k * 0.85; ctx.strokeStyle = tr.color; ctx.lineWidth = 1.4;
      rr(ctx, bx, yy, bw, bh, 5); ctx.stroke();
    }
    ctx.restore();

    T(ctx, tr.sub, x, 620, { font: fS(20), color: C.faint, alpha: app(t, 2.5 + ci * 0.1, 0.6) });
  });

  // not_enforced 整档取消 —— 划掉它
  const y = 748;
  const sa = app(t, 3.5, 0.5);
  const label = 'not_enforced';
  const lw2 = tw(ctx, label, fM(38, '700'));
  T(ctx, label, W / 2 - 210 - lw2, y, { font: fM(38, '700'), color: C.orange, alpha: sa });
  // 划线
  const sk = eOut(win(t, 4.0, 4.7));
  if (sk > 0) {
    ctx.save(); ctx.globalAlpha = sa;
    ctx.strokeStyle = C.red; ctx.lineWidth = 5; ctx.lineCap = 'round';
    const x1 = W / 2 - 210 - lw2 - 10, x2 = W / 2 - 210;
    ctx.beginPath(); ctx.moveTo(x1, y - 12); ctx.lineTo(x1 + (x2 - x1) * sk, y - 12); ctx.stroke();
    ctx.restore();
  }
  T(ctx, '整档取消', W / 2 - 180, y, { font: fS(40, '700'), color: C.fg, alpha: app(t, 4.5, 0.5) });
  T(ctx, '「无法自保」和「带上键就能自保」是两个世界', W / 2 + 90, y,
    { font: fS(26), color: C.dim, alpha: app(t, 4.9, 0.6) });

  T(ctx, '测试刻意不断言「N 档有 M 条」，只断言「声明与实测一致」—— 否则每加一个端点就要改测试',
    W / 2, 836, { font: fM(25), color: C.teal, align: 'center', alpha: app(t, 5.4, 0.7) });
  T(ctx, '物理保证仍是 PRIMARY KEY(idem_keys.key)，不是应用层的一句 if',
    W / 2, 888, { font: fM(23), color: C.faint, align: 'center', alpha: app(t, 6.0, 0.8) });
}

/* ==================================================================== 04 一档一处 */
function s4(ctx, t) {
  head(ctx, t, 3, 'ONE TIER, ONE PLACE', '一个档位只能由一处实现');

  const broken = t >= 2.15 && t < 3.85;   // 冲突窗口
  const fixed = t >= 3.85;

  // 两个框
  const boxes = [
    { x: 250, w: 560, title: 'idemClaim / idemSettle', sub: '通用幂等中间件', color: C.blue,
      code: fixed ? 'if (META[key].idem) return null;' : '' },
    { x: 1110, w: 560, title: 'handler · act / queue', sub: 'required 档，自己查 idem_keys', color: C.orange,
      code: 'SELECT payload FROM idem_keys …' },
  ];
  boxes.forEach((b, i) => {
    const a = app(t, 0.45 + i * 0.2, 0.55);
    const y = 312, h = 172;
    const col = broken && i === 0 ? C.red : b.color;
    panel(ctx, b.x, y, b.w, h, { r: 14, lw: 1.8, edgeColor: col + (broken && i === 0 ? 'cc' : '66'), alpha: a });
    T(ctx, b.title, b.x + 30, y + 52, { font: fM(28, '600'), color: col, alpha: a });
    T(ctx, b.sub, b.x + 30, y + 88, { font: fS(23), color: C.dim, alpha: a });
    T(ctx, b.code, b.x + 30, y + 132, { font: fM(23), color: broken && i === 0 ? C.red : C.green,
      alpha: a * (b.code ? 1 : 0) });
  });

  // 中央 idem_keys 行
  const a3 = app(t, 0.85, 0.55);
  const kx = 800, ky = 626, kw = 320, kh = 84;
  const shake = broken ? Math.sin(t * 44) * 5 : 0;
  ctx.save();
  ctx.globalAlpha = a3;
  ctx.translate(shake, 0);
  panel(ctx, kx, ky, kw, kh, { r: 10, lw: 2, edgeColor: broken ? C.red : (fixed ? C.green : C.edge),
    fill: broken ? 'rgba(248,81,73,0.10)' : (fixed ? 'rgba(63,185,80,0.08)' : C.panel) });
  T(ctx, 'idem_keys', kx + kw / 2, ky + 37, { font: fM(29, '600'), align: 'center',
    color: broken ? C.red : (fixed ? C.green : C.fg) });
  T(ctx, 'PRIMARY KEY(key)', kx + kw / 2, ky + 67, { font: fM(19), color: C.dim, align: 'center' });
  ctx.restore();

  // 两条箭头
  const arrows = [
    { fx: 530, on: !fixed && !broken, col: broken ? C.red : C.blue },
    { fx: 1390, on: true, col: broken ? C.red : C.orange },
  ];
  arrows.forEach((ar, i) => {
    if (i === 0 && fixed) return;   // 修好之后中间件不再插脚 —— 箭头消失
    const aa = app(t, 1.0 + i * 0.12, 0.5) * (broken ? 1 : 0.55);
    ctx.save(); ctx.globalAlpha = aa;
    ctx.strokeStyle = ar.col; ctx.lineWidth = broken ? 3.5 : 2.2;
    ctx.setLineDash(broken ? [9, 7] : []);
    ctx.beginPath();
    ctx.moveTo(ar.fx, 484);
    ctx.bezierCurveTo(ar.fx, 556, kx + kw / 2, 556, kx + kw / 2, ky - 4);
    ctx.stroke();
    ctx.setLineDash([]);
    // 箭头尖
    ctx.beginPath();
    ctx.moveTo(kx + kw / 2, ky - 2); ctx.lineTo(kx + kw / 2 - 9, ky - 18); ctx.lineTo(kx + kw / 2 + 9, ky - 18);
    ctx.closePath(); ctx.fillStyle = ar.col; ctx.fill();
    ctx.restore();
  });

  // 结论文本（带底：让「结论」和「过程」在版面上分开）
  if (broken) {
    const a = app(t, 2.15, 0.35);
    ctx.save(); ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(248,81,73,0.10)';
    rr(ctx, 470, 744, 980, 138, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(248,81,73,0.45)'; ctx.lineWidth = 1.6;
    rr(ctx, 470, 744, 980, 138, 14); ctx.stroke();
    ctx.restore();
    T(ctx, "Cannot read properties of null (reading 'action_id')", W / 2, 798,
      { font: fM(30, '600'), color: C.red, align: 'center', alpha: a });
    T(ctx, '11 套里 10 套立刻变红', W / 2, 856,
      { font: fS(40, '700'), color: C.red, align: 'center', alpha: a });
  }
  if (fixed) {
    const a = app(t, 3.85, 0.4);
    ctx.save(); ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(63,185,80,0.09)';
    rr(ctx, 470, 744, 980, 122, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(63,185,80,0.45)'; ctx.lineWidth = 1.6;
    rr(ctx, 470, 744, 980, 122, 14); ctx.stroke();
    ctx.restore();
    T(ctx, '中间件显式跳过自管档 —— required 档不归它管', W / 2, 798,
      { font: fS(32, '600'), color: C.green, align: 'center', alpha: a });
    T(ctx, '11 套 / 0 红', W / 2, 854,
      { font: fS(44, '700'), color: C.green, align: 'center', alpha: a });
    T(ctx, '为什么没被静默放过：断言卡「行为」（真调两次看结果），不是卡「意图」（代码里有没有 if）',
      W / 2, 928, { font: fM(25), color: C.teal, align: 'center', alpha: app(t, 4.6, 0.6) });
  }
}

/* ==================================================================== 05 TTL */
function s5(ctx, t) {
  head(ctx, t, 4, 'APPROVAL TTL', '审批单：可选 TTL，到期自动关闭');

  const x = 470, y = 320, w = 980, h = 286, a = app(t, 0.4, 0.55);
  const expired = t >= 4.55;
  const flash = expired ? cl(1 - (t - 4.55) / 0.5) : 0;
  const col = expired ? C.orange : C.blue;

  panel(ctx, x, y, w, h, { r: 16, lw: 2, edgeColor: col + (expired ? 'cc' : '77'), alpha: a });
  if (flash > 0) {
    ctx.save(); ctx.globalAlpha = flash * 0.28; ctx.fillStyle = C.orange;
    rr(ctx, x, y, w, h, 16); ctx.fill(); ctx.restore();
  }

  T(ctx, 'POST /v1/act/:id/confirm', x + 40, y + 62, { font: fM(27, '600'), color: C.fg, alpha: a });

  // 状态徽章
  const st = expired ? 'EXPIRED' : 'PENDING';
  const stw = tw(ctx, st, fM(24, '700')) + 46;
  ctx.save(); ctx.globalAlpha = a;
  ctx.fillStyle = col + '22'; ctx.strokeStyle = col; ctx.lineWidth = 1.8;
  rr(ctx, x + w - stw - 40, y + 34, stw, 44, 22); ctx.fill(); ctx.stroke();
  T(ctx, st, x + w - stw / 2 - 40, y + 57, { font: fM(24, '700'), color: col, align: 'center', base: 'middle' });
  ctx.restore();

  // 请求体
  const aa = app(t, 1.15, 0.5);
  T(ctx, 'body  {', x + 40, y + 148, { font: fM(25), color: C.dim, alpha: aa });
  T(ctx, '"approval_ttl_s": 3600', x + 40, y + 190, { font: fM(31, '600'), color: C.teal, alpha: aa });
  T(ctx, '}', x + 40, y + 228, { font: fM(25), color: C.dim, alpha: aa });

  // TTL 进度条（×1200 加速演示）
  const k = cl((t - 2.0) / 2.55);
  const barX = x + 470, barW = 460, barY = y + 176;
  ctx.save(); ctx.globalAlpha = app(t, 1.7, 0.5);
  ctx.fillStyle = 'rgba(139,148,158,0.16)'; rr(ctx, barX, barY, barW, 12, 6); ctx.fill();
  ctx.fillStyle = col; rr(ctx, barX, barY, barW * (1 - k), 12, 6); ctx.fill();
  const left = Math.round(3600 * (1 - k));
  T(ctx, left + 's', barX + barW, barY + 48, { font: fM(30, '600'), color: col, align: 'right' });
  T(ctx, '时间轴 ×1200 加速演示', barX + barW, barY - 18, { font: fM(19), color: C.faint, align: 'right' });
  ctx.restore();

  // 到期后的可查性
  if (expired) {
    const ea = app(t, 4.75, 0.5);
    T(ctx, 'GET /v1/approvals?status=EXPIRED  →  200 · 凭服务端时钟仲裁，未经人工裁决',
      W / 2, 662, { font: fM(26), color: C.orange, align: 'center', alpha: ea });
  }

  T(ctx, 'TTL 不进指纹 —— 否则同请求带不同 TTL 会变两张单，「重发不多开一张」作废',
    W / 2, 762, { font: fS(29, '600'), color: C.fg, align: 'center', alpha: app(t, 5.25, 0.6) });
  T(ctx, '重发只延长、不缩短   ·   裁决过期单回 APPROVAL_EXPIRED（让 agent 分清「被抢」和「来晚」）',
    W / 2, 816, { font: fM(25), color: C.teal, align: 'center', alpha: app(t, 5.7, 0.7) });
  T(ctx, 'sweepApprovals() 照搬租约模型 sweepLeases() —— 同一套时钟仲裁，不新造第二套',
    W / 2, 866, { font: fM(24), color: C.faint, align: 'center', alpha: app(t, 6.1, 0.8) });
}

/* ==================================================================== 06 同步核验 */
const FILES = [
  ['start.md', 46234, '79e66c6465da1e7f'],
  ['pkg.md', 129172, '5481be1c046a5c7b'],
  ['pkg-lite.md', 72118, 'ab2fc636e1d75f7d'],
  ['index.html', 38790, '5b579f05fcd52c0c'],
  ['openapi.json', 56227, 'f20a4bfd58e6cc60'],
  ['MANIFEST.json', 3593, '64feab97c470d571'],
  ['files/00_先读我.md', 1737, 'fce89143251ff546'],
  ['files/01_评测任务书.md', 8695, 'da3d125b691a026c'],
  ['files/02_关键证据原文.md', 20926, '6c5b021e23080de3'],
  ['files/03_契约速查表.md', 10534, '39854f606d54d87e'],
  ['files/04_背景简报.md', 23862, '7b8e4fda8aab2cdd'],
  ['files/05_输出模板.md', 4175, '1cbe8b488334247a'],
  ['prompt.txt', 2891, '8683f58c4cd83a81'],
];
const TOTAL_BYTES = FILES.reduce((a, f) => a + f[1], 0);
function s6(ctx, t) {
  head(ctx, t, 5, 'LIVE SYNC', '线上同步 · 13 文件逐字节核验');

  const x = 140, y0 = 292, rh = 40;
  let done = 0;

  FILES.forEach((f, i) => {
    const t0 = 0.5 + i * 0.2;
    const a = app(t, t0, 0.4);
    const ok = t >= t0 + 0.30;            // 状态标签晚一拍落地
    if (ok) done++;
    const y = y0 + i * rh;

    ctx.save(); ctx.globalAlpha = a;
    if (i % 2 === 0) { ctx.fillStyle = 'rgba(139,148,158,0.045)'; ctx.fillRect(x - 12, y - 22, 1190, rh - 4); }
    ctx.restore();

    T(ctx, f[0], x, y, { font: fM(24), color: ok ? C.fg : C.dim, alpha: a });
    T(ctx, String(f[1]), x + 640, y, { font: fM(23), color: C.dim, align: 'right', alpha: a });
    T(ctx, f[2], x + 660, y, { font: fM(19), color: C.faint, alpha: a * 0.9 });

    const lab = ok ? 'IDENTICAL' : '…';
    T(ctx, lab, x + 1150, y, { font: fM(23, '600'), color: ok ? C.green : C.faint, align: 'right', alpha: a });
    if (ok) {
      const g = eOut5(cl((t - t0 - 0.30) / 0.28));
      ctx.save(); ctx.globalAlpha = a * g;
      ctx.strokeStyle = C.green; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x + 1174, y - 7); ctx.lineTo(x + 1183, y + 1); ctx.lineTo(x + 1200, y - 16); ctx.stroke();
      ctx.restore();
    }
  });

  // 右侧大计数
  const px = 1400, pa = app(t, 0.5, 0.5);
  T(ctx, String(done), px, 470, { font: fM(126, '700'), color: done === FILES.length ? C.green : C.fg, alpha: pa });
  T(ctx, '/ 13', px + tw(ctx, String(done), fM(126, '700')) + 24, 470,
    { font: fM(50, '600'), color: C.faint, alpha: pa });
  T(ctx, '文件逐字节一致', px, 522, { font: fS(27), color: C.dim, alpha: pa });

  // 进度条
  ctx.save(); ctx.globalAlpha = pa;
  ctx.fillStyle = 'rgba(139,148,158,0.16)'; rr(ctx, px, 566, 380, 12, 6); ctx.fill();
  ctx.fillStyle = C.green; rr(ctx, px, 566, 380 * (done / FILES.length), 12, 6); ctx.fill();
  ctx.restore();

  T(ctx, 'sha256 相同 · 合计 ' + TOTAL_BYTES + ' 字节', px, 622,
    { font: fM(24), color: C.faint, alpha: pa });

  // 底部结论
  const ca = app(t, 3.5, 0.6);
  T(ctx, '13 / 13 IDENTICAL —— 线上就是本地这一版', W / 2, 918,
    { font: fS(40, '700'), color: C.green, align: 'center', alpha: ca });
  T(ctx, '但字节一致只证明「发的是本地这一版」，不证明「本地这一版是对的」—— 顺手 grep 线上内容，才撞出四处真缺陷',
    W / 2, 972, { font: fM(25), color: C.teal, align: 'center', alpha: app(t, 4.1, 0.7) });
}

/* ==================================================================== 07 收尾 */
function s7(ctx, t) {
  const cx = W / 2;

  const STATS = [
    { v: 11,  unit: '套', label: '测试', color: C.fg },
    { v: 487, unit: '条', label: '断言', color: C.fg },
    { v: 0,   unit: '',   label: '失败', color: C.green },
  ];
  const span = 420, x0 = cx - span;
  STATS.forEach((s, i) => {
    const a = app(t, 0.25 + i * 0.22, 0.6);
    const x = x0 + i * span;
    const k = win(t, 0.25 + i * 0.22, 1.15 + i * 0.22);
    const shown = Math.round(s.v * eOut(k));
    ctx.save(); ctx.globalAlpha = a;
    ctx.font = fM(112, '700');
    ctx.textAlign = 'center';
    ctx.fillStyle = s.color;
    ctx.fillText(String(shown), x, 372);
    const nw2 = ctx.measureText(String(shown)).width;
    // 🔴 标签必须显式改回 left：textAlign 是 canvas 状态，会从上一次 fillText 残留下来。
    //    留成 center 的话标签以"数字右侧 30px"为中心绘制，会向左压到数字上（末帧实测叠字）。
    ctx.font = fM(32, '600'); ctx.fillStyle = C.dim; ctx.textAlign = 'left';
    ctx.fillText(s.unit ? s.unit + '  ' + s.label : s.label, x + nw2 / 2 + 30, 372);
    ctx.restore();
  });

  const la = app(t, 1.35, 0.7);
  T(ctx, 'contract_digest', cx - 300, 486, { font: fM(27), color: C.dim, align: 'right', alpha: la });
  T(ctx, '6d439cbd7c94bf93', cx - 260, 486, { font: fM(34, '700'), color: C.blue, alpha: la });
  T(ctx, '( 上一轮 cc64b0c7a9178b32 —— 有意破坏性变更 )', cx + 300, 488,
    { font: fM(21), color: C.faint, alpha: la });

  T(ctx, 'acceptance 34/34   ·   agent-trial 20/20   ·   19 往返   ·   24510 tokens',
    cx, 556, { font: fM(28), color: C.teal, align: 'center', alpha: app(t, 1.85, 0.65) });

  T(ctx, '四档分布  safe 13 · optional 12 · fingerprint_dedup 3 · required 1   ｜   error.code 24 项',
    cx, 608, { font: fM(27), color: C.dim, align: 'center', alpha: app(t, 2.2, 0.65) });

  // 链接
  const ua = app(t, 2.75, 0.7);
  ctx.save(); ctx.globalAlpha = ua;
  ctx.fillStyle = 'rgba(88,166,255,0.09)'; ctx.strokeStyle = 'rgba(88,166,255,0.45)'; ctx.lineWidth = 1.6;
  const url = 'https://agent-console-eval.app.workbuddy.host/';
  const uw = tw(ctx, url, fM(33, '600')) + 72;
  rr(ctx, cx - uw / 2, 690, uw, 74, 12); ctx.fill(); ctx.stroke();
  T(ctx, url, cx, 735, { font: fM(33, '600'), color: C.blue, align: 'center', base: 'middle' });
  ctx.restore();

  T(ctx, '本片由同一套确定性管线渲染：绘画代码 → 无头 Chrome 逐帧 → ffmpeg   ·   零模型 · 零 API',
    cx, 846, { font: fM(25), color: C.faint, align: 'center', alpha: app(t, 3.4, 0.8) });
  T(ctx, '同一时刻永远同一帧，可复现、可断点续渲',
    cx, 892, { font: fM(25), color: C.faint, align: 'center', alpha: app(t, 3.75, 0.8) });

  // 收束带：五段色 = 五步。既是装饰，也把最后一段压住的暗部抬起来
  ctx.save();
  const seg = [C.blue, C.teal, C.green, C.red, C.orange];
  const segW = (W - 280) / 5;
  seg.forEach((c, i) => {
    const k = eOut(win(t, 3.0 + i * 0.09, 3.75 + i * 0.09));
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = c;
    ctx.fillRect(140 + i * segW, 966, (segW - 5) * k, 7);
  });
  ctx.restore();
}

/* ==================================================================== 章节表 */
const CHAPTERS = [
  { id: 's1', a: 0.0,  b: 4.6,  dot: C.blue,   draw: s1 },
  { id: 's2', a: 4.6,  b: 11.6, dot: C.teal,   draw: s2 },
  { id: 's3', a: 11.6, b: 20.4, dot: C.green,  draw: s3 },
  { id: 's4', a: 20.4, b: 28.2, dot: C.red,    draw: s4 },
  { id: 's5', a: 28.2, b: 35.6, dot: C.orange, draw: s5 },
  { id: 's6', a: 35.6, b: 43.2, dot: C.purple, draw: s6 },
  { id: 's7', a: 43.2, b: 48.6, dot: C.fg,     draw: s7 },
];
const DUR = CHAPTERS[CHAPTERS.length - 1].b;

function chapterAt(t) {
  for (const c of CHAPTERS) if (t >= c.a && t < c.b) return c;
  return t < 0 ? CHAPTERS[0] : CHAPTERS[CHAPTERS.length - 1];
}

/** 四角取景框：给整片一个统一的「控制台」外框，也让首尾帧不至于太空 */
function frameMarks(ctx, t) {
  const a = 0.45 * app(t, 0, 0.6);
  const m = 46, L = 54;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = C.dim; ctx.lineWidth = 2; ctx.lineCap = 'round';
  const c = [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]];
  for (const [x, y, sx, sy] of c) {
    ctx.beginPath();
    ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y);
    ctx.stroke();
  }
  ctx.restore();
}

function draw(ctx, w, h, t) {
  t = cl(t, 0, DUR);
  bg(ctx, t);
  frameMarks(ctx, t);

  const cur = chapterAt(t);
  const kin = app(t, cur.a, 0.42);
  const kout = cl((cur.b - t) / 0.4);

  ctx.save();
  ctx.globalAlpha = Math.min(kin, kout);
  ctx.translate(0, (1 - kin) * 26);
  cur.draw(ctx, t - cur.a, cur);
  ctx.restore();

  // 章节切换擦除线
  for (const c of CHAPTERS) {
    const d = t - c.a;
    if (d >= 0 && d < 0.5 && c.a > 0) {
      const k = eOut(d / 0.5);
      ctx.save();
      ctx.globalAlpha = (1 - k) * 0.5;
      ctx.strokeStyle = c.dot; ctx.lineWidth = 3;
      const yy = lerp(0, H, k);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
      ctx.restore();
    }
  }

  hud(ctx, t, cur);
}

window.SCENE = { draw, DUR, CHAPTERS, W, H };
})();
