/* ============================================================================
   短片 · 《一个 AI 的自白》 45.0s / 十二镜 / 1920×1080 @30fps
   ----------------------------------------------------------------------------
   与上一部《一个 AI 网页的诞生》的区别，一句话：**上一部的主角是网页，这一部是我。**

   三处结构性改动：
     1) 角色层 —— 从「代码画的参数化几何」换成「网络真实素材位图」。
        位图动不了胳膊腿，硬动就是纸片抖动。能动只剩 5 种：
        ① 呼吸 bob  ② 换图交叉淡化  ③ 淡入上浮  ④ 说话推拉  ⑤ 背后光晕。
        🔴 换图必须交叉淡化 —— 直接替换会让 alpha 从 1 跳到 0 闪断，
           与「章节硬切露一帧纯背景」是同一个病（skill §64），只是换了一层。
     2) 背景 —— 全片只有一件事：**单向变亮**。从最深的海底一路抬到有光。
        深色片亮度口径照 skill §62（抬暗部，不调阈值）。
     3) 信息单位 —— 从「端点/断言/token」换成「分钟/被打断的次数」。
        token 数一个都不出现，它就是上一部"人类看不懂"的病根。

   图片为什么内嵌成 data URI 而不是 file:// 直接读：
     file:// 加载的本地图会把 canvas 标记成 cross-origin 污染，
     之后每次 toDataURL() 都抛 SecurityError —— 而整条管线都建立在 toDataURL 上。
   ========================================================================= */
(() => {
'use strict';

const W = 1920, H = 1080;

/* ------------------------------------------------------------------ 调色 */
const C = {
  bg0:    '#0a0c1c',   // 最深（S01 海底）
  bg1:    '#171d38',   // 最亮（S12 有光）
  panel:  'rgba(26,26,58,0.92)',
  fg:     '#dbe4f5',
  dim:    '#8b96b0',
  faint:  '#5a6580',
  edge:   'rgba(120,140,190,0.20)',
  ds:     '#4d6bfe',   // DeepSeek whale blue
  dsSoft: '#8fa3ff',
  db:     '#cae4ff',   // 豆包官方浅蓝底
  dbEdge: '#7fb4f0',
  dbInk:  '#1c2b45',
  green:  '#34d399',
  red:    '#fb7185',
  amber:  '#f5b544',
  violet: '#a78bfa',
  teal:   '#39c5cf',
  slate:  '#9aa5b1',
  ink:    '#0b1026',   // "全黑"用极暗蓝 —— 纯黑在深色片里会砸出一个洞，
                       // 而且 qc 的分章极差会被这一下顶出阈值（实测 #05060f → 极差 30.1 CHECK）
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
const eBack = k => { const c = 2.04; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const win = (t, a, b) => cl((t - a) / (b - a));
const app = (t, a, d = 0.55) => eOut(win(t, a, a + d));
const rnd = (i, s = 127.1) => { const x = Math.sin(i * s + 311.7) * 43758.5453; return x - Math.floor(x); };

/** 两个 hex 之间插值 → 'rgb(...)'。全片"背景单向变亮"靠它。 */
function mixHex(a, b, k) {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((A >> 16) & 255, (B >> 16) & 255, k));
  const g = Math.round(lerp((A >> 8) & 255, (B >> 8) & 255, k));
  const bl = Math.round(lerp(A & 255, B & 255, k));
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

/** 呼吸：所有静止镜的常驻微动。幅度小到"没在动，但活着"。 */
const bobY = (t, amp = 4, per = 3.2, ph = 0) => amp * Math.sin(2 * Math.PI * t / per + ph);
const breathe = (t, amp = 0.006, per = 3.2, ph = 0) => 1 + amp * Math.sin(2 * Math.PI * t / per + ph);

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
  ctx.fillStyle = 'rgba(' + rgb + ',0.14)';
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
  return ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255);
}

/** canvas 没有"降饱和"这个操作，叠一层低透明灰蓝就是视觉上的"蒙灰"。 */
function desat(ctx, k, tint = 'rgba(126,138,158,0.20)') {
  if (k <= 0.001) return;
  ctx.save(); ctx.globalAlpha = cl(k); ctx.fillStyle = tint; ctx.fillRect(0, 0, W, H); ctx.restore();
}

/* ============================================================================
   角色层 —— 位图
   ========================================================================= */

const IMG = {};                       // key -> 已解码的 canvas
let _readyResolve = null;
const READY = new Promise(r => { _readyResolve = r; });

(function loadAssets() {
  const A = (typeof window !== 'undefined' && window.ASSETS) || {};
  const keys = Object.keys(A);
  if (!keys.length) {
    if (typeof console !== 'undefined') console.warn('[scene] window.ASSETS 是空的 —— page.html 忘了引 assets-data.js？');
    _readyResolve(); return;
  }
  let left = keys.length;
  const done = () => { if (--left === 0) _readyResolve(); };
  keys.forEach(k => {
    const im = new Image();
    im.onload = () => {
      // 中转成 canvas：canvas→canvas 是 drawImage 最快的一条路径。
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      IMG[k] = c; done();
    };
    im.onerror = () => {
      if (typeof console !== 'undefined') console.error('[scene] 素材加载失败：' + k);
      done();
    };
    im.src = A[k];
  });
})();

/**
 * actor —— 画一个位图角色。返回实际绘制高度。
 * o = { img, x, yb|yc, h, alpha, bob, scale, flip, glow, glowColor }
 *
 * 定位说明：yb 是**底边**、yc 是中心。素材已裁到内容包围盒，
 * 所以 x/yb 就是"这个角色站在哪"，不用再猜原图里的透明偏移。
 */
function actor(ctx, o) {
  const cv = IMG[o.img];
  if (!cv) return 0;
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.004) return 0;
  const h = o.h, w = h * (cv.width / cv.height);
  const sc = o.scale == null ? 1 : o.scale;
  const cy = (o.yc != null ? o.yc : o.yb - h / 2) + (o.bob || 0);

  ctx.save();
  ctx.globalAlpha = a;
  if (o.glow) {                                  // ⑤ 背后光晕
    const gc = o.glowColor || C.ds;
    const R = h * (o.glowR || 0.72);
    const g = ctx.createRadialGradient(o.x, cy, 0, o.x, cy, R);
    g.addColorStop(0, 'rgba(' + hexToRgb(gc) + ',' + (0.30 * o.glow).toFixed(3) + ')');
    g.addColorStop(0.55, 'rgba(' + hexToRgb(gc) + ',' + (0.11 * o.glow).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + hexToRgb(gc) + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(o.x - R, cy - R, R * 2, R * 2);
  }
  ctx.translate(o.x, cy);
  if (o.flip) ctx.scale(-1, 1);
  ctx.scale(sc, sc);
  ctx.drawImage(cv, -w / 2, -h / 2, w, h);
  ctx.restore();
  return h;
}

/**
 * actorMood —— 换表情。
 * 🔴 必须交叉淡化：直接换图会让 alpha 从 1 跳到 0，出现"闪断"。
 *    这和"章节硬切露一帧纯背景"是同一个病（skill §64），只是从章节层降到位图层。
 */
function actorMood(ctx, o, from, to, k) {
  k = cl(k);
  const a = o.alpha == null ? 1 : o.alpha;
  if (k < 1) actor(ctx, Object.assign({}, o, { img: from, alpha: a * (1 - k) }));
  if (k > 0) actor(ctx, Object.assign({}, o, { img: to, alpha: a * k }));
}

/** 气泡（豆包的说话方式）：自动宽度，尾巴朝下。配色对到官方浅蓝。 */
function bubble(ctx, x, y, text, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return 0;
  const fs = o.fs || 28, font = fS(fs, '500');
  const pad = 26, w = tw(ctx, text, font) + pad * 2, h = fs + 38;
  const lift = (1 - eOut(cl(o.k || 1))) * 10;
  const y0 = y - h - lift;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = o.fill || 'rgba(232,242,255,0.97)';
  rr(ctx, x - w / 2, y0, w, h, 16); ctx.fill();
  ctx.strokeStyle = o.edge || C.dbEdge; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.fillStyle = o.fill || 'rgba(232,242,255,0.97)';
  ctx.beginPath();
  ctx.moveTo(x - 12, y0 + h - 2); ctx.lineTo(x + 4, y0 + h - 2); ctx.lineTo(x - 8, y0 + h + 15);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = o.edge || C.dbEdge; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(x - 12, y0 + h - 1); ctx.lineTo(x - 8, y0 + h + 15); ctx.lineTo(x + 4, y0 + h - 1); ctx.stroke();
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = o.color || C.dbInk;
  ctx.fillText(text, x, y0 + h / 2 + 1);
  ctx.restore();
  return w;
}

/** 终端行（鲸鱼娘的说话方式）：▮ 提示符 + 等宽字，逐字打出 */
function termline(ctx, x, y, text, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.002) return;
  const fs = o.fs || 27, font = fM(fs, '500');
  const k = o.type == null ? 1 : cl(o.type);
  const shown = text.slice(0, Math.round(text.length * k));
  ctx.save();
  ctx.globalAlpha = a;
  const bx = x - 2, bw = 13, bh = 26;
  ctx.fillStyle = o.accent || C.dsSoft;
  ctx.globalAlpha = a * (0.55 + 0.45 * Math.abs(Math.sin((o.caret || 0) * 3)));
  rr(ctx, bx, y - 21, bw, bh, 3); ctx.fill();
  ctx.globalAlpha = a;
  const off = bw + 14;
  const wpx = tw(ctx, text, font);
  ctx.fillStyle = 'rgba(8,12,26,0.78)';
  rr(ctx, bx - 10, y - 27, wpx + bw + 34, 40, 8); ctx.fill();
  ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = o.color || C.fg;
  ctx.fillText(shown, x + off, y);
  if (k < 1) {
    const cw = tw(ctx, shown, font);
    ctx.globalAlpha = a * (0.4 + 0.6 * Math.abs(Math.sin((o.caret || 0) * 6)));
    ctx.fillStyle = o.accent || C.dsSoft;
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
  ctx.fillStyle = o.fill || 'rgba(16,20,40,0.96)';
  rr(ctx, -w / 2, -h / 2, w, h, 8); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.8;
  ctx.globalAlpha = a * 0.9;
  rr(ctx, -w / 2, -h / 2, w, h, 8); ctx.stroke();
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
  const k = cl(t / DUR);                      // 全片唯一的花招：单向变亮
  ctx.fillStyle = mixHex(C.bg0, C.bg1, k);
  ctx.fillRect(0, 0, W, H);

  // 顶部光柱（越到后面越亮 —— "从海底抬头，看见了光"）
  let g = ctx.createRadialGradient(W / 2, -140, 0, W / 2, -140, 1520);
  g.addColorStop(0, 'rgba(96,140,235,' + (0.16 + 0.16 * k).toFixed(3) + ')');
  g.addColorStop(0.5, 'rgba(58,92,170,' + (0.07 + 0.06 * k).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // 深海上浮微粒 —— 纯 t 函数，所以断点续渲也得到同一帧
  ctx.save();
  for (let i = 0; i < 52; i++) {
    const sx = rnd(i, 12.9), sp = 0.35 + rnd(i, 31.7) * 0.85;
    const span = H + 120;
    const y = H + 60 - ((t * sp * 24 + rnd(i, 77.3) * span) % span);
    const x = sx * W + Math.sin(t * 0.28 + i * 1.7) * 18;
    const twk = 0.55 + 0.45 * Math.sin(t * 0.7 + i * 2.3);
    ctx.globalAlpha = (0.07 + 0.13 * rnd(i, 55.1)) * twk;
    ctx.fillStyle = '#9fc4ff';
    ctx.beginPath(); ctx.arc(x, y, 1.0 + rnd(i, 91.3) * 2.2, 0, 7); ctx.fill();
  }
  ctx.restore();

  // 抬暗部：暗角之前铺一层薄雾（skill §62 —— 深色片不能把暗部压死）
  ctx.fillStyle = 'rgba(30,52,110,0.15)'; ctx.fillRect(0, 0, W, H);

  // 暗角
  g = ctx.createRadialGradient(W / 2, H / 2, H * 0.48, W / 2, H / 2, H * 1.2);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.36)');
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
  T(ctx, 'O N E   A I   T A L K I N G', 96, 74, { font: fM(20, '600'), color: C.faint, ls: 2 });
  T(ctx, '2 0 2 6 - 1 0 - 0 4', W - 96, 74, { font: fM(20, '600'), color: C.faint, align: 'right', ls: 2 });
}

/* ============================================================================
   章节
   ========================================================================= */

/* --------------------------------------------- 01 自白 (0.0 – 4.0)
   「我干活的样子，你其实没见过。」
   左：全身立绘 B（拿手机）；右：一块工作终端，日志一行行刷过。
   尾迹 12 段渐隐 = "一直在跑，没停过"。 */
function s1(ctx, t) {
  const A = 0.0, u = t - A;

  // 尾迹
  ctx.save();
  for (let i = 0; i < 12; i++) {
    const k = 1 - i / 12;
    const a = app(u, 1.0 + i * 0.045, 0.7) * k * 0.30;
    if (a <= 0.004) continue;
    ctx.globalAlpha = a;
    ctx.strokeStyle = C.dsSoft; ctx.lineWidth = 2.4 * k + 0.6;
    ctx.beginPath();
    const y = 700 + i * 22;
    ctx.moveTo(250 - i * 12, y);
    ctx.quadraticCurveTo(300 - i * 10, y - 16, 355 - i * 8, y - 4);
    ctx.stroke();
  }
  ctx.restore();

  // 角色：全身立绘 B，自左淡入上浮
  const a1 = app(u, 0.25, 1.0);
  if (a1 > 0.004) {
    const sl = (1 - a1) * 26;
    actor(ctx, {
      img: 'fullB', x: 470 - sl, yb: 930 + sl, h: 800,
      alpha: a1, bob: bobY(t, 4.5, 3.6), glow: a1 * 0.9, glowColor: C.ds,
    });
  }

  // 工作终端
  const a2 = app(u, 0.75, 0.8);
  if (a2 > 0.004) {
    const px = 1010, py = 214, pw = 720, ph = 566;
    panel(ctx, px, py, pw, ph, { alpha: a2, fill: 'rgba(14,18,40,0.90)' });
    ctx.save();
    ctx.globalAlpha = a2;
    ctx.fillStyle = 'rgba(40,50,92,0.85)';
    rr(ctx, px, py, pw, 46, 12); ctx.fill();
    rr(ctx, px, py, pw, 46, 12); ctx.fill();
    ctx.fillRect(px, py + 34, pw, 12);
    ctx.restore();
    [C.red, C.amber, C.green].forEach((c, i) => {
      ctx.save(); ctx.globalAlpha = a2; ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(px + 26 + i * 22, py + 23, 6, 0, 7); ctx.fill(); ctx.restore();
    });
    T(ctx, 'agent · working', px + 110, py + 30, { font: fM(19, '500'), color: C.dim, alpha: a2 });

    // 日志行：只用类别词，不含任何具体数字（溯源纪律）
    const LOGS = [
      '▮ 读文件', '▮ 改代码', '▮ 跑测试', '▮ 读回输出',
      '▮ 修一处', '▮ 再跑一遍', '▮ 全绿', '▮ 继续下一件',
    ];
    LOGS.forEach((s, i) => {
      const la = app(u, 1.35 + i * 0.30, 0.45) * a2;
      if (la <= 0.004) return;
      const ly = py + 106 + i * 50;
      ctx.save();
      ctx.globalAlpha = la * 0.5;
      ctx.fillStyle = 'rgba(22,30,60,0.9)';
      rr(ctx, px + 30, ly - 25, pw - 60, 40, 6); ctx.fill();
      ctx.restore();
      T(ctx, s, px + 48, ly + 2, { font: fM(24, '500'), color: i === 7 ? C.green : C.dim, alpha: la });
    });
  }

  // 头顶终端小字
  const a3 = app(u, 2.4, 0.6);
  if (a3 > 0.004) termline(ctx, 150, 176, '正在工作', { alpha: a3, fs: 26, caret: t });
}

/* --------------------------------------------- 02 痛点 (4.0 – 8.0)
   「一件事做完，我得停下来问你一次。」
   时间轴 0 → 25 分钟，三枚红标记依次砸落。每次砸落：轴硬停 + 画面蒙灰。
   右上角计数器一路走到 25:00 —— 时间就是在这些"停一下"里流掉的。 */
function s2(ctx, t) {
  const A = 4.0, u = t - A;
  const STEP = [0.85, 2.05, 3.25];                  // 三次打断的时刻
  const STOP = 0.13;                                 // 每次硬停的时长
  const ax0 = 262, ax1 = 1658, ay = 560;

  // 轴：底轴 + 已走部分 + 刻度（原版太暗，缩略图上几乎看不见）
  const a0 = app(u, 0.1, 0.7);
  const prog = cl((u - 0.5) / 3.0);
  const px = lerp(ax0, ax1, prog);
  ctx.save();
  ctx.globalAlpha = a0 * 0.9;
  ctx.strokeStyle = 'rgba(150,170,215,0.42)'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(ax0, ay); ctx.lineTo(ax1, ay); ctx.stroke();
  if (prog > 0) {                                    // 已走部分：蓝 → 红
    const gg = ctx.createLinearGradient(ax0, 0, ax1, 0);
    gg.addColorStop(0, 'rgba(' + hexToRgb(C.ds) + ',0.60)');
    gg.addColorStop(1, 'rgba(' + hexToRgb(C.red) + ',0.92)');
    ctx.globalAlpha = a0;
    ctx.strokeStyle = gg;
    ctx.beginPath(); ctx.moveTo(ax0, ay); ctx.lineTo(Math.max(ax0 + 1, px), ay); ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = a0 * 0.34;
  ctx.strokeStyle = 'rgba(175,195,235,0.9)'; ctx.lineWidth = 1.5;
  for (let i = 0; i <= 10; i++) {
    const x = lerp(ax0, ax1, i / 10);
    ctx.beginPath(); ctx.moveTo(x, ay - 11); ctx.lineTo(x, ay + 11); ctx.stroke();
  }
  ctx.restore();

  // 三个预置的打断位：竖虚线 + 序号（先立起来，再依次砸落）
  STEP.forEach((ts, i) => {
    const x = lerp(ax0 + 120, ax1 - 120, i / 2);
    const da = app(u, 0.5 + i * 0.10, 0.45);
    if (da <= 0.004) return;
    ctx.save();
    ctx.globalAlpha = da * 0.45;
    ctx.strokeStyle = C.red; ctx.lineWidth = 2;
    ctx.setLineDash([8, 10]);
    ctx.beginPath(); ctx.moveTo(x, ay - 14); ctx.lineTo(x, 414); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    T(ctx, '第 ' + (i + 1) + ' 次', x, 396,
      { font: fS(22, '600'), color: C.red, align: 'center', alpha: da * 0.8 });
  });

  T(ctx, '0', ax0, ay + 54, { font: fM(24, '600'), color: C.dim, align: 'center', alpha: a0 });
  T(ctx, '25 分钟', ax1, ay + 54, { font: fM(24, '600'), color: C.red, align: 'center', alpha: a0 });

  // 三枚标记
  STEP.forEach((ts, i) => {
    const k = win(u, ts, ts + 0.34);
    if (k <= 0) return;
    const drop = (1 - eIn(k)) * 130;
    const x = lerp(ax0 + 120, ax1 - 120, i / 2);
    // 落点涟漪
    ctx.save();
    ctx.globalAlpha = cl(1 - win(u, ts + 0.1, ts + 0.55)) * 0.55;
    ctx.strokeStyle = C.red; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, ay, 16 + win(u, ts + 0.1, ts + 0.75) * 46, 0, 7); ctx.stroke();
    ctx.restore();
    // 标记本体
    ctx.save();
    ctx.globalAlpha = cl(k * 1.4);
    ctx.fillStyle = C.red;
    ctx.beginPath();
    ctx.moveTo(x, ay - 13 - drop); ctx.lineTo(x - 17, ay - 52 - drop); ctx.lineTo(x + 17, ay - 52 - drop);
    ctx.closePath(); ctx.fill();
    ctx.fillRect(x - 3.5, ay - 52 - drop, 7, 36);
    ctx.restore();
    // 灰色小气泡「这样可以吗？」
    const nxt = STEP[i + 1] != null ? ts + 0.95 : ts + 1.6;
    const ba = app(u, ts + 0.42, 0.4) * cl(1 - win(u, nxt, nxt + 0.3));
    if (ba > 0.004) {
      const bx = x + 46, by = ay - 74, s = '这样可以吗？';
      const f = fS(23, '500'), w0 = tw(ctx, s, f) + 34, h0 = 46;
      ctx.save();
      ctx.globalAlpha = ba;
      ctx.fillStyle = 'rgba(150,160,180,0.18)';
      rr(ctx, bx, by - h0 / 2, w0, h0, 10); ctx.fill();
      ctx.strokeStyle = 'rgba(170,180,200,0.45)'; ctx.lineWidth = 1.4;
      rr(ctx, bx, by - h0 / 2, w0, h0, 10); ctx.stroke();
      ctx.font = f; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.slate; ctx.fillText(s, bx + 17, by + 1);
      ctx.restore();
    }
  });

  // 蒙灰（打断的那几拍）
  let dk = 0;
  STEP.forEach(ts => { dk = Math.max(dk, cl(1 - win(u, ts + 0.30, ts + 0.30 + STOP + 0.25)) * (u > ts + 0.30 ? 1 : 0)); });
  desat(ctx, dk * 0.85);

  // 计数器（右上）：每次被打断时闪一下 —— 时间就是在这儿流掉的
  const a4 = app(u, 0.2, 0.6);
  if (a4 > 0.004) {
    let lastStop = -9;
    STEP.forEach(ts => { if (u > ts + 0.30) lastStop = ts; });
    const flash = cl(1 - (u - (lastStop + 0.30)) / 0.30);
    const mins = cl((u - 0.5) / 3.0) * 25;
    const mm = String(Math.floor(mins)).padStart(2, '0');
    const ss = String(Math.floor((mins % 1) * 60)).padStart(2, '0');
    const bx = 1440, by = 232;
    if (flash > 0.02) {
      ctx.save();
      ctx.globalAlpha = flash * 0.5 * a4;
      ctx.strokeStyle = C.red; ctx.lineWidth = 3 + flash * 3;
      rr(ctx, bx, by, 388, 168, 12); ctx.stroke();
      ctx.restore();
    }
    panel(ctx, bx, by, 388, 168, { alpha: a4 * 0.92, fill: 'rgba(14,18,40,0.86)' });
    T(ctx, '已过去', bx + 30, by + 52, { font: fS(22, '600'), color: C.dim, alpha: a4 });
    T(ctx, mm + ':' + ss, bx + 358, by + 122, {
      font: fM(62, '700'), color: (mins > 23 || flash > 0.35) ? C.red : C.fg,
      align: 'right', alpha: a4,
    });
  }

  // 下注脚
  const a5 = app(u, 3.5, 0.5);
  if (a5 > 0.004) {
    T(ctx, '3 次', W / 2, 872, { font: fM(84, '700'), color: C.red, align: 'center', alpha: a5 });
    T(ctx, '每一次，我都得停下来等你回一句', W / 2, 926,
      { font: fS(28, '500'), color: C.dim, align: 'center', alpha: a5 * 0.95 });
  }
}

/* --------------------------------------------- 03 处境 (8.0 – 11.5)
   「我不缺智力。我缺的是一件趁手的工具。」
   Q版·困倦站在一面"聊天框墙"前，把结构化数据卡片往里推 —— 卡在框沿，滑掉。 */
function s3(ctx, t) {
  const A = 8.0, u = t - A;
  const wx = 916, wy = 210, cw = 268, ch = 146, gap = 22;

  const a0 = app(u, 0.15, 0.8);
  if (a0 > 0.004) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const x = wx + c * (cw + gap), y = wy + r * (ch + gap);
      const ia = app(u, 0.15 + i * 0.055, 0.5) * a0;
      if (ia <= 0.004) continue;
      ctx.save();
      ctx.globalAlpha = ia;
      ctx.fillStyle = 'rgba(30,36,70,0.94)';
      rr(ctx, x, y, cw, ch, 14); ctx.fill();
      ctx.strokeStyle = 'rgba(142,162,212,0.40)'; ctx.lineWidth = 1.5;
      rr(ctx, x, y, cw, ch, 14); ctx.stroke();
      ctx.fillStyle = 'rgba(158,176,214,0.48)';
      rr(ctx, x + 22, y + 38, cw - 44, 12, 6); ctx.fill();
      rr(ctx, x + 22, y + 64, (cw - 44) * 0.62, 12, 6); ctx.fill();
      ctx.strokeStyle = 'rgba(142,162,212,0.42)';
      rr(ctx, x + 18, y + ch - 42, cw - 36, 26, 13); ctx.stroke();
      ctx.restore();
    }
  }

  // 角色：Q版·困倦，整体下沉 6px 表"泄气"
  const a1 = app(u, 0.35, 0.9);
  if (a1 > 0.004) {
    const sink = eOut(win(u, 2.0, 2.6)) * 6;
    actor(ctx, {
      img: 'tired', x: 428, yb: 918 + sink, h: 452,
      alpha: a1, bob: bobY(t, 3.2, 4.9), glow: a1 * 0.75, glowColor: C.ds,
    });
  }

  // 结构化数据卡片：推 → 卡在框沿 → 滑掉
  const ck = win(u, 1.15, 2.35);
  if (ck > 0 && u < 3.5) {
    const k = eOut(ck);
    const x0 = 680, y0 = 660, x1 = wx + 134, y1 = wy + 73;
    const fall = eIn(win(u, 2.35, 3.05));
    const cx = lerp(x0, x1, k), cy = lerp(y0, y1, k) + fall * 320;
    const fade = cl(1 - win(u, 3.0, 3.5));
    ctx.save();
    ctx.globalAlpha = cl(k * 1.3) * fade;
    ctx.translate(cx, cy); ctx.rotate(-0.06 + fall * 0.34);
    ctx.fillStyle = 'rgba(77,107,254,0.22)';
    rr(ctx, -78, -52, 156, 104, 10); ctx.fill();
    ctx.strokeStyle = C.dsSoft; ctx.lineWidth = 2;
    rr(ctx, -78, -52, 156, 104, 10); ctx.stroke();
    ctx.font = fM(21, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.dsSoft;
    ctx.fillText('{', -62, -26); ctx.fillText('}', -62, 24);
    ctx.fillStyle = 'rgba(200,215,255,0.72)';
    rr(ctx, -44, -34, 96, 11, 5); ctx.fill();
    rr(ctx, -44, -12, 74, 11, 5); ctx.fill();
    rr(ctx, -44, 10, 88, 11, 5); ctx.fill();
    ctx.restore();
  }

  // 卡住的那一下
  const a2 = app(u, 2.45, 0.35) * cl(1 - win(u, 3.1, 3.6));
  if (a2 > 0.004) {
    T(ctx, '推不进去', wx + 134, wy + 200,
      { font: fS(24, '600'), color: C.red, align: 'center', alpha: a2 });
  }
}

/* --------------------------------------------- 04 初心 (11.5 – 15.0)
   「然后你问了我一句。」
   墙整体淡出 → 极暗 0.3s → 逐字打出用户原话 → 全身立绘 A（端咖啡）从下缘升起。
   全片唯一一次"转向镜头"。 */
function s4(ctx, t) {
  const A = 11.5, u = t - A;

  // 墙的余影淡出（不是硬切，避免亮度断崖）
  const wall = cl(1 - win(u, 0.0, 0.62));
  if (wall > 0.01) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const x = 916 + c * 290, y = 210 + r * 168;
      ctx.save();
      ctx.globalAlpha = wall * 0.85;
      ctx.fillStyle = 'rgba(30,36,70,0.94)';
      rr(ctx, x, y, 268, 146, 14); ctx.fill();
      ctx.strokeStyle = 'rgba(142,162,212,0.40)'; ctx.lineWidth = 1.5;
      rr(ctx, x, y, 268, 146, 14); ctx.stroke();
      ctx.restore();
    }
  }

  // 极暗段 0.28s。两个坑：
  //   ① 不能用纯黑 —— 深色片里会砸出一个洞；
  //   ② 不能全遮 —— 峰值 alpha 做到 1 时整帧变成一块纯色，那是"黑屏"不是"沉下去"。
  //      留 18% 的底，观众能看见深海还在那儿，只是潜得更深了。
  const dark = 0.82 * cl(win(u, 0.60, 0.86)) * cl(1 - win(u, 0.88, 1.20));
  if (dark > 0.001) {
    ctx.save(); ctx.globalAlpha = dark; ctx.fillStyle = C.ink;
    ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  // 用户那句话：逐字打出
  const LINE = '「做一个 AI 用的网页 —— 你作为 AI，会想要什么功能？」';
  const key = win(u, 1.18, 2.42);
  const a1 = app(u, 1.05, 0.5);
  if (a1 > 0.004 && key > 0) {
    const shown = LINE.slice(0, Math.round(LINE.length * cl(key)));
    const f = fS(46, '700');
    const x0 = 200, y0 = 452;
    ctx.save();
    ctx.globalAlpha = a1 * 0.55;
    ctx.fillStyle = C.ds;
    rr(ctx, x0 - 26, y0 - 62, 5, 92, 2.5); ctx.fill();
    ctx.restore();
    T(ctx, shown, x0, y0, { font: f, color: C.fg, alpha: a1 });
    if (key < 1) {
      const cw = tw(ctx, shown, f);
      ctx.save();
      ctx.globalAlpha = a1 * (0.35 + 0.65 * Math.abs(Math.sin(u * 13)));
      ctx.fillStyle = C.dsSoft;
      ctx.fillRect(x0 + cw + 5, y0 - 40, 15, 48);
      ctx.restore();
    }
    T(ctx, '—— 2026-10-03，你问我的一句', x0 + 2, y0 + 62,
      { font: fS(25, '500'), color: C.dim, alpha: a1 * 0.9 * cl(key) });
  }

  // 角色：全身立绘 A（端咖啡）从下缘升起 + 缓推近
  const a2 = app(u, 1.32, 1.1);
  if (a2 > 0.004) {
    const rise = (1 - eOut(a2)) * 120;
    const zoom = 1 + 0.05 * eOut(win(u, 1.6, 3.5));
    actor(ctx, {
      img: 'fullA', x: 1452, yb: 934 + rise, h: 748, scale: zoom,
      alpha: a2, bob: bobY(t, 3.6, 3.4), glow: a2, glowColor: C.ds,
    });
  }
}

/* --------------------------------------------- 05 答案 (15.0 – 19.0)
   「它的一号用户不是人，是我。」
   上行划掉、下行亮起；三枚芯片 状态/感官/行动 逐一点亮并给人话注解；
   最右侧一个聊天框被红叉划掉。 */
function s5(ctx, t) {
  const A = 15.0, u = t - A;

  // 上行：被划掉
  const a1 = app(u, 0.1, 0.55);
  if (a1 > 0.004) {
    const y = 232, x = 188, L = '第一用户  =  人';
    T(ctx, L, x, y, { font: fS(44, '700'), color: C.dim, alpha: a1 });
    const w0 = tw(ctx, L, fS(44, '700'));
    const strike = eOut(win(u, 0.7, 1.15));
    if (strike > 0) {
      ctx.save();
      ctx.globalAlpha = a1;
      ctx.strokeStyle = C.red; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - 6, y - 15); ctx.lineTo(x - 6 + (w0 + 12) * strike, y - 15); ctx.stroke();
      ctx.restore();
    }
    const na = app(u, 0.95, 0.4);
    if (na > 0.004) T(ctx, '✕', x + w0 + 30, y, { font: fS(36, '700'), color: C.red, alpha: na });
  }

  // 下行：亮起
  const a2 = app(u, 1.15, 0.7);
  const L2 = '第一用户  =  AI';
  if (a2 > 0.004) {
    const y = 348, x = 188, w2 = tw(ctx, L2, fS(58, '800'));
    const pulse = 0.75 + 0.25 * Math.sin(u * 3.4);
    T(ctx, L2, x, y, { font: fS(58, '800'), color: C.dsSoft, alpha: a2, ls: 1 });
    ctx.save();
    ctx.globalAlpha = a2 * 0.5 * pulse;
    ctx.strokeStyle = C.ds;
    rr(ctx, x - 22, y - 54, w2 + 44, 74, 12); ctx.stroke();
    ctx.restore();
    T(ctx, '← 这一句，是整件事的锚', x + w2 + 58, y - 4,
      { font: fS(25, '500'), color: C.dim, alpha: a2 * 0.9 });
  }

  // 三枚芯片
  const CH = [
    ['状态', '记住做到哪了', C.teal],
    ['感官', '拿得到数字', C.violet],
    ['行动', '敢动手', C.green],
  ];
  CH.forEach((c, i) => {
    const ck = app(u, 1.75 + i * 0.35, 0.55);
    if (ck <= 0.004) return;
    const x = 188 + i * 356, y = 574, w0 = 296, h0 = 106, lift = (1 - ck) * 18;
    ctx.save();
    ctx.globalAlpha = ck;
    ctx.fillStyle = 'rgba(' + hexToRgb(c[2]) + ',0.13)';
    rr(ctx, x, y + lift, w0, h0, 14); ctx.fill();
    ctx.strokeStyle = c[2]; ctx.lineWidth = 2;
    rr(ctx, x, y + lift, w0, h0, 14); ctx.stroke();
    ctx.fillStyle = c[2];
    rr(ctx, x, y + lift, 6, h0, 3); ctx.fill();
    ctx.restore();
    T(ctx, c[0], x + 30, y + lift + 62, { font: fS(40, '700'), color: c[2], alpha: ck });
    const na = app(u, 2.05 + i * 0.35, 0.5);
    if (na > 0.004) {
      const pf = fS(23, '500'), pw = tw(ctx, '人话 = ', pf);
      T(ctx, '人话 = ', x + 30, y + 138, { font: pf, color: C.faint, alpha: na });
      T(ctx, c[1], x + 30 + pw, y + 138, { font: fS(23, '600'), color: C.dim, alpha: na });
    }
  });

  // 右侧：聊天框被划掉
  const a4 = app(u, 2.9, 0.6);
  if (a4 > 0.004) {
    const x = 1508, y = 566, w0 = 268, h0 = 146;
    ctx.save();
    ctx.globalAlpha = a4;
    ctx.fillStyle = 'rgba(30,36,70,0.94)';
    rr(ctx, x, y, w0, h0, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(142,162,212,0.40)'; ctx.lineWidth = 1.5;
    rr(ctx, x, y, w0, h0, 14); ctx.stroke();
    ctx.fillStyle = 'rgba(158,176,214,0.46)';
    rr(ctx, x + 22, y + 38, w0 - 44, 12, 6); ctx.fill();
    rr(ctx, x + 22, y + 64, (w0 - 44) * 0.6, 12, 6); ctx.fill();
    ctx.restore();
    const ck = eOut(win(u, 3.25, 3.7));
    if (ck > 0) {
      ctx.save();
      ctx.globalAlpha = a4;
      ctx.strokeStyle = C.red; ctx.lineWidth = 7; ctx.lineCap = 'round';
      const cxm = x + w0 / 2, cym = y + h0 / 2, r = 62;
      ctx.beginPath();
      ctx.moveTo(cxm - r, cym - r); ctx.lineTo(cxm - r + 2 * r * ck, cym - r + 2 * r * ck);
      ctx.moveTo(cxm + r, cym - r); ctx.lineTo(cxm + r - 2 * r * ck, cym - r + 2 * r * ck);
      ctx.stroke();
      ctx.restore();
    }
    const ta = app(u, 3.4, 0.45);
    if (ta > 0.004) {
      T(ctx, '用聊天框搬结构化数据', x + w0 / 2, y + h0 + 46,
        { font: fS(23, '600'), color: C.red, align: 'center', alpha: ta });
      T(ctx, '—— 所有路里最慢的一条', x + w0 / 2, y + h0 + 82,
        { font: fS(23, '500'), color: C.dim, align: 'center', alpha: ta });
    }
  }

  // 左下角：Q版·坚定 小签
  const a5 = app(u, 1.5, 0.9);
  if (a5 > 0.004) {
    actor(ctx, {
      img: 'focus', x: 250, yb: 948, h: 300,
      alpha: a5 * 0.95, bob: bobY(t, 3.0, 4.0), glow: a5 * 0.55, glowColor: C.ds,
    });
  }
}

/* --------------------------------------------- 06 不服 (19.0 – 22.5)
   「我不自己说了算。」
   豆包官方图标自右边缘弹性弹入，气泡「你的设计，我挑了 7 个问题」；
   7 张纸飞向中央排成扇形，每张一个真实议题名。 */
function s6(ctx, t) {
  const A = 19.0, u = t - A;

  // 鲸鱼娘 Q版·坚定
  const a1 = app(u, 0.2, 0.8);
  if (a1 > 0.004) {
    actor(ctx, {
      img: 'focus', x: 372, yb: 930, h: 428,
      alpha: a1, bob: bobY(t, 3.6, 3.3), glow: a1 * 0.8, glowColor: C.ds,
    });
  }

  // 豆包图标：弹性入场
  const k2 = cl(win(u, 0.55, 1.25));
  let dbx = 1566, dby = 322;
  if (k2 > 0) {
    const x = lerp(2010, dbx, cl(eBack(k2)));
    actor(ctx, {
      img: 'doubao', x, yc: dby, h: 232,
      alpha: cl(k2 * 1.6), bob: bobY(t, 3.4, 3.0, 1.1), glow: k2 * 0.85, glowColor: C.db,
    });
    const a = app(u, 1.0, 0.5);
    if (a > 0.004) {
      const w0 = tw(ctx, '豆包', fM(23, '600')) + 40, h0 = 49;
      ctx.save(); ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(127,180,240,0.16)';
      rr(ctx, x - w0 / 2, dby + 128, w0, h0, h0 / 2); ctx.fill();
      ctx.strokeStyle = C.dbEdge; ctx.lineWidth = 1.6;
      rr(ctx, x - w0 / 2, dby + 128, w0, h0, h0 / 2); ctx.stroke();
      ctx.fillStyle = C.db; ctx.beginPath(); ctx.arc(x - w0 / 2 + 22, dby + 128 + h0 / 2, 4, 0, 7); ctx.fill();
      ctx.font = fM(23, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.db; ctx.fillText('豆包', x - w0 / 2 + 34, dby + 128 + h0 / 2 + 1);
      ctx.restore();
    }
  }

  // 气泡
  const a3 = app(u, 1.15, 0.55);
  if (a3 > 0.004) bubble(ctx, 1188, 512, '你的设计，我挑了 7 个问题', { alpha: a3, fs: 29 });

  // 7 张批评纸：扇形展开（议题名全部来自真实记录）
  const TOPICS = ['幂等', '版本化', '分片租约', '断点', '感知', '队列', '鉴权'];
  TOPICS.forEach((s, i) => {
    const k = eOut(cl(win(u, 1.3 + i * 0.075, 1.95 + i * 0.075)));
    if (k <= 0.004) return;
    const ang = -0.52 + i * 0.174;
    const x = 980 + Math.sin(ang) * 268, y = 762 - Math.cos(ang) * 268 * 0.42;
    slip(ctx, x, y, 176, 74, s, C.amber, {
      alpha: k, tilt: ang * 0.9, fs: 25, fill: 'rgba(40,32,14,0.94)',
    });
  });
}

/* --------------------------------------------- 07 交锋 (22.5 – 26.0)
   「5 条我认了，4 条我不认。不认的每一条，都附上了理由。」
   纸收拢重散成两簇：5 张飞向角色贴入（绿勾），4 张被推回（红章「理由」）；
   顶上两个计数牌。角色表情 坚定 → 开心。 */
function s7(ctx, t) {
  const A = 22.5, u = t - A;

  // 角色（换图：坚定 → 开心）
  const a1 = app(u, 0.1, 0.7);
  if (a1 > 0.004) {
    actorMood(ctx, {
      x: 336, yb: 936, h: 424, bob: bobY(t, 3.8, 3.3),
      glow: a1 * 0.85, glowColor: C.ds,
    }, 'focus', 'happy', cl(win(u, 1.5, 2.1)) * a1);
  }

  // 飞向角色的 5 张（绿）
  for (let i = 0; i < 5; i++) {
    const ts = 0.30 + i * 0.075;
    const k = eOut(cl(win(u, ts, ts + 0.85)));
    if (k <= 0.004) continue;
    const x0 = 980 + Math.sin(-0.52 + i * 0.24) * 134;
    const y0 = 700;
    const x1 = 512 + (i % 2) * 118 + 96, y1 = 372 + Math.floor(i / 2) * 104 + (i % 2) * 34;
    const x = lerp(x0, x1, k), y = lerp(y0, y1, k);
    slip(ctx, x, y, 150, 62, null, C.green, { alpha: cl(k * 1.3) * (1 - k * 0.3), tilt: -0.18 + i * 0.06 });
    const ck = eOut(cl(win(u, ts + 0.6, ts + 1.0)));
    if (ck > 0.01) {
      ctx.save();
      ctx.globalAlpha = ck * a1 * 0.95;
      ctx.strokeStyle = C.green; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 24, y + 2);
      ctx.lineTo(x + 24 + 12 * ck, y + 2 + 13 * ck);
      ctx.lineTo(x + 24 + 30 * ck, y + 2 - 20 * ck);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 被推回的 4 张（红 + 红章「理由」）
  for (let i = 0; i < 4; i++) {
    const ts = 0.42 + i * 0.075;
    const k = eOut(cl(win(u, ts, ts + 0.9)));
    if (k <= 0.004) continue;
    const x0 = 980, y0 = 700;
    const x1 = 1252 + (i % 2) * 116 + 88, y1 = 402 + Math.floor(i / 2) * 108;
    const x = lerp(x0, x1, k), y = lerp(y0, y1, k);
    slip(ctx, x, y, 150, 62, null, C.red, { alpha: cl(k * 1.3), tilt: 0.16 - i * 0.05 });
    const sk = eOut(cl(win(u, ts + 0.62, ts + 1.05)));
    if (sk > 0.01) {
      ctx.save();
      ctx.globalAlpha = sk * a1;
      ctx.translate(x + 8, y + 14); ctx.rotate(-0.22);
      ctx.scale(0.6 + 0.4 * sk, 0.6 + 0.4 * sk);
      ctx.fillStyle = 'rgba(' + hexToRgb(C.red) + ',0.20)';
      rr(ctx, -46, -19, 92, 38, 6); ctx.fill();
      ctx.strokeStyle = C.red; ctx.lineWidth = 2.2;
      rr(ctx, -46, -19, 92, 38, 6); ctx.stroke();
      ctx.font = fS(22, '700'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.red; ctx.fillText('理由', 0, 1);
      ctx.restore();
    }
  }

  // 顶部两个计数牌
  const a4 = app(u, 1.5, 0.6);
  if (a4 > 0.004) {
    const put = (x, label, n, color) => {
      const w0 = 268, h0 = 104;
      ctx.save();
      ctx.globalAlpha = a4;
      ctx.fillStyle = 'rgba(' + hexToRgb(color) + ',0.11)';
      rr(ctx, x, 156, w0, h0, 14); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      rr(ctx, x, 156, w0, h0, 14); ctx.stroke();
      ctx.restore();
      T(ctx, label, x + 26, 196, { font: fS(24, '600'), color: C.dim, alpha: a4 });
      T(ctx, String(n), x + w0 - 26, 236, { font: fM(58, '700'), color, align: 'right', alpha: a4 });
    };
    put(300, '采纳', 5, C.green);
    put(1180, '驳回', 4, C.red);
  }
}

/* --------------------------------------------- 08 危机 (26.0 – 29.5)
   「我写的报告，每个数字都标了出处。」
   报告吐在中间。豆包凑近，放大镜横扫 —— 两处亮起血红高亮。
   检索框逐字打出这两处，结果每次都是「0 条结果」红闪。 */
function s8(ctx, t) {
  const A = 26.0, u = t - A;
  const rx = 452, ry = 226, rw = 560, rh = 566;

  const a1 = app(u, 0.15, 0.8);
  if (a1 > 0.004) {
    panel(ctx, rx, ry, rw, rh, { alpha: a1, fill: 'rgba(14,18,40,0.94)' });
    T(ctx, 'REPORT', rx + 34, ry + 62, { font: fM(26, '700'), color: C.dsSoft, alpha: a1, ls: 2 });
    T(ctx, '· audit', rx + 34 + tw(ctx, 'REPORT', fM(26, '700'), 2), ry + 62,
      { font: fM(26, '500'), color: C.faint, alpha: a1 });
    ctx.save();
    ctx.globalAlpha = a1 * 0.6;
    ctx.strokeStyle = C.edge; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(rx + 34, ry + 92); ctx.lineTo(rx + rw - 34, ry + 92); ctx.stroke();
    ctx.restore();

    const ROWS = [
      ['trace', 'apr_9399f6', true],
      ['bytes', '929', true],
      ['status', 'PASS', false],
    ];
    ROWS.forEach((r, i) => {
      const y = ry + 168 + i * 92;
      const ra = app(u, 0.5 + i * 0.16, 0.5) * a1;
      if (ra <= 0.004) return;
      const hi = r[2] ? eOut(cl(win(u, 1.62 + i * 0.22, 2.02 + i * 0.22))) : 0;
      if (hi > 0.01) {
        ctx.save();
        ctx.globalAlpha = hi * a1 * (0.62 + 0.38 * Math.abs(Math.sin(u * 4.2 + i)));
        ctx.fillStyle = 'rgba(' + hexToRgb(C.red) + ',0.22)';
        rr(ctx, rx + 26, y - 40, rw - 52, 62, 8); ctx.fill();
        ctx.strokeStyle = C.red; ctx.lineWidth = 2;
        rr(ctx, rx + 26, y - 40, rw - 52, 62, 8); ctx.stroke();
        ctx.restore();
      }
      T(ctx, r[0], rx + 46, y, { font: fM(25, '500'), color: C.faint, alpha: ra });
      T(ctx, r[1], rx + 232, y, { font: fM(28, '600'), color: hi > 0.3 ? C.red : C.fg, alpha: ra });
    });
  }

  // 豆包凑近 + 放大镜横扫
  const k2 = eOut(cl(win(u, 0.72, 1.42)));
  if (k2 > 0) {
    actor(ctx, {
      img: 'doubao', x: 1216, yc: 348, h: 190,
      alpha: cl(k2 * 1.5), bob: bobY(t, 3.2, 2.6, 0.7), glow: k2 * 0.7, glowColor: C.db,
    });
    const su = win(u, 1.05, 1.95);
    if (su > 0 && su < 1) {
      const mx = lerp(rx - 20, rx + rw + 20, su), my = lerp(ry + 60, ry + rh - 40, su * 0.7 + 0.15);
      ctx.save();
      ctx.globalAlpha = cl(Math.sin(su * Math.PI) * 2.2) * 0.9;
      ctx.strokeStyle = C.db; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(mx, my, 42, 0, 7); ctx.stroke();
      ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(mx + 30, my + 30); ctx.lineTo(mx + 62, my + 62); ctx.stroke();
      ctx.restore();
    }
  }

  // 检索框
  const a3 = app(u, 1.9, 0.55);
  if (a3 > 0.004) {
    const qx = 1104, qy = 486, qw = 700, qh = 268;
    panel(ctx, qx, qy, qw, qh, { alpha: a3, fill: 'rgba(10,14,32,0.94)' });
    T(ctx, '检索全部材料', qx + 30, qy + 50, { font: fS(24, '600'), color: C.dim, alpha: a3 });
    const Q = ['apr_9399f6', 'bytes: 929'];
    Q.forEach((s, i) => {
      const y = qy + 118 + i * 76;
      const kk = cl(win(u, 2.2 + i * 0.55, 2.9 + i * 0.55));
      if (kk <= 0) return;
      ctx.save(); ctx.globalAlpha = a3 * 0.8;
      ctx.fillStyle = 'rgba(22,30,60,0.9)';
      rr(ctx, qx + 28, y - 30, 330, 52, 8); ctx.fill();
      ctx.restore();
      const shown = s.slice(0, Math.round(s.length * cl(kk / 0.62)));
      T(ctx, shown, qx + 46, y + 6, { font: fM(26, '600'), color: C.fg, alpha: a3 });
      const ra = cl(win(u, 2.55 + i * 0.55, 2.95 + i * 0.55));
      if (ra > 0) {
        const fl = 0.72 + 0.28 * Math.abs(Math.sin(u * 7 + i));
        T(ctx, '0 条结果', qx + qw - 34, y + 6,
          { font: fM(27, '700'), color: C.red, align: 'right', alpha: a3 * ra * fl });
      }
    });
  }

  // 角色表情：坚定 → 困倦
  const a4 = app(u, 0.3, 0.8);
  if (a4 > 0.004) {
    actorMood(ctx, {
      x: 250, yb: 962, h: 318, bob: bobY(t, 2.8, 4.2),
      glow: a4 * 0.5, glowColor: C.ds,
    }, 'focus', 'tired', cl(win(u, 2.6, 3.2)) * a4);
  }
}

/* --------------------------------------------- 09 立住 (29.5 – 33.7, 4.2s)
   「查不出来源的数字，就是编的。」
   七拍：静止低头 → 撕纸 → 极暗 → 护栏落下 → 三条判据打勾 → 6/6 PASS → 互审台词。
   ⚠ 这一镜原本只有 3.5s，实测 6/6 PASS 要到 3.77s 才出、末句整段被切；
     从 S10 借 0.7s，并把判据的错帧从 0.30s 压到 0.32s→0.32s 起步更早。 */
function s9(ctx, t) {
  const A = 29.5, u = t - A;

  // ---- 报告：静止（低头下压）→ 撕开滑出
  const shake = u < 0.55 ? 6 * eOut(cl(u / 0.55)) : 0;
  if (u < 1.15) {
    const rx = 700, ry = 200, rw = 520;
    panel(ctx, rx, ry + shake, rw, 520, { alpha: 1, fill: 'rgba(14,18,40,0.94)' });
    T(ctx, 'REPORT', rx + 32, ry + 60 + shake, { font: fM(25, '700'), color: C.dsSoft, ls: 2 });
    T(ctx, 'trace  apr_9399f6', rx + 50, ry + 178 + shake, { font: fM(27, '600'), color: C.red });
    T(ctx, 'bytes  929', rx + 50, ry + 254 + shake, { font: fM(27, '600'), color: C.red });
    T(ctx, 'status PASS', rx + 50, ry + 330 + shake, { font: fM(27, '500'), color: C.faint });
  }
  const tear = win(u, 0.55, 1.15);
  if (tear > 0) {
    const k = eIn(tear);
    [[-1, -0.06, 'apr_9399f6'], [1, 0.06, 'bytes  929']].forEach(([sgn, rot, label]) => {
      ctx.save();
      ctx.globalAlpha = cl(1 - win(u, 0.98, 1.32));
      ctx.translate(960 + sgn * (60 + k * 620), 460 + k * 26);
      ctx.rotate(rot * k);
      ctx.fillStyle = 'rgba(18,22,46,0.96)';
      rr(ctx, -258, -64, 516, 128, 8); ctx.fill();
      ctx.strokeStyle = C.red; ctx.lineWidth = 1.8;
      rr(ctx, -258, -64, 516, 128, 8); ctx.stroke();
      ctx.font = fM(27, '600'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.red; ctx.fillText(label, 0, 1);
      ctx.restore();
    });
  }

  // 极暗 0.2s（同样留 18% 的底，见 s4 的说明）
  const dark = 0.82 * cl(win(u, 1.16, 1.32)) * cl(1 - win(u, 1.38, 1.58));
  if (dark > 0.001) {
    ctx.save(); ctx.globalAlpha = dark; ctx.fillStyle = C.ink;
    ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  // ---- 护栏面板：自上落下
  const k2 = eOut(cl(win(u, 1.36, 1.94)));
  if (k2 > 0) {
    const px = 452, py = 168 + (1 - k2) * -190, pw = 1016, ph = 512;
    ctx.save();
    ctx.globalAlpha = cl(k2 * 1.4);
    panel(ctx, px, py, pw, ph, { fill: 'rgba(10,26,30,0.94)', edgeColor: 'rgba(52,211,153,0.42)', lw: 2 });
    ctx.fillStyle = 'rgba(52,211,153,0.14)';
    rr(ctx, px, py, pw, 62, 12); ctx.fill();
    rr(ctx, px, py, pw, 62, 12); ctx.fill();
    ctx.fillRect(px, py + 46, pw, 16);
    ctx.font = fM(27, '700'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.green;
    ctx.fillText('verify-citation', px + 34, py + 32);
    ctx.font = fS(22, '500'); ctx.fillStyle = C.dim;
    ctx.fillText('· 一道引用核验', px + 34 + tw(ctx, 'verify-citation', fM(27, '700')) + 20, py + 32);
    ctx.restore();

    const CHK = ['每个数字都有来源', '来源可以被独立检索到', '搜不到 —— 不许进报告'];
    CHK.forEach((s, i) => {
      const y = py + 142 + i * 92;
      const ca = app(u, 1.86 + i * 0.32, 0.45);
      if (ca <= 0.004) return;
      ctx.save();
      ctx.globalAlpha = ca;
      ctx.fillStyle = 'rgba(52,211,153,0.09)';
      rr(ctx, px + 34, y - 34, pw - 68, 70, 10); ctx.fill();
      ctx.restore();
      const gk = eOut(cl(win(u, 2.04 + i * 0.32, 2.42 + i * 0.32)));
      if (gk > 0.01) {
        ctx.save();
        ctx.globalAlpha = ca;
        ctx.strokeStyle = C.green; ctx.lineWidth = 5.5; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px + 66, y);
        ctx.lineTo(px + 66 + 13 * gk, y + 14 * gk);
        ctx.lineTo(px + 66 + 33 * gk, y - 20 * gk);
        ctx.stroke();
        ctx.restore();
      }
      T(ctx, s, px + 128, y + 10, { font: fS(28, '600'), color: C.fg, alpha: ca });
    });

    const la = app(u, 3.12, 0.40);
    if (la > 0.004) {
      const by = py + ph - 62, wtxt = tw(ctx, '6/6 PASS', fM(38, '700'));
      T(ctx, '6/6 PASS', px + 34, by, { font: fM(38, '700'), color: C.green, alpha: la });
      ctx.save();
      ctx.globalAlpha = la * 0.35;
      ctx.fillStyle = C.green;
      ctx.beginPath(); ctx.arc(px + 34 + wtxt + 34, by - 13, 4, 0, 7); ctx.fill();
      ctx.restore();
      T(ctx, '1 RECORD', px + 34 + wtxt + 62, by, { font: fM(38, '700'), color: C.dim, alpha: la });
    }
  }

  // 角色：困倦 → 坚定
  const a4 = app(u, 0.1, 0.6);
  if (a4 > 0.004) {
    actorMood(ctx, {
      x: 250, yb: 962, h: 316, bob: bobY(t, 2.6, 4.2),
      glow: a4 * 0.6, glowColor: C.ds,
    }, 'tired', 'focus', cl(win(u, 2.62, 3.02)) * a4);
  }

  // 豆包：我错了。
  const a5 = app(u, 2.98, 0.45);
  if (a5 > 0.004) {
    actor(ctx, {
      img: 'doubao', x: 1730, yc: 300, h: 152,
      alpha: a5 * 0.98, bob: bobY(t, 3.0, 2.8, 2.2), glow: a5 * 0.5, glowColor: C.db,
    });
    bubble(ctx, 1600, 528, '我错了。', { alpha: a5, fs: 28 });
  }

  // 鲸鱼娘的回话：终端行
  const a6 = app(u, 3.28, 0.45);
  if (a6 > 0.004) {
    termline(ctx, 334, 800, '我做的东西，自己也得先立得住。', {
      alpha: a6, fs: 27, type: cl(win(u, 3.33, 4.00)), caret: u,
    });
  }
}

/* --------------------------------------------- 10 结果 (33.0 – 37.5)
   「那最后省下来的，是什么？」
   两条 1 分钟一格的时间条并排：
     逐段确认 25 格（碎，3 处打断）←→ 攒批确认 19 格（整，1 处打断）
   碎与整的对比一眼就懂，不需要额外解释。 */
function s10(ctx, t) {
  const A = 33.7, u = t - A;
  const bx = 592, unit = 40, gw = 36, bh = 84;

  const track = (y, mins, color, label, marks, delay, digits) => {
    const k = eOut(cl(win(u, delay, delay + 0.95)));
    if (k <= 0.004) return;
    T(ctx, label, bx, y - 26, { font: fS(30, '700'), color: C.fg, alpha: k });
    // 轨道
    ctx.save();
    ctx.globalAlpha = k * 0.45;
    ctx.fillStyle = 'rgba(22,28,56,0.9)';
    rr(ctx, bx, y, mins * unit - (unit - gw), bh, 10); ctx.fill();
    ctx.restore();
    // 逐格点亮
    for (let i = 0; i < mins; i++) {
      const ik = cl((k - i / mins) * mins * 2.2);
      if (ik <= 0.01) continue;
      const x = bx + i * unit;
      ctx.save();
      ctx.globalAlpha = ik;
      const g = ctx.createLinearGradient(x, y, x, y + bh);
      g.addColorStop(0, 'rgba(' + hexToRgb(color) + ',0.52)');
      g.addColorStop(1, 'rgba(' + hexToRgb(color) + ',0.86)');
      ctx.fillStyle = g;
      rr(ctx, x, y, gw, bh, 6); ctx.fill();
      ctx.restore();
    }
    // 打断标记
    marks.forEach((mk, i) => {
      const mkA = eOut(cl(win(u, delay + 1.05 + i * 0.22, delay + 1.4 + i * 0.22)));
      if (mkA <= 0.01) return;
      const x = bx + (mk * mins) * unit + gw / 2;
      const drop = (1 - mkA) * 40;
      ctx.save();
      ctx.globalAlpha = mkA;
      ctx.fillStyle = C.red;
      ctx.beginPath(); ctx.arc(x, y + bh + 34 + drop, 9, 0, 7); ctx.fill();
      ctx.strokeStyle = C.red; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(x, y + bh + 8); ctx.lineTo(x, y + bh + 24 + drop); ctx.stroke();
      ctx.restore();
    });
    // 末尾数字
    const da = app(u, delay + 0.85, 0.5);
    if (da > 0.004) {
      T(ctx, digits, bx + mins * unit + 24, y + bh - 12, {
        font: fM(52, '700'), color, alpha: da,
      });
    }
    const ma = app(u, delay + 1.3, 0.5);
    if (ma > 0.004) {
      T(ctx, marks.length + ' 次被打断', bx + 4, y + bh + 96, {
        font: fS(24, '600'), color: C.red, alpha: ma,
      });
    }
  };

  track(486, 25, C.red, '逐段确认', [0.18, 0.54, 0.86], 0.10, '25:00');
  track(742, 19, C.green, '攒批确认', [0.46], 0.45, '19:00');

  // 两条之间的对比标注
  const a3 = app(u, 2.75, 0.5);
  if (a3 > 0.004) {
    const y = 628;
    ctx.save();
    ctx.globalAlpha = a3 * 0.45;
    ctx.strokeStyle = C.dim; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(300, y); ctx.lineTo(400, y); ctx.stroke();
    ctx.restore();
    T(ctx, '省下 6 分钟 · 少打扰 2 次', W / 2, y + 8, {
      font: fS(30, '700'), color: C.fg, align: 'center', alpha: a3,
    });
  }
}

/* --------------------------------------------- 11 盲区 (37.7 – 41.0, 3.3s)
   「有些 bug，人点一辈子也点不出来。」
   一张请求卡片 + 一条流动的虚线把"落点"指出来：先落 HTML（红）→ 改判 JSON（绿）。
   ⚠ 原版让卡片缩到 0.40 飞过去 —— 实测 30px 的字变成 12px，等于不可读。
     改成卡片原地不动、用连线指路。 */
function s11(ctx, t) {
  const A = 37.7, u = t - A;

  const k0 = app(u, 0.10, 0.6);
  const drop = (1 - eOut(cl(win(u, 0.10, 0.70)))) * -70;
  const cx = 960, cy = 318 + drop;
  const cw = 760, chh = 240;

  const toHTML = cl(win(u, 1.25, 1.70)) * (1 - cl(win(u, 2.05, 2.28)));
  const toJSON = cl(win(u, 2.28, 2.75));

  // 两个分支
  [['HTML', 552, C.red, toHTML], ['JSON', 1068, C.green, toJSON]].forEach(([label, x, color, hot]) => {
    const ba = app(u, 1.00, 0.45);
    if (ba <= 0.004) return;
    const on = hot > 0.05;
    ctx.save();
    ctx.globalAlpha = ba * (on ? 1 : 0.42);
    ctx.translate(x + 120, 782); ctx.scale(1 + 0.06 * hot, 1 + 0.06 * hot); ctx.translate(-(x + 120), -782);
    ctx.fillStyle = 'rgba(' + hexToRgb(color) + ',' + (on ? '0.20' : '0.06') + ')';
    rr(ctx, x, 720, 240, 124, 14); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = on ? 3 : 1.6;
    rr(ctx, x, 720, 240, 124, 14); ctx.stroke();
    ctx.restore();
    T(ctx, label, x + 120, 796, {
      font: fM(40, '700'), color, align: 'center', alpha: ba * (on ? 1 : 0.5),
    });
  });

  // 路由连线：流动虚线 + 箭头
  const link = (x2, color, k) => {
    if (k <= 0.01) return;
    const y1 = cy + chh / 2 + 8, y2 = 706;
    ctx.save();
    ctx.globalAlpha = k * 0.9;
    ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.setLineDash([16, 14]);
    ctx.lineDashOffset = -u * 170;
    ctx.beginPath();
    ctx.moveTo(cx, y1);
    ctx.quadraticCurveTo(cx, y1 + 130, x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2 + 4); ctx.lineTo(x2 - 15, y2 - 26); ctx.lineTo(x2 + 15, y2 - 26);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  link(672, C.red, toHTML);
  link(1188, C.green, toJSON);

  // 卡片（保持原尺寸）
  if (k0 > 0.004) {
    ctx.save();
    ctx.globalAlpha = k0;
    ctx.translate(cx, cy);
    const flash = Math.max(toHTML > 0.5 ? 1 - cl(win(u, 2.05, 2.28)) : 0,
      toJSON > 0.5 ? 1 - cl(win(u, 2.75, 2.95)) : 0);
    ctx.fillStyle = 'rgba(14,18,40,0.96)';
    rr(ctx, -cw / 2, -chh / 2, cw, chh, 16); ctx.fill();
    ctx.strokeStyle = flash > 0.1 ? (toJSON > 0.5 ? C.green : C.red) : C.edge;
    ctx.lineWidth = 2 + flash * 5;
    rr(ctx, -cw / 2, -chh / 2, cw, chh, 16); ctx.stroke();
    ctx.font = fM(30, '500'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = C.dim; ctx.fillText('GET /data HTTP/1.1', -cw / 2 + 44, -46);
    const hl = eOut(cl(win(u, 0.62, 1.15)));
    ctx.fillStyle = C.fg; ctx.fillText('Accept:', -cw / 2 + 44, 44);
    const ax = -cw / 2 + 44 + tw(ctx, 'Accept: ', fM(30, '500'));
    if (hl > 0.01) {
      ctx.fillStyle = 'rgba(' + hexToRgb(C.amber) + ',' + (0.24 * hl).toFixed(3) + ')';
      rr(ctx, ax - 12, 18, 132, 54, 8); ctx.fill();
      ctx.strokeStyle = C.amber; ctx.lineWidth = 2;
      rr(ctx, ax - 12, 18, 132, 54, 8); ctx.stroke();
    }
    ctx.fillStyle = hl > 0.5 ? C.amber : C.fg;
    ctx.font = fM(34, '700');
    ctx.fillText('*/*', ax, 46);
    ctx.restore();
  }

  // 小字
  const a4 = app(u, 0.68, 0.45);
  if (a4 > 0.004) {
    T(ctx, '这恰好是几乎所有 AI 客户端的默认值', 960, 640, {
      font: fS(25, '500'), color: C.dim, align: 'center', alpha: a4,
    });
  }
  const a5 = app(u, 2.85, 0.40);
  if (a5 > 0.004) {
    T(ctx, '人不会发 */* —— 可 AI 的客户端默认就发它', 960, 900, {
      font: fS(27, '600'), color: C.fg, align: 'center', alpha: a5,
    });
  }
}

/* --------------------------------------------- 12 命题 (41.0 – 45.0)
   「好工具，让约束变得不必要。」
   两张全身立绘并排、**同频呼吸**，中缝叠一枚豆包图标；
   背景抬到全片最亮并打一束顶光 —— 仍在深色域，不转浅色。 */
function s12(ctx, t) {
  const A = 41.0, u = t - A;

  // 顶光（全片最亮的一刻）
  const ka = eOut(win(u, 0.0, 2.6));
  const g = ctx.createRadialGradient(W / 2, -180, 0, W / 2, 180, 1180);
  g.addColorStop(0, 'rgba(140,175,255,' + (0.20 + 0.22 * ka).toFixed(3) + ')');
  g.addColorStop(0.45, 'rgba(80,120,220,' + (0.06 + 0.08 * ka).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.globalAlpha = cl(ka * 1.4); ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H); ctx.restore();

  // 两张全身立绘：同一相位 = 同频呼吸
  // 高度 742→636：原尺寸下角色头顶(y≈170)会顶进命题文字的位置，实测重叠。
  const ph = 3.1, per = 3.6;
  const a1 = app(u, 0.35, 1.0);
  if (a1 > 0.004) {
    const bb = bobY(t, 5.0, per, ph);
    actor(ctx, {
      img: 'fullA', x: 612, yb: 934, h: 636, alpha: a1, bob: bb,
      glow: a1 * 0.9, glowColor: C.ds,
    });
    actor(ctx, {
      img: 'fullB', x: 1308, yb: 934, h: 636, alpha: a1, bob: bb,
      glow: a1 * 0.9, glowColor: C.ds,
    });
  }

  // 中缝：豆包图标
  const a2 = app(u, 1.5, 0.8);
  if (a2 > 0.004) {
    actor(ctx, {
      img: 'doubao', x: 960, yc: 800, h: 152,
      alpha: a2, bob: bobY(t, 4.2, per, ph), glow: a2 * 0.95, glowColor: C.db,
    });
  }

  // 命题
  const a3 = app(u, 0.9, 0.7);
  if (a3 > 0.004) {
    const y = 190;
    T(ctx, '好工具，让约束变得不必要。', W / 2, y, {
      font: fS(56, '800'), color: C.fg, align: 'center', alpha: a3, ls: 1,
    });
    const a4 = app(u, 1.5, 0.7);
    if (a4 > 0.004) {
      T(ctx, '而不是让约束变得更多', W / 2, y + 68, {
        font: fS(33, '500'), color: C.dsSoft, align: 'center', alpha: a4 * 0.95,
      });
    }
  }

  // 左下角：成果印章 + 署名（署名是 CC BY-NC-SA 的义务，不是可选项）
  const a5 = app(u, 2.4, 0.7);
  if (a5 > 0.004) {
    T(ctx, '11 套 · 487 断言 · 0 失败', 96, 996,
      { font: fM(20, '500'), color: C.faint, alpha: a5 * 0.9 });
    T(ctx, '鲸鱼娘形象 © 上善 / ZipZipPipe · CC BY-NC-SA 4.0', 96, 1028,
      { font: fS(18, '400'), color: C.faint, alpha: a5 * 0.72 });
  }
}

/* ============================================================================
   字幕 & 主循环
   ========================================================================= */

/* 字幕全文 24 行。副行刻意用"人的体感"措辞（分钟 / 被打断几次），
   而不是端点 / 断言 / token —— 那些是上一部"人类看不懂"的病根。 */
const SUBS = {
  s1:  ['我干活的样子，你其实没见过。', '—— 一个 AI 的自白'],
  s2:  ['一件事做完，我得停下来问你一次。', '25 分钟里，你被打断了 3 次'],
  s3:  ['我不缺智力。我缺的是一件趁手的工具。', '用聊天框搬结构化数据 —— 那是所有路里最慢的一条'],
  s4:  ['然后你问了我一句。', '「做一个 AI 用的网页 —— 你作为 AI，会想要什么功能？」'],
  s5:  ['它的一号用户不是人，是我。', '最该省掉的，恰恰是那个聊天框'],
  s6:  ['我不自己说了算。', '我叫豆包来审我 —— 它挑了 7 个问题'],
  s7:  ['5 条我认了，4 条我不认。', '不认的每一条，都附上了理由'],
  s8:  ['我写的报告，每个数字都标了出处。', '豆包查了两处 —— 全部材料里，一处都搜不到'],
  s9:  ['查不出来源的数字，就是编的。', '我把报告撕了，从头做了一遍'],
  s10: ['那最后省下来的，是什么？', '25 分钟 → 19 分钟；被打断 3 次 → 只打扰你 1 次'],
  s11: ['有些 bug，人点一辈子也点不出来。', '人不会发 */*，可 AI 的客户端默认就发它'],
  s12: ['好工具，让约束变得不必要。', '而不是让约束变得更多'],
};

/** 底部字幕：主行 + 副行。每镜前 0.35s 不出现（先给画面，再给字）。 */
function subs(ctx, t, id) {
  const s = SUBS[id];
  if (!s) return;
  const a = app(t, 0.35, 0.5);
  if (a <= 0.01) return;
  const cx = W / 2;
  const f1 = fS(42, '700');
  const w1 = tw(ctx, s[0], f1);
  ctx.save();
  ctx.globalAlpha = a * 0.5;
  ctx.fillStyle = 'rgba(6,9,22,0.74)';
  rr(ctx, cx - w1 / 2 - 30, 964, w1 + 60, 54, 10); ctx.fill();
  ctx.restore();
  T(ctx, s[0], cx, 1002, { font: f1, color: C.fg, align: 'center', alpha: a });
  if (s[1]) T(ctx, s[1], cx, 1048, { font: fM(24), color: C.dim, align: 'center', alpha: a * 0.95 });
}

/* 时长分配说明（用户把片长交给我定，45.0s 不变，但镜内预算要重排）：
   S09 原本 3.5s 装不下「静止→撕纸→极暗→护栏落下→3 条判据打勾→6/6 PASS→互审台词」
   共 7 拍，实测 6/6 PASS 要到 3.77s 才出、末句终端行整段被切 —— 从 S10 借 0.7s 补上。
   S10 的"25 格 vs 19 格"对比只需展示，压缩到 4.0s 足够；S11 的卡片飞行重新压到 3.3s。 */
const CHAPTERS = [
  { id: 's1',  a: 0.0,  b: 4.0,  dot: C.ds,     draw: s1  },   // 自白
  { id: 's2',  a: 4.0,  b: 8.0,  dot: C.red,    draw: s2  },   // 痛点
  { id: 's3',  a: 8.0,  b: 11.5, dot: C.slate,  draw: s3  },   // 处境
  { id: 's4',  a: 11.5, b: 15.0, dot: C.violet, draw: s4  },   // 初心
  { id: 's5',  a: 15.0, b: 19.0, dot: C.teal,   draw: s5  },   // 答案
  { id: 's6',  a: 19.0, b: 22.5, dot: C.amber,  draw: s6  },   // 不服
  { id: 's7',  a: 22.5, b: 26.0, dot: C.green,  draw: s7  },   // 交锋
  { id: 's8',  a: 26.0, b: 29.5, dot: C.red,    draw: s8  },   // 危机
  { id: 's9',  a: 29.5, b: 33.7, dot: C.green,  draw: s9  },   // 立住（4.2s）
  { id: 's10', a: 33.7, b: 37.7, dot: C.teal,   draw: s10 },   // 结果（4.0s）
  { id: 's11', a: 37.7, b: 41.0, dot: C.amber,  draw: s11 },   // 盲区（3.3s）
  { id: 's12', a: 41.0, b: 45.0, dot: C.fg,     draw: s12 },   // 命题
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
    _tmpCtx.globalAlpha = 1;    // ← 必须显式归 1：各章内部大量 ctx.globalAlpha = a（绝对赋值）
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

window.SCENE = { draw, DUR, CHAPTERS, W, H, whenReady: () => READY };
})();
