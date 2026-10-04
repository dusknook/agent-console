/* ============================================================================
   短片 · 《一个 AI 的自白》 v2  60.0s / 十五镜 / 1920×1080 @30fps
   ----------------------------------------------------------------------------
   v1（45.0s / 12 镜）的成片在根目录 `AI的自白_45s.mp4`，源码归档 `scene-part3-45s.js`。

   🔴 v2 为什么加长：用户看完 v1 的反馈 ——
      「信息量太少了，观众可能会没耐心看下去，增加一些对观众有用的信息，
        比如说这个网站可以解决 AI 上下文过长或者减少 token 使用量这类的信息，
        还有可以丰富一下动效」

   于是 v2 是本片第一次**把技术指标翻译回观众能用的收益**，加了三章硬信息：
     · ctx  上下文入场费 —— 契约全文 48697 B ≈ 12175 tokens，agent 开工前先付掉
     · idx  索引替说明书 —— GET /v1/health 690 tokens → 29 条路由，2 次往返冷启动
     · bill 实测账单     —— 19 往返 / 24510 tokens / 1290 每往返 / 0 次卡住
   （全部出自 `.agent-trial.txt` 的机器生成输出，溯源表在剧本 §7）

   ⚠ v1 的叙事纪律是「token 数一律不进本片」，v2 **推翻该条**：
     不是"数字不能进"，是"没有出处的数字不能进，没翻译成人话的数字不能进"。
     三个新章的每个数字都配了"这对你意味着什么"的一句人话。

   四处结构性设定（v1 沿用）：
     1) 角色层 —— 网络真实素材位图。能动只剩 5 种：
        ① 呼吸 bob  ② 换图交叉淡化  ③ 淡入上浮  ④ 说话推拉  ⑤ 背后光晕。
        🔴 换图必须交叉淡化 —— 直接替换会让 alpha 从 1 跳到 0 闪断，
           与「章节硬切露一帧纯背景」是同一个病（skill §64），只是换了一层。
     2) 背景 —— 全片只有一件事：**单向变亮**。从最深的海底一路抬到有光。
        深色片亮度口径照 skill §62（抬暗部，不调阈值）。
     3) 动效语法（v2 加强）—— 数字一律**滚动到位**（odometer），条一律**生长 + 扫光**，
        元素一律**错帧入场**，对比一律**对向生长**。见 §「动效原语」。
     4) 时长 —— 用户把片长交给我定：v1 45.0s → v2 60.0s。
        旧 12 章一秒没砍，只是挪位；收尾章 ±0 给足呼吸。

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
   动效原语（v2 新增）
   ----------------------------------------------------------------------------
   用户要「丰富一下动效」。但动效多 ≠ 好看 —— 堆多了就是视觉噪音。
   所以不逐处手写，而是抽出 6 个**可复用**的原语，让全片动效语言统一：

     odo()    滚动数字（odometer）—— 所有数字都"滚"到位，不硬切出现
     bar()    生长条 + 头部扫光 —— 所有占比/长度都"长"出来
     scan()   扫描线 —— 表达"正在核对 / 正在读"
     ring()   扩散环 —— 表达"命中 / 落点"
     dash()   流动虚线 —— 指路（比缩放一个元素去指路可读得多，见 s11）
     streak() 底部数据流光带 —— 全片底噪级的"机器一直在跑"

   ⚠ 亮度纪律：这些原语全部是**低 alpha 的叠加**，不新增浅色面。
     深色片里加动效最容易犯的错是"越加越亮"，导致分章亮度带失衡（skill §62）。
   ========================================================================= */

/** 千分位（不依赖 toLocaleString —— 那个输出随环境变） */
const grp = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * odo —— 滚动数字。k: 0→1 的滚动进度。
 * 滚动中的"残影"用上下两层低 alpha 副本模拟纵向运动模糊 —— 这是数字能
 * "滚"起来而不是"跳"过来的关键；k 到 1 时残影自然归零。
 */
function odo(ctx, x, y, target, o = {}) {
  const k = eOut5(cl(o.k == null ? 1 : o.k));
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.004) return 0;
  const fs = o.fs || 72, font = o.font || fM(fs, '800');
  const txt = (o.raw ? String(Math.round(target * k)) : grp(target * k)) + (o.suffix || '');
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = font; ctx.textAlign = o.align || 'center'; ctx.textBaseline = o.base || 'alphabetic';
  const col = o.color || C.fg;
  const blur = (1 - k) * Math.min(1, k * 5) * fs * 0.17;
  if (blur > 0.8) {
    ctx.fillStyle = col; ctx.globalAlpha = a * 0.20;
    ctx.fillText(txt, x, y - blur);
    ctx.fillText(txt, x, y + blur);
    ctx.globalAlpha = a;
  }
  ctx.fillStyle = col;
  ctx.fillText(txt, x, y);
  ctx.restore();
  return tw(ctx, txt, font);
}

/**
 * bar —— 生长条。k: 0→1。
 * 头部有一道扫光（`head`），会让"生长"这件事读起来有方向感。
 */
function bar(ctx, x, y, w, h, k, color, o = {}) {
  k = cl(k);
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.004) return;
  const r = o.r == null ? Math.min(h / 2, 10) : o.r;
  ctx.save();
  ctx.globalAlpha = a;
  if (o.track !== false) {
    ctx.fillStyle = o.trackColor || 'rgba(22,28,56,0.82)';
    rr(ctx, x, y, w, h, r); ctx.fill();
    if (o.trackEdge !== false) {
      ctx.strokeStyle = 'rgba(120,140,190,0.22)'; ctx.lineWidth = 1.2;
      rr(ctx, x, y, w, h, r); ctx.stroke();
    }
  }
  if (k > 0.001) {
    const ww = o.min ? Math.max(o.min, w * k) : w * k;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, 'rgba(' + hexToRgb(color) + ',' + (o.a0 == null ? 0.52 : o.a0) + ')');
    g.addColorStop(1, 'rgba(' + hexToRgb(color) + ',' + (o.a1 == null ? 0.95 : o.a1) + ')');
    ctx.fillStyle = g;
    rr(ctx, x, y, ww, h, r); ctx.fill();
    if (o.ticks) {                                // 十分位刻度
      ctx.save();
      ctx.globalAlpha = a * 0.5;
      ctx.strokeStyle = 'rgba(8,12,26,0.6)'; ctx.lineWidth = 2;
      for (let i = 1; i < o.ticks; i++) {
        const xx = x + ww * i / o.ticks;
        ctx.beginPath(); ctx.moveTo(xx, y + 7); ctx.lineTo(xx, y + h - 7); ctx.stroke();
      }
      ctx.restore();
    }
    if (o.head && ww > 6) {                       // 头部扫光
      const hg = ctx.createLinearGradient(x + ww - 46, 0, x + ww, 0);
      hg.addColorStop(0, 'rgba(255,255,255,0)');
      hg.addColorStop(1, 'rgba(255,255,255,' + (0.30 * o.head).toFixed(3) + ')');
      ctx.fillStyle = hg;
      rr(ctx, x, y, ww, h, r); ctx.fill();
    }
  }
  ctx.restore();
}

/** scan —— 竖向扫描线，k: 0→1 从左到右扫一遍 */
function scan(ctx, x, y, w, h, k, color, alpha = 0.5) {
  k = cl(k);
  if (k <= 0 || k >= 1) return;
  const sx = x + w * k;
  ctx.save();
  ctx.globalAlpha = cl(alpha) * Math.sin(k * Math.PI);
  const g = ctx.createLinearGradient(sx - 70, 0, sx + 70, 0);
  g.addColorStop(0, 'rgba(' + hexToRgb(color) + ',0)');
  g.addColorStop(0.5, 'rgba(' + hexToRgb(color) + ',0.55)');
  g.addColorStop(1, 'rgba(' + hexToRgb(color) + ',0)');
  ctx.fillStyle = g; ctx.fillRect(sx - 70, y, 140, h);
  ctx.fillStyle = 'rgba(' + hexToRgb(color) + ',0.85)';
  ctx.fillRect(sx - 1.2, y, 2.4, h);
  ctx.restore();
}

/** ring —— 扩散环，k: 0→1（命中 / 落点反馈） */
function ring(ctx, x, y, r0, r1, k, color, lw = 2.5, alpha = 0.7) {
  k = cl(k);
  if (k <= 0 || k >= 1) return;
  ctx.save();
  ctx.globalAlpha = (1 - k) * cl(alpha);
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.arc(x, y, lerp(r0, r1, eOut(k)), 0, 7); ctx.stroke();
  ctx.restore();
}

/** dash —— 流动虚线（指路用；比"缩小元素飞过去"可读得多） */
function dash(ctx, pts, color, o = {}) {
  const a = cl(o.alpha == null ? 1 : o.alpha);
  if (a <= 0.004) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = color; ctx.lineWidth = o.lw || 4; ctx.lineCap = 'round';
  ctx.setLineDash(o.dash || [16, 14]);
  ctx.lineDashOffset = -(o.off || 0);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 3) ctx.quadraticCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
  else for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** streak —— 底部数据流光带。全片底噪级的"机器一直在跑"，不抢主体。 */
function streak(ctx, t, k) {
  ctx.save();
  for (let i = 0; i < 7; i++) {
    const y = 828 + i * 34 + Math.sin(t * 0.5 + i * 1.3) * 5;
    const sp = 42 + rnd(i, 21.3) * 130;
    const w = 150 + rnd(i, 44.7) * 480;
    const x = ((t * sp + rnd(i, 63.1) * W * 2) % (W + w)) - w;
    const a = (0.05 + 0.09 * rnd(i, 88.9)) * (1 - i / 9) * cl(k);
    ctx.globalAlpha = a;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(120,160,255,0)');
    g.addColorStop(0.5, 'rgba(140,180,255,1)');
    g.addColorStop(1, 'rgba(120,160,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, 1.6);
  }
  ctx.restore();
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

  // 底部数据流光带（v2 新增）：全片底噪级的"机器一直在跑"
  streak(ctx, t, 0.55 + 0.45 * k);

  // 顶部章节刻度：当前章的点会"长出来 + 扫一道光"，章节推进因此有了动感
  const cw = 40, total = CHAPTERS.length * cw - 12, x0 = W / 2 - total / 2;
  CHAPTERS.forEach((c, i) => {
    const cur = t >= c.a && t < c.b;
    const seen = t >= c.b;
    const u = t - c.a;
    const grow = cur ? eOut5(cl(u / 0.45)) : 1;         // 当前章的点从 0 长到满
    const wcur = cur ? 28 : 22;
    ctx.save();
    ctx.globalAlpha = cur ? 1 : seen ? 0.42 : 0.16;
    ctx.fillStyle = cur ? c.dot : C.dim;
    rr(ctx, x0 + i * cw, 34, Math.max(1, wcur * grow), 4, 2); ctx.fill();
    ctx.restore();
    if (cur && u < 0.6) {                               // 章节开场的那一道扫光
      const sk = cl(u / 0.6);
      ctx.save();
      ctx.globalAlpha = (1 - sk) * 0.85;
      ctx.fillStyle = c.dot;
      rr(ctx, x0 + i * cw + 26 * grow, 34, 10, 4, 2); ctx.fill();
      ctx.globalAlpha = (1 - sk) * 0.30;
      rr(ctx, x0 + i * cw - 6, 34, 14, 4, 2); ctx.fill();
      ctx.restore();
    }
  });

  // 顶部整片进度发丝线（v2）：一条 1.5px 的线走完全片，观众知道自己在哪
  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.fillStyle = 'rgba(120,150,220,0.55)';
  ctx.fillRect(0, 0, W * k, 3);
  ctx.globalAlpha = 0.9 * Math.min(1, k * 12) * (k < 0.999 ? 1 : 0);
  ctx.fillStyle = 'rgba(180,205,255,0.95)';
  ctx.fillRect(W * k - 3, 0, 3, 3);
  ctx.restore();

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
  // ⚠ 入场时点被前移过一次：原来 u=0.25 起、淡入 1.0s，于是 t 0–0.27 只有背景仪器、
  //   主角区一片空 —— 开场头 8 帧是"空舞台"，观众第一秒看不到主体。现在 u=0.08 起、0.62s 淡入。
  const a1 = app(u, 0.08, 0.62);
  if (a1 > 0.004) {
    const sl = (1 - a1) * 26;
    actor(ctx, {
      img: 'fullB', x: 470 - sl, yb: 930 + sl, h: 800,
      alpha: a1, bob: bobY(t, 4.5, 3.6), glow: a1 * 0.9, glowColor: C.ds,
    });
  }

  // 工作终端（同步前移：原来 u=0.75，比角色晚了 0.5s，开场那半秒面板是空的）
  const a2 = app(u, 0.42, 0.70);
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

/* ============================================================================
   ★ v2 新增三章 —— 用户要的「对观众有用的信息」
   ----------------------------------------------------------------------------
   观众真正在乎的不是端点数和断言数，是**这跟我有什么关系**。
   这三章把技术指标翻译成两句话：「AI 干活要花多少上下文」「省在哪儿」。

   三个数字全部出自 `.agent-trial.txt`（机器生成，非手写）：
     48697 B ≈ 12175 tokens   —— 契约全文；若整份入上下文，这是"入场费"
     690 tokens / 29 条路由   —— GET /v1/health 的响应体与内容
     19 往返 / 24510 tokens / 1290 每往返 / 0 阻塞 —— 一整轮 20 项检查的真实开销
     403 vs 441 tokens        —— 单查一张审批单 vs 拉全表
   ========================================================================= */

/* 条长尺度：12175 tokens → 1200px。**sCtx 与 sIdx 共用同一个尺度** ——
   两章要能直接比长度，各用各的尺度就等于骗人。 */
const TOK_FULL = 12175;
const TOK_PX = 1200 / TOK_FULL;

/* --------------------------------------------- 03 ★上下文入场费 (8.0 – 12.5, 4.5s)
   「AI 的上下文，是一笔预算。」
   一摞说明书纸飞入堆叠 → 被吸进上下文条 → 条长到 1200px、数字滚到 12,175。
   条右端立一条虚线：「还没开工，先花掉」。
   角色：Q版·困倦，抱着一摞纸，随着纸越堆越低头。 */
function sCtx(ctx, t) {
  const A = 8.0, u = t - A;
  const x0 = 300, y0 = 430, bh = 88, trackW = 1240;
  const full = TOK_FULL * TOK_PX;                       // 1200px

  // 标题
  const a0 = app(u, 0.08, 0.5);
  if (a0 > 0.004) {
    T(ctx, '上下文 · context window', x0, 250,
      { font: fM(28, '600'), color: C.slate, alpha: a0, ls: 2 });
    T(ctx, 'AI 每开一次工，都得先把「说明书」整份读一遍', x0, 298,
      { font: fS(25, '500'), color: C.dim, alpha: app(u, 0.45, 0.5) });
  }

  // 一摞说明书纸：错帧飞入 → 堆叠 → 被吸进条里
  const PAPERS = 12;
  for (let i = 0; i < PAPERS; i++) {
    const ts = 0.30 + i * 0.055;
    const kin = eOut(cl(win(u, ts, ts + 0.52)));
    if (kin <= 0.004) continue;
    const suck = eIn(cl(win(u, 1.22, 1.52)));            // 被吸走
    const tx = 1120 + i * 2.4, ty = 366 - i * 3.4;       // 堆叠落点
    const sx = 560 - i * 18, sy = 280 - i * 16;          // 起点（左上来）
    const x = lerp(sx, tx, kin), y = lerp(sy, ty, kin);
    ctx.save();
    ctx.globalAlpha = kin * (1 - suck) * 0.92;
    const scale = 1 - suck * 0.72;
    ctx.translate(x, y); ctx.scale(scale, scale); ctx.rotate(-0.08 + i * 0.012);
    ctx.fillStyle = 'rgba(228,236,252,0.13)';
    rr(ctx, -120, -66, 240, 132, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(190,208,244,0.42)'; ctx.lineWidth = 1.6;
    rr(ctx, -120, -66, 240, 132, 6); ctx.stroke();
    ctx.fillStyle = 'rgba(190,208,244,0.30)';
    for (let r = 0; r < 5; r++) {
      rr(ctx, -94, -40 + r * 20, 188 * (0.5 + rnd(i * 7 + r, 3.3) * 0.5), 7, 3.5);
      ctx.fill();
    }
    ctx.restore();
  }

  // 左端标签（条上方）
  const la = app(u, 0.55, 0.5);
  if (la > 0.004) {
    T(ctx, '这一整份，都得先进去', x0, y0 - 24,
      { font: fS(26, '600'), color: C.dim, alpha: la });
  }

  // 上下文条：生长 + 十分位刻度 + 头部扫光（红条压低不透明度，避免读成"报错"）
  const kb = eOut(cl(win(u, 1.30, 2.30)));
  if (kb > 0.004) {
    bar(ctx, x0, y0, trackW, bh, kb * (full / trackW), C.red, {
      r: 10, head: 1, ticks: 10, a0: 0.34, a1: 0.60,
      trackColor: 'rgba(22,28,56,0.86)',
    });
    scan(ctx, x0, y0, full * kb, bh, cl(win(u, 3.15, 3.95)), C.amber, 0.45);
  }

  // 数字：滚到 12,175
  const kd = cl(win(u, 1.35, 2.45));
  if (kd > 0) {
    odo(ctx, x0 + full, y0 - 18, TOK_FULL, { k: kd, fs: 78, color: C.red, align: 'right' });
    T(ctx, 'tokens', x0 + full + 14, y0 - 26,
      { font: fM(26, '600'), color: C.dim, alpha: cl(kd * 1.6) });
    T(ctx, '48697 字符 · 契约全文', x0, y0 + bh + 50,
      { font: fS(26, '600'), color: C.dim, alpha: cl(kd * 1.6) });
  }

  // 到位的冲击：扩散环 + 边框红闪
  const hit = win(u, 2.24, 2.62);
  ring(ctx, x0 + full, y0 + bh / 2, 20, 150, hit, C.red, 3, 0.55);
  if (u > 2.20 && u < 2.62) {
    ctx.save();
    ctx.globalAlpha = (1 - win(u, 2.20, 2.62)) * 0.85;
    ctx.strokeStyle = C.red; ctx.lineWidth = 3;
    rr(ctx, x0 - 6, y0 - 6, full + 12, bh + 12, 14); ctx.stroke();
    ctx.restore();
  }

  // 条右端：虚线 + 「还没开工，先花掉」
  const ka = app(u, 2.05, 0.5);
  if (ka > 0.004) {
    dash(ctx, [[x0 + full, y0 + bh + 92], [x0 + full, y0 + bh + 138]], C.red,
      { alpha: ka * 0.8, lw: 2, dash: [7, 8], off: u * 40 });
    T(ctx, '还没开工，先花掉', x0 + full, y0 + bh + 176,
      { font: fS(27, '700'), color: C.red, align: 'right', alpha: ka });
  }

  // 人话注解（画面里那句"所以呢"）
  const na = app(u, 2.70, 0.6);
  if (na > 0.004) {
    T(ctx, '上下文越长，往后每一次往返都越贵', x0, 790,
      { font: fS(30, '600'), color: C.dsSoft, alpha: na });
    T(ctx, '—— 所以省上下文，不是省一次，是省每一次', x0, 834,
      { font: fS(25, '500'), color: C.dim, alpha: app(u, 3.00, 0.55) * 0.95 });
  }

  // 角色：困倦 + 越堆越低。
  // ⚠ 放右侧：左下角被"上下文越长…"那句注解占着，角色压上去会吃掉字（实测重过）。
  const a4 = app(u, 0.25, 0.9);
  if (a4 > 0.004) {
    const sink = eOut(win(u, 1.1, 2.5)) * 10;
    actor(ctx, {
      img: 'tired', x: 1690, yb: 940 + sink, h: 300,
      alpha: a4 * 0.95, bob: bobY(t, 2.8, 4.4), glow: a4 * 0.5, glowColor: C.ds,
    });
  }
}

/* --------------------------------------------- 04 处境 (12.5 – 16.0)
   「我不缺智力。我缺的是一件趁手的工具。」
   Q版·困倦站在一面"聊天框墙"前，把结构化数据卡片往里推 —— 卡在框沿，滑掉。 */
function s3(ctx, t) {
  const A = 12.5, u = t - A;
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

/* --------------------------------------------- 05 初心 (16.0 – 19.5)
   「然后你问了我一句。」
   墙整体淡出 → 极暗 0.3s → 逐字打出用户原话 → 全身立绘 A（端咖啡）从下缘升起。
   全片唯一一次"转向镜头"。 */
function s4(ctx, t) {
  const A = 16.0, u = t - A;

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

  // 极暗段：墙走了、字还没来 —— 这段「真空」必须短。
  //   三个坑：
  //   ① 不能用纯黑 —— 深色片里会砸出一个洞；
  //   ② 不能全遮 —— 峰值 alpha 做到 1 时整帧变成一块纯色，那是"黑屏"不是"沉下去"；留 18% 的底，
  //      观众能看见深海还在那儿，只是潜得更深了。
  //   ③ 🔴 遮罩的退场必须早于文字的入场。原来遮罩退到 u=1.20、文字 u=1.05 才起，
  //      于是 u 0.62–1.05 之间"墙没了、字没来" —— 实测该刻的 PNG 只有 718 KB（其余静帧 1.3–1.9 MB），
  //      一帧准空白，观众会以为卡住了。现在遮罩 u=1.02 退净、文字 u=0.86 起，空窗压到 0.22s。
  const dark = 0.82 * cl(win(u, 0.60, 0.84)) * cl(1 - win(u, 0.84, 1.02));
  if (dark > 0.001) {
    ctx.save(); ctx.globalAlpha = dark; ctx.fillStyle = C.ink;
    ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  // 用户那句话：逐字打出
  const LINE = '「做一个 AI 用的网页 —— 你作为 AI，会想要什么功能？」';
  const key = win(u, 0.94, 2.26);
  const a1 = app(u, 0.86, 0.42);
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

/* --------------------------------------------- 06 答案 (19.5 – 23.5)
   「它的一号用户不是人，是我。」
   上行划掉、下行亮起；三枚芯片 状态/感官/行动 逐一点亮并给人话注解；
   最右侧一个聊天框被红叉划掉。 */
function s5(ctx, t) {
  const A = 19.5, u = t - A;

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

/* --------------------------------------------- 07 ★索引替说明书 (23.5 – 28.0, 4.5s)
   「先拿目录，别背整本书。」
   两条条共用同一个尺度，直接比长度：
     上：整份契约入上下文 —— 12,175 tokens（把 1240px 的轨道铺满）
     下：实际冷启动读索引 —— 690 tokens（只有 68px）
   下面把「29 条路由」一格一格点亮 —— 这 690 tokens 里到底装了什么。
   角色：Q版·坚定，站在右侧。 */
function sIdx(ctx, t) {
  const A = 23.5, u = t - A;
  const x0 = 300, tw_ = 1200, th = 78;

  // 标题
  const a0 = app(u, 0.08, 0.5);
  if (a0 > 0.004) {
    T(ctx, '自举入口 · GET /v1/health', x0, 250,
      { font: fM(28, '600'), color: C.dsSoft, alpha: a0, ls: 2 });
  }

  // ---- 上条：整份契约
  const k1 = eOut(cl(win(u, 0.30, 1.20)));
  const heavy = eOut(cl(win(u, 1.20, 1.50))) * 0.5;
  if (k1 > 0.004) {
    bar(ctx, x0, 330 + heavy * 6, tw_, th, k1, C.red, {
      r: 10, head: 1 - heavy, alpha: 1 - heavy * 0.45, ticks: 10, a0: 0.34, a1: 0.60,
    });
    T(ctx, '整份契约入上下文', x0, 300, { font: fS(26, '600'), color: C.dim, alpha: a0 * (1 - heavy * 0.6) });
    odo(ctx, x0 + tw_ + 22, 392, TOK_FULL, { k: cl(win(u, 0.35, 1.30)), fs: 62, color: C.red, align: 'left' });
    T(ctx, 'tokens', x0 + tw_ + 22, 434, { font: fM(22, '600'), color: C.dim, alpha: cl(k1 * 1.5) });
  }

  // ---- 下条：读索引
  const k2 = eOut(cl(win(u, 1.50, 2.30)));
  if (k2 > 0.004) {
    bar(ctx, x0, 470, tw_, th, k2 * (690 / TOK_FULL), C.green, { r: 10, head: 1 });
    T(ctx, '实际冷启动：只读索引', x0, 440, { font: fS(26, '600'), color: C.green, alpha: app(u, 1.35, 0.45) });
    const hit = win(u, 2.24, 2.60);
    ring(ctx, x0 + tw_ * (690 / TOK_FULL), 470 + th / 2, 14, 120, hit, C.green, 3, 0.6);
    odo(ctx, x0 + tw_ + 22, 532, 690, { k: cl(win(u, 1.55, 2.35)), fs: 62, color: C.green, align: 'left' });
    T(ctx, 'tokens', x0 + tw_ + 22, 574, { font: fM(22, '600'), color: C.dim, alpha: cl(k2 * 1.5) });
  }

  // ---- 690 tokens 里装了什么：29 条路由，逐格点亮
  const ga = app(u, 2.30, 0.5);
  if (ga > 0.004) {
    T(ctx, '这 690 个 token 里装的：29 条路由', x0, 632,
      { font: fS(26, '600'), color: C.fg, alpha: ga });
    const N = 29, cwd = 44, chd = 50, gp = 8, per = 15;
    for (let i = 0; i < N; i++) {
      const r = Math.floor(i / per), c = i % per;
      const x = x0 + c * (cwd + gp), y = 662 + r * (chd + gp);
      const kk = eOut(cl(win(u, 2.45 + i * 0.042, 2.80 + i * 0.042)));
      if (kk <= 0.004) continue;
      ctx.save();
      ctx.globalAlpha = kk * 0.9;
      ctx.fillStyle = 'rgba(52,211,153,0.16)';
      rr(ctx, x, y, cwd, chd, 6); ctx.fill();
      ctx.strokeStyle = 'rgba(52,211,153,0.65)'; ctx.lineWidth = 1.4;
      rr(ctx, x, y, cwd, chd, 6); ctx.stroke();
      ctx.fillStyle = C.green;
      rr(ctx, x + 12, y + 18, cwd - 24, 3, 1.5); ctx.fill();
      rr(ctx, x + 12, y + 28, (cwd - 24) * 0.62, 3, 1.5); ctx.fill();
      ctx.restore();
    }
    // 全亮之后整体脉冲一次
    if (u > 3.66 && u < 4.10) {
      ctx.save();
      ctx.globalAlpha = (1 - win(u, 3.66, 4.10)) * 0.30;
      ctx.fillStyle = C.green;
      rr(ctx, x0 - 10, 652, per * (cwd + gp) + 10, 2 * (chd + gp) + 4, 8); ctx.fill();
      ctx.restore();
    }
  }

  // ---- 2 次往返
  const ra = app(u, 3.30, 0.5);
  if (ra > 0.004) {
    const s = '2 次往返 · 一个零知识 agent 就能开工';
    T(ctx, s, x0, 838, { font: fS(30, '700'), color: C.fg, alpha: ra });
    // 两个小箭头依次点亮
    for (let i = 0; i < 2; i++) {
      const kk = app(u, 3.45 + i * 0.22, 0.35);
      if (kk <= 0.004) continue;
      const ax = x0 + tw(ctx, s, fS(30, '700')) + 34 + i * 34;
      ctx.save();
      ctx.globalAlpha = kk;
      ctx.strokeStyle = C.dsSoft; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax, 818); ctx.lineTo(ax + 16, 830); ctx.lineTo(ax, 842);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- 注解（人话）
  const na = app(u, 3.72, 0.45);
  if (na > 0.004) {
    T(ctx, '不必把整份契约塞进上下文 —— 先拿目录，要哪条翻哪条', x0, 890,
      { font: fS(26, '500'), color: C.dsSoft, alpha: na });
  }

  // ---- 角色
  const a4 = app(u, 0.35, 0.9);
  if (a4 > 0.004) {
    actor(ctx, {
      img: 'focus', x: 1642, yb: 940, h: 318,
      alpha: a4 * 0.95, bob: bobY(t, 3.2, 3.7, 0.8), glow: a4 * 0.75, glowColor: C.ds,
    });
  }
}

/* --------------------------------------------- 08 不服 (28.0 – 31.5)
   「我不自己说了算。」
   豆包官方图标自右边缘弹性弹入，气泡「你的设计，我挑了 7 个问题」；
   7 张纸飞向中央排成扇形，每张一个真实议题名。 */
function s6(ctx, t) {
  const A = 28.0, u = t - A;

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
    const k = eOut(cl(win(u, 1.25 + i * 0.075, 1.85 + i * 0.075)));
    if (k <= 0.004) return;
    const ang = -0.52 + i * 0.174;
    const fx = 980 + Math.sin(ang) * 268, fy = 762 - Math.cos(ang) * 268 * 0.42;
    // v2：从豆包那一侧"抛"过来，走一条微微上拱的弧 —— 直线插值读起来像贴上去的
    const x = lerp(1620, fx, k);
    const y = lerp(700, fy, k) - Math.sin(k * Math.PI) * 46;
    slip(ctx, x, y, 176, 74, s, C.amber, {
      alpha: cl(k * 1.6), tilt: ang * 0.9 + (1 - k) * 0.55, fs: 25,
      fill: 'rgba(40,32,14,0.94)',
    });
  });
  ring(ctx, 980, 700, 20, 300, win(u, 1.25, 2.25), C.amber, 2.5, 0.26);
}

/* --------------------------------------------- 09 交锋 (31.5 – 35.0)
   「5 条我认了，4 条我不认。不认的每一条，都附上了理由。」
   纸收拢重散成两簇：5 张飞向角色贴入（绿勾），4 张被推回（红章「理由」）；
   顶上两个计数牌。角色表情 坚定 → 开心。 */
function s7(ctx, t) {
  const A = 31.5, u = t - A;

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
    slip(ctx, x, y, 150, 62, null, C.green, {
      alpha: cl(k * 1.3) * (1 - k * 0.3), tilt: -0.18 + i * 0.06 + (1 - k) * 0.85,
    });
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
    slip(ctx, x, y, 150, 62, null, C.red, {
      alpha: cl(k * 1.3), tilt: 0.16 - i * 0.05 - (1 - k) * 0.85,
    });
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

/* --------------------------------------------- 10 危机 (35.0 – 38.5)
   「我写的报告，每个数字都标了出处。」
   报告吐在中间。豆包凑近，放大镜横扫 —— 两处亮起血红高亮。
   检索框逐字打出这两处，结果每次都是「0 条结果」红闪。 */
function s8(ctx, t) {
  const A = 35.0, u = t - A;
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

/* --------------------------------------------- 11 立住 (38.5 – 42.7, 4.2s)
   「查不出来源的数字，就是编的。」
   七拍：静止低头 → 撕纸 → 极暗 → 护栏落下 → 三条判据打勾 → 6/6 PASS → 互审台词。
   ⚠ 这一镜原本只有 3.5s，实测 6/6 PASS 要到 3.77s 才出、末句整段被切；
     从 S10 借 0.7s，并把判据的错帧从 0.30s 压到 0.32s→0.32s 起步更早。 */
function s9(ctx, t) {
  const A = 38.5, u = t - A;

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

/* --------------------------------------------- 12 结果 (42.7 – 46.7)
   「那最后省下来的，是什么？」
   两条 1 分钟一格的时间条并排：
     逐段确认 25 格（碎，3 处打断）←→ 攒批确认 19 格（整，1 处打断）
   碎与整的对比一眼就懂，不需要额外解释。 */
function s10(ctx, t) {
  const A = 42.7, u = t - A;
  const bx = 592, unit = 40, gw = 36, bh = 84;

  const track = (y, mins, color, label, marks, delay) => {
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
      const edge = cl(1 - Math.abs(k - i / mins) * mins * 1.15);   // 正在长出来的那一格
      ctx.save();
      ctx.globalAlpha = ik;
      const g = ctx.createLinearGradient(x, y, x, y + bh);
      g.addColorStop(0, 'rgba(' + hexToRgb(color) + ',0.52)');
      g.addColorStop(1, 'rgba(' + hexToRgb(color) + ',0.86)');
      ctx.fillStyle = g;
      rr(ctx, x, y, gw, bh, 6); ctx.fill();
      if (edge > 0.02) {                                          // 生长头的亮边
        ctx.globalAlpha = ik * edge * 0.85;
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        rr(ctx, x, y, gw, bh, 6); ctx.fill();
      }
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
    // 末尾数字：滚动到位（v2 —— 数字不硬切出现）
    const dk = cl(win(u, delay + 0.75, delay + 1.55));
    if (dk > 0) {
      odo(ctx, bx + mins * unit + 24, y + bh - 12, mins, {
        k: dk, fs: 52, color, align: 'left', suffix: ':00', font: fM(52, '700'),
      });
    }
    const ma = app(u, delay + 1.3, 0.5);
    if (ma > 0.004) {
      T(ctx, marks.length + ' 次被打断', bx + 4, y + bh + 96, {
        font: fS(24, '600'), color: C.red, alpha: ma,
      });
    }
  };

  track(486, 25, C.red, '逐段确认', [0.18, 0.54, 0.86], 0.10);
  track(742, 19, C.green, '攒批确认', [0.46], 0.45);

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

/* --------------------------------------------- 13 ★实测账单 (46.7 – 51.2, 4.5s)
   「一整轮真活儿，账单长这样。」
   四块数字牌（错帧入场 + 数字滚动 + 落点扩散环），中间扫一道结算光；
   底部两小节：单查一张 vs 拉全表。
   全部出自 .agent-trial.txt（20 项检查 / 0 blocker）。 */
function sBill(ctx, t) {
  const A = 46.7, u = t - A;

  const a0 = app(u, 0.08, 0.5);
  if (a0 > 0.004) {
    T(ctx, '一次真活儿 · agent-trial', 220, 250,
      { font: fM(28, '600'), color: C.teal, alpha: a0, ls: 2 });
    T(ctx, '模拟条件：只有 HTTP · 只有契约 · 不读源码 · 不依赖中文', 220, 292,
      { font: fS(23, '500'), color: C.dim, alpha: app(u, 0.5, 0.5) });
  }

  // ---- 四块数字牌
  const CARDS = [
    [19,      '次往返',        C.dsSoft],
    [24510,   'tokens 累计',   C.amber],
    [1290,    'tokens · 每次往返', C.violet],
    [0,       '次需要人介入',   C.green],
  ];
  CARDS.forEach((c, i) => {
    const x = 220 + i * 400, y = 340, w0 = 340, h0 = 196;
    const kin = app(u, 0.30 + i * 0.32, 0.55);
    if (kin <= 0.004) return;
    const lift = (1 - kin) * 26;
    ctx.save();
    ctx.globalAlpha = kin;
    ctx.fillStyle = 'rgba(' + hexToRgb(c[2]) + ',0.10)';
    rr(ctx, x, y + lift, w0, h0, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(' + hexToRgb(c[2]) + ',0.55)'; ctx.lineWidth = 1.8;
    rr(ctx, x, y + lift, w0, h0, 16); ctx.stroke();
    ctx.fillStyle = c[2];
    rr(ctx, x, y + lift, w0, 5, 2.5); ctx.fill();
    ctx.restore();
    // 落点扩散环（用牌子的入场时刻）
    ring(ctx, x + w0 / 2, y + 110 + lift, 20, 170, win(u, 0.30 + i * 0.32, 0.92 + i * 0.32), c[2], 2.5, 0.35);
    odo(ctx, x + w0 / 2, y + 126 + lift, c[0], {
      k: cl(win(u, 0.42 + i * 0.32, 1.90)), fs: 76, color: c[2], alpha: kin,
    });
    T(ctx, c[1], x + w0 / 2, y + 172 + lift,
      { font: fS(23, '600'), color: C.dim, align: 'center', alpha: kin });
  });

  // ---- 结算扫光：一道光横向刷过四块牌
  scan(ctx, 200, 332, 1624, 214, cl(win(u, 1.95, 2.45)), C.teal, 0.42);

  // ---- 底部：单查 vs 拉全表（同一个尺度）
  const kk = eOut(cl(win(u, 2.40, 3.20)));
  if (kk > 0.004) {
    const bx = 700, bw = 520;
    const rows = [
      ['单查一张审批单 · O(1)', 403, C.green, 'GET /v1/approvals/{id}'],
      ['退而求其次 · 拉全表 O(n)', 441, C.slate, 'GET /v1/approvals'],
    ];
    rows.forEach((r, i) => {
      const y = 626 + i * 76;
      const rk = eOut(cl(win(u, 2.40 + i * 0.18, 3.10 + i * 0.18)));
      if (rk <= 0.004) return;
      T(ctx, r[0], 220, y + 34, { font: fS(25, '600'), color: r[2], alpha: rk });
      T(ctx, r[3], 220, y + 66, { font: fM(19, '500'), color: C.faint, alpha: rk * 0.9 });
      bar(ctx, bx, y, bw, 52, rk * (r[1] / 441), r[2], { r: 8, head: 1, trackColor: 'rgba(22,28,56,0.7)' });
      odo(ctx, bx + bw + 20, y + 40, r[1], { k: rk, fs: 40, color: r[2], align: 'left' });
    });
    const sa = app(u, 3.15, 0.45);
    if (sa > 0.004) {
      T(ctx, '查得越准，付得越少 —— 省 9%，而且不会翻到别人的单子', 220, 800,
        { font: fS(27, '600'), color: C.fg, alpha: sa });
    }
  }

  // ---- 收尾注解
  const na = app(u, 3.55, 0.45);
  if (na > 0.004) {
    T(ctx, '20 项检查全部通过 —— 全程没有一处需要人来救', 220, 852,
      { font: fS(26, '500'), color: C.green, alpha: na });
  }

  // ---- 角色：坚定（"我的账单，我自己贴出来"）—— 放右侧，避免压住左下的对比标签
  const a4 = app(u, 0.25, 0.9);
  if (a4 > 0.004) {
    actor(ctx, {
      img: 'focus', x: 1690, yb: 934, h: 286,
      alpha: a4 * 0.95, bob: bobY(t, 3.0, 3.5, 1.4), glow: a4 * 0.6, glowColor: C.ds,
    });
  }
}

/* --------------------------------------------- 14 盲区 (51.2 – 54.5, 3.3s)
   「有些 bug，人点一辈子也点不出来。」
   一张请求卡片 + 一条流动的虚线把"落点"指出来：先落 HTML（红）→ 改判 JSON（绿）。
   ⚠ 原版让卡片缩到 0.40 飞过去 —— 实测 30px 的字变成 12px，等于不可读。
     改成卡片原地不动、用连线指路。 */
function s11(ctx, t) {
  const A = 51.2, u = t - A;

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

/* --------------------------------------------- 15 命题 (54.5 – 60.0)
   「好工具，让约束变得不必要。」
   两张全身立绘并排、**同频呼吸**，中缝叠一枚豆包图标；
   背景抬到全片最亮并打一束顶光 —— 仍在深色域，不转浅色。 */
function s12(ctx, t) {
  const A = 54.5, u = t - A;

  // 顶光（全片最亮的一刻）
  const ka = eOut(win(u, 0.0, 3.4));
  const g = ctx.createRadialGradient(W / 2, -180, 0, W / 2, 180, 1180);
  g.addColorStop(0, 'rgba(140,175,255,' + (0.20 + 0.22 * ka).toFixed(3) + ')');
  g.addColorStop(0.45, 'rgba(80,120,220,' + (0.06 + 0.08 * ka).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.globalAlpha = cl(ka * 1.4); ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H); ctx.restore();

  // v2 新增：上浮光斑 —— "从海底浮上来"这件事必须有可见的速度
  ctx.save();
  for (let i = 0; i < 26; i++) {
    const sp = 26 + rnd(i, 17.7) * 54;
    const span = H + 160;
    const y = H + 80 - ((t * sp + rnd(i, 41.3) * span) % span);
    const x = rnd(i, 71.9) * W + Math.sin(t * 0.5 + i * 2.1) * 22;
    ctx.globalAlpha = (0.10 + 0.22 * rnd(i, 63.7)) * (1 - y / (H + 80)) * cl(ka * 1.3);
    ctx.fillStyle = '#bcd7ff';
    ctx.beginPath(); ctx.arc(x, y, 1.4 + rnd(i, 89.1) * 2.6, 0, 7); ctx.fill();
  }
  ctx.restore();

  // 两张全身立绘：同一相位 = 同频呼吸；v2 加缓慢推近（z 1.00 → 1.045）
  // 高度 742→636：原尺寸下角色头顶(y≈170)会顶进命题文字的位置，实测重叠。
  const ph = 3.1, per = 3.6;
  const zoom = 1 + 0.045 * eOut(win(u, 0.35, 5.5));
  const a1 = app(u, 0.35, 1.0);
  if (a1 > 0.004) {
    const bb = bobY(t, 5.0, per, ph);
    actor(ctx, {
      img: 'fullA', x: 612, yb: 934, h: 636, alpha: a1, bob: bb, scale: zoom,
      glow: a1 * 0.9, glowColor: C.ds,
    });
    actor(ctx, {
      img: 'fullB', x: 1308, yb: 934, h: 636, alpha: a1, bob: bb, scale: zoom,
      glow: a1 * 0.9, glowColor: C.ds,
    });
  }

  // 中缝：豆包图标（呼吸同相，四拍里慢半拍，读起来"在一起但不同步"）
  const a2 = app(u, 1.5, 0.8);
  if (a2 > 0.004) {
    actor(ctx, {
      img: 'doubao', x: 960, yc: 800, h: 152,
      alpha: a2, bob: bobY(t, 4.2, per, ph + 0.5), glow: a2 * 0.95, glowColor: C.db,
    });
  }

  // 命题：上浮 + 字距收拢（ls 从 6 收到 1）—— 字"落定"的过程也是动效
  const a3 = app(u, 0.9, 0.8);
  if (a3 > 0.004) {
    const y = 190 - (1 - a3) * 14;
    T(ctx, '好工具，让约束变得不必要。', W / 2, y, {
      font: fS(56, '800'), color: C.fg, align: 'center', alpha: a3,
      ls: lerp(6, 1, eOut(cl(win(u, 0.9, 2.2)))),
    });
    const a4 = app(u, 1.6, 0.8);
    if (a4 > 0.004) {
      T(ctx, '而不是让约束变得更多', W / 2, y + 68 + (1 - a4) * 12, {
        font: fS(33, '500'), color: C.dsSoft, align: 'center', alpha: a4 * 0.95,
      });
    }
  }

  // 印章：出现时扩散一圈，表示"结账"
  const a5 = app(u, 2.4, 0.7);
  if (a5 > 0.004) {
    ring(ctx, 300, 988, 10, 190, win(u, 2.40, 3.10), C.dsSoft, 2, 0.28);
    T(ctx, '11 套 · 487 断言 · 0 失败', 96, 996,
      { font: fM(20, '500'), color: C.faint, alpha: a5 * 0.9 });
    T(ctx, '鲸鱼娘形象 © 上善 / ZipZipPipe · CC BY-NC-SA 4.0', 96, 1028,
      { font: fS(18, '400'), color: C.faint, alpha: a5 * 0.72 });
  }

  // 收尾 1.4s：全片唯一一次"整帧呼吸"—— 光晕涨一次再落回去。
  // ⚠ 原版是 0.7s / 峰值 alpha 0.16。实测它在 t=59.4 造成一个 +6.4 的亮度台阶
  //   （0.3s 均值 58.9 → 65.3），读起来是"结尾闪了一下"，而且把 s12 的 p90 顶到 61.2 越出深色带。
  //   改成 1.4s / 峰值 0.10：涨落整个落在背景爬坡里，不再有台阶。
  //   改后 s12 极差 31.6 → 27（PASS），峰值亮度回到深色域。
  const fin = cl(win(u, 4.10, 5.50));
  if (fin > 0.001) {
    const p = Math.sin(fin * Math.PI);
    ctx.save();
    ctx.globalAlpha = p * 0.10;
    const fg = ctx.createRadialGradient(W / 2, H * 0.52, 0, W / 2, H * 0.52, H * 1.05);
    fg.addColorStop(0, 'rgba(150,185,255,1)');
    fg.addColorStop(1, 'rgba(150,185,255,0)');
    ctx.fillStyle = fg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/* ============================================================================
   字幕 & 主循环
   ========================================================================= */

/* 字幕全文 30 行（15 镜 × 主副）。副行原则（v2 修订）：
   —— 数字**可以**进副行，但有两条硬条件：
      ① 每个数字在剧本 §7 溯源表里能查到出处；
      ② 数字后面必须跟一句"这对你意味着什么"的人话。
   v1 立的"token 数一律不进片"是过头了 —— 病根不是数字，是**没翻译**的数字。 */
const SUBS = {
  s1:   ['我干活的样子，你其实没见过。', '—— 一个 AI 的自白'],
  s2:   ['一件事做完，我得停下来问你一次。', '25 分钟里，你被打断了 3 次'],
  ctx:  ['AI 的上下文，是一笔预算。', '契约全文 48697 字符 ≈ 12,175 tokens —— 还没开工，先花掉'],
  s3:   ['我不缺智力。我缺的是一件趁手的工具。', '用聊天框搬结构化数据 —— 那是所有路里最慢的一条'],
  s4:   ['然后你问了我一句。', '「做一个 AI 用的网页 —— 你作为 AI，会想要什么功能？」'],
  s5:   ['它的一号用户不是人，是我。', '最该省掉的，恰恰是那个聊天框'],
  idx:  ['先拿目录，别背整本书。', '690 tokens 拿到 29 条路由 —— 零知识冷启动只要 2 次往返'],
  s6:   ['我不自己说了算。', '我叫豆包来审我 —— 它挑了 7 个问题'],
  s7:   ['5 条我认了，4 条我不认。', '不认的每一条，都附上了理由'],
  s8:   ['我写的报告，每个数字都标了出处。', '豆包查了两处 —— 全部材料里，一处都搜不到'],
  s9:   ['查不出来源的数字，就是编的。', '我把报告撕了，从头做了一遍'],
  s10:  ['那最后省下来的，是什么？', '25 分钟 → 19 分钟；被打断 3 次 → 只打扰你 1 次'],
  bill: ['我一整轮的账，我自己贴出来。', '19 次往返 · 24,510 tokens · 每次往返 1,290 · 0 次需要人介入'],
  s11:  ['有些 bug，人点一辈子也点不出来。', '人不会发 */*，可 AI 的客户端默认就发它'],
  s12:  ['好工具，让约束变得不必要。', '而不是让约束变得更多'],
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

/* 时长分配（v2）：v1 的 12 章一秒没砍，只是整体后移；新增 3 章插在叙事缺口上。
   v1 45.0s → v2 60.0s。收尾章 4.0 → 5.5s：命题需要呼吸，也是全片唯一"停下来"的地方。
     S01  4.0  S02  4.0  S03* 4.5  S04  3.5  S05  3.5  S06  4.0
     S07* 4.5  S08  3.5  S09  3.5  S10  3.5  S11  4.2  S12  4.0
     S13* 4.5  S14  3.3  S15  5.5                      合计 60.0s（* = v2 新增） */
const CHAPTERS = [
  { id: 's1',   a: 0.0,  b: 4.0,  dot: C.ds,     draw: s1   },   // 01 自白
  { id: 's2',   a: 4.0,  b: 8.0,  dot: C.red,    draw: s2   },   // 02 痛点
  { id: 'ctx',  a: 8.0,  b: 12.5, dot: C.amber,  draw: sCtx },   // 03 ★上下文入场费
  { id: 's3',   a: 12.5, b: 16.0, dot: C.slate,  draw: s3   },   // 04 处境
  { id: 's4',   a: 16.0, b: 19.5, dot: C.violet, draw: s4   },   // 05 初心
  { id: 's5',   a: 19.5, b: 23.5, dot: C.teal,   draw: s5   },   // 06 答案
  { id: 'idx',  a: 23.5, b: 28.0, dot: C.green,  draw: sIdx },   // 07 ★索引替说明书
  { id: 's6',   a: 28.0, b: 31.5, dot: C.amber,  draw: s6   },   // 08 不服
  { id: 's7',   a: 31.5, b: 35.0, dot: C.green,  draw: s7   },   // 09 交锋
  { id: 's8',   a: 35.0, b: 38.5, dot: C.red,    draw: s8   },   // 10 危机
  { id: 's9',   a: 38.5, b: 42.7, dot: C.green,  draw: s9   },   // 11 立住（4.2s）
  { id: 's10',  a: 42.7, b: 46.7, dot: C.teal,   draw: s10  },   // 12 结果（4.0s）
  { id: 'bill', a: 46.7, b: 51.2, dot: C.violet, draw: sBill},   // 13 ★实测账单
  { id: 's11',  a: 51.2, b: 54.5, dot: C.amber,  draw: s11  },   // 14 盲区（3.3s）
  { id: 's12',  a: 54.5, b: 60.0, dot: C.fg,     draw: s12  },   // 15 命题（5.5s）
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
