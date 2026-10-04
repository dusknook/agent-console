#!/usr/bin/env node
// 生成「给豆包」的交付层：不用压缩包，改成
//   A) 单文件全文版（一个 .md 上传即可）
//   B) 编号多文件版（逐个上传）
//   C) 可直接粘贴进对话框的短提示词
// 数据来源：EVAL-PACKAGE/ 现有文件 + 运行中服务的活契约（不手抄）
import fs from 'node:fs';
import path from 'node:path';
import { digestIn, assertContractDigestsAgree, assertSamplesStable } from './contract-sync.mjs';

const ROOT = 'E:/2026-10-03-16-38-27';
const PKG = path.join(ROOT, 'EVAL-PACKAGE');
const SNAPSHOT_CONTRACT = path.join(PKG, 'snapshot/contract.openapi.json');
const OUT = path.join(ROOT, 'DOUBAO-DELIVERY');
const BASE = 'http://127.0.0.1:8787';
// 线上站点地址（短提示词里给「贴 URL」通道用）。域名由发布时确定，可用环境变量覆盖。
const SITE = process.env.SITE_URL || 'https://agent-console-eval.app.workbuddy.host';
// 前端页真实体积（文案里用来对比「索引 vs 整页」），从文件算，不写死
const FRONT_KB = (() => {
  try { return Math.round(fs.statSync(path.join(ROOT, 'ai-workbench.html')).size / 1024) + 'KB'; } catch { return '几十 KB'; }
})();

const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const jr = (p) => JSON.parse(rd(p));
const readSafe = (p) => (fs.existsSync(p) ? rd(p) : `<<缺失：${p}>>`);

// ---------- 0. 测试结果：一律从落盘文件读，绝不硬编码 ----------
// 教训：这里曾经写死「11 套 / 404 断言 / 23135 tokens」，而实际早就变成 422 / 23320。
// 硬编码的数字不会报错，只会在某天悄悄变成谎话 —— 所以改成读机器可读的采集结果。
const SUMMARY_PATH = path.join(ROOT, '.tests-summary.json');
const BASELINE_PATH = path.join(PKG, 'agent-trial-baseline.json');
let summary = null;
try { if (fs.existsSync(SUMMARY_PATH)) summary = jr(SUMMARY_PATH); } catch (e) { console.warn('读 .tests-summary.json 失败：' + e.message); }
let baseline = null;
try { if (fs.existsSync(BASELINE_PATH)) baseline = jr(BASELINE_PATH); } catch (e) { console.warn('读 agent-trial-baseline.json 失败：' + e.message); }

function baselineSection() {
  const b = baseline;
  const s = summary;
  const at = s?.at ? s.at.slice(0, 19).replace('T', ' ') + ' UTC' : '（未记录）';

  if (!b && !s) {
    return `## §5 基线数据

**本次未采集到机器可读的测试结果**（\`.tests-summary.json\` 与 \`agent-trial-baseline.json\` 都不存在）。

我不在这里填数字 —— 硬编码的断言数会随测试增长悄悄过时，那恰恰是这份交付想避免的事。
要拿到权威数字，请跑 \`bash run-tests.sh\`（它会在末尾自动写出 \`.tests-summary.json\`）。`;
  }

  const checks = b?.checks?.length ?? s?.agent_trial?.checks;
  const pass = b ? b.checks.filter((c) => c.pass).length : s?.agent_trial?.pass;
  const fail = checks != null && pass != null ? checks - pass : null;
  const rt = b?.roundtrips ?? s?.agent_trial?.roundtrips ?? null;
  const tk = b?.tokens_spent ?? s?.agent_trial?.tokens ?? null;
  const per = rt && tk ? Math.round(tk / rt) : (s?.agent_trial?.tokens_per_roundtrip ?? null);
  const suites = s?.suites_count ?? null;
  const asserts = s?.assertion_total ?? null;
  const afail = s?.assertion_failed_total ?? null;

  const unknown = (v, unit = '') => (v == null ? `未采集${unit}` : String(v));

  return `## §5 基线数据（我跑出来的，可被推翻）

**本节所有数字都由测试自己落盘、本文件直接读取 —— 不是我手写进去的。**
来源：\`.tests-summary.json\`（由 \`tools/collect-tests.mjs\` 在 \`run-tests.sh\` 末尾解析生成）
采集时间：${at}

\`\`\`
${unknown(checks)} 项判定 → ${unknown(pass)} PASS / ${unknown(fail)} FAIL
往返总次数····················· ${unknown(rt)} 次
累计响应体 tokens················ ≈ ${unknown(tk)}
平均每往返 tokens················ ≈ ${unknown(per)}
\`\`\`

配套 ${unknown(suites)} 套测试 / ${unknown(asserts)} 项检查 / ${unknown(afail)} 失败。

> **关于浮动**：token 数与延迟每次运行会有**个位数浮动**（响应体里含实测延迟等运行时字段，
> 这是「不编数」的代价）。对不上 ± 几位数属正常；但**结构性差异**——
> 多一次往返、多一个 FAIL、多一个 blocker——**请直接指出**，那才是信号。

**这些数字都可以被推翻 —— 请自己跑一遍（§B）。如果对不上，那才是我该先解释的。**`;
}

// 把被内嵌文档的标题整体降 n 级，避免与顶层 § 撞级导致目录糊掉。
// 必须跳过围栏代码块 —— 里面的 `# 注释` 不是标题。
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

fs.mkdirSync(path.join(OUT, '多文件版'), { recursive: true });

// ---------- 1. 活契约（优先从服务拉，拉不到就退回快照） ----------
let contract, contractRaw, contractSource, liveDigest = null;
try {
  const r = await fetch(`${BASE}/v1/openapi.json`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  // 保留原始字节：本包的自我一致性靠「响应体逐字节可复现」，
  // 重新序列化会改掉空白/缩进，导致字节数对不上，不能自证。
  contractRaw = (await r.text()).replace(/\r\n/g, '\n');
  contract = JSON.parse(contractRaw);
  liveDigest = contract['x-agent-console']?.contract_digest || null;
  contractSource = `运行中的服务 ${BASE}/v1/openapi.json（实测拉取，${Buffer.byteLength(contractRaw, 'utf8')} 字节）`;
} catch (e) {
  contractRaw = readSafe(SNAPSHOT_CONTRACT);
  contract = JSON.parse(contractRaw);
  contractSource = `快照 EVAL-PACKAGE/snapshot/contract.openapi.json（服务不可达：${e.message}）`;
}

// ★ 护栏：本包的契约走 live、证据走快照 —— 两个源不同新鲜度就会自相矛盾。
//   只要服务可达，快照必须与活契约同摘要，否则拒绝出包（不要靠"我下次记得重采"）。
assertContractDigestsAgree(
  [{ label: '快照契约', digest: digestIn(SNAPSHOT_CONTRACT), path: 'EVAL-PACKAGE/snapshot/contract.openapi.json' }],
  liveDigest, BASE);

// ★ 第二道护栏：契约摘要一致 ≠ 证据样本还准。
//   样本里描述的是**活服务的响应**，其中含运行态字段（_meta.request_id / latency_ms / budget.reserved…），
//   它们一变，交付物里抄下来的 bytes 就成了假数字。重放一遍、只屏蔽 _volatile.fields 后比语义，
//   出现清单外差异即拒绝出包 —— 这样「运行态字段悄悄变多」不会再逃过。
await assertSamplesStable(path.join(PKG, 'snapshot'), BASE);

// ---------- 2. 契约速查表（从活数据派生，不手抄） ----------
const sch = contract.components.schemas;
const envelope = sch.Envelope;
const enumOf = (node, key) => {
  // 在 Envelope 里挖出 error.code / hints[].action 的 enum
  const out = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.enum && n.__k === key) { n.enum.forEach((v) => out.add(v)); return; }
    for (const [k, v] of Object.entries(n)) {
      if (k === key && v && typeof v === 'object' && Array.isArray(v.enum)) v.enum.forEach((x) => out.add(x));
      walk(v);
    }
  };
  walk(node);
  return [...out];
};

function findEnumPath(obj, targetPath) {
  // targetPath 形如 ['code'] 或 ['action']
  let found = null;
  const walk = (n, trail) => {
    if (!n || typeof n !== 'object' || found) return;
    if (trail.length && trail[trail.length - 1] === targetPath[0] && Array.isArray(n.enum)) { found = n.enum; return; }
    for (const [k, v] of Object.entries(n)) walk(v, [...trail, k]);
  };
  walk(obj, []);
  return found || [];
}

const codeEnum = findEnumPath(envelope, ['code']);
const actionEnum = findEnumPath(envelope, ['action']);

let routeTable = [];
for (const [p, ops] of Object.entries(contract.paths)) {
  for (const [m, op] of Object.entries(ops)) {
    routeTable.push({
      method: m.toUpperCase(),
      path: p,
      tags: (op.tags || []).join(','),
      gate: (op['x-gate'] || {}).level || 'none',
      requires: Array.isArray(op['x-requires']) ? op['x-requires'].join(' / ') : (op['x-requires'] || '-'),
      idem: op['x-idempotency'] || '-',
      params: (op.parameters || []).map((x) => x.name + (x.required ? '*' : '')).join(' ') || '-',
      summary: (op.summary || '').split('。')[0],
    });
  }
}

const mdRouteTable = [
  '| # | 方法 | 路径 | tag | gate | requires | 幂等 | 参数(带*=必填) | 说明 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...routeTable.map((r, i) =>
    `| ${i + 1} | ${r.method} | \`${r.path}\` | ${r.tags} | ${r.gate === 'none' ? '—' : '**' + r.gate + '**'} | ${r.requires} | ${r.idem} | ${r.params} | ${r.summary} |`),
].join('\n');

const gatePolicy = (contract['x-agent-console']?.gate?.policy || [])
  .map((g) => `- \`${g.route}\` → level=\`${g.level}\`：${g.why}`)
  .join('\n');
const gateBypassRule = contract['x-agent-console']?.gate?.bypass_rule || '';
/* 幂等词表必须是契约原文的派生值，不是重写 —— 重写就会漂：
 * 契约把 `not_enforced` 取消、改成四档之后，词表还照旧教评审者 `not_enforced` 是合法值。 */
const idemModel = contract['x-agent-console']?.idempotency_model || '';
if (!idemModel) throw new Error('契约里没有 x-agent-console.idempotency_model —— 幂等词表没有派生来源，拒绝生成');
const IDEM_TIERS = ['safe', 'required', 'optional', 'fingerprint_dedup'];
const idemDist = {};
for (const ops of Object.values(contract.paths))
  for (const op of Object.values(ops)) {
    const t = op['x-idempotency'] || 'safe';
    idemDist[t] = (idemDist[t] || 0) + 1;
  }
const IDEM_DIST = IDEM_TIERS.filter((t) => idemDist[t]).map((t) => `\`${t}\` ${idemDist[t]}`).join(' / ');

// 从契约的 Envelope schema **现场派生**形状摘要 —— 不手写。
// 手写清单会漂移：曾漏掉 gate 的六个子字段，结果只读速查表的人（agent / 评审者）
// 以为契约没声明 gate，把「响应里有、契约里没有」当缺陷报上来。
// 派生就不可能漏：契约声明了什么，这里就显示什么。
function brief(s, depth) {
  if (!s) return '?';
  if (Array.isArray(s.enum)) return `enum(${s.enum.length}): ${s.enum.slice(0, 3).join(' | ')}${s.enum.length > 3 ? ' | …' : ''}`;
  if (s.type === 'array') {
    const it = brief(s.items, depth + 1);
    return `array<${it && typeof it === 'object' ? '{' + Object.keys(it).join(', ') + '}' : it}>`;
  }
  if (s.type === 'object' && s.properties && depth < 3) {
    const o = {};
    for (const [k, v] of Object.entries(s.properties)) o[k] = brief(v, depth + 1);
    return o;
  }
  return s.type || 'any';
}
const envelopeShape = JSON.stringify(
  Object.fromEntries(Object.entries(envelope.properties).map(([k, v]) => [k, brief(v, 0)])),
  null, 2);

const digest = `# 契约速查表（从活服务派生，非手抄）

来源：${contractSource}
版本：\`${contract['x-agent-console']?.version || contract.info?.version}\`
契约摘要：\`contract_digest = ${contract['x-agent-console']?.contract_digest || 'n/a'}\`
规模：**${Object.keys(contract.paths).length} 路径 / ${routeTable.length} 路由 / ${Object.keys(sch).length} 个 schema（只有 Envelope）**

> 这份表是压缩版速查。**完整契约**见 06 号文件（或单文件版的附录 A）。
> 判定问题请以完整契约为准，本表只用来快速定位。

---

## 一、全部 ${routeTable.length} 条路由

${mdRouteTable}

**列含义**
- \`gate\`：**授权**轴 —— 非 \`none\` 表示 HTTP 网关在进 handler 之前就截停，返回 403，业务代码一行不跑
- \`requires\`：**裁决**轴 —— 结果谁来定。取值 \`auto\` / \`human\` / \`agent\` / \`human_or_llm\`；
  多值用 \`/\` 分隔（如 \`auto / human\`）= 这个端点**可能返回其中之一**，运行时响应里的 \`requires\` 必是其一
- \`idem\`：**幂等**档 —— 契约原文（${idemModel}）。本服务实测分布：${IDEM_DIST}

## 二、门控策略原文

${gatePolicy || '（无）'}

${gateBypassRule ? '绕过规则：' + gateBypassRule : ''}

## 三、统一信封 Envelope（唯一 schema）

\`\`\`json
${envelopeShape}
\`\`\`

## 四、两个枚举词表（可穷举分支）

**error.code（${codeEnum.length} 项）**
\`\`\`
${codeEnum.join('\n')}
\`\`\`

**hints[].action（${actionEnum.length} 项）** —— 给 agent 做 \`if\` 分支的机器词表
\`\`\`
${actionEnum.join('\n')}
\`\`\`

## 五、service 自述（x-agent-console）

\`\`\`json
${JSON.stringify(contract['x-agent-console'], null, 1)}
\`\`\`
`;

// ---------- 3. 关键证据原文 ----------
const snap = (f) => readSafe(path.join(PKG, 'snapshot', f));

/* 引用规范段里的「示例值」必须是**本次快照的真值**。
 * 踩过的坑（同一课第二次）：规范教人「引用要逐字可核」，而它自己举的例子
 * 用的是上一次快照的值（"bytes": 1260 / apr_822943）—— 重采一次，规范本身就成了假引用。
 * 所以示例值改成占位符，在这里现场从快照派生，并在写文件前**自证**：
 * 示例值必须真的能在本包自己的证据原文里逐字命中。 */
const sampleTruth = {
  SAMPLE_ROOT_BYTES: (snap('bootstrap-root.sample.json').match(/"bytes":\s*(\d+)/) || [])[1] || '',
  SAMPLE_403_ID: (snap('gate-403.sample.json').match(/apr_[0-9a-f]{6}/) || [])[0] || '',
};
// 第三轮外部评审者编出来的值 —— 规范段把它们当**反例**，必须原样保留、不参与替换
const FABRICATED = ['apr_9399f6', '929'];
const applySampleTruth = (text, label) => {
  let out = text;
  for (const [k, v] of Object.entries(sampleTruth)) {
    if (!v) throw new Error(`快照里取不到 ${k} —— 拒绝把空的示例值写进交付物`);
    out = out.split('{{' + k + '}}').join(v);
  }
  const left = out.match(/\{\{[A-Za-z_]+\}\}/g);
  if (left) throw new Error(`${label} 还有没替换的占位符：` + [...new Set(left)].join(', '));
  return out;
};
/** 自证：规范段的示例值必须能在本包证据原文里逐字命中，且不能取到反例值。 */
const assertExampleCitable = () => {
  for (const [k, v] of Object.entries(sampleTruth)) {
    if (!evidence.includes(v)) throw new Error(`引用规范的示例值 ${k}=${v} 在本包证据原文里找不到 —— 规范段自证失败`);
    if (FABRICATED.includes(v)) throw new Error(`示例值 ${k} 取到了反例值 ${v} —— 规范段自己违反规范`);
  }
};

/* 简报里的规模数字同样不许手写：它随 04_背景简报 / pkg §4 一起发出去，
 * 写死就会与同一份文档里的「本轮」数字自相矛盾（实测出现过：§5 说 480、§8 说 487）。
 * 唯一来源仍是 .tests-summary.json。 */
const briefVars = {
  N_SUITES: summary?.suites_count ?? '未采集',
  N_SUITE_ASSERTS: summary?.suites_assert_passed ?? '未采集',
  N_ACCEPTANCE: summary?.acceptance?.items ?? '未采集',
  N_AI_CHECKS: summary?.agent_trial?.checks ?? '未采集',
  N_CHECKS_TOTAL: summary?.assertion_total ?? '未采集',
  N_RT: summary?.agent_trial?.roundtrips ?? baseline?.roundtrips ?? '未采集',
  N_TK: summary?.agent_trial?.tokens ?? baseline?.tokens_spent ?? '未采集',
};
/** 源文件里给「作者自己看」的段落，打包时整段删掉 —— 评审者不该看到生成侧的自言自语。 */
const stripGenOnly = (t) => t.replace(/<!--\s*GEN-ONLY-START\s*-->[\s\S]*?<!--\s*GEN-ONLY-END\s*-->\n?/g, '');
const applyBriefVars = (text, label) => {
  let out = stripGenOnly(text);
  for (const [k, v] of Object.entries(briefVars)) out = out.split('{{' + k + '}}').join(String(v));
  const left = out.match(/\{\{[A-Za-z_]+\}\}/g);
  if (left) throw new Error(`${label} 还有没替换的占位符：` + [...new Set(left)].join(', '));
  if (out.includes('GEN-ONLY')) throw new Error(`${label} 里残留 GEN-ONLY 标记 —— 作者注没删干净`);
  return out;
};

const evidence = `# 关键证据原文（全部来自运行中的真实服务）

> **这是本包最该逐字读的部分。** 下面每一段都是真实响应体，未经改写。
> 读的时候请代入 agent 视角：**只拿到这些字段，我知不知道下一步该干什么？**

---

## 1. ★ 被门控时的完整 403 响应

场景：agent 试图执行一个「产生费用 + 不可逆副作用」的动作，被网关截停。

\`\`\`json
${snap('gate-403.sample.json').trim()}
\`\`\`

**自查问题**
- 它有没有告诉我「**别重试**」？这个信号是**可程序化提取**的，还是只能靠读中文？
- 它指向的下一步端点，**真的存在于契约里**吗？
- 伪造一个 \`X-Approved: true\` 头、或换个 method，能绕过去吗？

---

## 2. 零知识 agent 的第一次请求（\`GET /\`）

一个只知道 base URL 的 agent，第一发就是这里。注意它**没有**被 ${FRONT_KB} 的 HTML 糊一脸。

\`\`\`json
${snap('bootstrap-root.sample.json').trim()}
\`\`\`

---

## 3. 自举入口 \`GET /v1/health\`

\`\`\`json
${snap('health.sample.json').trim()}
\`\`\`

---

## 4. 单查审批单 \`GET /v1/approvals/{id}\`

注意 \`requires\` 字段：**随状态变** —— 还挂着时是 \`human\`，裁决后转 \`auto\`。
这是「agent 拿到 approval_id 后 O(1) 查自己的单子」的端点（改前不存在，只能拉全表 O(n) 自己过滤）。

\`\`\`json
${snap('approval-single.sample.json').trim()}
\`\`\`

---

## 5. 契约的响应头（传输元数据在这里，不在文档体里）

为什么重要：文档体里放 \`generated_at\` 会让契约**不确定**（每次都不同，无法 diff、无法做金标准）。
所以契约里只有 \`contract_digest\`，而传输统计走响应头。

\`\`\`text
${snap('contract.transport-headers.txt').trim()}
\`\`\`

---

## 6. AI 视角测评的原始判定数据（机器可读）

\`\`\`json
${readSafe(path.join(PKG, 'agent-trial-baseline.json')).trim()}
\`\`\`
`;

/* 证据原文已成型 —— 此刻立刻自证引用规范段的示例值可逐字命中。
 * 放在这里而不是写文件前，是为了让失败**早于**任何产物落盘。 */
assertExampleCitable();

// ---------- 4. 短提示词（可直接粘贴进对话框） ----------
const prompt = `你现在的身份不是「评审员」，而是**一个要用这套 HTTP 接口干活的 agent**。

【最快的方式（如果你能访问网址）】
直接抓这一份，它自带全部内容 + 开测步骤，读完即可按里面的清单开工：
${SITE}/start.md
若抓取受限，退到 ${SITE}/pkg-lite.md（不含契约全文）；只要精确契约则 ${SITE}/openapi.json。

我要你评测的是一个「给 AI 用的工作台后端」：单文件 Node 服务，零 npm 依赖，
${routeTable.length} 条路由，外加一份**从活元数据现场派生**的 OpenAPI 契约。
它要解决一个问题：让 agent 在「不该做」的事情上，从「我不该」变成「我不能」——
被门控的端点在 HTTP 层就被截停（403），请求原样落盘成待批单，业务代码一行不跑。

【你会拿到什么】
- 评测任务书：这个产品是什么、你该评哪 6 个维度、哪些是我已知的边界（别当 bug 报）
- 关键证据原文：被门控时的**完整 403 响应**、零知识首次请求的响应、单查审批单、契约响应头
- 契约速查表：全部 ${routeTable.length} 条路由（gate / requires / 幂等 / 参数），以及 error.code 与 hints[].action 两个枚举词表
- 完整 OpenAPI 契约全文
- 背景简报：我的 5 个关键设计决策 + 5 条诚实自评（含我认为自己薄弱的地方）

【我明确不要的】
- 不要评「界面美不美」「响应快不快」——这不是给人用的产品的主体
- 不要把「本机无鉴权、写端点默认档是可选的幂等（不带键就不受约束）、审批单默认永不过期、回放同步阻塞」当漏洞报 —— 这些是我**故意标明**的已知边界
- 不要只有结论没有证据。「我觉得不太好用」对我没有价值；
  「\`POST /v1/act/queue\` 缺 \`Idempotency-Key\` 时返回的 error.code 是 X，但契约没声明这个码」才有价值

【我最想要的（也是最有价值的输出）】
1. **设计出我没想到的 agent 任务，并在其中找出摩擦点。**
   我自己写的测评脚本只覆盖了我已经想到的问题，它证明不了「没有别的问题」。
2. 所有结论都要能**独立复现**：贴出你看到的原始响应片段或字段，不要转述。
3. 明确区分【缺陷】和【设计选择】；严重度用 blocker / friction / nit 三级。
4. **诚实声明你的评估条件**：你执行过代码吗？如果没有，这些结论是**静态推演**，
   请明说 —— 推演和实测的可信度不是一个量级，我需要知道哪些是哪种。
5. 最后请写「我怀疑但没验证的」——这一块比十条泛泛的表扬有用得多。

输出请按任务书里的模板（或你自己的格式），但必须包含上面第 2、3、4、5 点。
`;

// 原压缩包里的文件数（动态数，不硬编码 —— 硬编码的数字迟早撒谎）
let zipCount = 0;
try {
  const zipPath = path.join(ROOT, 'agent-console-eval.zip');
  if (fs.existsSync(zipPath)) {
    // zip 中央目录条目数：只读末尾 64KB 找 EOCD，不解压
    const buf = fs.readFileSync(zipPath);
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { zipCount = buf.readUInt16LE(i + 10); break; }
    }
  }
} catch { /* 数不出来就不写这个数字 */ }

// ---------- 5. 单文件全文版 ----------
const oneFile = `# 豆包评测包 · 单文件版

**文件名建议**：\`agent-console-评测包.md\`
**用途**：原压缩包（\`agent-console-eval.zip\`）无法直接提交给豆包工作，本文件是它的**纯文本等价物**。
全文自包含 —— 不需要解压、不需要下载任何别的东西、不需要联网，读完就拥有全部证据。

契约来源：${contractSource}
契约摘要：\`contract_digest = ${contract['x-agent-console']?.contract_digest || 'n/a'}\`（用途：校验本文件里的契约有没有被改动过）
本文件生成于：${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC（时间戳只属于本交付层；**契约本体是不含时间戳的**，所以它才能逐字节复现）

---

## 目录

| 节 | 内容 |
|---|---|
| §0 | 交付说明（给人看的 30 秒版） |
| §1 | 评测任务书 —— **先读这一节**（你的身份是 agent，不是人） |
| §2 | 关键证据原文（403 完整响应等，最该逐字读） |
| §3 | 契约速查表（${routeTable.length} 路由 + 2 个枚举词表） |
| §4 | 背景简报（5 个设计决策 + 5 条诚实自评） |
| §5 | 我跑出的基线数据 |
| §6 | 输出格式要求 |
| §A | 附录 A：完整 OpenAPI 契约（JSON 原文） |
| §B | 附录 B：如何自己复现（有 Node 22.5+ 才需要看） |

---

## §0 交付说明（给人看的 30 秒版）

这是一份**产品评测交付**，评测对象是一个「**给 AI agent 用的网页/服务**」。
它的第一用户是 AI，所以：

- **评估主体也应该是 AI**。人类点按钮式的验收在这里系统性失效 ——
  人读一句中文就懂了，agent 需要的却是能 \`if\` 的枚举。
- 本文件把原压缩包${zipCount ? `里的 ${zipCount} 个文件` : '中的全部评测文件'}合并成一份纯文本，**内容未删减**（契约全文在附录 A）。
  唯一被排除的是「必须被执行才有意义」的东西：11 套测试脚本、CDP 客户端、\`.sh\`／\`.cmd\` 运行器。
- 如果你（豆包）**无法执行代码**，请照 §1 的「路 B：只能读文件」走，
  并在结论里**声明你是静态推演**。这不掉价，反而让我知道哪些结论硬、哪些软。

**评测对象一句话**：让 agent 在「不该做」的事情上，从「我不该」变成「我不能」。


## §1 评测任务书

${demote(readSafe(path.join(PKG, 'README_FOR_EVALUATOR.md')).replace(/^# 给评估者：先读这一份\n/, ''))}

> 注：上一节提到的 \`snapshot/\` 目录内容，已全部内联在本文件 §2；
> \`EVAL-BRIEF.md\` 即 §4；\`EVAL-TEMPLATE.md\` 即 §6。你不需要任何额外文件。


## §2 关键证据原文

${demote(evidence.replace(/^# 关键证据原文（全部来自运行中的真实服务）\n/, ''))}


## §3 契约速查表

${demote(digest.replace(/^# 契约速查表（从活服务派生，非手抄）\n/, ''))}


## §4 背景简报

${demote(applyBriefVars(readSafe(path.join(PKG, 'EVAL-BRIEF.md')).replace(/^# 背景简报：这个东西是什么，为什么这么做\n/, ''), 'EVAL-BRIEF（pkg §4）'))}


${baselineSection()}


## §6 输出格式要求

${demote(applySampleTruth(readSafe(path.join(PKG, 'EVAL-TEMPLATE.md')).replace(/^# 评估输出模板\n/, ''), 'EVAL-TEMPLATE（pkg §6）'))}


## §A 附录 A：完整 OpenAPI 契约（JSON 原文）

来源：${contractSource}

> 为什么把全文放进来：这份契约是**这个产品的本体**，不是附属文档。
> 它由 \`ROUTES\`（结构）× \`GATE\`（授权）× \`META\`（语义）三份**活数据现场算出**，
> 不落盘、不手写 —— 所以不会随代码迭代漂移。
> 配套测试叫「spec 不撒谎」：声明 gated 的端点真调必须真 403；声明要幂等键的真调必须真 400。

\`\`\`json
${contractRaw.trim()}
\`\`\`


## §B 附录 B：如何自己复现（有 Node 22.5+ 才需要看）

**没有 Node 也不用管这一节。** 纯静态评估完全可以用 §1～§6 做出结论，只是要在报告里声明。

需要 Node 22.5+（\`node:sqlite\` 内置）。**零 npm 依赖，不需要 npm install。**

\`\`\`bash
node server.js        # 1) 起服务，占 8787
node agent-trial.mjs  # 2) 另开终端跑 AI 视角测评（7 类任务 / 20 项判定）
curl -s http://127.0.0.1:8787/v1/openapi.json   # 3) 拉契约自证
\`\`\`

\`agent-trial.mjs\` 的自我约束：**不 import 源码、不读仓库、不依赖中文**，
只用 HTTP 和契约 —— 即它复现的是「一个外部 agent 真实体验到的接口」。

原压缩包内还有：11 套测试脚本、\`acceptance.mjs\`（${summary?.acceptance?.items ?? '全部'} 条人读证据）、
\`acceptance-browser.mjs\`（真双标签页）、\`tools/cdp.mjs\`。这些不放进本文件，
因为**它们的价值在于能被执行**，而纯文本形式执行不了。
`;

/* 词表护栏：幂等词表必须是契约原文的派生值。
 * 只做正面检查（文档里必须出现契约的 idempotency_model 字符串），
 * 不做「不许出现某词」的反面检查 —— §7 对账那一节会**合法地**引用已退役档位名当历史证据。 */
if (!oneFile.includes(idemModel))
  throw new Error('单文件版的幂等词表不是从契约 x-agent-console.idempotency_model 派生的');
fs.writeFileSync(path.join(OUT, 'agent-console-评测包-单文件版.md'), oneFile, 'utf8');

// 精简版：砍掉附录 A（52KB 契约全文）与附录 B —— 防某些入口对单文件文本长度设限被截断。
// 由同一份 oneFile 切出来，保证两版内容永不漂移。
const liteCut = oneFile.split('## §A 附录 A')[0].trimEnd();
const oneFileLite = liteCut + `

## §A 附录 A：完整 OpenAPI 契约

**本精简版不含契约 JSON 全文**（那是 ${Buffer.byteLength(contractRaw, 'utf8')} 字节，全量版才带）。

你依然有两条拿到完整契约的路：

1. 用隔壁 \`agent-console-评测包-单文件版.md\`（全量版，含契约全文）；
2. 或直接调 \`GET http://127.0.0.1:8787/v1/openapi.json\`（服务在跑的话）。

**§3 的契约速查表已经覆盖了 ${routeTable.length} 条路由的全部机器语义**
（gate / requires / 幂等 / 必填参数）+ 两个枚举词表 + Envelope 结构。
只做静态评估的话，速查表 + §2 的 403 原文足够支撑结论 ——
但请注意：**速查表是压缩视图，判定「契约有没有漏声明字段」这类问题必须看全文。**
`;
if (!oneFileLite.includes(idemModel))
  throw new Error('精简版的幂等词表不是从契约 x-agent-console.idempotency_model 派生的');
fs.writeFileSync(path.join(OUT, 'agent-console-评测包-精简版.md'), oneFileLite, 'utf8');

// ---------- 6. 多文件版（可逐个上传） ----------
const D = path.join(OUT, '多文件版');
const f = (name, body) => fs.writeFileSync(path.join(D, name), body, 'utf8');

f('00_先读我.md', `# 先读我 —— 这个包怎么用

这是一份**产品评测交付**。原压缩包没法直接提交给豆包工作，所以拆成可逐个上传的纯文本。

**上传顺序（建议按编号，前 4 件是必读）**

| 编号 | 文件 | 必读 | 是什么 |
|---|---|---|---|
| 00 | 先读我.md | — | 本文件 |
| 01 | 评测任务书.md | ★ | 你的身份是 agent、评哪 6 个维度、哪些是已知边界 |
| 02 | 关键证据原文.md | ★ | 403 完整响应等真实响应体 |
| 03 | 契约速查表.md | ★ | ${routeTable.length} 条路由 + 两个枚举词表 |
| 04 | 背景简报.md | ★ | 5 个设计决策 + 我的 5 条诚实自评 |
| 05 | 输出模板.md | ○ | 我期望的输出格式 |
| 06 | 契约全文.openapi.json | ○ | 完整 OpenAPI（速查表的母本） |

**如果你一次只能传一个文件** —— 优先用隔壁的 \`豆包开测版.md\`：
它按「你要产出什么」组织（开篇即任务 + 可勾选检查清单 + 填空模板），**读完就能开工**。
要完整原始材料，则用 \`agent-console-评测包-单文件版.md\`（这 7 份的合并版，内容未删减）。

**如果你只能粘贴文字** —— 用 \`可直接粘贴的短提示词.txt\`。
它会给你完整的评测立场与要求，配合其中 1～2 个附件即可开工。

---

## 一句话说清评测对象

一个「给 AI agent 用的工作台后端」：单文件 Node 服务、零 npm 依赖、${routeTable.length} 条路由、
契约从活元数据现场派生。它要解决一个问题：

> 让 agent 在「不该做」的事情上，从「**我不该**」变成「**我不能**」。

"我不该"写在提示词里，agent 心情好就遵守；"我不能"写在服务端网关里，agent 想绕也没有路径。
`);

f('01_评测任务书.md', readSafe(path.join(PKG, 'README_FOR_EVALUATOR.md')) + `

---

> 本件配套：02 关键证据原文 · 03 契约速查表 · 04 背景简报 · 05 输出模板 · 06 契约全文
> 文中提到的 \`snapshot/\` 目录内容 = 02 号文件；\`EVAL-BRIEF.md\` = 04 号；\`EVAL-TEMPLATE.md\` = 05 号。
`);

f('02_关键证据原文.md', evidence);
f('03_契约速查表.md', digest);
f('04_背景简报.md', applyBriefVars(readSafe(path.join(PKG, 'EVAL-BRIEF.md')), '04_背景简报.md'));
f('05_输出模板.md', applySampleTruth(readSafe(path.join(PKG, 'EVAL-TEMPLATE.md')), '05_输出模板.md'));
fs.writeFileSync(path.join(D, '06_契约全文.openapi.json'), contractRaw, 'utf8');

// ---------- 7. 短提示词 ----------
fs.writeFileSync(path.join(OUT, '可直接粘贴的短提示词.txt'), prompt, 'utf8');

// ---------- 7.5 根目录交付说明（基础版，可能被覆盖） ----------
// 注意：make-doubao-start.mjs 会在流水线最后一步用 tools/templates/delivery-readme.md
// **覆盖**本文件 —— 因为那时「开测版」才生成，表格里它才有真实大小。
// 这里保留是为了让本脚本能单独运行（不跑 start 脚本时也有一份可用的说明）。
fs.writeFileSync(path.join(OUT, 'README_交付说明.md'), `# 给豆包的评测包 · 交付说明

**原压缩包 \`agent-console-eval.zip\` 无法直接提交给豆包工作，所以这里提供三种纯文本形态。**
内容全部由运行中的真实服务现场派生（契约 ${Buffer.byteLength(contractRaw, 'utf8')} 字节，逐字节可复现），非手抄。

---

## 先决定用哪一版

| 场景 | 用这个 | 大小 |
|---|---|---|
| **只能上传一个文件**（最常见） | \`agent-console-评测包-单文件版.md\` | ${Math.round(fs.statSync(path.join(OUT, 'agent-console-评测包-单文件版.md')).size / 1024)}KB |
| 上传的文件被截断 / 有大小限制 | \`agent-console-评测包-精简版.md\` | ${Math.round(fs.statSync(path.join(OUT, 'agent-console-评测包-精简版.md')).size / 1024)}KB |
| 能上传多个文件 | \`多文件版/\` 里的 7 份（按编号传） | 100KB |
| **只能粘贴文字** | \`可直接粘贴的短提示词.txt\` + 任意 1～2 个附件 | 2.4KB |

**建议路径**：先传「单文件版」，如果豆包反馈读不全，就退到「精简版」；
如果连文件都不能传，就粘贴「短提示词」再把 \`多文件版/02_关键证据原文.md\` 和 \`03_契约速查表.md\` 一起贴进去。

---

## 核心提醒（贴给豆包时值得加一句）

这份包的评估对象是一个「**给 AI agent 用的服务**」，所以**评估主体也应该是 AI**。
人类点按钮式的验收在这里系统性失效：人读一句中文就懂了，agent 需要的却是能 \`if\` 的枚举。
所以请让豆包**以「我是一个要用这套接口干活的 agent」的立场**来评，
而不是「我在评审一份作业」——这两者的结论会差很远。

另外请它在结论里**声明是否执行过代码**：如果只是读文件，那是静态推演，
可信度和实测不是一个量级，我需要知道哪些是哪种。

---

## 目录

\`\`\`
DOUBAO-DELIVERY/
├── README_交付说明.md                    ← 本文件
├── agent-console-评测包-单文件版.md       ← 全量版（含契约全文）
├── agent-console-评测包-精简版.md         ← 无契约全文，防截断
├── 可直接粘贴的短提示词.txt               ← 只能粘贴时用
└── 多文件版/
    ├── 00_先读我.md
    ├── 01_评测任务书.md          ★ 身份 + 6 个评测维度 + 已知边界
    ├── 02_关键证据原文.md        ★ 403 完整响应等真实响应体
    ├── 03_契约速查表.md          ★ ${routeTable.length} 条路由 + 2 个枚举词表
    ├── 04_背景简报.md            ★ 5 个设计决策 + 5 条诚实自评
    ├── 05_输出模板.md
    └── 06_契约全文.openapi.json     完整 OpenAPI
\`\`\`

## 重新生成

\`\`\`bash
node server.js                      # 服务需在 8787
node tools/make-doubao-package.mjs  # 拉活契约 → 重算速查表 → 重建全部文本
\`\`\`

服务不可达时会自动退回 \`EVAL-PACKAGE/snapshot/\` 的快照，并在包头标注来源，不会静默用旧数据。
`, 'utf8');

// ---------- 8. 回执 ----------
const sizes = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else sizes.push([path.relative(ROOT, p).replace(/\\/g, '/'), fs.statSync(p).size]);
  }
};
walk(OUT);
console.log('DOUBAO-DELIVERY 生成完毕');
console.log('契约来源：' + contractSource);
for (const [p, s] of sizes) console.log(`  ${String(s).padStart(8)}  ${p}`);
console.log(`合计 ${sizes.length} 个文件 / ${sizes.reduce((a, [, s]) => a + s, 0)} 字节`);
