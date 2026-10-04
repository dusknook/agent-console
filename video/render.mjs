// render.mjs — 用无头 Chrome 驱动 page.html 逐帧出图，再交给 ffmpeg 编码。
//   node render.mjs --probe                                   打印 GPU 名（必须看到 NVIDIA）
//   node render.mjs --sheet=0,1.5,11,20 --cols=2 --out=out/check/a.jpg   接触表（快速巡检）
//   node render.mjs --stills=0.9,14,30 --out=out/stills       全分辨率 PNG 静帧
//   node render.mjs --frames=0:48.6 --fps=30 --workers=1      全片 JPEG 帧 → out/frames（可续跑）
//   node render.mjs --encode [--audio=assets/bgm.wav] [--out=out/film.mp4]
//
// 纪律（来自 headless-canvas-video-render skill）：
//   · 混合显卡笔记本上 headless Chrome 默认落核显 → --force_high_performance_gpu 实测 2.4 倍。
//   · 并发固定 1：非前台标签页被判 occluded，toDataURL 的 GPU 回读被降级，多开净收益为零甚至倒赔。
//   · --frames 有续跑机制（已存在且 >1000 字节的帧直接跳过）—— 换了内容必须显式删帧。
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true];
}));

const CHROME = args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// 🔴 ffmpeg 不在 PATH，而本机有两份、能力不同：AutoMusic 那份才有 libx264/aac。
const FF = args.ffmpeg || process.env.MV_FFMPEG || 'D:/Users/30762/AppData/Local/AutoMusic/ffmpeg.exe';
const FPS = +(args.fps || 30);
const VW = +(args.vw || 1920), VH = +(args.vh || 1080);
const FRAMES_DIR = 'out/frames';
const PAGE = 'page.html';

const run = (cmd, a) => new Promise((ok, bad) => {
  const p = spawn(cmd, a, { stdio: 'inherit' });
  p.on('close', c => c ? bad(new Error(cmd + ' exited ' + c)) : ok());
});

/* ------------------------------------------------------------------ 编码 */
if (args.encode) {
  const files = existsSync(FRAMES_DIR) ? readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')) : [];
  if (!files.length) throw new Error('out/frames 里没有帧，先跑 --frames');
  const out = args.out || 'out/film.mp4';
  mkdirSync(dirname(out), { recursive: true });
  console.log(`encoding ${files.length} frames → ${out}`);
  // 🔴 帧是 JPEG 进来的 → ffmpeg 默认按 yuvj420p（full range 0–255）处理，
  //    播放器按 limited(16–235) 解释时整片发灰发白。显式做 full→limited 并打 tv 标记。
  const vf = ['-vf', 'scale=in_range=full:out_range=limited', '-color_range', 'tv'];
  const a = ['-y', '-loglevel', 'error', '-stats',
    '-framerate', String(FPS), '-i', `${FRAMES_DIR}/f%05d.jpg`];
  if (args.audio) a.push('-i', String(args.audio));
  a.push('-map', '0:v', ...vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  if (args.audio) a.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  a.push(out);
  await run(FF, a);
  console.log('wrote ' + out);
  process.exit(0);
}

/* ------------------------------------------------------------------ 浏览器 */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 0,
  args: [
    '--allow-file-access-from-files',   // 必须：否则本地 file:// 加载不了同目录资源
    '--force_high_performance_gpu',     // ← 关键：不加就走 Intel 核显，慢 2.4 倍
    '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu-rasterization',
    `--window-size=${VW},${VH}`,
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(process.env.MV_GPU_ARGS ? process.env.MV_GPU_ARGS.split(' ').filter(Boolean) : []),
  ],
});

let _meta = null;
async function openPage(tag = '') {
  const page = await browser.newPage();
  page.on('console', m => { if (['error', 'warn'].includes(m.type())) console.log(`[page${tag}]`, m.text()); });
  page.on('pageerror', e => console.log(`[page error${tag}]`, e.message));
  // 页面不引外部字体，但把 Google Fonts 一并拦掉：这个网络下 fonts.googleapis.com 时通时不通，
  // waitUntil 会一直等它，最后整批以 TimeoutError 收场（静默故障）。
  await page.setRequestInterception(true);
  page.on('request', r => { /fonts\.(googleapis|gstatic)\.com/.test(r.url()) ? r.abort() : r.continue(); });
  await page.goto(pathToFileURL(resolve(PAGE)).href + '?render', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.ready === true', { timeout: 120000 });
  if (process.env.MV_TRACE) console.log(`  page${tag} ready · GPU: ${await page.evaluate(() => window.gpuInfo())}`);
  if (!_meta) {
    _meta = await page.evaluate(() => window.SCENE_META);
    if (process.env.MV_TRACE) console.log(`  scene dur=${_meta.dur}s · ${_meta.chapters.length} chapters`);
  }
  return page;
}

const frameOf = async (page, t, type, q) => {
  const url = await page.evaluate((t, type, q) => window.renderAt(t, type, q), t, type, q);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
};
const times = s => String(s).split(',').map(Number);

/* ------------------------------------------------------------------ 分支 */
if (args.probe) {
  const page = await openPage();
  console.log('GPU :', await page.evaluate(() => window.gpuInfo()));
  console.log('meta:', JSON.stringify(_meta));
  // 一次单帧计时，用来判断有没有踩核显的坑
  const t0 = Date.now();
  await frameOf(page, 13.5, 'image/jpeg', .94);
  console.log(`单帧(含 toDataURL) ${Date.now() - t0} ms`);
} else if (args.sheet) {
  const page = await openPage(), out = args.out || 'out/check/sheet.jpg';
  mkdirSync(dirname(out), { recursive: true });
  const { url, ms } = await page.evaluate((ts, c, w) => window.renderSheet(ts, c, w),
    times(args.sheet), +(args.cols || 3), +(args.w || 640));
  writeFileSync(out, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  console.log(`${out}   ms/frame(绘制): ${ms.join(' ')}`);
} else if (args.stills) {
  const page = await openPage(), out = args.out || 'out/stills';
  mkdirSync(out, { recursive: true });
  console.log('GPU:', await page.evaluate(() => window.gpuInfo()));
  for (const s of times(args.stills)) {
    const t0 = Date.now(), buf = await frameOf(page, s, 'image/png');
    const f = `${out}/t${s.toFixed(2).replace('.', '_')}.png`;
    writeFileSync(f, buf);
    console.log(`${f}  ${Date.now() - t0} ms  ${(buf.length / 1024).toFixed(0)} KB`);
  }
} else if (args.frames) {
  const probe = await openPage(); const DUR = _meta.dur; await probe.close();
  const [a, b] = String(args.frames).split(':').map(Number);
  const workers = +(args.workers || 1);
  mkdirSync(FRAMES_DIR, { recursive: true });
  const first = Math.round(a * FPS);
  const last = Math.min(Math.ceil(DUR * FPS) - 1, Math.round((isFinite(b) ? b : DUR) * FPS) - 1);
  const todo = [];
  for (let i = first; i <= last; i++) {
    const f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`;
    if (!existsSync(f) || statSync(f).size < 1000) todo.push(i);   // ← 续跑：已存在的静默跳过
  }
  console.log(`DUR=${DUR}s · ${todo.length} frames to render (${last - first + 1 - todo.length} already done) · ${workers} worker(s)`);
  let next = 0, done = 0; const start = Date.now();
  const work = async w => {
    const page = await openPage('#' + w);
    while (next < todo.length) {
      const i = todo[next++], f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`;
      const t0 = Date.now();
      const buf = await frameOf(page, i / FPS, 'image/jpeg', .94);
      if (process.env.MV_TRACE) console.log(`  w${w} f${i} ${Date.now() - t0} ms ${(buf.length / 1024).toFixed(0)} KB`);
      writeFileSync(f + '.tmp', buf); renameSync(f + '.tmp', f);
      if (++done % 10 === 0 || done === todo.length) {
        const el = (Date.now() - start) / 1000;
        console.log(`frame ${done}/${todo.length}  ${(el / done * 1000).toFixed(0)} ms/frame  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => work(w)));
} else {
  console.log('用法见文件头注释。至少给一个：--probe / --sheet / --stills / --frames / --encode');
}

await browser.close();
