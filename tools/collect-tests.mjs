#!/usr/bin/env node
// 把 11 套测试的输出汇总成一份机器可读的 .tests-summary.json。
//
// 为什么需要它：交付包里曾经**硬编码**「11 套 / 404 断言」，而那个数字会随测试增长
// 悄悄过时（写死 23135 tokens 也是同一个病）。数字不报错，只会在某天变成谎话。
// 所以断言数、往返数、token 数一律**从测试输出里解析**，不手写。
//
// 输入（都由 run-tests.sh 落盘）：
//   .testlog-all.txt   套件 1-9 的完整输出（含 "N passed / M failed"）
//   .acceptance.txt    第 10 套：人读证据版验收（含 "验收项 N 通过 M"）
//   .agent-trial.txt   第 11 套：AI 视角验收（含 "N 项判定 → P PASS" 与成本核算）
// 输出：
//   .tests-summary.json
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/2026-10-03-16-38-27';
const rd = (p) => (fs.existsSync(p) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : null);

const warn = [];
const readOrFail = (p) => {
  const t = rd(p);
  if (t === null) warn.push(`缺少 ${p}（该套结果未采集，不编数）`);
  return t || '';
};

// ---------- 套件 1-9：解析 "N passed / M failed" ----------
const log = readOrFail('.testlog-all.txt');
const suites = [];
{
  // run-tests.sh 每套会打印 "  ---- 93 passed / 0 failed ----"
  const re = /(\d+)\s+passed\s*\/\s*(\d+)\s+failed/g;
  let m;
  while ((m = re.exec(log))) suites.push({ passed: +m[1], failed: +m[2] });
}
if (suites.length === 0 && log) warn.push('.testlog-all.txt 里没解析到 "N passed / M failed"，套件结果缺失');

// ---------- 第 10 套：acceptance ----------
const acc = readOrFail('.acceptance.txt');
let acceptance = null;
{
  const m = acc.match(/验收项\s+(\d+)\s+通过\s+(\d+)\s+失败\s+(\d+)/);
  if (m) acceptance = { items: +m[1], passed: +m[2], failed: +m[3] };
  else warn.push('.acceptance.txt 里没解析到 "验收项 N 通过 M 失败 K"');
}

// ---------- 第 11 套：agent-trial ----------
const trial = readOrFail('.agent-trial.txt');
let agentTrial = null;
{
  const m = trial.match(/(\d+)\s+项判定\s*→\s*(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/);
  const r = trial.match(/往返总次数[·．.\s]*(\d+)\s*次/);
  const t = trial.match(/累计响应体 tokens[·．.\s]*≈?\s*(\d+)/);
  const p = trial.match(/平均每往返 tokens[·．.\s]*≈?\s*(\d+)/);
  if (m) {
    agentTrial = {
      checks: +m[1], pass: +m[2], fail: +m[3],
      roundtrips: r ? +r[1] : null,
      tokens: t ? +t[1] : null,
      tokens_per_roundtrip: p ? +p[1] : null,
    };
  } else {
    warn.push('.agent-trial.txt 里没解析到 "N 项判定 → P PASS / Q FAIL"');
  }
}

// ---------- 汇总 ----------
const suitePassed = suites.reduce((a, s) => a + s.passed, 0);
const suiteFailed = suites.reduce((a, s) => a + s.failed, 0);
const suiteCount = suites.length + (acceptance ? 1 : 0) + (agentTrial ? 1 : 0);
const assertionTotal = suitePassed + (acceptance ? acceptance.items : 0) + (agentTrial ? agentTrial.checks : 0);

const out = {
  _note: '由 tools/collect-tests.mjs 从测试输出解析生成 —— 不是手写数字。交付包读它，不硬编码。',
  at: new Date().toISOString(),
  suites_count: suiteCount,
  suites: suites.map((s, i) => ({ n: i + 1, ...s })),
  suites_assert_passed: suitePassed,
  suites_assert_failed: suiteFailed,
  acceptance,
  agent_trial: agentTrial,
  assertion_total: assertionTotal,
  assertion_failed_total: suiteFailed + (acceptance ? acceptance.failed : 0) + (agentTrial ? agentTrial.fail : 0),
  sources: {
    suites: '.testlog-all.txt',
    acceptance: '.acceptance.txt',
    agent_trial: '.agent-trial.txt',
  },
  warnings: warn,
};

fs.writeFileSync(path.join(ROOT, '.tests-summary.json'), JSON.stringify(out, null, 1), 'utf8');

console.log('已写出 .tests-summary.json');
console.log(`  套件数 ${suiteCount}  ·  断言合计 ${assertionTotal}  ·  失败 ${out.assertion_failed_total}`);
console.log(`  套件 1-9：${suitePassed} passed / ${suiteFailed} failed（${suites.length} 套）`);
if (acceptance) console.log(`  第 10 套 验收：${acceptance.passed}/${acceptance.items}`);
if (agentTrial) console.log(`  第 11 套 AI 视角：${agentTrial.pass}/${agentTrial.checks} 判定 · ${agentTrial.roundtrips} 往返 · ${agentTrial.tokens} tokens`);
for (const w of warn) console.log('  [warn] ' + w);
