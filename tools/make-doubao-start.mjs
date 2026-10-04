#!/usr/bin/env node
// 生成「豆包开测版」：一份**以产出为组织单位**的交付物。
//
// 与 make-doubao-package.mjs 产出的「合并型」文档不同：
//   合并型 = 把原始材料按原顺序拼起来，读者自己组织；
//   开测版 = 按「豆包要产出什么」重排 —— 开篇即任务、六维变可勾选清单、
//            输出模板变填空表。目标：读完就能开工。
//
// 文档正文放在 tools/templates/doubao-start.md（占位符 {{VAR}}），
// **不在 JS 模板字符串里写 Markdown** —— 那样满屏反引号要转义，极易出错。
//
// 数据来源仍是单一数据源：
//   - 证据/契约速查表：DOUBAO-DELIVERY/多文件版/（由 make-doubao-package.mjs 生成）
//   - 规模数字：从活服务契约派生（路由数/门控数/枚举数）
//   - 基线数字：从 .tests-summary.json + agent-trial-baseline.json 读，不硬编码
// 所以先跑 make-doubao-package.mjs，再跑本脚本。
import fs from 'node:fs';
import path from 'node:path';
import { digestIn, assertContractDigestsAgree, assertSamplesStable } from './contract-sync.mjs';

const ROOT = 'E:/2026-10-03-16-38-27';
const OUT = path.join(ROOT, 'DOUBAO-DELIVERY');
const MULTI = path.join(OUT, '多文件版');
const PKG = path.join(ROOT, 'EVAL-PACKAGE');
const TEMPLATE = path.join(ROOT, 'tools/templates/doubao-start.md');
const BASE = 'http://127.0.0.1:8787';

const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const readSafe = (p) => (fs.existsSync(p) ? rd(p) : `<<缺失：${p}>>`);

// 把内嵌文档的标题整体降级，避免与外层 `## 第 N 步` 撞级。跳过围栏代码块（里面的 # 不是标题）。
function demote(md, n = 1) {
  let fence = false;
  return md.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    const m = line.match(/^(#{1,6}) (.*)$/);
    if (!m) return line;
    return '#'.repeat(Math.min(6, m[1].length + n)) + ' ' + m[2];
  }).join('\n');
}

// ---------- 1. 活契约：派生规模数字（不手抄） ----------
let contract = null, contractSource, liveDigest = null;
try {
  const r = await fetch(`${BASE}/v1/openapi.json`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  contract = await r.json();
  liveDigest = contract['x-agent-console']?.contract_digest || null;
  contractSource = `运行中的服务 ${BASE}/v1/openapi.json（实测拉取）`;
} catch (e) {
  contract = JSON.parse(readSafe(path.join(PKG, 'snapshot/contract.openapi.json')));
  contractSource = `快照 EVAL-PACKAGE/snapshot/contract.openapi.json（服务不可达：${e.message}）`;
}

// ★ 护栏：本文件把交付层的证据与速查表内联进来，所以它同时继承了
//   「快照」和「交付层」两个上游的新鲜度 —— 任一与活契约不一致都必须拒绝出包。
assertContractDigestsAgree([
  { label: '快照契约', digest: digestIn(path.join(PKG, 'snapshot/contract.openapi.json')),
    path: 'EVAL-PACKAGE/snapshot/contract.openapi.json' },
  { label: '交付包契约', digest: digestIn(path.join(MULTI, '06_契约全文.openapi.json')),
    path: 'DOUBAO-DELIVERY/多文件版/06_契约全文.openapi.json' },
], liveDigest, BASE);

// ★ 第二道护栏：本文件内联了证据样本，所以样本一旦与活服务语义不符，这里也会把假数字抄进去。
await assertSamplesStable(path.join(PKG, 'snapshot'), BASE);

let routeCount = 0;
const pathCount = Object.keys(contract.paths).length;
const gated = [];
/* 幂等档位一律**从契约数出来**，交付物里的词表与计数绝不手写。
 * 踩过的坑：契约把 `not_enforced` 取消、改成四档之后，交付物的词表还在教评审者
 * `not_enforced` 是合法值 —— 契约改了、文案没改，生成器与契约各说各话。
 * 现在档位名、分布、词表都只有唯一来源：这份 contract。 */
const IDEM_TIERS = ['safe', 'required', 'optional', 'fingerprint_dedup'];
const idemDist = {};
const byTier = {};
for (const [p, ops] of Object.entries(contract.paths)) {
  for (const [m, op] of Object.entries(ops)) {
    routeCount++;
    const lv = (op['x-gate'] || {}).level;
    if (lv && lv !== 'none') gated.push({ m: m.toUpperCase(), p, level: lv });
    const tier = op['x-idempotency'] || 'safe';
    idemDist[tier] = (idemDist[tier] || 0) + 1;
    (byTier[tier] = byTier[tier] || []).push(`${m.toUpperCase()} ${p}`);
  }
}
const idemModel = contract['x-agent-console']?.idempotency_model || '';
if (!idemModel) throw new Error('契约里没有 x-agent-console.idempotency_model —— 词表没有派生来源，拒绝生成');
const tiersOf = (t) => byTier[t] || [];
const fmtList = (arr, n = 6) => arr.slice(0, n).map((x) => '`' + x + '`').join('、');
const IDEM_DIST = IDEM_TIERS.filter((t) => idemDist[t]).map((t) => `\`${t}\` ${idemDist[t]}`).join(' / ');
const digest = contract['x-agent-console']?.contract_digest || 'n/a';
const version = contract['x-agent-console']?.version || contract.info?.version || 'n/a';

const findEnum = (root, key) => {
  let found = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object' || found.length) return;
    for (const [k, v] of Object.entries(n)) {
      if (k === key && v && Array.isArray(v.enum)) { found = v.enum; return; }
      walk(v);
    }
  };
  walk(root);
  return found;
};
const envelope = (contract.components && contract.components.schemas && contract.components.schemas.Envelope) || {};
const codeEnum = findEnum(envelope, 'code');
const actionEnum = findEnum(envelope, 'action');

// ---------- 2. 基线数字：只读文件，绝不硬编码 ----------
let summary = null, baseline = null;
try { if (fs.existsSync(path.join(ROOT, '.tests-summary.json'))) summary = JSON.parse(rd(path.join(ROOT, '.tests-summary.json'))); } catch {}
try { if (fs.existsSync(path.join(PKG, 'agent-trial-baseline.json'))) baseline = JSON.parse(rd(path.join(PKG, 'agent-trial-baseline.json'))); } catch {}

const un = (v) => (v == null ? '未采集' : String(v));
const bt = baseline || {};
const su = summary || {};
/* 新鲜度优先：`.tests-summary.json` 由 run-tests.sh 每次重采；
 * `agent-trial-baseline.json` 是「偶尔手动跑 --json」的产物，会静默过期。
 * 之前让 baseline 优先，结果交付物里印着一组比实测更旧的 tokens ——
 * 同一概念有两个来源时，让**每次都会更新的那个**说话。 */
const nChecks = (su.agent_trial && su.agent_trial.checks != null) ? su.agent_trial.checks : (bt.checks ? bt.checks.length : null);
const nPass = (su.agent_trial && su.agent_trial.pass != null) ? su.agent_trial.pass : (bt.checks ? bt.checks.filter((c) => c.pass).length : null);
const rt = (su.agent_trial && su.agent_trial.roundtrips != null) ? su.agent_trial.roundtrips : (bt.roundtrips != null ? bt.roundtrips : null);
const tk = (su.agent_trial && su.agent_trial.tokens != null) ? su.agent_trial.tokens : (bt.tokens_spent != null ? bt.tokens_spent : null);
const nSuites = su.suites_count != null ? su.suites_count : null;
const nAsserts = su.assertion_total != null ? su.assertion_total : null;

// ---------- 3. 证据：从多文件版裁（保留 1-5，去掉第 6 节 baseline 全量） ----------
let evidence = readSafe(path.join(MULTI, '02_关键证据原文.md')).replace(/^# 关键证据原文（全部来自运行中的真实服务）\n/, '');
{
  const cut = evidence.indexOf('## 6.');
  if (cut >= 0) evidence = evidence.slice(0, cut).trimEnd();
}
const contractDigest = readSafe(path.join(MULTI, '03_契约速查表.md')).replace(/^# 契约速查表（从活服务派生，非手抄）\n/, '');

/* 引用规范段里的「示例值」必须是**本次快照的真值**，从本页自己的证据里现场取。
 * 踩过的坑（同一课第二次）：规范教人「引用要逐字可核」，而它自己举的例子用的是
 * 上一次快照的值 —— 重采一次，规范本身就成了假引用。示例值现在只认活证据。 */
const secBodyOf = (re) => {
  const hit = evidence.split(/\n## /).slice(1).find((s) => re.test(s.split('\n')[0]));
  return hit || '';
};
const SAMPLE_403_ID = (secBodyOf(/403/).match(/apr_[0-9a-f]{6}/) || [])[0] || '';
const SAMPLE_ROOT_BYTES = (secBodyOf(/零知识/).match(/"bytes":\s*(\d+)/) || [])[1] || '';
if (!SAMPLE_403_ID || !SAMPLE_ROOT_BYTES)
  throw new Error('证据里取不到引用规范要用的示例真值 —— 拒绝生成（示例值不能是空的或手写的）');

// ---------- 4. 读模板 → 替换占位符 ----------
let doc = readSafe(TEMPLATE);
if (doc.startsWith('<<缺失')) throw new Error('模板缺失：' + TEMPLATE);

// 先替换含标题的内嵌文档（它们需要降级），再替换标量
doc = doc.replace('{{EVIDENCE}}', demote(evidence));
doc = doc.replace('{{CONTRACT_DIGEST_TABLE}}', demote(contractDigest));

const vars = {
  PATH_COUNT: pathCount,
  ROUTE_COUNT: routeCount,
  GATED_COUNT: gated.length,
  GATED_LIST: gated.map((g) => '`' + g.m + ' ' + g.p + '`').join('、'),
  IDEM_MODEL: idemModel,
  SAMPLE_403_ID: SAMPLE_403_ID,
  SAMPLE_ROOT_BYTES: SAMPLE_ROOT_BYTES,
  IDEM_DIST: IDEM_DIST,
  OPTIONAL_COUNT: tiersOf('optional').length,
  OPTIONAL_LIST: fmtList(tiersOf('optional')),
  FP_DEDUP_COUNT: tiersOf('fingerprint_dedup').length,
  FP_DEDUP_LIST: fmtList(tiersOf('fingerprint_dedup')),
  REQUIRED_COUNT: tiersOf('required').length,
  REQUIRED_LIST: fmtList(tiersOf('required'), 2),
  CODE_ENUM_COUNT: codeEnum.length,
  ACTION_ENUM_COUNT: actionEnum.length,
  N_CHECKS: un(nChecks),
  N_PASS: un(nPass),
  N_RT: un(rt),
  N_TK: un(tk),
  N_SUITES: un(nSuites),
  N_ASSERTS: un(nAsserts),
  VERSION: version,
  DIGEST: digest,
  CONTRACT_SOURCE: contractSource,
};
for (const [k, v] of Object.entries(vars)) doc = doc.split('{{' + k + '}}').join(String(v));

// 体积占位：先按「估算值长度」占位算一遍，再填真实值（偏差 <10 字节，可忽略）
const startKB = Math.round(Buffer.byteLength(doc.replace('{{SIZE_KB}}', '000KB'), 'utf8') / 1024);
doc = doc.split('{{SIZE_KB}}').join(startKB + 'KB');

// 残留占位符检查：不静默留下 {{...}} 给读者
const leftover = doc.match(/\{\{[A-Za-z_]+\}\}/g);
if (leftover) console.warn('  [warn] 未替换的占位符：' + [...new Set(leftover)].join(', '));

/* 词表护栏（两条，都是这次真踩出来的）：
 * ① 契约里已退役的档位名，不许在交付物里继续当「合法值」教给评审者 —— 正面检查做不到，
 *    反面检查可以：把已退役的名字钉在这里，契约里没有它、而文档里拿反引号引了它，就拒绝出文件。
 * ② 词表必须是契约原文的**派生值**而不是重写 —— 文档里必须真的出现 idempotency_model 字符串。 */
const RETIRED_TIERS = ['not_enforced'];
for (const t of RETIRED_TIERS) {
  if (!(t in idemDist) && doc.includes('`' + t + '`'))
    throw new Error(`交付物把契约中已不存在的档位 \`${t}\` 当作合法值写出（词表漂移）`);
}
if (!doc.includes(idemModel))
  throw new Error('交付物的幂等词表不是从契约 x-agent-console.idempotency_model 派生的');

// 引用规范自证：示例值必须在本页证据里逐字命中（否则规范段自己就是假引用）
if (!doc.includes('"bytes": ' + SAMPLE_ROOT_BYTES))
  throw new Error('引用规范的示例值在本页证据里找不到 —— 规范段自证失败');
if (!doc.includes(SAMPLE_403_ID))
  throw new Error('引用规范提到的真实 approval_id 在本页证据里找不到 —— 规范段自证失败');

const filename = '豆包开测版.md';
fs.writeFileSync(path.join(OUT, filename), doc, 'utf8');

const size = fs.statSync(path.join(OUT, filename)).size;
console.log('已生成 ' + filename + '（' + size + ' 字节 / ' + Math.round(size / 1024) + 'KB）');
console.log(`  契约 ${pathCount} 路径 / ${routeCount} 条 · 门控 ${gated.length} · 幂等四档 ${IDEM_DIST}`);
console.log(`  枚举 error.code ${codeEnum.length} · hints[].action ${actionEnum.length}`);
console.log(`  基线 ${un(nChecks)} 判定 / ${un(rt)} 往返 / ${un(tk)} tokens · ${un(nSuites)} 套 / ${un(nAsserts)} 断言`);

// ---------- 5. 交付说明：流水线最后一步生成（此时所有档位都就位，大小才是真的） ----------
// 放在这里而不是 make-doubao-package.mjs，是因为那时开测版还没生成，表格里的它会缺一行。
const OUT_README = path.join(OUT, 'README_交付说明.md');
const szKB = (rel) => {
  const p = path.join(OUT, rel);
  return fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) + 'KB' : '未生成';
};
const dirKB = (rel) => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else n += fs.statSync(p).size;
    }
  };
  walk(path.join(OUT, rel));
  return Math.round(n / 1024) + 'KB';
};
const contractBytes = (() => {
  try { return fs.statSync(path.join(MULTI, '06_契约全文.openapi.json')).size; } catch { return '未采集'; }
})();
const nCheckpoints = (doc.match(/- \[ \] \*\*/g) || []).length;

let readme = readSafe(path.join(ROOT, 'tools/templates/delivery-readme.md'));
if (readme.startsWith('<<缺失')) throw new Error('README 模板缺失');
const rvars = {
  CONTRACT_BYTES: contractBytes,
  SZ_START: szKB('豆包开测版.md'),
  SZ_PKG: szKB('agent-console-评测包-单文件版.md'),
  SZ_LITE: szKB('agent-console-评测包-精简版.md'),
  SZ_MULTI: dirKB('多文件版'),
  SZ_PROMPT: szKB('可直接粘贴的短提示词.txt'),
  N_CHECKPOINTS: nCheckpoints,
  PATH_COUNT: pathCount,
  ROUTE_COUNT: routeCount,
  GATED_COUNT: gated.length,
  CODE_ENUM_COUNT: codeEnum.length,
  ACTION_ENUM_COUNT: actionEnum.length,
  OPTIONAL_COUNT: tiersOf('optional').length,
  FP_DEDUP_COUNT: tiersOf('fingerprint_dedup').length,
  IDEM_DIST: IDEM_DIST,
};
for (const [k, v] of Object.entries(rvars)) readme = readme.split('{{' + k + '}}').join(String(v));
const rleft = readme.match(/\{\{[A-Za-z_]+\}\}/g);
if (rleft) console.warn('  [warn] README 未替换占位符：' + [...new Set(rleft)].join(', '));
fs.writeFileSync(OUT_README, readme, 'utf8');
console.log('已生成 README_交付说明.md（' + fs.statSync(OUT_README).size + ' 字节）');
