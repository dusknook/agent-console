#!/usr/bin/env node
/**
 * 打印「本地 ←→ 线上」逐文件 sha256 比对表，并把结果落盘成 Markdown 记录。
 *
 * 与 verify-live.mjs 的分工：
 *   verify-live.mjs  —— 断言用，只回 IDENTICAL / MISMATCH，不一致 exit 1（给 CI/习惯用）
 *   本脚本           —— 记录用，把完整 64 位 sha256 与字节数写成一张可归档的表
 *
 * 用法： node tools/live-hash-table.mjs [--dir site-doubao] [--base https://xxx] [--out 同步核验.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = path.resolve(argOf('--dir', 'site-doubao'));
const BASE = (argOf('--base', 'https://agent-console-eval.app.workbuddy.host')).replace(/\/+$/, '');
const OUT = argOf('--out', null);

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
    } catch (e) { last = e; if (i < tries) await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last;
};

const files = walk(DIR).sort();
const rows = [];
let bad = 0;

for (const f of files) {
  const local = fs.readFileSync(path.join(DIR, f));
  let online = null, err = null;
  try { online = await fetchRetry(BASE + '/' + f.split('/').map(encodeURIComponent).join('/')); }
  catch (e) { err = e; }

  if (!online) { rows.push({ f, ok: false, la: sha(local), lb: local.length, oa: '-', ob: '-', err: err.message }); bad++; continue; }
  const la = sha(local), oa = sha(online);
  const ok = la === oa;
  if (!ok) bad++;
  rows.push({ f, ok, la, lb: local.length, oa, ob: online.length });
}

const marks = rows.map((r) => `${r.ok ? 'IDENTICAL' : 'MISMATCH '} ${r.f}`).join('\n');
console.log(`校验 ${files.length} 个文件：${BASE}/  ←→  ${DIR}\n`);
console.log(marks);

const lines = [];
lines.push(`# 线上 ←→ 本地 逐字节核验（site-doubao）`, '');
lines.push(`- 线上：${BASE}/`);
lines.push(`- 本地：${DIR}`);
lines.push(`- 时间：${new Date().toISOString()}  （本机时钟 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`);
lines.push(`- 结论：**${bad === 0 ? `${files.length}/${files.length} IDENTICAL —— 线上就是本地这一版` : `${bad} 项不一致 —— 没发成功`}**`, '');
lines.push(`| 文件 | 字节 | 本地 sha256 | 线上 sha256 | 判定 |`);
lines.push(`| --- | ---: | --- | --- | :---: |`);
for (const r of rows) {
  lines.push(`| \`${r.f}\` | ${r.lb}${r.ob !== '-' && r.ob !== r.lb ? ` / online ${r.ob}` : ''} | \`${r.la}\` | \`${r.oa}\` | ${r.ok ? '✅ 一致' : '❌ 不一致'} |`);
}
lines.push('', `合计 ${rows.reduce((a, r) => a + r.lb, 0)} 字节。`, '');

const text = lines.join('\n');
if (OUT) { fs.writeFileSync(OUT, text, 'utf8'); console.log(`\n已写入 ${OUT}（${Buffer.byteLength(text)}B）`); }
else console.log('\n' + text);

console.log(bad === 0 ? `\n✔ ${files.length}/${files.length} IDENTICAL` : `\n✖ ${bad} 项不一致`);
process.exit(bad === 0 ? 0 : 1);
