// 本轮交付物最终核验：所有数字从文件读出来，不手写。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'E:/2026-10-03-16-38-27';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

console.log('===== 1) 粘贴版分片（自动切分） =====');
const PDIR = path.join(ROOT, 'DOUBAO-DELIVERY/粘贴版');
const files = fs.readdirSync(PDIR).filter((f) => /^\d+_/.test(f)).sort();
console.log(`  实际 ${files.length} 片：${files.join(' | ')}`);
const SEP = '-'.repeat(60) + '\n';
const bodies = [];
for (const f of files) {
  const t = fs.readFileSync(path.join(PDIR, f), 'utf8');
  const i = t.indexOf(SEP);
  const body = i === -1 ? t : t.slice(i + SEP.length);
  const head = t.slice(0, i === -1 ? 0 : i);
  const range = (head.match(/正文行 (\d+)–(\d+)/) || [])[1] ? `${(head.match(/正文行 (\d+)–(\d+)/) || [])[1]}–${(head.match(/正文行 (\d+)–(\d+)/) || [])[2]}` : '—';
  console.log(`  ${f.padEnd(46)} ${kb(Buffer.byteLength(t)).padStart(9)}  行 ${range}`);
  // 只收「分片」：00_全量单条.md 是整份原文，拼进去会重复（我第一版就踩了这个）
  if (/^0[1-9]_/.test(f)) bodies.push(body);
}
const src = rd(path.join(ROOT, 'DOUBAO-DELIVERY/豆包开测版.md'));
const rejoined = bodies.join('\n');
console.log(`\n  正文拼回 === 开测版：${rejoined === src ? '是 ✓' : '否 ✗'}   sha256 ${sha(rejoined)}  vs  ${sha(src)}`);
console.log(`  开测版 ${kb(Buffer.byteLength(src))} / ${src.split('\n').length} 行`);

console.log('\n===== 2) DOUBAO-DELIVERY 全部档 =====');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const all = walk(path.join(ROOT, 'DOUBAO-DELIVERY'));
let total = 0;
for (const p of all.sort()) {
  const s = fs.statSync(p).size; total += s;
  console.log(`  ${String(s).padStart(8)}  ${path.relative(path.join(ROOT, 'DOUBAO-DELIVERY'), p).replace(/\\/g, '/')}`);
}
console.log(`  合计 ${all.length} 文件 / ${kb(total)}`);

console.log('\n===== 3) 站点 vs 线上 =====');
const SITE = path.join(ROOT, 'site-doubao');
const sfiles = walk(SITE).map((p) => path.relative(SITE, p).replace(/\\/g, '/')).sort();
console.log(`  本地 site-doubao：${sfiles.length} 文件 / ${kb(sfiles.reduce((a, f) => a + fs.statSync(path.join(SITE, f)).size, 0))}`);

console.log('\n===== 4) 快照里的运行态标注（本轮新增） =====');
for (const f of ['bootstrap-root.sample.json', 'health.sample.json', 'gate-403.sample.json', 'approval-single.sample.json']) {
  const j = JSON.parse(rd(path.join(ROOT, 'EVAL-PACKAGE/snapshot', f)));
  const v = j._volatile || {};
  console.log(`  ${f.padEnd(32)} bytes=${String(j.bytes).padStart(5)}  运行态字段 ${String((v.fields || []).length).padStart(2)} 个  观测字节 [${(v.bytes_observed || []).join(', ')}]`);
}
