/* ============================================================================
   scene.js —《一个 AI 网页的诞生》  (38.0s / 30fps / 1920x1080)

   内容 = 2026-10-03 一天之内，把一个"给 AI 用的网页"从一句提问做到上线：

     01  3.0  起念            —— 「做一个 AI 用的网页 —— 你想要什么功能？」
     02  6.0  v1 原型         —— 11 个端点，一个 HTML 文件，双击就跑
     03  9.8  v3 走出浏览器    —— node:http + node:sqlite，零 npm 依赖
     04 13.6  v4 长出牙齿      —— requires 从标注变成闸门
     05 17.6  v5→v7 自述+换人  —— 契约现场派生 · 验收人换成 agent
     06 21.6  互审① 它审我     —— 7 条批评：采纳 5，驳回 4
     07 25.4  互审② 我审它     —— 这份报告里有编造
     08 28.6  互审③ 伪造出处   —— 它把幻觉升级成"取自原文"
     09 31.0  互审④ 护栏落下   —— verify-citation
     10 34.4  三通道降级       —— 一份内容，五种形态
     11 38.0  上线            —— 11 套 · 487 断言 · 0 失败

   三个角色设定上的讲究（不是装饰，是性格）：
     · Nook  —— 竖立机箱 + 顶部黄昏光带（呼应 🌆）+ 单条光圈眼 + 探针。
                说话用**终端提示符**（> ...），因为它的主张是"数据说话"。
     · 豆包   —— 包子形 + 圆眼 + 会飘的纸。说话用**气泡**，因为它是"话痨型"。
     两种说话方式本身就是性格刻画：一个只输出结论行，一个爱铺陈。

   纪律（沿用第一部，见 headless-canvas-video-render skill）：
   - 画面里每个数字都是实测值，不是估的（.tests-summary.json / 记忆 2026-10-03.md）。
   - 所有运动是 t 的纯函数 —— 同一 t 永远同一帧（断点续渲的前提）。
   - 零外部资源：只用系统字体，不引 Google Fonts。
   - 每个角色绘制都套 save/restore —— canvas 状态会跨 fillText 残留（skill §60）。
   ========================================================================= */
(() => {
'use strict';

const W = 1920, H = 1080;

/* ------------------------------------------------------------------ 调色 */
const C = {
  bg:     '#080c11',
  panel:  'rgba(33,46,64,0.94)',
  grid:   'rgba(126,148,180,0.128)',
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
  slate:  '#9aa5b1',
  amber:  '#f59e0b',   // 本部主强调色
  violet: '#a78bfa',
  rose:   '#fb7185',
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
const eInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
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

/** 统一文本入口：s=文字 · x,y · o={font,color,align,base,alpha,ls} */
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

/** 圆点徽章（返回宽度） */
function badge(ctx, x, y, text, color, alpha = 1, fs = 26) {
  ctx.save();
  ctx.globalAlpha = cl(alpha);
  const w = tw(ctx, text, fM(fs, '600')) + 40, h = fs + 26;
  const rgb = hexToRgb(color);
  ctx.fillStyle = `rgba(${rgb},0.14)`;
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
function hexToRgb(hex) {
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return '139,148,158';
  const v = parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

/* ============================================================================
   角色层
   —— 两个角色都不是"贴图"，是参数化几何。表情 = mood 字符串，全部由形状实现。
   ========================================================================= */

const NK = { body0: '#243244', body1: '#161f2b', edge: '#f59e0b', eye: '#fbbf24' };
const DB = { skin: '#f4e4c3', shade: '#e3cda2', edge: '#d98a3d', ink: '#40301a', blush: '#e8a07a' };

/**
 * Nook —— 竖立机箱 / 顶部黄昏光带 / 单条光圈眼 / 探针
 * o = { alpha, mood, look, probe, bob, blink }
 *    mood: 'calm' | 'focus' | 'skeptic' | 'happy' | 'alert' | 'sad'
 *    look: -1..1  光圈横向偏移
 *    probe: 0..1  探针伸出，0.5 时正好指向前方
 *    bob:  垂直位移（呼吸）
 */
function nook(ctx, x, yb, s, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return;
  const w = 104 * s, h = 118 * s, bob = o.bob || 0;
  const y0 = yb - h + bob;
  const mood = o.mood || 'calm';
  const look = o.look || 0;

  ctx.save();
  ctx.globalAlpha = a;

  // 影子 —— 角色必须"站住"，否则像贴纸
  ctx.save();
  ctx.globalAlpha = a * 0.34;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, yb + 4 * s, w * 0.54, 8 * s, 0, 0, 7); ctx.fill();
  ctx.restore();

  // 探针（先画，压在机身下面）
  if (o.probe != null && o.probe > 0.02) {
    const p = eOut5(cl(o.probe)) ;
    const px0 = x + w * 0.48, py0 = y0 + h * 0.62;
    const len = 74 * s * p;
    const ang = -0.62 + 0.42 * p;
    const px1 = px0 + Math.cos(ang) * len, py1 = py0 + Math.sin(ang) * len;
    ctx.save();
    ctx.strokeStyle = 'rgba(245,158,11,0.85)'; ctx.lineWidth = 2.6 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(px1, py1); ctx.stroke();
    ctx.fillStyle = C.amber;
    ctx.beginPath(); ctx.arc(px1, py1, 4.4 * s, 0, 7); ctx.fill();
    ctx.globalAlpha = a * 0.45;
    ctx.beginPath(); ctx.arc(px1, py1, 10 * s * p, 0, 7); ctx.stroke();
    ctx.restore();
  }

  // 机身
  const g = ctx.createLinearGradient(x, y0, x, y0 + h);
  g.addColorStop(0, NK.body0); g.addColorStop(1, NK.body1);
  ctx.fillStyle = g;
  rr(ctx, x - w / 2, y0, w, h, 16 * s); ctx.fill();
  ctx.strokeStyle = NK.edge; ctx.lineWidth = 1.9 * s;
  ctx.globalAlpha = a * 0.82;
  rr(ctx, x - w / 2, y0, w, h, 16 * s); ctx.stroke();
  ctx.globalAlpha = a;

  // 顶部黄昏光带（🌆 的抽象）—— 加高一点，缩略图下才认得出这是它的标志
  const bg2 = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  bg2.addColorStop(0, C.amber); bg2.addColorStop(0.55, C.rose); bg2.addColorStop(1, C.violet);
  ctx.fillStyle = bg2;
  rr(ctx, x - w / 2 + 7 * s, y0 + 8 * s, w - 14 * s, 11 * s, 5.5 * s); ctx.fill();

  // 光圈眼
  const ey = y0 + h * 0.46, ex = x + look * 9 * s;
  const blink = o.blink || 0;                     // 0=睁 1=闭
  ctx.save();
  ctx.translate(ex, ey);
  if (mood === 'skeptic') ctx.rotate(-0.16);
  ctx.fillStyle = NK.eye;
  if (mood === 'happy') {
    ctx.globalAlpha = a;
    ctx.strokeStyle = NK.eye; ctx.lineWidth = 5 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 6 * s, 15 * s, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  } else if (mood === 'alert') {
    ctx.beginPath(); ctx.arc(0, 0, 12 * s, 0, 7); ctx.fill();
    ctx.globalAlpha = a * 0.35;
    ctx.beginPath(); ctx.arc(0, 0, 20 * s, 0, 7); ctx.fill();
  } else if (mood === 'sad') {
    ctx.strokeStyle = NK.eye; ctx.lineWidth = 4.4 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 12 * s, 14 * s, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  } else {
    const hh = (mood === 'focus' ? 11 : 6) * s * (1 - blink * 0.85);
    ctx.globalAlpha = a;
    rr(ctx, -22 * s, -hh / 2, 44 * s, Math.max(2, hh), hh / 2); ctx.fill();
    if (mood === 'focus') {
      ctx.globalAlpha = a * 0.28;
      rr(ctx, -30 * s, -hh, 60 * s, hh * 2, hh); ctx.fill();
    }
  }
  ctx.restore();

  // 底部接口线
  ctx.save();
  ctx.globalAlpha = a * 0.5; ctx.strokeStyle = 'rgba(245,158,11,0.6)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath(); ctx.moveTo(x - 14 * s, y0 + h - 13 * s); ctx.lineTo(x + 14 * s, y0 + h - 13 * s); ctx.stroke();
  ctx.restore();

  ctx.restore();
}

/**
 * 豆包 —— 包子：穹顶 + 底褶 + 两只圆眼 + 会飘的纸
 * o = { alpha, mood, look, talk, bob, paper }
 *    mood: 'smile' | 'talk' | 'wow' | 'sweat' | 'proud' | 'flat' | 'sad'
 *    talk: 0..1 嘴的张合（只有 mood='talk' 时用）
 *    paper: >0 时手上托着纸（数量 = 向下取整）
 */
function doubao(ctx, x, yb, s, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return;
  const w = 124 * s, h = 104 * s, bob = o.bob || 0;
  const y0 = yb - h + bob;
  const mood = o.mood || 'smile';
  const look = o.look || 0;
  const cx0 = x, cy0 = y0 + h * 0.50;

  ctx.save();
  ctx.globalAlpha = a;

  // 影子
  ctx.save();
  ctx.globalAlpha = a * 0.32; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, yb + 4 * s, w * 0.48, 8 * s, 0, 0, 7); ctx.fill();
  ctx.restore();

  // 手上的纸（评测报告）
  const np = o.paper ? Math.max(0, Math.floor(o.paper)) : 0;
  for (let i = 0; i < np; i++) {
    const k = i / 4;
    ctx.save();
    ctx.globalAlpha = a * 0.95;
    ctx.translate(x + w * 0.46 + i * 3 * s, cy0 + 12 * s - i * 5 * s);
    ctx.rotate(-0.10 + i * 0.05);
    ctx.fillStyle = '#e9e3d5'; ctx.fillRect(0, 0, 46 * s, 34 * s);
    ctx.strokeStyle = 'rgba(120,100,70,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, 46 * s, 34 * s);
    ctx.strokeStyle = 'rgba(120,100,70,0.42)';
    for (let l = 0; l < 3; l++) {
      ctx.beginPath();
      ctx.moveTo(6 * s, (9 + l * 8) * s); ctx.lineTo((40 - k * 8) * s, (9 + l * 8) * s); ctx.stroke();
    }
    ctx.restore();
  }

  // 包身
  const g = ctx.createLinearGradient(x, y0, x, y0 + h);
  g.addColorStop(0, '#fbf0d8'); g.addColorStop(0.62, DB.skin); g.addColorStop(1, DB.shade);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, cy0 + h * 0.10);
  ctx.bezierCurveTo(x - w / 2, cy0 - h * 0.86, x + w / 2, cy0 - h * 0.86, x + w / 2, cy0 + h * 0.10);
  // 底褶：三个小弧
  ctx.quadraticCurveTo(x + w * 0.34, cy0 + h * 0.44, x + w * 0.20, cy0 + h * 0.40);
  ctx.quadraticCurveTo(x + w * 0.10, cy0 + h * 0.56, x, cy0 + h * 0.40);
  ctx.quadraticCurveTo(x - w * 0.10, cy0 + h * 0.56, x - w * 0.20, cy0 + h * 0.40);
  ctx.quadraticCurveTo(x - w * 0.34, cy0 + h * 0.44, x - w / 2, cy0 + h * 0.10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = DB.edge; ctx.lineWidth = 1.7 * s;
  ctx.globalAlpha = a * 0.7; ctx.stroke();
  ctx.globalAlpha = a;

  // 顶部收口
  ctx.fillStyle = DB.shade;
  ctx.beginPath(); ctx.ellipse(x, y0 + h * 0.055, 9 * s, 5.5 * s, 0, 0, 7); ctx.fill();

  // 眼睛
  const exGap = 21 * s, ey = cy0 - h * 0.16, er = (mood === 'wow' ? 12 : 9) * s;
  const lx = x - exGap + look * 4 * s, rx = x + exGap + look * 4 * s;
  ctx.save();
  ctx.fillStyle = DB.ink;
  if (mood === 'proud') {
    ctx.strokeStyle = DB.ink; ctx.lineWidth = 3.4 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(lx, ey + 3 * s, 8 * s, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
    ctx.beginPath(); ctx.arc(rx, ey + 3 * s, 8 * s, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
  } else if (mood === 'flat') {
    ctx.strokeStyle = DB.ink; ctx.lineWidth = 3.4 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(lx - 7 * s, ey); ctx.lineTo(lx + 7 * s, ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rx - 7 * s, ey); ctx.lineTo(rx + 7 * s, ey); ctx.stroke();
  } else if (mood === 'sad') {
    ctx.strokeStyle = DB.ink; ctx.lineWidth = 3.4 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(lx, ey + 4 * s, 8 * s, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
    ctx.beginPath(); ctx.arc(rx, ey + 4 * s, 8 * s, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(lx, ey, er, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(rx, ey, er, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(lx + 3 * s, ey - 3 * s, er * 0.30, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(rx + 3 * s, ey - 3 * s, er * 0.30, 0, 7); ctx.fill();
  }
  ctx.restore();

  // 腮红
  if (mood === 'smile' || mood === 'proud' || mood === 'talk') {
    ctx.save();
    ctx.globalAlpha = a * 0.5; ctx.fillStyle = DB.blush;
    ctx.beginPath(); ctx.ellipse(x - exGap - 13 * s, ey + 13 * s, 7 * s, 4.4 * s, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + exGap + 13 * s, ey + 13 * s, 7 * s, 4.4 * s, 0, 0, 7); ctx.fill();
    ctx.restore();
  }

  // 嘴
  const my = cy0 + h * 0.02;
  ctx.save();
  ctx.strokeStyle = DB.ink; ctx.lineWidth = 3.2 * s; ctx.lineCap = 'round';
  ctx.fillStyle = DB.ink;
  if (mood === 'wow') {
    ctx.beginPath(); ctx.ellipse(x, my, 7.5 * s, 9.5 * s, 0, 0, 7); ctx.fill();
  } else if (mood === 'sweat') {
    ctx.beginPath(); ctx.arc(x, my - 1 * s, 8 * s, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  } else if (mood === 'flat' || mood === 'sad') {
    ctx.beginPath(); ctx.arc(x, my + 8 * s, 9 * s, Math.PI * 1.18, Math.PI * 1.82); ctx.stroke();
  } else if (mood === 'talk') {
    const k = 0.35 + 0.65 * Math.abs(Math.sin((o.talk || 0) * 3.4));
    ctx.beginPath(); ctx.ellipse(x, my, 6 * s, 4.6 * s * k + 1.4 * s, 0, 0, 7); ctx.fill();
  } else if (mood === 'proud') {
    ctx.beginPath(); ctx.arc(x, my - 2 * s, 10 * s, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(x, my - 3 * s, 10 * s, 0.14 * Math.PI, 0.86 * Math.PI); ctx.stroke();
  }
  ctx.restore();

  // 汗滴（放大过 —— 原尺寸在 1080p 下等于看不见）
  if (mood === 'sweat' || mood === 'sad') {
    const k = cl((o.blink != null ? o.blink : 0.5) + 0.5);
    ctx.save();
    ctx.globalAlpha = a * 0.95;
    const dx = x + w * 0.42, dy = y0 + h * 0.20 + (1 - k) * 8 * s;
    ctx.fillStyle = '#7dd3fc';
    ctx.beginPath();
    ctx.moveTo(dx, dy - 14 * s);
    ctx.bezierCurveTo(dx + 11 * s, dy + 3 * s, dx + 8 * s, dy + 14 * s, dx, dy + 14 * s);
    ctx.bezierCurveTo(dx - 8 * s, dy + 14 * s, dx - 11 * s, dy + 3 * s, dx, dy - 14 * s);
    ctx.fill();
    ctx.globalAlpha = a * 0.6;
    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath(); ctx.ellipse(dx - 3 * s, dy + 5 * s, 2.6 * s, 4 * s, -0.3, 0, 7); ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/** 气泡（豆包的说话方式）：自动宽度，尾巴朝下 */
function bubble(ctx, x, y, text, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return 0;
  const fs = o.fs || 28, font = fS(fs, '500');
  const pad = 26, w = tw(ctx, text, font) + pad * 2, h = fs + 38;
  const lift = (1 - eOut(cl(o.k || 1))) * 10;
  const y0 = y - h - lift;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = o.fill || 'rgba(244,228,195,0.96)';
  rr(ctx, x - w / 2, y0, w, h, 16); ctx.fill();
  ctx.strokeStyle = o.edge || DB.edge; ctx.lineWidth = 1.6; ctx.stroke();
  // 尾巴
  ctx.fillStyle = o.fill || 'rgba(244,228,195,0.96)';
  ctx.beginPath();
  ctx.moveTo(x - 12, y0 + h - 2); ctx.lineTo(x + 4, y0 + h - 2); ctx.lineTo(x - 8, y0 + h + 15);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = o.edge || DB.edge; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(x - 12, y0 + h - 1); ctx.lineTo(x - 8, y0 + h + 15); ctx.lineTo(x + 4, y0 + h - 1); ctx.stroke();
  // 文字
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = o.color || '#3a2c17';
  ctx.fillText(text, x, y0 + h / 2 + 1);
  ctx.restore();
  return w;
}

/** 终端行（Nook 的说话方式）：> 前缀 + 等宽字，逐字打出 */
function termline(ctx, x, y, text, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return;
  const fs = o.fs || 27, font = fM(fs, '500');
  const k = o.type == null ? 1 : cl(o.type);
  const shown = text.slice(0, Math.round(text.length * k));
  ctx.save();
  ctx.globalAlpha = a;
  // 提示符
  const bx = x - 2, bw = 13, bh = 26;
  ctx.fillStyle = C.amber;
  ctx.globalAlpha = a * (0.55 + 0.45 * Math.abs(Math.sin((o.caret || 0) * 3)));
  rr(ctx, bx, y - 21, bw, bh, 3); ctx.fill();
  ctx.globalAlpha = a;
  const off = bw + 14;
  // 底衬
  const wpx = tw(ctx, text, font);
  ctx.fillStyle = 'rgba(10,16,24,0.72)';
  rr(ctx, bx - 10, y - 27, wpx + bw + 34, 40, 8); ctx.fill();
  ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = o.color || C.fg;
  ctx.fillText(shown, x + off, y);
  if (k < 1) {   // 打字光标
    const cw = tw(ctx, shown, font);
    ctx.globalAlpha = a * (0.4 + 0.6 * Math.abs(Math.sin((o.caret || 0) * 6)));
    ctx.fillStyle = C.amber;
    ctx.fillRect(x + off + cw + 2, y - 21, 10, 25);
  }
  ctx.restore();
}

/** 一小片纸（批评条 / 报告页） */
function slip(ctx, x, y, w, h, text, color, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return;
  const tilt = o.tilt || 0;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y); ctx.rotate(tilt);
  ctx.fillStyle = o.fill || 'rgba(18,26,36,0.96)';
  rr(ctx, -w / 2, -h / 2, w, h, 8); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.8;
  ctx.globalAlpha = a * 0.9;
  rr(ctx, -w / 2, -h / 2, w, h, 8); ctx.stroke();
  // 左侧色条
  ctx.globalAlpha = a;
  ctx.fillStyle = color;
  rr(ctx, -w / 2, -h / 2, 5, h, 3); ctx.fill();
  if (text) {
    ctx.font = fM(o.fs || 23, '500');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = o.color || C.fg;
    ctx.fillText(text, -w / 2 + 18, 1);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ 背景 */
function bg(ctx, t) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // 顶部环境光
  let g = ctx.createRadialGradient(W / 2, -120, 0, W / 2, -120, 1500);
  g.addColorStop(0, 'rgba(66,116,190,0.20)');
  g.addColorStop(0.5, 'rgba(48,82,135,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 网格
  const gs = 64, off = (t * 6) % gs;
  ctx.save();
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -off; x < W; x += gs) { ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, H); }
  for (let y = -off; y < H; y += gs) { ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(W, Math.round(y) + .5); }
  ctx.stroke();
  ctx.restore();

  // 抬暗部：在暗角之前铺一层薄雾（skill §62 —— 深色片不能压死）
  ctx.fillStyle = 'rgba(34,58,94,0.17)'; ctx.fillRect(0, 0, W, H);

  // 暗角
  g = ctx.createRadialGradient(W / 2, H / 2, H * 0.46, W / 2, H / 2, H * 1.18);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 顶部章节刻度
  const cw = 40, total = CHAPTERS.length * cw - 12, x0 = W / 2 - total / 2;
  CHAPTERS.forEach((c, i) => {
    const cur = t >= c.a && t < c.b;
    const seen = t >= c.b;
    ctx.save();
    ctx.globalAlpha = cur ? 1 : seen ? 0.42 : 0.16;
    ctx.fillStyle = cur ? c.dot : C.dim;
    rr(ctx, x0 + i * cw, 34, cur ? 28 : 22, 4, 2); ctx.fill();
    ctx.restore();
  });
  // 顶部左右角标
  T(ctx, 'A G E N T - C O N S O L E', 96, 74, { font: fM(20, '600'), color: C.faint, ls: 2 });
  T(ctx, '2 0 2 6 - 1 0 - 0 3', W - 96, 74, { font: fM(20, '600'), color: C.faint, align: 'right', ls: 2 });
}

/* ============================================================================
   章节
   ========================================================================= */

/* ------------------------------------------------- 01 起念 (0.0 – 3.0) */
function s1(ctx, t) {
  const A = 0.0, u = t - A;
  const cx = W / 2;

  // 打字机
  const line = '做一个 AI 用的网页 —— 你想要什么功能？';
  const k = cl(win(u, 0.20, 1.55) * 1.12);
  const shown = line.slice(0, Math.round(line.length * k));
  const font = fS(56, '700');
  const full = tw(ctx, line, font);
  T(ctx, shown, cx - full / 2, 322, { font, color: C.fg });
  if (k < 1) {
    const wpx = tw(ctx, shown, font);
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(u * 6.2));
    ctx.fillStyle = C.amber;
    ctx.fillRect(cx - full / 2 + wpx + 4, 282, 15, 46);
    ctx.restore();
  }

  // 来源标注
  const a1 = app(t, 1.65, 0.5);
  T(ctx, 'first user: not human', cx, 394,
    { font: fM(25, '600'), color: C.amber, align: 'center', alpha: a1, ls: 1.5 });

  // 两个角色入场
  const e1 = eOut(win(u, 1.55, 2.55));
  const e2 = eOut(win(u, 1.75, 2.75));
  nook(ctx, lerp(760, 690, e1), 812, 1.12, { alpha: e1, mood: 'calm', look: 0.5 });
  doubao(ctx, lerp(1180, 1250, e2), 812, 1.12, { alpha: e2, mood: 'talk', talk: u, look: -0.5 });

  // 名牌
  const a2 = app(t, 2.35, 0.45);
  T(ctx, 'Nook', 690, 862, { font: fM(24, '600'), color: C.amber, align: 'center', alpha: a2 });
  T(ctx, '豆包', 1250, 862, { font: fM(24, '600'), color: C.orange, align: 'center', alpha: a2 });

  // 中间的"×"——两个 AI，一次对账
  T(ctx, '⟷', cx, 762, { font: fM(46, '600'), color: C.faint, align: 'center', alpha: app(t, 2.5, 0.4) });
  T(ctx, '两个 AI 的相互对账', cx, 806,
    { font: fS(24), color: C.faint, align: 'center', alpha: app(t, 2.6, 0.4) });
}

/* ------------------------------------------------- 02 v1 原型 (3.0 – 6.0) */
function s2(ctx, t) {
  const u = t - 3.0;
  const X0 = 300, X1 = 1620, Y0 = 196, Y1 = 620;

  // 三栏线框展开
  const k = eOut(win(u, 0.05, 0.75));
  const w = (X1 - X0) * k, x = X0 + (X1 - X0 - w) / 2;
  const cols = [[0.24, '目录 CATALOG'], [0.48, '响应 RESPONSE'], [0.28, '队列 QUEUE']];
  let cx0 = x;
  cols.forEach(([frac, name], i) => {
    const cw = (w - 24) * frac, a = app(t, 3.15 + i * 0.18, 0.45);
    panel(ctx, cx0, Y0, cw, Y1 - Y0, { alpha: a });
    T(ctx, name, cx0 + 20, Y0 + 38, { font: fM(19, '600'), color: C.dim, alpha: a, ls: 1 });
    // 内容条
    if (i === 0) {
      const n = 11;
      for (let r = 0; r < n; r++) {
        const ra = app(t, 3.55 + r * 0.055, 0.3);
        ctx.save();
        ctx.globalAlpha = ra * 0.5;
        ctx.fillStyle = r < 4 ? C.amber : C.dim;
        rr(ctx, cx0 + 20, Y0 + 62 + r * 27, cw - 46 - rnd(r) * 40, 7, 3.5); ctx.fill();
        ctx.restore();
      }
    }
    if (i === 1) {
      const ra = app(t, 3.9, 0.5);
      panel(ctx, cx0 + 18, Y0 + 58, cw - 36, 200, { alpha: ra * 0.55, fill: 'rgba(8,12,17,0.75)' });
      T(ctx, '{ "ok": true, "replayed": false,', cx0 + 34, Y0 + 96,
        { font: fM(19), color: C.teal, alpha: ra });
      T(ctx, '  "hints": [ { "action": "proceed" } ] }', cx0 + 34, Y0 + 126,
        { font: fM(19), color: C.teal, alpha: ra });
    }
    if (i === 2) {
      for (let r = 0; r < 4; r++) {
        const ra = app(t, 4.1 + r * 0.12, 0.35);
        panel(ctx, cx0 + 16, Y0 + 56 + r * 78, cw - 32, 64,
          { alpha: ra, fill: 'rgba(18,26,36,0.8)', r: 8 });
        T(ctx, ['等待确认', '已执行', '已挂起', '已完成'][r], cx0 + 32, Y0 + 94,
          { font: fM(19), color: r === 0 ? C.orange : C.dim, alpha: ra });
      }
    }
    cx0 += cw + 12;
  });

  // 三层需求芯片
  const chips = [
    ['状态 STATE', 'L1', C.blue],
    ['感官 SENSES', 'L2', C.teal],
    ['行动 ACT', 'L3', C.amber],
  ];
  const cwid = 300, gap = 30, tot = chips.length * cwid + (chips.length - 1) * gap;
  let bx = W / 2 - tot / 2;
  chips.forEach(([label, tag, col], i) => {
    const a = app(t, 3.25 + i * 0.25, 0.5);
    const y = 132;
    panel(ctx, bx, y, cwid, 46, { alpha: a, fill: 'rgba(18,26,36,0.9)', r: 23, edgeColor: col });
    T(ctx, tag, bx + 24, y + 31, { font: fM(21, '700'), color: col, alpha: a });
    T(ctx, label, bx + 68, y + 31, { font: fS(23, '600'), color: C.fg, alpha: a });
    if (i < 2) T(ctx, '→', bx + cwid + 6, y + 31, { font: fS(22), color: C.faint, alpha: a });
    bx += cwid + gap;
  });

  // 两个角色在下方
  const e = app(t, 3.0, 0.5);
  nook(ctx, 350, 786, 0.9, { alpha: e, mood: 'focus', look: 0.6, probe: app(t, 3.9, 0.6) });
  doubao(ctx, 1570, 786, 0.9, { alpha: e, mood: 'smile', look: -0.6, bob: Math.sin(u * 2) * 2 });

  // 结论行（整行居中：先量宽再落笔，别让大字号自己找位置）
  const a3 = app(t, 4.4, 0.5);
  const p1 = '11', p2 = ' 个端点 · 一个 HTML 文件 · 零依赖';
  const f1 = fM(54, '700'), f2 = fS(27, '600');
  const w1 = tw(ctx, p1, f1), w2 = tw(ctx, p2, f2);
  const rx0 = W / 2 - (w1 + w2) / 2;
  T(ctx, p1, rx0, 700, { font: f1, color: C.amber, alpha: a3 });
  T(ctx, p2, rx0 + w1, 700, { font: f2, color: C.fg, alpha: a3 });
}

/* ------------------------------------------------- 03 v3 走出浏览器 (6.0 – 9.8) */
function s3(ctx, t) {
  const u = t - 6.0;

  // 左：浏览器窗；右：常驻进程
  const lw = 620, lh = 400, lx = 260, ly = 220;
  const rw = 560, rh = 400, rx = 1030, ry = 220;

  const aL = app(t, 6.05, 0.6), aR = app(t, 6.3, 0.6);
  panel(ctx, lx, ly, lw, lh, { alpha: aL, r: 14 });
  panel(ctx, lx, ly, lw, 44, { alpha: aL, r: 14, fill: 'rgba(40,52,68,0.9)' });
  [C.red, C.orange, C.green].forEach((c, i) => {
    ctx.save(); ctx.globalAlpha = aL * 0.8; ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(lx + 24 + i * 22, ly + 22, 6, 0, 7); ctx.fill(); ctx.restore();
  });
  T(ctx, 'browser · ai-workbench.html', lx + 96, ly + 29, { font: fM(19), color: C.dim, alpha: aL });
  T(ctx, 'UI', lx + 40, ly + 120, { font: fS(34, '700'), color: C.slate, alpha: aL });
  T(ctx, '队列曾经住在这里', lx + 40, ly + 162, { font: fS(23), color: C.faint, alpha: aL });
  // 关掉的窗
  const aX = app(t, 7.4, 0.4);
  ctx.save();
  ctx.globalAlpha = aX * 0.9; ctx.strokeStyle = C.red; ctx.lineWidth = 6; ctx.lineCap = 'round';
  const cxm = lx + lw / 2, cym = ly + lh / 2;
  ctx.beginPath(); ctx.moveTo(cxm - 90, cym - 90); ctx.lineTo(cxm + 90, cym + 90); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cxm + 90, cym - 90); ctx.lineTo(cxm - 90, cym + 90); ctx.stroke();
  ctx.restore();

  panel(ctx, rx, ry, rw, rh, { alpha: aR, r: 14, edgeColor: 'rgba(63,185,80,0.5)' });
  T(ctx, 'server · node:http + node:sqlite', rx + 24, ry + 40, { font: fM(19), color: C.green, alpha: aR });
  T(ctx, '零 npm 依赖', rx + 24, ry + 76, { font: fS(24, '600'), color: C.fg, alpha: aR });

  // 表：一把钥匙
  const aT = app(t, 6.9, 0.55);
  panel(ctx, rx + 40, ry + 116, rw - 80, 170, { alpha: aT, fill: 'rgba(8,12,17,0.8)', r: 10 });
  T(ctx, 'idem_keys', rx + 62, ry + 152, { font: fM(21, '600'), color: C.dim, alpha: aT });
  T(ctx, 'PRIMARY KEY(key)', rx + 62, ry + 182, { font: fM(18), color: C.faint, alpha: aT });
  const kx = rx + 190, ky = ry + 214, kw = 250, kh = 50;
  ctx.save();
  ctx.globalAlpha = aT * 0.5; ctx.fillStyle = 'rgba(139,148,158,0.18)';
  rr(ctx, kx, ky, kw, kh, 8); ctx.fill(); ctx.restore();

  // 两支箭：同一个键
  const aA = eOut5(win(u, 1.35, 2.05));
  const aB = eOut5(win(u, 2.15, 2.85));
  const ax0 = lx + lw + 16, ay = ky + kh / 2;
  const arrow = (k, col, lbl) => {
    if (k <= 0) return;
    ctx.save();
    ctx.globalAlpha = aT;
    ctx.strokeStyle = col; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    const x1 = lerp(ax0, kx - 14, k);
    ctx.beginPath(); ctx.moveTo(ax0, ay); ctx.lineTo(x1, ay); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x1, ay); ctx.lineTo(x1 - 14, ay - 8); ctx.lineTo(x1 - 14, ay + 8); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = aT * cl(k * 1.6);
    T(ctx, lbl, (ax0 + x1) / 2, ay - 22, { font: fM(20, '600'), color: col, align: 'center' });
    ctx.restore();
  };
  arrow(aA, C.green, 'call #1');
  arrow(aB, C.orange, 'call #2 · 同一把钥匙');

  // 结果
  if (aB > 0.05) {
    const a1 = app(t, 8.45, 0.35), a2 = app(t, 8.75, 0.35);
    badge(ctx, kx + kw + 22, ky - 8, '201 CREATED', C.green, a1, 21);
    badge(ctx, kx + kw + 22, ky + 30, '200 replayed', C.orange, a2, 21);
    ctx.save();
    ctx.globalAlpha = a2 * 0.35; ctx.fillStyle = C.orange;
    rr(ctx, kx, ky, kw, kh, 8); ctx.fill(); ctx.restore();
  }

  // 角色
  const e = app(t, 6.6, 0.5);
  nook(ctx, 200, 830, 0.86, { alpha: e, mood: 'focus', look: 0.7, probe: app(t, 6.9, 0.6) });
  doubao(ctx, 1740, 830, 0.86, { alpha: e, mood: 'wow', look: -0.7, bob: Math.sin(u * 2.4) * 2 });

  T(ctx, '跑得快不重要 —— 重发一次不产生第二个副作用才重要', W / 2, 900,
    { font: fS(27), color: C.teal, align: 'center', alpha: app(t, 8.0, 0.6) });
}

/* ------------------------------------------------- 04 v4 长出牙齿 (9.8 – 13.6) */
function s4(ctx, t) {
  const u = t - 9.8;
  const cy = 420;

  // 轨道（起点必须在收件箱右侧 —— 否则轨道会横穿收件箱）
  const ox0 = 680, ox1 = 1620;
  ctx.save();
  ctx.globalAlpha = app(t, 9.85, 0.5);
  ctx.strokeStyle = 'rgba(139,148,158,0.22)'; ctx.lineWidth = 2;
  ctx.setLineDash([9, 11]);
  ctx.beginPath(); ctx.moveTo(ox0, cy); ctx.lineTo(ox1, cy); ctx.stroke();
  ctx.restore();

  // 处理块（右侧）
  const hx = 1290, hw = 300, hh = 150;
  panel(ctx, hx, cy - hh / 2, hw, hh, { alpha: app(t, 9.9, 0.5), edgeColor: 'rgba(88,166,255,0.45)' });
  T(ctx, '业务 handler', hx + hw / 2, cy - 14, { font: fS(26, '600'), color: C.blue, align: 'center', alpha: app(t, 10.0, 0.4) });
  T(ctx, 'GATE 之外的代码', hx + hw / 2, cy + 22, { font: fM(19), color: C.faint, align: 'center', alpha: app(t, 10.0, 0.4) });

  // 闸墙（在业务块之前）
  const gateX = 1010, gk = eOut5(win(u, 0.75, 1.35));
  if (gk > 0.02) {
    ctx.save();
    ctx.globalAlpha = gk;
    ctx.strokeStyle = C.red; ctx.lineWidth = 7; ctx.lineCap = 'round';
    const gh = 210 * gk;
    ctx.beginPath(); ctx.moveTo(gateX, cy - gh / 2); ctx.lineTo(gateX, cy + gh / 2); ctx.stroke();
    for (let i = 0; i < 7; i++) {
      ctx.globalAlpha = gk * 0.5;
      ctx.beginPath();
      ctx.moveTo(gateX - 16, cy - gh / 2 + i * gh / 7);
      ctx.lineTo(gateX + 16, cy - gh / 2 + i * gh / 7);
      ctx.stroke();
    }
    ctx.globalAlpha = gk;
    T(ctx, 'GATE', gateX, cy - gh / 2 - 18, { font: fM(21, '700'), color: C.red, align: 'center' });
    T(ctx, 'HTTP 层 · 先于 handler', gateX, cy + gh / 2 + 32, { font: fM(18), color: C.red, align: 'center', alpha: gk * 0.8 });
    ctx.restore();
  }

  // 请求光球
  const fly = eOut(win(u, 0.2, 1.05));
  const stopped = win(u, 1.35, 1.5) > 0;
  const bx = lerp(ox0, gateX - 26, fly);
  const aBall = 1 - cl(win(u, 1.42, 1.62));
  if (aBall > 0.02) {
    ctx.save();
    ctx.globalAlpha = aBall;
    ctx.fillStyle = C.amber;
    ctx.beginPath(); ctx.arc(bx, cy, 15, 0, 7); ctx.fill();
    ctx.globalAlpha = aBall * 0.35;
    ctx.beginPath(); ctx.arc(bx, cy, 30, 0, 7); ctx.fill();
    ctx.restore();
  }

  // 403 卡片落进收件箱
  const drop = eInOut(cl(win(u, 1.5, 2.1)));
  const ix = 168, iy = 250, iw = 460, ih = 300;
  panel(ctx, ix, iy, iw, ih, { alpha: app(t, 10.0, 0.5), edgeColor: 'rgba(248,81,73,0.35)' });
  T(ctx, '待审批收件箱', ix + 24, iy + 40, { font: fS(24, '600'), color: C.fg, alpha: app(t, 10.0, 0.5) });
  T(ctx, 'APPROVALS', ix + 24, iy + 68, { font: fM(17, '600'), color: C.faint, alpha: app(t, 10.0, 0.5), ls: 1 });
  const cw2 = iw - 48, ch2 = 62;
  const cxx = lerp(gateX - 40, ix + 24, drop);
  const cyy = lerp(cy - 30, iy + 92, drop);
  ctx.save();
  ctx.globalAlpha = app(t, 10.35, 0.3);
  panel(ctx, cxx, cyy, cw2, ch2, { fill: 'rgba(248,81,73,0.12)', edgeColor: C.red, r: 8 });
  T(ctx, '403  REQUIRE_APPROVAL', cxx + 18, cyy + 26, { font: fM(19, '700'), color: C.red });
  T(ctx, 'parked · 原样落盘，agent 没有直接执行的路径', cxx + 18, cyy + 48,
    { font: fS(17), color: C.dim });
  ctx.restore();

  // 批准 → 服务端回放
  const aOk = app(t, 12.0, 0.4);
  if (aOk > 0.02) {
    ctx.save();
    ctx.globalAlpha = aOk;
    // 按钮
    const bxx = ix + iw - 150, byy = iy + ih - 56;
    ctx.fillStyle = 'rgba(63,185,80,0.16)';
    rr(ctx, bxx, byy, 126, 40, 20); ctx.fill();
    ctx.strokeStyle = C.green; ctx.lineWidth = 1.8; rr(ctx, bxx, byy, 126, 40, 20); ctx.stroke();
    T(ctx, '批准', bxx + 63, byy + 27, { font: fS(22, '600'), color: C.green, align: 'center' });
    ctx.restore();

    // 从服务端侧重放
    const rk = eOut5(win(u, 2.35, 3.05));
    ctx.save();
    ctx.globalAlpha = aOk;
    ctx.strokeStyle = C.green; ctx.lineWidth = 4; ctx.lineCap = 'round';
    const sx = hx + hw / 2, sy = cy + hh / 2 + 40;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx - 120, sy + 60, gateX - 60, cy + 120, gateX - 30, cy + 20);
    ctx.stroke();
    const ex = lerp(gateX - 30, hx - 10, rk);
    ctx.fillStyle = C.green;
    ctx.beginPath(); ctx.arc(ex, lerp(cy + 20, cy, rk), 11, 0, 7); ctx.fill();
    ctx.restore();
    T(ctx, 'replay · handler 只有这一条路能跑到', W / 2, 806,
      { font: fM(23, '600'), color: C.green, align: 'center', alpha: app(t, 12.5, 0.5) });
  }

  // 角色
  nook(ctx, 200, 900, 0.8, { alpha: app(t, 10.2, 0.5), mood: 'focus', look: 0.5, probe: app(t, 11.2, 0.6) });
  doubao(ctx, 1760, 900, 0.8, { alpha: app(t, 10.2, 0.5), mood: 'wow', look: -0.5, bob: Math.sin(u * 2.2) * 2 });
}

/* ------------------------------------------------- 05 v5→v7 (13.6 – 17.6) */
function s5(ctx, t) {
  const u = t - 13.6;

  /* 前半：三束流 → 契约 */
  const cx = 960, cy = 400;
  const flows = [
    ['ROUTES', '结构', C.blue, -1],
    ['GATE', '授权', C.red, 0],
    ['META', '语义', C.amber, 1],
  ];
  const fk = eOut(win(u, 0.10, 0.95));
  flows.forEach(([name, sub, col, yi], i) => {
    const sx = 460, sy = cy + yi * 108;
    const a = app(t, 13.7 + i * 0.14, 0.45);
    panel(ctx, sx - 130, sy - 32, 230, 64, { alpha: a, fill: 'rgba(18,26,36,0.9)', r: 10, edgeColor: col + '99' });
    T(ctx, name, sx - 112, sy - 4, { font: fM(24, '700'), color: col, alpha: a });
    T(ctx, sub, sx - 112, sy + 20, { font: fS(18), color: C.faint, alpha: a });
    // 流
    ctx.save();
    ctx.globalAlpha = a * 0.55;
    ctx.strokeStyle = col; ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(sx + 104, sy);
    ctx.bezierCurveTo(sx + 200, sy, sx + 180, cy, cx - 60, cy);
    ctx.stroke();
    // 流动的点
    for (let p = 0; p < 3; p++) {
      const kk = ((u * 0.55 + p * 0.33 + i * 0.11) % 1);
      const px = lerp(sx + 104, cx - 60, kk), py = lerp(sy, cy, kk * kk);
      ctx.globalAlpha = a * 0.95;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, 4.2, 0, 7); ctx.fill();
    }
    ctx.restore();
  });

  // 契约文档
  const ak = app(t, 14.45, 0.6);
  const dw = 400, dh = 330, dx = cx - 40, dy = cy - dh / 2;
  panel(ctx, dx, dy, dw, dh, { alpha: ak, fill: 'rgba(10,16,24,0.92)', edgeColor: 'rgba(163,113,247,0.5)' });
  T(ctx, 'openapi.json', dx + 24, dy + 40, { font: fM(23, '700'), color: C.violet, alpha: ak });
  T(ctx, '从活元数据现场派生 · 绝不手写', dx + 24, dy + 70, { font: fS(18), color: C.dim, alpha: ak });
  for (let r = 0; r < 6; r++) {
    ctx.save();
    ctx.globalAlpha = ak * (0.55 - r * 0.05);
    ctx.fillStyle = C.dim;
    rr(ctx, dx + 24, dy + 100 + r * 26, dw - 60 - rnd(r) * 90, 7, 3.5); ctx.fill();
    ctx.restore();
  }
  // 时间戳被划掉 → 指纹
  const tsA = app(t, 14.9, 0.35);
  if (tsA > 0.02) {
    T(ctx, 'generated_at: 23:0X:XX', dx + 24, dy + dh - 34,
      { font: fM(18), color: C.faint, alpha: tsA });
    const st = eOut5(win(u, 1.5, 1.9));
    if (st > 0.02) {
      ctx.save();
      ctx.globalAlpha = tsA * st; ctx.strokeStyle = C.red; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(dx + 20, dy + dh - 42); ctx.lineTo(dx + 232, dy + dh - 42); ctx.stroke();
      ctx.restore();
    }
    const ha = app(t, 15.45, 0.4);
    T(ctx, 'contract_digest: 6d439cbd7c94bf93', dx + 24, dy + dh - 8,
      { font: fM(18, '700'), color: C.green, alpha: ha });
  }

  /* 后半：换验收人 */
  const pk = cl(win(u, 2.15, 3.0));
  if (pk > 0.02) {
    ctx.save();
    ctx.globalAlpha = pk;
    // 人形轮廓（左）
    const hxx = 1420, hyy = 520;
    ctx.save();
    ctx.globalAlpha = pk * (1 - cl(win(u, 2.75, 3.25)));
    ctx.strokeStyle = C.dim; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(hxx, hyy - 96, 26, 0, 7); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hxx - 40, hyy + 40); ctx.lineTo(hxx - 28, hyy - 62);
    ctx.lineTo(hxx + 28, hyy - 62); ctx.lineTo(hxx + 40, hyy + 40);
    ctx.stroke();
    ctx.restore();
    T(ctx, 'human review', hxx, hyy - 148, { font: fM(21, '600'), color: C.dim, align: 'center', alpha: pk * 0.9 });
    T(ctx, '验的是「界面好使」', hxx, hyy + 76, { font: fS(21), color: C.faint, align: 'center', alpha: pk * 0.9 });

    // 溶解 → agent（用 Nook 代表）
    const nk = eOut(win(u, 2.85, 3.5));
    if (nk > 0.02) {
      nook(ctx, hxx, hyy + 46, 1.0, { alpha: nk, mood: 'focus', look: -0.2, probe: nk });
      T(ctx, 'agent review', hxx, hyy - 148, { font: fM(21, '600'), color: C.amber, align: 'center', alpha: nk });
    }
    ctx.restore();
  }

  // 结果数字
  const na = app(t, 16.55, 0.5);
  if (na > 0.02) {
    T(ctx, '13/20', 1420, 700, { font: fM(54, '700'), color: C.dim, align: 'center', alpha: na * 0.75 });
    T(ctx, '→', 1420, 758, { font: fM(34, '600'), color: C.faint, align: 'center', alpha: na });
    T(ctx, '20/20', 1420, 830, { font: fM(72, '700'), color: C.green, align: 'center', alpha: na });
    T(ctx, '一轮挖出 3 个真缺陷', 1420, 878, { font: fS(21), color: C.teal, align: 'center', alpha: na });
  }

  doubao(ctx, 1740, 900, 0.78, { alpha: app(t, 13.9, 0.5), mood: 'smile', look: -0.4, paper: 0, bob: Math.sin(u * 2) * 2 });
}

/* --------------------------------------- 06 互审① 它审我 (17.6 – 21.6) */
function s6(ctx, t) {
  const u = t - 17.6;

  T(ctx, '互 审 · 第 一 回 合', W / 2, 128,
    { font: fM(26, '700'), color: C.orange, align: 'center', alpha: app(t, 17.65, 0.5), ls: 4 });

  // 工作台（高度收短：纸只占上半，下半留空会让画面重心发飘）
  const tx = 700, ty = 210, tw2 = 560, th = 400;
  panel(ctx, tx, ty, tw2, th, { alpha: app(t, 17.9, 0.5), fill: 'rgba(10,16,24,0.86)' });
  T(ctx, '本轮提交物：v1 设计', tx + 24, ty + 40, { font: fM(20, '600'), color: C.dim, alpha: app(t, 17.9, 0.5) });

  // 豆包发言
  doubao(ctx, 1600, 800, 1.02, {
    alpha: app(t, 17.7, 0.45), mood: 'talk', talk: u * 1.6, look: -0.8, paper: 3,
    bob: Math.sin(u * 2.6) * 2.4,
  });
  bubble(ctx, 1560, 612, '你的设计，我挑了 7 个问题', { alpha: app(t, 18.0, 0.45), k: win(u, 0.4, 0.9) });

  // 7 张批评纸飞向工作台（用真实议题名，比 #1..#7 有信息量）
  const papers = ['幂等', '版本化', '分片租约', '断点', '感知', '队列', '鉴权'];
  for (let i = 0; i < 7; i++) {
    const t0 = 18.7 + i * 0.16;
    const k = eInOut(cl(win(u, t0 - 17.6, t0 - 17.6 + 0.7)));
    if (k <= 0.01) continue;
    const sx = 1560, sy = 560;
    const cx2 = tx + 90 + (i % 4) * 130, cy2 = ty + 130 + Math.floor(i / 4) * 115;
    const x = lerp(sx, cx2, k), y = lerp(sy, cy2, k) - Math.sin(k * Math.PI) * 90;
    const acc = cl(win(u, 20.55, 20.95));   // 0 未裁决 → 1 已分类
    const isAdopt = i < 5;
    const col = acc > 0.5 ? (isAdopt ? C.green : 'rgba(139,148,158,0.75)') : C.orange;
    if (!isAdopt && acc > 0.01) {
      // 驳回的纸：飞出画面
      const off = eOut(acc);
      ctx.save(); ctx.globalAlpha = (1 - off) * 0.9;
      slip(ctx, x + off * 300, y - off * 260, 124, 72, papers[i], col, { tilt: (rnd(i) - 0.5) * 0.25, fs: 21 });
      ctx.restore();
      // 打叉
      ctx.save();
      ctx.globalAlpha = off * 0.85; ctx.strokeStyle = C.red; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - 12, y - 10); ctx.lineTo(x + 12, y + 12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + 12, y - 10); ctx.lineTo(x - 12, y + 12); ctx.stroke();
      ctx.restore();
    } else {
      slip(ctx, x, y, 124, 72, papers[i], col, { tilt: (rnd(i) - 0.5) * 0.25, fs: 21 });
      if (acc > 0.5 && isAdopt) {
        // 收下标：纸右上角挂一枚绿勾（画进纸里会压到文字）
        ctx.save();
        ctx.globalAlpha = cl((acc - 0.5) * 2) * 0.95;
        ctx.fillStyle = C.green;
        ctx.beginPath(); ctx.arc(x + 62, y - 36, 11.5, 0, 7); ctx.fill();
        ctx.strokeStyle = '#0b1017'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x + 56.5, y - 36); ctx.lineTo(x + 60.5, y - 31.5); ctx.lineTo(x + 67.5, y - 41.5); ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Nook 发言（终端行）—— 靠左放，右侧留给工作台（x≥700）
  nook(ctx, 320, 800, 1.02, {
    alpha: app(t, 17.7, 0.45), mood: u > 1.6 ? 'focus' : 'calm', look: 0.7,
    probe: app(t, 19.2, 0.6),
  });
  termline(ctx, 150, 640, '5 条采纳。4 条驳回 —— 附理由。', {
    alpha: app(t, 20.2, 0.45), type: win(u, 2.65, 3.5), caret: u, fs: 26,
  });

  // 计数
  const ca = app(t, 20.7, 0.45);
  if (ca > 0.02) {
    badge(ctx, 760, 762, 'ADOPTED 5', C.green, ca, 24);
    badge(ctx, 1010, 762, 'REJECTED 4', C.red, ca, 24);
    T(ctx, '外部模型评审 → 采纳 5 · 驳回 4', W / 2, 872,
      { font: fS(28, '600'), color: C.fg, align: 'center', alpha: ca });
    T(ctx, '外部意见不是命令 —— 每条都要给出取或舍的理由', W / 2, 912,
      { font: fS(23), color: C.faint, align: 'center', alpha: app(t, 21.0, 0.4) });
  }
}

/* --------------------------------------- 07 互审② 我审它 (21.6 – 25.4) */
function s7(ctx, t) {
  const u = t - 21.6;

  T(ctx, '互 审 · 第 二 回 合', W / 2, 128,
    { font: fM(26, '700'), color: C.teal, align: 'center', alpha: app(t, 21.65, 0.5), ls: 4 });

  // 报告板
  const bx = 620, by = 200, bw = 700, bh = 470;
  panel(ctx, bx, by, bw, bh, {
    alpha: app(t, 21.9, 0.5), fill: 'rgba(10,16,24,0.9)',
    edgeColor: 'rgba(244,228,195,0.35)',
  });
  T(ctx, '豆包 评测报告', bx + 26, by + 42, { font: fM(22, '700'), color: C.orange, alpha: app(t, 21.9, 0.5) });
  T(ctx, '「每个值都标了出处」', bx + 26, by + 72, { font: fS(19), color: C.dim, alpha: app(t, 22.1, 0.5) });

  // 报告条目
  const rows = [
    ['approval_id = apr_9399f6', true],
    ['"bytes": 929', true],
    ['403 携带 gate 字段', false],
    ['幂等键在存储层仲裁', false],
  ];
  const scanK = eOut(cl(win(u, 1.55, 2.3)));   // 探针扫过
  rows.forEach(([txt, bad], i) => {
    const a = app(t, 22.25 + i * 0.16, 0.4);
    const y = by + 130 + i * 78;
    panel(ctx, bx + 26, y - 32, bw - 52, 62, {
      alpha: a * 0.6, fill: 'rgba(18,26,36,0.8)', r: 8,
      edgeColor: bad ? 'rgba(248,81,73,0.45)' : 'rgba(139,148,158,0.18)',
    });
    T(ctx, txt, bx + 46, y + 6, { font: fM(22), color: C.fg, alpha: a });
    if (bad) {
      const hx = cl((scanK - i * 0.30) / 0.30);
      if (hx > 0.01) {
        ctx.save();
        ctx.globalAlpha = hx * 0.16; ctx.fillStyle = C.red;
        rr(ctx, bx + 26, y - 32, bw - 52, 62, 8); ctx.fill();
        ctx.globalAlpha = hx;
        ctx.strokeStyle = C.red; ctx.lineWidth = 3.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(bx + bw - 84, y - 14); ctx.lineTo(bx + bw - 62, y + 10); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx + bw - 62, y - 14); ctx.lineTo(bx + bw - 84, y + 10); ctx.stroke();
        ctx.restore();
      }
    }
  });

  // Nook 扫描
  nook(ctx, 300, 720, 1.0, {
    alpha: app(t, 21.8, 0.5), mood: 'focus', look: 0.9,
    probe: app(t, 22.35, 0.7),
  });
  // 扫描光束
  if (scanK > 0.02) {
    ctx.save();
    ctx.globalAlpha = scanK * 0.5;
    const g = ctx.createLinearGradient(bx - 120, 0, bx + 40, 0);
    g.addColorStop(0, 'rgba(245,158,11,0)'); g.addColorStop(1, 'rgba(245,158,11,0.6)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(bx - 120, by + 30); ctx.lineTo(bx + 30, by + 30);
    ctx.lineTo(bx + 30, by + bh - 30); ctx.lineTo(bx - 120, by + bh - 30);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // 豆包
  const mood = u > 2.6 ? 'sweat' : 'proud';
  doubao(ctx, 1610, 790, 1.0, {
    alpha: app(t, 21.8, 0.5), mood, look: -0.9, paper: 1,
    bob: Math.sin(u * 2.4) * 2, blink: win(u, 3.0, 3.4),
  });
  bubble(ctx, 1560, 596, '每个值都标了出处！', {
    alpha: app(t, 22.0, 0.4) * (1 - cl(win(u, 2.5, 2.8))), k: win(u, 0.4, 0.9),
  });
  bubble(ctx, 1560, 596, '怎么可能…我再查查', {
    alpha: app(t, 24.3, 0.35) * cl(win(u, 2.5, 2.8)), k: win(u, 2.6, 3.0),
  });

  // Nook 结论
  termline(ctx, 180, 900, '查两处：全部材料里都搜不到。', {
    alpha: app(t, 23.6, 0.45), type: win(u, 2.1, 2.9), caret: u, fs: 26,
  });
}

/* --------------------------------------- 08 互审③ 伪造出处 (25.4 – 28.6) */
function s8(ctx, t) {
  const u = t - 25.4;

  T(ctx, '互 审 · 第 三 回 合', W / 2, 128,
    { font: fM(26, '700'), color: C.red, align: 'center', alpha: app(t, 25.45, 0.5), ls: 4 });

  // 左：它标的出处   右：实际内容
  const lx = 200, ly = 220, lw = 620, lh = 300;
  const rx2 = 1100, rw2 = 620;

  panel(ctx, lx, ly, lw, lh, { alpha: app(t, 25.7, 0.5), fill: 'rgba(10,16,24,0.9)' });
  T(ctx, '它声称的出处', lx + 24, ly + 42, { font: fM(20, '600'), color: C.dim, alpha: app(t, 25.7, 0.5) });
  T(ctx, '「取自评测包第 4 节 403 响应示例原文」', lx + 24, ly + 88,
    { font: fS(22, '600'), color: C.fg, alpha: app(t, 25.9, 0.45) });
  T(ctx, 'approval_id = apr_9399f6', lx + 24, ly + 146, { font: fM(22), color: C.red, alpha: app(t, 26.1, 0.45) });
  T(ctx, '"bytes": 929', lx + 24, ly + 186, { font: fM(22), color: C.red, alpha: app(t, 26.3, 0.45) });
  T(ctx, '标注：「逐字取自原文」', lx + 24, ly + 236, { font: fS(19), color: C.faint, alpha: app(t, 26.5, 0.45) });

  panel(ctx, rx2, ly, rw2, lh, { alpha: app(t, 25.9, 0.5), fill: 'rgba(10,16,24,0.9)', edgeColor: 'rgba(63,185,80,0.4)' });
  T(ctx, '出处文件里的实际内容', rx2 + 24, ly + 42, { font: fM(20, '600'), color: C.dim, alpha: app(t, 25.9, 0.5) });
  T(ctx, 'approval_id = apr_822943', rx2 + 24, ly + 100, { font: fM(22), color: C.green, alpha: app(t, 26.1, 0.45) });
  T(ctx, '"bytes": 1260', rx2 + 24, ly + 142, { font: fM(22), color: C.green, alpha: app(t, 26.3, 0.45) });
  T(ctx, 'apr_ 前缀 ID 全材料仅此一个', rx2 + 24, ly + 196, { font: fS(18), color: C.faint, alpha: app(t, 26.5, 0.45) });

  // 命中判定：0
  const ha = app(t, 27.0, 0.45);
  if (ha > 0.02) {
    ctx.save();
    ctx.globalAlpha = ha;
    ctx.strokeStyle = C.red; ctx.lineWidth = 2.4; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(lx + lw + 22, ly + 40); ctx.lineTo(rx2 - 22, ly + 40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx + lw + 22, ly + lh - 40); ctx.lineTo(rx2 - 22, ly + lh - 40); ctx.stroke();
    ctx.restore();
    T(ctx, '逐字比对', (lx + lw + rx2) / 2, ly + 150,
      { font: fS(20), color: C.dim, align: 'center', alpha: ha });
    T(ctx, '0', (lx + lw + rx2) / 2, ly + 200,
      { font: fM(64, '700'), color: C.red, align: 'center', alpha: ha });
    T(ctx, '命中', (lx + lw + rx2) / 2, ly + 234,
      { font: fS(20), color: C.red, align: 'center', alpha: ha });
  }

  // 角色
  nook(ctx, 300, 760, 0.94, { alpha: app(t, 25.6, 0.5), mood: 'skeptic', look: 0.8, probe: app(t, 26.6, 0.6) });
  doubao(ctx, 1620, 750, 0.94, {
    alpha: app(t, 25.6, 0.5), mood: 'sweat', look: -0.8, bob: Math.sin(u * 3.2) * 3,
    blink: u * 0.5,
  });

  bubble(ctx, 1560, 566, '这次真的取自原文！', { alpha: app(t, 26.2, 0.4), k: win(u, 0.8, 1.3) });
  termline(ctx, 170, 900, '幻觉升级成了「伪造出处」。', {
    alpha: app(t, 27.2, 0.45), type: win(u, 1.6, 2.4), caret: u, fs: 26,
  });
}

/* --------------------------------------- 09 互审④ 护栏落下 (28.6 – 31.0) */
function s9(ctx, t) {
  const u = t - 28.6;

  const bx = 560, by = 210, bw = 800, bh = 400;

  // 护栏落下
  const gk = eOut5(win(u, 0.10, 0.85));
  const gx = bx - 26;
  if (gk > 0.02) {
    ctx.save();
    ctx.globalAlpha = gk;
    const gh = bh * gk;
    const g = ctx.createLinearGradient(gx, 0, gx + 14, 0);
    g.addColorStop(0, C.green); g.addColorStop(1, 'rgba(63,185,80,0.25)');
    ctx.fillStyle = g;
    rr(ctx, gx, by, 14, gh, 7); ctx.fill();
    ctx.restore();
  }

  panel(ctx, bx, by, bw, bh, { alpha: app(t, 28.7, 0.5), fill: 'rgba(10,16,24,0.9)', edgeColor: 'rgba(63,185,80,0.4)' });
  T(ctx, 'tools/verify-citation.mjs', bx + 30, by + 46,
    { font: fM(24, '700'), color: C.green, alpha: app(t, 28.8, 0.5) });
  T(ctx, '把声称的出处，拿去逐字比对', bx + 30, by + 82,
    { font: fS(20), color: C.dim, alpha: app(t, 29.0, 0.5) });

  const items = [
    ['在**指定出处文件**里能否逐字命中', '判定口径'],
    ['命中 → PASS · 未命中 → FAIL', '判据'],
    ['历史已漂移的旧引用 → RECORD（照常留痕，不计失败）', '不篡改历史'],
  ];
  items.forEach(([txt, tag], i) => {
    const a = app(t, 29.15 + i * 0.2, 0.42);
    const y = by + 140 + i * 76;
    panel(ctx, bx + 30, y - 30, bw - 60, 60, { alpha: a * 0.55, fill: 'rgba(18,26,36,0.8)', r: 8 });
    T(ctx, tag, bx + 52, y + 8, { font: fM(19, '600'), color: C.green, alpha: a });
    T(ctx, txt, bx + 210, y + 8, { font: fS(20), color: C.fg, alpha: a });
  });

  // 结果
  const ra = app(t, 29.85, 0.45);
  if (ra > 0.02) {
    badge(ctx, bx + 30, by + bh - 66, '6/6 PASS', C.green, ra, 24);
    badge(ctx, bx + 220, by + bh - 66, '1 RECORD', C.slate, ra, 24);
    T(ctx, '改写历史值 = 伪造出处 —— 所以旧值原样保留，只标记它已漂移',
      bx + 420, by + bh - 44, { font: fS(19), color: C.faint, alpha: ra });
  }

  // 两个角色：和解（表情切换必须留够时间 —— 2.4s 的章节里 0.1s 的笑等于没有）
  const hk = cl(win(u, 1.05, 1.60));
  nook(ctx, 330, 800, 0.96, {
    alpha: app(t, 28.65, 0.45), mood: hk > 0.5 ? 'happy' : 'focus', look: 0.7,
    probe: cl(1 - hk * 1.6),
  });
  doubao(ctx, 1600, 800, 0.96, {
    alpha: app(t, 28.65, 0.45),
    mood: hk > 0.5 ? 'smile' : 'sad', look: -0.7, bob: Math.sin(u * 2.2) * 2,
  });

  bubble(ctx, 1540, 622, '我错了。', {
    alpha: app(t, 29.0, 0.35) * (1 - cl(win(u, 1.30, 1.65))), k: win(u, 0.5, 0.95),
  });
  bubble(ctx, 1540, 622, '…这条我服。', {
    alpha: app(t, 30.0, 0.35) * cl(win(u, 1.30, 1.65)), k: win(u, 1.35, 1.8),
  });
  termline(ctx, 180, 900, '我做的东西，自己也得先立得住。', {
    alpha: app(t, 29.35, 0.45), type: win(u, 1.05, 1.85), caret: u, fs: 26,
  });
}

/* --------------------------------------- 10 三通道降级 (31.0 – 34.4) */
function s10(ctx, t) {
  const u = t - 31.4;

  const items = [
    ['压缩包 .zip', '✗', C.red, '对方不收附件'],
    ['在线链接 URL', '✓', C.green, '能读，但会失效'],
    ['纯文本粘贴', '✓', C.green, '最土，最可靠'],
  ];
  const cw = 380, gap = 60, tot = items.length * cw + (items.length - 1) * gap;
  let x0 = W / 2 - tot / 2;
  const y = 260, h = 200;

  items.forEach(([name, mark, col, note], i) => {
    const a = app(t, 31.45 + i * 0.55, 0.45);
    if (a <= 0.02) return;
    panel(ctx, x0, y, cw, h, { alpha: a, fill: 'rgba(18,26,36,0.9)', edgeColor: col + '66' });
    T(ctx, name, x0 + cw / 2, y + 70, { font: fS(28, '600'), color: C.fg, align: 'center', alpha: a });
    T(ctx, note, x0 + cw / 2, y + 106, { font: fS(19), color: C.faint, align: 'center', alpha: a });
    // 判定
    const ja = app(t, 31.8 + i * 0.55, 0.35);
    T(ctx, mark, x0 + cw / 2, y + 172, { font: fS(46, '700'), color: col, align: 'center', alpha: ja });
    // 连接箭头
    if (i < 2) T(ctx, '→', x0 + cw + gap / 2, y + h / 2 + 12,
      { font: fS(30), color: C.faint, align: 'center', alpha: app(t, 31.9 + i * 0.55, 0.4) });
    x0 += cw + gap;
  });

  // 裂成五形态
  const fk = eOut(win(u, 2.05, 2.85));
  if (fk > 0.02) {
    T(ctx, '一份内容，五种形态', W / 2, 520,
      { font: fS(24), color: C.faint, align: 'center', alpha: cl(fk * 1.6) });
    const forms = ['单文件版', '精简版', '多文件版', '粘贴版', '开测版'];
    const fw = 226, fg2 = 20, ftot = forms.length * fw + (forms.length - 1) * fg2;
    let fx = W / 2 - ftot / 2;
    forms.forEach((f, i) => {
      const a2 = cl((fk - i * 0.12) / 0.4);
      if (a2 <= 0.02) { fx += fw + fg2; return; }
      ctx.save();
      ctx.globalAlpha = a2;
      ctx.translate(0, (1 - eOut(a2)) * 26);
      panel(ctx, fx, 560, fw, 96, { fill: 'rgba(18,26,36,0.92)', edgeColor: 'rgba(163,113,247,0.4)' });
      T(ctx, f, fx + fw / 2, 600, { font: fS(24, '600'), color: C.violet, align: 'center' });
      T(ctx, 'DOUBAO-DELIVERY/', fx + fw / 2, 632, { font: fM(15), color: C.faint, align: 'center' });
      ctx.restore();
      fx += fw + fg2;
    });
  }

  // 角色
  nook(ctx, 200, 830, 0.84, { alpha: app(t, 31.6, 0.5), mood: 'calm', look: 0.6 });
  doubao(ctx, 1730, 830, 0.84, { alpha: app(t, 31.6, 0.5), mood: 'smile', look: -0.6, bob: Math.sin(u * 2.4) * 2, paper: 1 });

  T(ctx, '每次降级都是被现实逼的，不是设计出来的', W / 2, 900,
    { font: fS(27), color: C.purple, align: 'center', alpha: app(t, 33.9, 0.55) });
}

/* --------------------------------------- 11 上线 (34.4 – 38.0) */
function s11(ctx, t) {
  const u = t - 34.5;
  const cx = W / 2;

  // 大数字
  const k = eOut(cl(win(u, 0.25, 1.45)));
  const shown = Math.round(487 * k);

  T(ctx, '11 套测试 · 断言总数', cx, 300,
    { font: fM(28, '600'), color: C.dim, align: 'center', alpha: app(t, 34.55, 0.5), ls: 2 });

  ctx.save();
  ctx.globalAlpha = app(t, 34.6, 0.5);
  ctx.font = fM(210, '700'); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.fg;
  ctx.fillText(String(shown), cx, 512);
  ctx.restore();

  // 0 失败
  const fa = app(t, 35.9, 0.4);
  if (fa > 0.02) {
    ctx.save();
    ctx.globalAlpha = fa;
    ctx.translate(cx, 610 + (1 - eOut(fa)) * -16);
    const txt = '0  FAILED';
    const fnt = fS(56, '700');
    const w = tw(ctx, txt, fnt);
    // 🔴 translate 之后一律用相对坐标 —— 混用绝对坐标会把元素推出一整个屏宽
    ctx.fillStyle = 'rgba(63,185,80,0.14)';
    rr(ctx, -w / 2 - 40, -54, w + 80, 82, 41); ctx.fill();
    ctx.strokeStyle = C.green; ctx.lineWidth = 2;
    rr(ctx, -w / 2 - 40, -54, w + 80, 82, 41); ctx.stroke();
    ctx.font = fnt; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.green;
    ctx.fillText(txt, 0, 1);
    ctx.restore();
  }

  // 三行小字
  const la = app(t, 36.25, 0.45);
  const lines = [
    ['11 套 / 487 断言 / 0 失败', C.fg],
    ['acceptance 34/34  ·  agent-trial 20/20', C.dim],
    ['contract_digest 6d439cbd7c94bf93  ·  error.code 24 项', C.dim],
  ];
  lines.forEach(([txt, col], i) => {
    T(ctx, txt, cx, 700 + i * 40, { font: fM(i === 0 ? 27 : 23, i === 0 ? '600' : '400'), color: col, align: 'center', alpha: la });
  });

  // URL
  const ua = app(t, 36.8, 0.5);
  if (ua > 0.02) {
    const url = 'https://agent-console-eval.app.workbuddy.host/';
    const fnt = fM(30, '600');
    const w = tw(ctx, url, fnt);
    ctx.save();
    ctx.globalAlpha = ua;
    ctx.fillStyle = 'rgba(245,158,11,0.10)';
    rr(ctx, cx - w / 2 - 40, 836, w + 80, 68, 34); ctx.fill();
    ctx.strokeStyle = 'rgba(245,158,11,0.5)'; ctx.lineWidth = 1.8;
    rr(ctx, cx - w / 2 - 40, 836, w + 80, 68, 34); ctx.stroke();
    // 呼吸状态点
    ctx.globalAlpha = ua * (0.45 + 0.55 * Math.abs(Math.sin(u * 2.2)));
    ctx.fillStyle = C.green;
    ctx.beginPath(); ctx.arc(cx - w / 2 - 14, 870, 7, 0, 7); ctx.fill();
    ctx.restore();
    T(ctx, url, cx, 880, { font: fnt, color: C.amber, align: 'center', alpha: ua });
    T(ctx, '已上线 · 13 文件逐字节核验一致', cx, 936,
      { font: fS(21), color: C.faint, align: 'center', alpha: app(t, 37.1, 0.5) });
  }

  // 两个角色并肩（收尾同框）
  const ea = app(t, 35.7, 0.6);
  const bob = Math.sin((t - 34.5) * 2.1) * 2.5;
  nook(ctx, 430, 890, 0.8, { alpha: ea, mood: 'happy', look: 0.5, bob });
  doubao(ctx, 1490, 890, 0.8, { alpha: ea, mood: 'proud', look: -0.5, bob: -bob, paper: 0 });
}

/* ============================================================================
   字幕 & 主循环
   ========================================================================= */

const SUBS = {
  s1:  ['做一个 AI 用的网页 —— 你想要什么功能？', '第一用户不是人，是 agent'],
  s2:  ['v1 · 11 个端点，一个 HTML 文件，双击就跑', '状态 → 感官 → 行动，三层需求'],
  s3:  ['v3 · 走出浏览器：node:http + node:sqlite', '零 npm 依赖 · 两个进程抢同一把钥匙，只执行一次'],
  s4:  ['v4 · 给它牙齿：requires 从标注变成闸门', '业务代码一行不跑 · 批准 = 服务端回放原请求'],
  s5:  ['v5→v7 · 契约现场派生 · 验收人换成 agent', '可逐字节 diff —— 撒谎的 spec 比没有 spec 更坏'],
  s6:  ['互审 ① 它审我：7 条批评 → 采纳 5，驳回 4', '外部意见不是命令 —— 取或舍都要给理由'],
  s7:  ['互审 ② 我审它：这份报告里有编造', '两个值标注「取自原文」，全部材料里都搜不到'],
  s8:  ['互审 ③ 它把幻觉升级成了「伪造出处」', '编造可以原谅；安一个假出处，不行'],
  s9:  ['互审 ④ 于是加了一道引用核验', '护栏不是防它 —— 是防「我自己也会漂」'],
  s10: ['压缩包不收 → 给链接 → 只要纯文本', '一份内容，五种形态'],
  s11: ['11 套 · 487 断言 · 0 失败', 'https://agent-console-eval.app.workbuddy.host/'],
};

/** 底部字幕：主标题 + 副行。v2 用淡入淡出，不留残影。 */
function subs(ctx, t, id) {
  const s = SUBS[id];
  if (!s) return;
  const a = app(t, 0, 0.5);
  if (a <= 0.01) return;
  const cx = W / 2;

  // 主字幕底衬
  const f1 = fS(42, '700');
  const w1 = tw(ctx, s[0], f1);
  ctx.save();
  ctx.globalAlpha = a * 0.5;
  ctx.fillStyle = 'rgba(8,12,17,0.72)';
  rr(ctx, cx - w1 / 2 - 30, 964, w1 + 60, 54, 10); ctx.fill();
  ctx.restore();

  T(ctx, s[0], cx, 1002, { font: f1, color: C.fg, align: 'center', alpha: a });
  if (s[1]) T(ctx, s[1], cx, 1048, { font: fM(24), color: C.dim, align: 'center', alpha: a * 0.95 });
}

const CHAPTERS = [
  { id: 's1',  a: 0.0,  b: 3.0,  dot: C.blue,   draw: s1  },
  { id: 's2',  a: 3.0,  b: 6.0,  dot: C.teal,   draw: s2  },
  { id: 's3',  a: 6.0,  b: 9.8,  dot: C.green,  draw: s3  },
  { id: 's4',  a: 9.8,  b: 13.6, dot: C.red,    draw: s4  },
  { id: 's5',  a: 13.6, b: 17.6, dot: C.orange, draw: s5  },
  { id: 's6',  a: 17.6, b: 21.6, dot: C.amber,  draw: s6  },
  { id: 's7',  a: 21.6, b: 25.4, dot: C.teal,   draw: s7  },
  { id: 's8',  a: 25.4, b: 28.6, dot: C.red,    draw: s8  },
  { id: 's9',  a: 28.6, b: 31.4, dot: C.green,  draw: s9  },
  { id: 's10', a: 31.4, b: 34.5, dot: C.purple, draw: s10 },
  { id: 's11', a: 34.5, b: 38.0, dot: C.fg,     draw: s11 },
];
const DUR = CHAPTERS[CHAPTERS.length - 1].b;

const at = (t) => {
  for (const c of CHAPTERS) if (t >= c.a && t < c.b) return c;
  return t < 0 ? CHAPTERS[0] : CHAPTERS[CHAPTERS.length - 1];
};

/* 入场交叠 —— 直接切章会在每章第一帧露出"纯背景"：qc 实测每个切换点亮度骤降 5–7
   （视觉上就是"每章开头闪一下暗"）。把上一章的最后一帧离屏渲染后半透明压上来，
   硬切就变成叠化。只在每章头 0.22s 生效，多画一次，代价可忽略。 */
const FADE_IN = 0.22;
let _tmpCv = null, _tmpCtx = null;
if (typeof document !== 'undefined') {
  _tmpCv = document.createElement('canvas');
  _tmpCv.width = W; _tmpCv.height = H;
  _tmpCtx = _tmpCv.getContext('2d', { alpha: false });
}

function draw(ctx, w, h, t) {
  t = cl(t, 0, DUR);
  bg(ctx, t);
  const c = at(t);
  const idx = CHAPTERS.indexOf(c);
  const u = t - c.a;

  if (_tmpCtx && idx > 0 && u < FADE_IN) {
    const prev = CHAPTERS[idx - 1];
    const pt = prev.b - 0.001;
    _tmpCtx.globalAlpha = 1;
    bg(_tmpCtx, pt);
    _tmpCtx.save(); prev.draw(_tmpCtx, pt); _tmpCtx.restore();
    subs(_tmpCtx, prev.b - prev.a - 0.001, prev.id);
    ctx.save();
    ctx.globalAlpha = 1 - eOut(u / FADE_IN);
    ctx.drawImage(_tmpCv, 0, 0);
    ctx.restore();
  }

  ctx.save();
  c.draw(ctx, t);
  ctx.restore();
  subs(ctx, u, c.id);
}

window.SCENE = { draw, DUR, CHAPTERS, W, H };
})();
