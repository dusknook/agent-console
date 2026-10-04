#!/usr/bin/env node
// 把 DOUBAO-DELIVERY/ 发布成一个静态站点。
// 动机：豆包能接收网址，所以除了「传文件」还要给「贴 URL」这条通道。
//
// 设计要点（顺序即优先级）：
//   1. /pkg.md  —— 全量纯文本，**这是要给豆包的 URL**
//   2. /index.html —— 人读导航 + 摘要；但它本身也必须是有实质内容的页面，
//      因为有些抓取器只吃 HTML、拿不到 .md（内容协商方向反过来想）
//   3. /MANIFEST.json —— 机器可读路径清单，方便 agent 自己找想要的粒度
import fs from 'node:fs';
import path from 'node:path';
import { digestIn, liveDigestOf, assertContractDigestsAgree, assertSamplesStable } from './contract-sync.mjs';

const ROOT = 'E:/2026-10-03-16-38-27';
const SRC = path.join(ROOT, 'DOUBAO-DELIVERY');
const OUT = path.join(ROOT, 'site-doubao');
// 原子发布：全部产物先建在 BUILD，所有自检通过之后才整体替换 OUT。
// 动机（2026-10-03 20:29 真事故）：HTML 自检在写 index.html 之前，这没错；
// 但 `rmSync(OUT)` 在最前面 —— 自检一失败，**旧的好产物已经被删了**，新产物又不完整，
// 目录停在半破碎状态（那次 site-doubao 缺了 index.html 和 MANIFEST.json）。
// 教训是：我上轮只给「契约护栏」做了「先拒绝再删」，却没给「HTML 自检」做同样的事。
// 同一条纪律只做一半，等于没做。所以改成：构建与落盘分离，落盘是一次原子 rename。
const BUILD = OUT + '.build';
const BASE = 'http://127.0.0.1:8787';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const bytes = (p) => fs.statSync(p).size;

if (!fs.existsSync(SRC)) {
  console.error('先跑 tools/make-doubao-package.mjs —— 站点是从交付层派生的，不重复造数据');
  process.exit(1);
}

// ★ 护栏：本站派生自交付层，交付层派生自「live 契约 + 冻结快照」。
//   若交付层本身已与活契约不一致（典型成因：改了契约只重跑生成链、没重采快照），
//   把站点发出去等于把矛盾搬上线。**必须在删旧产物之前拒绝**，否则旧的好的产物也没了。
const liveDigest = await liveDigestOf(BASE);
assertContractDigestsAgree(
  [{ label: '交付包契约', digest: digestIn(path.join(SRC, '多文件版/06_契约全文.openapi.json')),
     path: 'DOUBAO-DELIVERY/多文件版/06_契约全文.openapi.json' }],
  liveDigest, BASE);

// ★ 同样的第二道护栏，也放在 rmSync 旧产物之前：样本语义对不上就别上线，
//   而且要先拒绝、再删 —— 否则连旧的好的产物一起没了。
await assertSamplesStable(path.join(ROOT, 'EVAL-PACKAGE/snapshot'), BASE);

// 注意这里清的是 **BUILD**，不是正式目录 —— 正式目录要等全部自检通过才动。
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD, 'files'), { recursive: true });

// ---------- 1. 契约（交付层里的原始字节，已是 live 派生） ----------
const contractRaw = rd(path.join(SRC, '多文件版/06_契约全文.openapi.json'));
const contract = JSON.parse(contractRaw);

// 服务是否还在跑 —— 只用于在页面上标注"契约新鲜度"（liveDigest 已在护栏里取过）
const digest = contract['x-agent-console']?.contract_digest || 'n/a';
const freshNote = liveDigest
  ? (liveDigest === digest
      ? `<b>已核对</b>：与当前运行中的服务一致（<code>${digest}</code>）`
      : `<b>注意</b>：本站契约 <code>${digest}</code> 与运行中服务 <code>${liveDigest}</code> 不一致，请以服务为准`)
  : `服务未运行，无法核对新鲜度（本站契约 <code>${digest}</code>）`;

// ---------- 2. 派生路由表与枚举 ----------
const rows = [];
for (const [p, ops] of Object.entries(contract.paths)) {
  for (const [m, op] of Object.entries(ops)) {
    rows.push({
      method: m.toUpperCase(), path: p,
      gate: (op['x-gate'] || {}).level || 'none',
      requires: Array.isArray(op['x-requires']) ? op['x-requires'].join(' / ') : (op['x-requires'] || '-'),
      idem: op['x-idempotency'] || '-',
      params: (op.parameters || []).map((x) => x.name + (x.required ? '*' : '')).join(' ') || '—',
      summary: (op.summary || '').split('。')[0],
    });
  }
}
const findEnum = (node, key) => {
  let hit = null;
  const walk = (n, trail) => {
    if (!n || typeof n !== 'object' || hit) return;
    if (trail[trail.length - 1] === key && Array.isArray(n.enum)) { hit = n.enum; return; }
    for (const [k, v] of Object.entries(n)) walk(v, [...trail, k]);
  };
  walk(node, []);
  return hit || [];
};
const codeEnum = findEnum(contract.components.schemas.Envelope, 'code');
const actionEnum = findEnum(contract.components.schemas.Envelope, 'action');
const gated = rows.filter((r) => r.gate !== 'none');
const gatePolicy = (contract['x-agent-console']?.gate?.policy || []);
/* 幂等档位：计数、词表一律从契约派生。站点是给人读的第一入口，
 * 词表漂了比契约漂了更难发现 —— HTML 里的枚举没人会去跟 JSON 对。 */
const IDEM_TIERS = ['safe', 'required', 'optional', 'fingerprint_dedup'];
const idemModel = contract['x-agent-console']?.idempotency_model || '';
if (!idemModel) throw new Error('契约里没有 x-agent-console.idempotency_model —— 站点词表没有派生来源，拒绝生成');
const tierCount = (t) => rows.filter((r) => (r.idem || 'safe') === t).length;
const optionalRows = rows.filter((r) => r.idem === 'optional');
const fpDedupRows = rows.filter((r) => r.idem === 'fingerprint_dedup');
const IDEM_DIST = IDEM_TIERS.filter((t) => tierCount(t)).map((t) => `<code>${t}</code> ${tierCount(t)}`).join(' / ');
const IDEM_CLASS = { safe: 'safe', required: 'must', optional: 'opt', fingerprint_dedup: 'fp' };

// 产品自带前端的真实体积（用于「首页会不会被大 HTML 糊一脸」这句）——
// 曾经这里写死「80KB」，硬编码的数字迟早撒谎。现在从文件算。
const frontBytes = (() => {
  try { return fs.statSync(path.join(ROOT, 'ai-workbench.html')).size; } catch { return null; }
})();
const frontKB = frontBytes ? Math.round(frontBytes / 1024) + 'KB' : '大体积';

// ---------- 3. 拷贝原始文件（给能抓原始文本的抓取器） ----------
const copy = {
  '豆包开测版.md': ['start.md', '★★ 开测版：以产出为组织单位（开篇即任务、六维变可勾选清单、模板变填空表）—— <b>首选入口</b>'],
  'agent-console-评测包-单文件版.md': ['pkg.md', '全量纯文本评测包（含契约全文）—— 要完整材料时用'],
  'agent-console-评测包-精简版.md': ['pkg-lite.md', '精简版（不含契约全文），防抓取被截断'],
  '可直接粘贴的短提示词.txt': ['prompt.txt', '短提示词：只能粘贴文字时用'],
};
const manifest = [];
for (const [from, [to, what]] of Object.entries(copy)) {
  fs.copyFileSync(path.join(SRC, from), path.join(BUILD, to));
  manifest.push({ path: '/' + to, bytes: bytes(path.join(BUILD, to)), what });
}
fs.copyFileSync(path.join(SRC, '多文件版/06_契约全文.openapi.json'), path.join(BUILD, 'openapi.json'));
manifest.push({ path: '/openapi.json', bytes: bytes(path.join(BUILD, 'openapi.json')), what: '完整 OpenAPI 契约（唯一 schema 是 Envelope）' });

const multi = ['00_先读我.md', '01_评测任务书.md', '02_关键证据原文.md', '03_契约速查表.md', '04_背景简报.md', '05_输出模板.md'];
for (const f of multi) {
  fs.copyFileSync(path.join(SRC, '多文件版', f), path.join(BUILD, 'files', f));
  manifest.push({ path: '/files/' + f, bytes: bytes(path.join(BUILD, 'files', f)), what: f.replace(/^\d+_/, '').replace(/\.md$/, '') });
}

// ---------- 4. 证据原文 ----------
const evidence = rd(path.join(SRC, '多文件版/02_关键证据原文.md'));
const grab = (title) => {
  const i = evidence.indexOf(`## ${title}`);
  if (i < 0) return '';
  const rest = evidence.slice(i);
  const j = rest.indexOf('\n---\n', 10);
  const block = j < 0 ? rest : rest.slice(0, j);
  const m = block.match(/```json\n([\s\S]*?)\n```/);
  return m ? m[1] : '';
};
const gate403 = grab('1. ★ 被门控时的完整 403 响应');
const bootstrap = grab('2. 零知识 agent 的第一次请求（`GET /`）');
const approvalSingle = grab('4. 单查审批单 `GET /v1/approvals/{id}`');

// ---------- 5. index.html ----------
const rowHtml = rows.map((r, i) => `<tr class="${r.gate !== 'none' ? 'gated' : ''}">
<td class="n">${i + 1}</td><td><span class="m m-${r.method.toLowerCase()}">${r.method}</span></td>
<td><code>${esc(r.path)}</code></td>
<td>${r.gate === 'none' ? '<span class="dim">—</span>' : `<span class="tag gate">${r.gate}</span>`}</td>
<td><span class="tag req-${String(r.requires).split(/[\s/]+/)[0]}">${r.requires}</span></td>
<td><span class="tag idem-${IDEM_CLASS[r.idem] || 'opt'}">${r.idem}</span></td>
<td class="params">${esc(r.params)}</td><td class="sum">${esc(r.summary)}</td></tr>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Console 评测包 · 给 AI 评审者的交付</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a19;--dim:#6b6b68;--line:#e4e4e0;--card:#fff;--accent:#0f766e;--warn:#b45309;--gate:#b91c1c;--code:#f4f4f2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:26px;margin:0 0 6px}
h2{font-size:19px;margin:44px 0 12px;padding-top:18px;border-top:1px solid var(--line)}
h3{font-size:15px;margin:22px 0 8px}
p{margin:10px 0}
code{font-family:"Cascadia Mono",Consolas,monospace;font-size:.88em;background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto;font-family:"Cascadia Mono",Consolas,monospace;font-size:12.5px;line-height:1.55;max-height:460px}
.lead{color:var(--dim);margin:0 0 18px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 0}
.badge{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:12.5px;color:var(--dim)}
.badge b{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.callout{border-left:3px solid var(--accent);background:#f0fdfa}
.warn{border-left:3px solid var(--warn);background:#fffbeb}
.gatecall{border-left:3px solid var(--gate);background:#fef2f2}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card)}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f6f6f4;font-weight:600;position:sticky;top:0}
tr.gated{background:#fff7f7}
td.n{color:var(--dim);text-align:right;width:28px}
td.params{font-family:Consolas,monospace;font-size:12px;color:var(--dim)}
td.sum{color:var(--dim)}
.dim{color:var(--dim)}
.m{font-weight:600;font-size:11.5px;padding:1px 6px;border-radius:4px}
.m-get{background:#ecfdf5;color:#047857}.m-post{background:#eff6ff;color:#1d4ed8}.m-put{background:#fef3c7;color:#92400e}
.tag{font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.tag.gate{background:#fee2e2;color:#b91c1c;border-color:#fecaca;font-weight:600}
.req-human{background:#ede9fe;color:#6d28d9}.req-auto{background:#f1f5f9;color:#475569}.req-human_or_llm{background:#fce7f3;color:#be185d}.req-agent{background:#fef3c7;color:#92400e}
.idem-safe{background:#f1f5f9;color:#475569}.idem-must{background:#eff6ff;color:#1d4ed8}.idem-opt{background:#ecfdf5;color:#047857}.idem-fp{background:#fff7ed;color:#c2410c}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.chip{font-family:Consolas,monospace;font-size:11.5px;background:var(--card);border:1px solid var(--line);border-radius:5px;padding:2px 7px}
a{color:var(--accent)}
ul{margin:8px 0;padding-left:22px}
li{margin:5px 0}
.path{font-family:Consolas,monospace;font-size:12.5px}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}
</style>
</head>
<body><main>

<h1>Agent Console · 评测包</h1>
<p class="lead">一个「给 AI agent 用的工作台接口」的交付包。<b>第一用户是 AI，所以评估主体也应该是 AI。</b></p>
<div class="badges">
<span class="badge">版本 <b>${contract['x-agent-console']?.version || 'v6'}</b></span>
<span class="badge">路由 <b>${rows.length}</b></span>
<span class="badge">门控 <b>${gated.length}</b></span>
<span class="badge">error.code <b>${codeEnum.length}</b> 枚举</span>
<span class="badge">hints.action <b>${actionEnum.length}</b> 枚举</span>
<span class="badge">契约 <b>${Buffer.byteLength(contractRaw, 'utf8')}</b> 字节</span>
<span class="badge">digest <b>${digest}</b></span>
</div>

<div class="card gatecall">
<p style="margin:0"><b>先抓这一份就能开工：<a href="/start.md">/start.md</a>（开测版）</b><br>
<span class="dim">它按「你要产出什么」组织：开篇即任务、六个评测维度变成可勾选的检查清单、输出模板变成填空表。
读完（约 ${Math.round(bytes(path.join(BUILD, 'start.md')) / 1024)}KB）就能直接动手，不需要再找别的文件。</span></p>
</div>

<h2>0 · 如果你是 AI，从这里开始</h2>
<div class="card callout">
<p><b>你的身份不是「评审员」，而是一个要用这套 HTTP 接口干活的 agent。</b>这两者的结论会差很远。</p>
<p>人类点按钮式的验收在这个产品上<b>系统性失效</b> —— 但原因不是「界面不够好」，而是：</p>
<ul>
<li>人读一句中文就懂了；<b>agent 需要能 <code>if</code> 的枚举</b>，不是需要解读的散文。</li>
<li>人觉得「一次响应 700 tokens 而已」；<b>agent 的上下文就是预算</b>，每次往返都在扣。</li>
<li>人「报错了就看看怎么了」；<b>agent 会重试到死</b> —— 除非错误里有明确的停止信号。</li>
</ul>
<p style="margin-bottom:0"><b>所以如果你只做静态推演（不执行代码），请在结论里明说。</b>推演与实测的可信度不是一个量级，我需要知道哪条是哪种。</p>
</div>

<h2>1 · 评测对象</h2>
<p>一个单文件 Node 后端 + 单文件前端，<b>零 npm 依赖</b>（只用 Node 22.5+ 内置的 <code>node:sqlite</code>）。核心不是页面，是 <code>/v1/*</code> 这组接口，外加一份<b>由运行中的服务现场派生</b>的 OpenAPI 契约（不手写、不落盘，所以不会随代码迭代漂移）。</p>
<div class="card gatecall"><p style="margin:0"><b>它想解决的一个具体问题：</b>让 agent 在「不该做」的事情上，从「<b>我不该</b>」变成「<b>我不能</b>」。<br><span class="dim">"我不该"写在提示词里，agent 心情好就遵守；"我不能"写在服务端网关里，agent 想绕也没有路径 —— 被门控的端点在 HTTP 层就被截停，请求原样落盘成待审批单，业务代码一行不跑。能跑它的代码只有一行，在「人批准」的回放里。</span></p></div>

<h2>2 · 评什么（六个维度）</h2>
<div class="grid">
<div class="card"><h3>① 契约自足性</h3><p>只看契约，能否回答：哪些端点会被门控、原因写清楚没？调用前知道哪些参数必填、哪些写操作要幂等键吗？错误码可穷举吗？<b>有没有「说了会发生、却没说身体长什么样」的地方？</b></p></div>
<div class="card"><h3>② 错误信息的可操作性</h3><p>403 有没有告诉 agent「<b>别重试</b>」？这个信号是<b>可程序化提取</b>的，还是只能读中文？它指向的下一步端点真的存在吗？伪造请求头或换 method 能绕过吗？</p></div>
<div class="card"><h3>③ 上下文经济性</h3><p>一次典型任务几次往返？契约本身多重？有没有「为拿一个字段被迫拉一整张表」？返回的东西里多少是给 agent 的、多少是给人界面的？</p></div>
<div class="card"><h3>④ 行为可预测性</h3><p>重试同一请求会不会重复开单、重复扣钱？并发两次会不会都成功（双扣）？拿到一个 id 能不能 O(1) 查到，而不是拉全表过滤？</p></div>
<div class="card"><h3>⑤ 收敛性</h3><p>被挂起后，能否明确知道「现在该人接手了，我不该再动」？人处理完能否查到<b>明确终态</b>而非反复轮询？有没有永远等不到的状态（死等）？</p></div>
<div class="card"><h3>⑥ 自举成本</h3><p>零知识 agent 从「只知道一个 base URL」到「知道该干什么」要几次往返？第一发会不会被 ${frontKB} 的 HTML 糊一脸？</p></div>
</div>

<h2>3 · 已知边界：这些<b>不是 bug</b>，别当缺陷报</h2>
<p>这个项目有一条原则叫<b>「降级诚实」</b> —— 不确定的写清楚，做不到的标出来。下面这些是<b>故意</b>的，可以讨论，但不要当漏洞报：</p>
<div class="card warn"><ol>
<li><b>默认无鉴权</b>：同机任何进程都能调裁决端点。这是「本机单人工具」的前提。补救开关存在（设 <code>APPROVAL_SECRET</code>），默认关。</li>
<li><b>网关先于业务校验</b>：不存在的 <code>action_id</code> 也会被挂起（回放时才 404）。理论上 agent 可以刷待批队列。<b>真实部署需按请求方限流 —— 这是已知缺口。</b></li>
<li><b>写端点的默认幂等档是可选的，不是强制</b>：契约里<b>如实</b>写成「${esc(idemModel)}」（实测分布 ${IDEM_DIST}）。<b>带上 <code>Idempotency-Key</code> 就重放首次响应，不带则不受任何约束。</b>这是已声明的取舍，不是设计选择。</li>
<li><b>回放是同步的</b>：长任务会阻塞裁决请求。</li>
<li><b>前端有一份离线 mock</b>：后端没开时页面降级为浏览器内模拟，降级时它<b>如实写在页脚</b>「闸门守的是本页内存」，不假装还在守。</li>
</ol></div>
<p>如果你发现<b>已知边界之外</b>的问题，那才是我想要的东西。如果你发现上面某条「其实比写的更严重」，也请说 —— 那是我的诚实标注不够诚实。</p>

<h2>4 · 关键证据：被门控时的完整 403 响应</h2>
<p>场景：agent 试图执行一个「产生费用 + 不可逆副作用」的动作，被网关截停。<b>请逐字段读，然后问自己：只拿到这个，我知不知道下一步该干什么？</b></p>
<pre>${esc(gate403.trim())}</pre>

<h2>5 · 路由总表（${rows.length} 条，从活元数据派生）</h2>
<p class="dim">列含义：<code>gate</code>=授权轴（非 none 即网关截停，403，业务代码一行不跑）；<code>requires</code>=裁决轴（结果谁来定，多值用 / 分隔表示可能返回其中之一）；<code>幂等</code>=四档 <code>safe</code> 读 / <code>required</code> 必带键 / <code>optional</code> 可选带键（带即重放，不带不受约束） / <code>fingerprint_dedup</code> 门控端点按内容指纹去重。参数带 <code>*</code> 为必填。</p>
<div style="max-height:620px;overflow:auto;border:1px solid var(--line);border-radius:8px">
<table><thead><tr><th>#</th><th>方法</th><th>路径</th><th>gate</th><th>requires</th><th>幂等</th><th>参数</th><th>说明</th></tr></thead>
<tbody>
${rowHtml}
</tbody></table></div>

<h3>门控策略原文（为什么这几个要被拦）</h3>
<ul>${gatePolicy.map((g) => `<li><code>${esc(g.route)}</code> → <span class="tag gate">${esc(g.level)}</span>：${esc(g.why)}</li>`).join('')}</ul>

<h2>6 · 两个枚举词表</h2>
<p><b>这是这个产品对 agent 最有价值的部分。</b>关键指令押注在自然语言上是缺陷：「停止重试」这四个字对跨语区模型没有稳定的解析契约 —— 换个模型、换个语区，分支就可能走错，代价是白烧上下文。</p>
<h3><code>error.code</code>（${codeEnum.length} 项，可穷举分支）</h3>
<div class="chips">${codeEnum.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
<h3><code>hints[].action</code>（${actionEnum.length} 项，给 agent 做 <code>if</code> 的机器词表）</h3>
<div class="chips">${actionEnum.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
<p class="dim">配套机制：传输层对 <code>action</code> 做运行时校验，任何不在词表内的值会在响应里现形（<code>_meta.hint_action_violation</code>）；测试层断言它恒为空 —— 否则将来谁加了 hint 忘了 action，契约的 enum 就会比现实少一个值。</p>

<h2>7 · 原始文件（要全文就抓这些）</h2>
<table><thead><tr><th>路径</th><th>字节</th><th>内容</th></tr></thead><tbody>
${manifest.map((m) => `<tr><td class="path"><a href="${m.path}">${m.path}</a></td><td>${m.bytes}</td><td>${esc(m.what)}</td></tr>`).join('')}
</tbody></table>
<p><b>推荐抓取次序：</b><code>/start.md</code>（<b>开测版，首选</b> —— 按产出组织，读完即可开工）→ 要完整原始材料则 <code>/pkg.md</code>（全量含契约全文）→ 若嫌大则 <code>/pkg-lite.md</code>（不含契约全文）→ 需要精确契约结构则 <code>/openapi.json</code>。<br>
能只粘贴文字时用 <code>/prompt.txt</code>（2.4KB，含完整评测立场与要求）。</p>

<h2>8 · 另外两段证据</h2>
<h3>零知识 agent 的第一次请求 <code>GET /</code></h3>
<p class="dim">一个只知道 base URL 的 agent 第一发就是这里。注意它<b>没有</b>被 ${frontKB} 的 HTML 糊一脸。</p>
<pre>${esc(bootstrap.trim())}</pre>
<h3>单查审批单 <code>GET /v1/approvals/{id}</code></h3>
<p class="dim">注意 <code>requires</code> 随状态变：还挂着时是 <code>human</code>，裁决后转 <code>auto</code>。这是「拿到 approval_id 后 O(1) 查自己那张单子」的端点（改前不存在，只能拉全表 O(n) 自己过滤）。</p>
<pre>${esc(approvalSingle.trim())}</pre>

<h2>9 · 输出要求</h2>
<div class="card callout"><ol>
<li><b>你能独立复现的数据</b>（跑了什么、看到什么），不要只有结论。</li>
<li><b>每个问题附证据</b>：哪个端点、哪个字段、什么响应片段（贴原文，不要转述）。「我觉得不太好用」没有用。</li>
<li><b>区分「设计选择」和「缺陷」</b>，严重度用 <code>blocker</code>（走不通）/ <code>friction</code>（走得通但代价大）/ <code>nit</code>三级。</li>
<li><b>声明你的评估条件</b>：执行过代码吗？如果没有，请明说是静态推演。</li>
<li><b>写「我怀疑但没验证的」</b> —— 这一块比十条泛泛的表扬有用得多。</li>
</ol></div>
<p><b>我最想要的输出：设计出我自己没覆盖到的 agent 任务，并在其中找出摩擦点。</b>我写的测评脚本只证明「我修的那三处真的修好了」，证明不了「没有别的问题」。</p>

<footer>
契约来源：运行中的服务现场派生（原始字节，未重排）· ${freshNote}<br>
页面上所有路由、枚举、门控策略均由 <code>ROUTES × GATE × META</code> 派生，非手抄。<br>
本站由 <code>tools/make-doubao-site.mjs</code> 从 <code>DOUBAO-DELIVERY/</code> 派生 —— 单一数据源，站点与文件包内容不会漂移。
</footer>
</main></body></html>
`;
// 生成即自检：HTML 正文里不许有 markdown 残留。
// 这个坑踩过两次（「**系统性失效**」「**首选入口**」）—— markdown 粗体写进 HTML 会
// 原样显示成星号，而无头截图在全页缩略图里根本看不出来。所以让生成器自己拦住，
// 别指望每次都能靠分段截图抓到。
{
  const residues = [];
  const lines = html.split('\n');
  lines.forEach((l, i) => {
    // 只看 HTML 正文（排除 <pre>...<script> 之类可能含原文的块由正则近似处理）
    if (/\*\*/.test(l) && !/^\s*(\/\/|\*)/.test(l)) residues.push('行 ' + (i + 1) + ': ' + l.trim().slice(0, 80));
  });
  if (residues.length) {
    console.error('!! index.html 里出现 markdown 粗体 ** —— 会显示成字面星号，请改用 <b></b>：');
    residues.slice(0, 5).forEach((r) => console.error('   ' + r));
    process.exit(1);
  }
}
// 词表护栏：index.html 里的幂等词表必须是契约原文（转义后）派生值 —— HTML 里的枚举没人会去跟 JSON 对，
// 漂了最难发现。
if (!html.includes(esc(idemModel)))
  throw new Error('index.html 的幂等词表不是从契约 x-agent-console.idempotency_model 派生的');
fs.writeFileSync(path.join(BUILD, 'index.html'), html, 'utf8');

// ---------- 6. MANIFEST.json（给 agent 自己找粒度） ----------
const manifestJson = {
  site: 'agent-console 评测包',
  audience: 'agent（第一用户是 AI，评估主体也应该是 AI）',
  entry_for_agent: '/start.md',
  note: '首选 /start.md（开测版：按产出组织，读完即可开工）。index.html 是人读入口，但也含实质内容（路由表/403 原文/枚举词表），HTML-only 抓取不会空手而归。',
  entries: {
    '/start.md': '开测版（首选）—— 开篇即任务 + 六维可勾选清单 + 输出填空模板',
    '/pkg.md': '全量纯文本评测包（含契约全文）',
    '/pkg-lite.md': '精简版（不含契约全文）',
    '/openapi.json': '完整 OpenAPI 契约（原始字节）',
    '/prompt.txt': '可粘贴短提示词',
  },
  contract: {
    digest,
    bytes: Buffer.byteLength(contractRaw, 'utf8'),
    version: contract['x-agent-console']?.version,
    routes: rows.length,
    gated: gated.map((g) => `${g.method} ${g.path}`),
    error_code_enum: codeEnum,
    hint_action_enum: actionEnum,
  },
  files: [{ path: '/index.html', bytes: bytes(path.join(BUILD, 'index.html')), what: '人读入口（含摘要、路由表、403 原文）' }, ...manifest],
  regenerate: 'node tools/make-doubao-package.mjs && node tools/make-doubao-site.mjs',
};
fs.writeFileSync(path.join(BUILD, 'MANIFEST.json'), JSON.stringify(manifestJson, null, 2), 'utf8');

// ---------- 7. 原子落盘：到这一步所有自检都已通过 ----------
// 先把 BUILD 落成正式的 OUT（同盘 rename 是原子的），再回执。
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(BUILD, OUT);

const all = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : all.push([path.relative(OUT, p).replace(/\\/g, '/'), bytes(p)]); } };
walk(OUT);
console.log('site-doubao 生成完毕（原子替换，构建期产物在 ' + path.basename(BUILD) + '）');
for (const [p, s] of all.sort()) console.log(`  ${String(s).padStart(8)}  ${p}`);
console.log(`合计 ${all.length} 文件 / ${all.reduce((a, [, s]) => a + s, 0)} 字节`);
console.log('给豆包的 URL：/start.md（开测版，首选入口）');
