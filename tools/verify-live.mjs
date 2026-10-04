#!/usr/bin/env node
/**
 * 校验线上站点与本地产物**逐字节一致**。
 *
 * 为什么不是「打开看看对不对」：静态托管会有缓存/CDN/构建产物替换，
 * 「看起来对」完全可能是在看上一版。字节一致才是发成功的唯一证据。
 * 之前这个检查是手工 curl + sha256 一行行敲的 —— 手工的东西不会每次都做，
 * 所以固化成脚本，并让它自己 exit 1。
 *
 * 用法： node tools/verify-live.mjs [--dir site-doubao] [--base https://xxx] [--must-contain cc64b0c7a9178b32]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = path.resolve(argOf('--dir', 'site-doubao'));
const BASE = (argOf('--base', 'https://agent-console-eval.app.workbuddy.host')).replace(/\/+$/, '');
const MUST = argOf('--must-contain', null);

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function walk(d, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(d, e.name), r));
    else out.push(r);
  }
  return out;
}

const fetchRetry = async (url, tries = 5) => {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      // curl 的 exit 56（接收失败）在网络抖动时很常见 —— 它是**传输**问题，不是内容问题，重试即可
      if (i < tries) await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
};

const files = walk(DIR);
console.log(`校验 ${files.length} 个文件：${BASE}/  ←→  ${DIR}\n`);

let bad = 0;
for (const f of files) {
  const local = fs.readFileSync(path.join(DIR, f));
  let online = null, err = null;
  try { online = await fetchRetry(BASE + '/' + f.split('/').map(encodeURIComponent).join('/')); }
  catch (e) { err = e; }

  if (!online) { console.log(`  FETCH-FAIL  ${f}   (${err.message})`); bad++; continue; }
  const a = sha(local), b = sha(online);
  if (a === b) {
    console.log(`  IDENTICAL   ${f}  (${local.length}B)`);
  } else {
    console.log(`  MISMATCH    ${f}  local=${a.slice(0, 16)} online=${b.slice(0, 16)}  ${online.length}B≠${local.length}B`);
    bad++;
  }

}

// 关键内容抽查：入口文档里必须真的出现指定摘要 —— 防「线上还是缓存里的旧包」。
if (MUST) {
  const probe = ['start.md', 'pkg.md', 'openapi.json', 'index.html', 'MANIFEST.json'];
  for (const f of probe) {
    if (!files.includes(f)) continue;
    const online = await fetchRetry(BASE + '/' + f).catch(() => null);
    if (online && !online.includes(MUST)) { console.log(`  MISSING-DIGEST  ${f}  未出现 ${MUST}`); bad++; }
  }
}

console.log(bad === 0 ? `\n✔ ${files.length}/${files.length} IDENTICAL —— 线上就是本地这一版。`
                      : `\n✖ ${bad} 项不一致 —— 别当发成功了。`);
process.exit(bad === 0 ? 0 : 1);
