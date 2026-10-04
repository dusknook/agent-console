#!/usr/bin/env node
/**
 * verify-citation.mjs —— 让「引用」变成可机器核对的事实
 *
 * 动机（真实事件，非假设）：
 *   某外部评测者两次声称「取自评测包第 N 节原文」并给出具体值：
 *     ① 403 示例的 approval_id = apr_9399f6
 *     ② GET / 示例的 bytes     = 929
 *   实测两处出处均不存在：
 *     · 403 示例原文的 id 是 apr_822943（材料里 apr_ 前缀 ID 仅此一个）
 *     · 该节的 bytes 是 1260（就在它声称的那一节内）
 *     · 材料里既无 9399f6 也无 929；材料最高到「第 7 步 + 附 ABC」，没有「第 8 节」
 *   人工核这两个断言花了多轮 grep —— 本脚本把成本降到一次调用。
 *
 * 纪律：**引用类说法必须能被逐字命中，且出处必须真实存在。**
 *       给出处 ≠ 有出处。伪造出处是幻觉升级，不是幻觉减少。
 *       这与「解释性文字必须由机器可核对的字段支撑」是同一条纪律的延伸。
 *
 * 用法：
 *   node tools/verify-citation.mjs                                  # 跑内置回归（含两处伪造值反例）
 *   node tools/verify-citation.mjs --claims <file.json|->           # 批量校验（- = 从 stdin 读）
 *   node tools/verify-citation.mjs --claim <file>|<locator>|<literal>
 *   node tools/verify-citation.mjs --index                          # 列出全部可引用位置
 *   node tools/verify-citation.mjs --no-color
 *
 * ⚠ Windows 注意：**不要用 argv 传中文**。文件路径与节标题都含中文，
 *   经 shell/execFileSync 的 argv 通道会丢字（实测：真实值被误判为不存在）。
 *   跨进程调用一律走 --claims 的 stdin 通道（JSON），既避开编码问题，又能批量。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/2026-10-03-16-38-27';
// 只有这些目录会被当作「可引用材料」。sqlite / 二进制不在内。
const SCAN_DIRS = ['DOUBAO-DELIVERY', 'site-doubao', 'EVAL-PACKAGE'];
const TEXT_EXT = new Set(['.md', '.json', '.txt', '.html', '.htm']);

const argv = process.argv.slice(2);
const NO_COLOR = argv.includes('--no-color') || !process.stdout.isTTY;
const C = {
  pass: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  fail: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ---------- 1. 建索引：文件 → 节（标题 + 正文 + 起始行） ----------
/** @type {{file:string, title:string, body:string, startLine:number}[]} */
const SECTIONS = [];

const walk = (dir) => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    if (e.isDirectory()) { walk(rel); continue; }
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;

    const lines = rd(p).split('\n');
    let cur = null;
    // 文件本身也算一个「节」，便于整文件级命中
    SECTIONS.push({ file: rel, title: '(全文)', body: lines.join('\n'), startLine: 1 });
    lines.forEach((l, i) => {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(l);
      if (m) {
        if (cur) cur.body = lines.slice(cur.startLine - 1, i).join('\n');
        cur = { file: rel, title: m[2], body: lines.slice(i).join('\n'), startLine: i + 1 };
        SECTIONS.push(cur);
      }
    });
    if (cur) cur.body = lines.slice(cur.startLine - 1).join('\n');
  }
};
SCAN_DIRS.forEach(walk);

// ---------- 2. 判定单条引用 ----------
/**
 * @param {{file:string, locator:string, literal:string, expect?:string}} claim
 * @returns {{ok:boolean, reason:string, where?:string}}
 */
function check(claim) {
  const { file, locator, literal } = claim;

  // (a) 文件是否存在
  const fileSections = SECTIONS.filter((s) => s.file === file || s.file.endsWith('/' + file));
  if (!fileSections.length) {
    const near = [...new Set(SECTIONS.map((s) => s.file))].filter((f) => f.includes(file.replace(/\.md$/, '')));
    return { ok: false, reason: `文件不存在：${file}` + (near.length ? `（含该名的：${near.slice(0, 3).join(' / ')}）` : '') };
  }

  // (b) 出处（节）是否存在
  let scope = fileSections;
  if (locator) {
    const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
    const hit = fileSections.filter((s) => norm(s.title).includes(norm(locator)) && s.title !== '(全文)');
    if (!hit.length) {
      const titles = fileSections.filter((s) => s.title !== '(全文)').map((s) => s.title);
      return {
        ok: false,
        reason: `出处不存在：${file} 里没有匹配「${locator}」的节` +
          (titles.length ? `（该文件的节：${titles.slice(0, 6).join(' / ')}${titles.length > 6 ? ' …' : ''}）` : ''),
      };
    }
    scope = hit;
  }

  // 只声明出处、不给片段 → 到此即通过
  if (!literal) {
    return { ok: true, reason: `出处存在（${scope.length} 处）`, where: scope.map((s) => `${s.file}:${s.startLine} ${s.title}`).join('\n      ') };
  }

  // (c) 片段是否逐字命中
  const found = scope.filter((s) => s.body.includes(literal));
  if (!found.length) {
    // 给点线索：把片段里的「数字/ID」抽出来，看是不是连**该出处文件**里都没有。
    // ⚠ 必须限定在该文件内，不能用「全部材料」——否则说明性文档里把某个值当反例举出来
    //   （本次交付物就写了 apr_9399f6 / 929 作反面案例），会让存在性判定被自我污染。
    const fileText = fileSections.map((s) => s.body).join('\n');
    const tok = literal.match(/[A-Za-z_]*\d[\w.]*|apr_[0-9a-f]+/g) || [];
    const nowhere = tok.filter((t) => !fileText.includes(t));
    return {
      ok: false,
      reason: `片段未逐字命中：${JSON.stringify(literal)}` +
        (nowhere.length ? `\n      └ 其中这些词在 ${file} 里都不存在：${nowhere.join(', ')}` : ''),
    };
  }
  return { ok: true, reason: '片段逐字命中', where: found.map((s) => `${s.file}:${s.startLine} ${s.title}`).join('\n      ') };
}

// ---------- 3. 内置回归：真实值必须 PASS，伪造值必须 FAIL ----------
/** 从材料里动态读真值，避免用例随快照重采而失效 */
function dynamicTruth() {
  const sec403 = SECTIONS.find((s) => s.file.endsWith('多文件版/02_关键证据原文.md') && /403/.test(s.title));
  const secRoot = SECTIONS.find((s) => s.file.endsWith('多文件版/02_关键证据原文.md') && /零知识/.test(s.title));
  const id = sec403 && (sec403.body.match(/apr_[0-9a-f]{6}/) || [])[0];
  const bytes = secRoot && (secRoot.body.match(/"bytes":\s*(\d+)/) || [])[1];
  /* 403 的 bytes 也是活服务的自报体长（响应里含 self-referential 的字节数），
   * 每次重采都会漂 —— 曾经这里写死 1916，重生成一次就红。
   * 真值一律现场读，用例才不会随快照重采而失效。 */
  const bytes403 = sec403 && (sec403.body.match(/"bytes":\s*(\d+)/) || [])[1];
  return { id, bytes, bytes403, has403: !!sec403, hasRoot: !!secRoot };
}

function runSelfTest() {
  const t = dynamicTruth();
  console.log(C.bold('\n自带事实索引'));
  console.log(`  403 示例真实 approval_id = ${t.id ? C.bold(t.id) : '（采不到）'}`);
  console.log(`  GET / 示例真实 bytes     = ${t.bytes ? C.bold(t.bytes) : '（采不到）'}`);
  console.log(`  真实值场景用例：${t.has403 ? '有' : '无'} 403 节 / ${t.hasRoot ? '有' : '无'} 「零知识」节`);

  const F403 = 'DOUBAO-DELIVERY/多文件版/02_关键证据原文.md';
  const cases = [
    // —— 反例：外部评测者的两条「伪造出处」声明，必须被驳回 ——
    { name: '反例① approval_id = apr_9399f6（它称取自第4节 403 示例原文）', claim: { file: F403, locator: '被门控时的完整 403 响应', literal: 'apr_9399f6' }, expect: 'fail' },
    { name: '反例② "bytes": 929（它称取自第8节 零知识第一次请求原文）', claim: { file: F403, locator: '零知识 agent 的第一次请求', literal: '"bytes": 929' }, expect: 'fail' },
    { name: '反例③ 出处「第8节」本身（材料最高到第7步+附ABC）', claim: { file: F403, locator: '第8节', literal: '' }, expect: 'fail' },
    { name: '反例④ 引用不存在的文件', claim: { file: 'DOUBAO-DELIVERY/多文件版/09_不存在的文件.md', locator: '', literal: 'x' }, expect: 'fail' },
    // —— 正例：真实值必须通过（防误杀） ——
    { name: `正例① 它说对的 403 = ${t.bytes403 || '?'} 字节`, claim: { file: F403, locator: '被门控时的完整 403 响应', literal: t.bytes403 ? `"bytes": ${t.bytes403}` : '__none__' }, expect: t.bytes403 ? 'pass' : 'skip' },
    { name: '正例② 真实值 {ID}', claim: { file: F403, locator: '被门控时的完整 403 响应', literal: t.id || '__none__' }, expect: t.id ? 'pass' : 'skip' },
    { name: '正例③ 真实值 "bytes": {N}', claim: { file: F403, locator: '零知识 agent 的第一次请求', literal: t.bytes ? `"bytes": ${t.bytes}` : '__none__' }, expect: t.bytes ? 'pass' : 'skip' },
  ];

  let bad = 0, ran = 0;
  console.log(C.bold('\n回归用例'));
  for (const c of cases) {
    if (c.expect === 'skip') { console.log(C.dim(`  SKIP  ${c.name}`)); continue; }
    ran++;
    const r = check(c.claim);
    const got = r.ok ? 'pass' : 'fail';
    const good = got === c.expect;
    if (!good) bad++;
    const tag = good ? C.pass('  OK  ') : C.fail('  BAD ');
    console.log(`${tag}${c.name}`);
    console.log(C.dim(`        判定=${got}（期望 ${c.expect}）  ${r.reason.split('\n')[0]}`));
    if (r.reason.includes('\n')) console.log(C.dim(r.reason.split('\n').slice(1).join('\n')));
  }
  console.log(`\n  ${ran - bad}/${ran} 用例符合预期` + (bad ? C.fail(`  —— ${bad} 项异常`) : C.pass('  —— 校验器有牙')) + '\n');
  return bad ? 1 : 0;
}

// ---------- 4. 入口 ----------
/** 批量校验：JSON 数组 [{file, locator, literal, expect?, name?}] */
function runClaims(list) {
  let bad = 0, ran = 0, recorded = 0;
  for (const c of list) {
    const r = check(c);
    const got = r.ok ? 'pass' : 'fail';
    /* snapshot_bound：标注为「当时快照如此」的历史记录。证据原文每次重采都会漂
     * （approval_id 是随机的、bytes 是自报体长），所以这些条目**必然**会与当前快照不符 ——
     * 那不是缺陷，是记录。它们照样打印（留痕），但不计入失败，否则一条永远红的检查
     * 会让人把整套闸门当成噪音。当前值的门禁在内置回归里（现场派生）。 */
    if (c.snapshot_bound && c.expect && got !== c.expect) {
      recorded++;
      console.log(C.dim('RECORD') + '  ' + (c.name || c.file) + '  —— 快照绑定，与当前快照不符属预期（不改写历史记录）');
      continue;
    }
    if (c.expect) {
      ran++;
      if (got !== c.expect) bad++;
    }
    console.log((r.ok ? C.pass('PASS  ') : C.fail('FAIL  ')) + (c.name || `${c.file} | ${c.locator || '(全文)'} | ${c.literal || ''}`));
    console.log('      ' + r.reason.split('\n').join('\n      '));
    if (r.where) console.log('      → ' + r.where);
  }
  if (ran) console.log(`\n  ${ran - bad}/${ran} 条符合 expect` + (bad ? C.fail(`  —— ${bad} 条异常`) : C.pass('  —— 全部符合')));
  if (recorded) console.log(C.dim(`  （另有 ${recorded} 条快照绑定的历史记录，按设计不计入判定）`));
  console.log();
  return bad ? 1 : 0;
}

const iClaims = argv.indexOf('--claims');
const iClaim = argv.indexOf('--claim');
if (iClaims >= 0) {
  const src = argv[iClaims + 1];
  let raw;
  try {
    raw = (!src || src === '-') ? fs.readFileSync(0, 'utf8') : rd(src);
  } catch (e) {
    console.error('读不到 claim 列表：' + e.message + '\n用法：--claims <file.json|->（- 表示 stdin）');
    process.exit(2);
  }
  let list;
  try { list = JSON.parse(raw); } catch (e) { console.error('claim 列表不是合法 JSON：' + e.message); process.exit(2); }
  if (!Array.isArray(list)) { console.error('claim 列表应为 JSON 数组'); process.exit(2); }
  process.exit(runClaims(list));
} else if (argv.includes('--index')) {
  const byFile = {};
  SECTIONS.filter((s) => s.title !== '(全文)').forEach((s) => { (byFile[s.file] ||= []).push(`${s.startLine}: ${s.title}`); });
  for (const [f, ss] of Object.entries(byFile)) {
    console.log(C.bold(`\n${f}`));
    ss.forEach((s) => console.log('  ' + s));
  }
  console.log();
} else if (iClaim >= 0) {
  const raw = argv[iClaim + 1];
  if (!raw) { console.error('用法：--claim "文件|出处节|逐字片段"'); process.exit(2); }
  const [file, locator, ...rest] = raw.split('|');
  const r = check({ file, locator: locator || '', literal: rest.join('|') });
  console.log((r.ok ? C.pass('PASS  ') : C.fail('FAIL  ')) + raw);
  console.log('      ' + r.reason);
  if (r.where) console.log('      → ' + r.where);
  process.exit(r.ok ? 0 : 1);
} else {
  process.exit(runSelfTest());
}
