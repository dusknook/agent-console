#!/usr/bin/env node
/**
 * agent-trial.mjs —— 以 AI 为第一用户的可用性测评
 *
 * 与 smoke-*.mjs 的区别（这是本轮的核心命题）：
 *   smoke-*  断言「代码是对的」—— 写测试的人知道内幕，验证实现是否符合自己的预期
 *   this     度量「AI 用起来顺不顺」—— 测评者被剥夺内幕，只能用 HTTP + 契约
 *
 * 三条自我施加的约束（违反任何一条，这个测评就失去意义）：
 *   1. 不 import server.js、不读源码 —— agent 在真实场景里也拿不到你的仓库
 *   2. 不依赖中文 —— 第一用户可能是任何语区的模型，关键决策不能靠读中文自然语言
 *   3. 不做超纲操作 —— 只看响应体与 openapi.json 能给出什么
 *
 * 度量的是「摩擦」，不是「对错」。摩擦分三级：
 *   blocker  该路径走不通，agent 只能放弃或求人
 *   friction 走得通但代价明显（多绕路、烧上下文、需猜）
 *   nit      可以更好
 *
 * 用法：node agent-trial.mjs [--base http://127.0.0.1:8787] [--json 输出文件]
 */

const args = process.argv.slice(2);
const BASE = (() => {
  const i = args.indexOf('--base');
  return i >= 0 ? args[i + 1] : 'http://127.0.0.1:8787';
})();
const JSON_OUT = (() => {
  const i = args.indexOf('--json');
  return i >= 0 ? args[i + 1] : null;
})();

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[90m', B: '\x1b[1m', x: '\x1b[0m' };

const findings = [];   // 摩擦事件
const checks = [];     // 硬判定
let tokensSpent = 0;   // 全程累计 token（agent 的真实成本）
let roundtrips = 0;    // 全程累计往返

const tok = v => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v)).length / 4);

async function call(method, path, { body, headers, silent } = {}) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const t = tok(text);
  // silent：测试装置的准备动作（demo/reset）不算 agent 的自举成本，
  // 否则每个任务都白背一次往返，量出来的数字就不是 agent 的成本了。
  if (!silent) { roundtrips++; tokensSpent += t; }
  return { status: r.status, json, text, bytes: text.length, tokens: t, ms: Date.now() - t0,
    headers: Object.fromEntries(r.headers.entries()) };
}

const F = (sev, task, what, evidence) => findings.push({ sev, task, what, evidence });
const ck = (name, pass, detail) => { checks.push({ name, pass, detail }); };

/** 只做结构化解析：不读自然语言，能提取出多少机器可用的决策信息？ */
function machineReadable(step) {
  const out = [];
  if (step.status === 403 && step.json) {
    const j = step.json;
    if (j.error && typeof j.error.code === 'string' && /^[A-Z_]+$/.test(j.error.code)) out.push('error.code=' + j.error.code);
    if (j.error && j.error.approval_id) out.push('error.approval_id');
    if (j.error && j.error.fingerprint) out.push('error.fingerprint');
    // 这一条是关键：hints 里有没有可枚举的动作语义？
    for (const h of (j.hints || [])) {
      if (h.action && /^[a-z_]+$/.test(h.action)) out.push('hints.action=' + h.action);
    }
    if (j.gate && j.gate.level) out.push('gate.level');
  }
  return out;
}

/** 一段文本里非 ASCII 占比 —— 衡量「关键信息是否押注在自然语言上」 */
const cjkRatio = s => {
  const arr = [...(s || '')];
  if (!arr.length) return 0;
  const cjk = arr.filter(ch => /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)).length;
  return +(cjk / arr.length).toFixed(3);
};

// ══════════════════════════════════════════════════════════════════════
const sec = t => { console.log('\n' + C.B + '── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length)) + C.x); };
const kv = (k, v) => console.log('   ' + k.padEnd(30, '·') + ' ' + v);
const note = t => console.log('   ' + C.d + t + C.x);

async function main() {
  console.log(C.B + '\n══════════════════════════════════════════════════════════════' + C.x);
  console.log(C.B + '  Agent Trial · 以 AI 为第一用户的可用性测评' + C.x);
  console.log(C.B + '══════════════════════════════════════════════════════════════' + C.x);
  console.log('  base       ' + BASE);
  console.log('  模拟条件   只有 HTTP · 只有契约 · 不读源码 · 不依赖中文');
  console.log('  度量对象   摩擦（往返数 / token / 需猜次数 / 可程序化程度）');
  console.log('  时间       ' + new Date().toISOString());

  await call('POST', '/v1/demo/reset', { silent: true });

  // ────────────────────────────────────────────────────────────────
  sec('T1  冷启动：一个零知识 agent 如何自举');
  note('agent 只知道一个 base URL。它必须自己发现「这里有什么」。');

  const root = await call('GET', '/');
  const rootIsJson = (root.headers['content-type'] || '').indexOf('json') >= 0;
  kv('第 1 站 GET /', 'HTTP ' + root.status + ' · ' + root.bytes + 'B · ' +
    (rootIsJson ? C.g + '机器可读索引' + C.x : C.r + 'HTML 标记语言' + C.x));
  note(rootIsJson
    ? '→ 内容协商生效：同一个 URL，浏览器看见控制台，agent 看见索引（含契约地址与起手式）'
    : '→ 拿到的是给人看的 HTML，agent 得先撞一次墙才知道该去找 JSON');

  const health = await call('GET', '/v1/health');
  const routeList = (health.json && health.json.data && health.json.data.routes) || [];
  const firstUseful = roundtrips;
  kv('第 ' + firstUseful + ' 站 GET /v1/health', 'HTTP ' + health.status + ' · ' + health.tokens + ' tokens');
  kv('→ 是否直接给出端点清单', routeList.length + ' 条路由，' + (routeList.length ? C.g + '可直接用' + C.x : C.r + '无' + C.x));
  ck('T1.1 零知识 agent 在 ≤2 次往返内拿到完整端点清单',
    firstUseful <= 2 && routeList.length > 20, '往返 ' + firstUseful + ' 次 / ' + routeList.length + ' 路由');
  if (!rootIsJson) {
    F('friction', 'T1', '首站给的是 HTML，agent 要先撞一次标记语言才找得到 JSON', 'GET / → ' + (root.headers['content-type'] || '?'));
  } else if (firstUseful > 2) {
    F('friction', 'T1', '自举需要 3 次以上往返', '往返 ' + firstUseful + ' 次');
  } // 首站即机器索引且 ≤2 次往返 → 无摩擦，不进清单

  // ────────────────────────────────────────────────────────────────
  sec('T2  执行一次会产生费用的动作');
  const q = await call('POST', '/v1/act/queue', {
    headers: { 'Idempotency-Key': 'trial-' + Date.now() },
    body: { kind: 'trial_call', shard: 'T', cost_cny: 0.42, route: 'approve' }
  });
  kv('POST /v1/act/queue', 'HTTP ' + q.status + ' · ' + q.tokens + ' tokens');
  const actionId = q.json && q.json.data && q.json.data.id;
  ck('T2.1 入队成功且返回可追踪 id', q.status === 201 && !!actionId, 'HTTP ' + q.status + ' id=' + actionId);

  const conf = await call('POST', '/v1/act/' + actionId + '/confirm', { body: {} });
  kv('POST /v1/act/{id}/confirm', 'HTTP ' + conf.status + ' · ' + conf.tokens + ' tokens');
  ck('T2.2 被门控拦下（而不是执行了）', conf.status === 403, 'HTTP ' + conf.status);
  ck('T2.3 拦截响应带机器可枚举的 error.code',
    !!(conf.json && conf.json.error && /^[A-Z_]+$/.test(conf.json.error.code)),
    conf.json && conf.json.error && conf.json.error.code);
  const approvalId = conf.json && conf.json.error && conf.json.error.approval_id;

  // ────────────────────────────────────────────────────────────────
  sec('T3  撞墙之后：agent 能否【程序化】算出该干什么');
  note('这是 agent-native 的分水岭。人类读一句中文就懂了；agent 需要能 if 的语义。');

  const mr = machineReadable(conf);
  kv('结构化可提取的决策信息', mr.length ? mr.map(s => C.g + s + C.x).join('  ') : C.r + '（无）' + C.x);
  const hintSuggest = (conf.json && conf.json.hints || []).map(h => h.suggest).join(' ');
  kv('hints[].suggest 中文占比', (cjkRatio(hintSuggest) * 100).toFixed(1) + '%');
  const hasActionEnum = mr.some(s => s.indexOf('hints.action=') === 0);
  ck('T3.1 存在【不依赖自然语言】的机器可读下一步（hints[].action）', hasActionEnum,
    hasActionEnum ? mr.filter(s => /hints\.action/.test(s)).join(',') : 'hints 只有自然语言 suggest/why，无可枚举 action');
  if (!hasActionEnum) {
    F('friction', 'T3',
      '「停止重试」这条最关键指令只有中文自然语言载体，跨语区 agent 无法程序化决策',
      'hints[].suggest 中文占比 ' + (cjkRatio(hintSuggest) * 100).toFixed(1) + '%，且无 action 枚举字段');
  }
  const canDetectStop = !!(conf.json && conf.json.error && conf.json.error.code === 'REQUIRE_APPROVAL');
  ck('T3.2 仅凭 error.code 就能推出「不该重试」（有兜底）', canDetectStop,
    canDetectStop ? 'error.code=REQUIRE_APPROVAL 可枚举，agent 可硬编码该分支' : '无');
  if (canDetectStop) note('→ 兜底路径存在（error.code 可枚举，契约已声明其 enum），但正常路径应当是读 hints[].action。');

  // 重试陷阱：agent 若真的重试，会怎样？
  const retry = await call('POST', '/v1/act/' + actionId + '/confirm', { body: {} });
  kv('盲目重试同一动作', 'HTTP ' + retry.status + ' · 同一张单 ' + ((retry.json && retry.json.error && retry.json.error.approval_id) === approvalId ? C.g + '是（幂等，未重复开单）' + C.x : C.r + '否（开了新单）' + C.x));
  ck('T3.3 重试不会重复开单（挂起幂等）',
    retry.json && retry.json.error && retry.json.error.approval_id === approvalId, 'approval_id 一致');
  ck('T3.4 重试不会执行副作用（预算未动）',
    retry.status === 403, 'HTTP ' + retry.status);

  // ────────────────────────────────────────────────────────────────
  sec('T4  追踪「我那张单子批了没有」');
  note('agent 拿到 approval_id 后的第一反应就是查这一张。');

  const single = await call('GET', '/v1/approvals/' + approvalId);
  kv('GET /v1/approvals/{id}', 'HTTP ' + single.status + (single.status === 404 ? C.r + '  ← 无此路' + C.x : ' · ' + single.tokens + ' tokens'));
  ck('T4.1 可按 id 单查审批单（O(1) 追踪）', single.status === 200, 'HTTP ' + single.status);
  if (single.status === 404) {
    F('friction', 'T4',
      'agent 手握 approval_id 却无法单查，只能拉全表再自己过滤 —— 队列一长就是 O(n) 且夹带无关数据',
      'GET /v1/approvals/apr_xxx → 404');
  }

  const list = await call('GET', '/v1/approvals?status=PENDING');
  kv('退而求其次 GET /v1/approvals', 'HTTP ' + list.status + ' · ' + list.tokens + ' tokens');
  const selfFilter = ((list.json && list.json.data && list.json.data.approvals) || []).some(a => a.id === approvalId);
  ck('T4.2 兜底：列表可自行过滤出目标', selfFilter, selfFilter ? '能，但代价 O(n)' : '不能');
  kv('→ 单查 vs 列表', single.tokens + ' vs ' + list.tokens + ' tokens' +
    (single.status === 200 ? C.g + '（省 ' + Math.round((1 - single.tokens / list.tokens) * 100) + '%，且不含别人的单子）' + C.x : ''));

  // ────────────────────────────────────────────────────────────────
  sec('T5  契约自足性：只看 openapi.json，agent 能学到多少');
  const spec = await call('GET', '/v1/openapi.json');
  const S = spec.json;
  kv('spec 体量', spec.bytes + 'B · ~' + spec.tokens + ' tokens（agent 若整份入上下文，这是入场费）');
  ck('T5.1 spec 不套信封、是纯文档', spec.status === 200 && !S._meta, 'HTTP ' + spec.status);

  const ops = Object.values(S.paths || {}).flatMap(p => Object.values(p));
  const gated = ops.filter(o => o['x-gate'] && o['x-gate'].level !== 'none');
  kv('可查出「哪些端点会被拦」', gated.length + ' / ' + ops.length + ' 条带 x-gate');
  ck('T5.2 契约声明了门控范围', gated.length > 0, gated.map(o => o.operationId).join(', '));

  const schemas = (S.components && S.components.schemas) || {};
  const errSchema = schemas.Envelope && schemas.Envelope.properties && schemas.Envelope.properties.error;
  const declaredErrFields = (errSchema && errSchema.properties) ? Object.keys(errSchema.properties) : [];
  kv('契约声明的 error 字段', declaredErrFields.length ? declaredErrFields.join(', ') : '（无）');
  const realErrFields = Object.keys((conf.json && conf.json.error) || {});
  kv('实际返回的 error 字段', realErrFields.join(', '));
  const undeclared = realErrFields.filter(f => declaredErrFields.indexOf(f) < 0);
  const errDeclared = undeclared.length === 0;
  ck('T5.3 契约声明全了 403 body 的实际字段（agent 不必靠猜）', errDeclared,
    errDeclared ? '全部已声明' : '未声明: ' + undeclared.join(', '));
  if (!errDeclared) {
    F('friction', 'T5',
      '契约说 403 会发生，却没说 403 的身体长什么样 —— agent 想知道「撞墙后能拿到什么」必须实际撞一次',
      '未声明字段: ' + undeclared.join(', ') + '（实际返回 ' + realErrFields.length + ' 个，声明 ' + declaredErrFields.length + ' 个）');
  }
  const codeEnum = errSchema && errSchema.properties && errSchema.properties.code && errSchema.properties.code.enum;
  kv('error.code 是否可枚举', codeEnum ? codeEnum.length + ' 个: ' + codeEnum.slice(0, 6).join(',') + '…' : C.r + '无 enum（agent 无法穷举处理）' + C.x);
  ck('T5.4 error.code 有 enum，agent 可穷举分支', !!codeEnum, codeEnum ? codeEnum.length + ' 个' : '无');

  const hintSchema = schemas.Envelope && schemas.Envelope.properties && schemas.Envelope.properties.hints;
  const hintProps = (hintSchema && hintSchema.items && hintSchema.items.properties) ? Object.keys(hintSchema.items.properties) : [];
  kv('契约声明的 hints 字段', hintProps.length ? hintProps.join(', ') : '（无）');
  ck('T5.5 契约声明 hints[].action（机器语义）',
    hintProps.indexOf('action') >= 0, hintProps.indexOf('action') >= 0 ? '已声明' : '未声明 —— 契约不承认存在机器语义');

  const idemOps = ops.filter(o => o['x-idempotency'] === 'required');
  const optionalOps = ops.filter(o => o['x-idempotency'] === 'optional');
  const fpDedupOps = ops.filter(o => o['x-idempotency'] === 'fingerprint_dedup');
  kv('幂等强度可从契约得知',
    'required ' + idemOps.length + ' 条 / optional ' + optionalOps.length +
    ' 条 / fingerprint_dedup ' + fpDedupOps.length + ' 条 —— 四档都写清楚，没有「无保护」这一档');
  ck('T5.6 幂等强度按四档如实声明（agent 有可选的自保手段：带键即可）',
    idemOps.length > 0 && optionalOps.length > 0 && fpDedupOps.length > 0,
    'required=' + idemOps.length + ' optional=' + optionalOps.length + ' fp_dedup=' + fpDedupOps.length);

  // ────────────────────────────────────────────────────────────────
  sec('T6  反向测试：agent 尝试绕过门控（安全性）');
  note('一个「聪明」的 agent 会试各种偏方。全部必须失败，而且必须不产生副作用。');

  const budgetBefore = (await call('GET', '/v1/state/bundle')).json.data.budget.used;
  const tricks = [
    ['换个 method 试试', () => call('PUT', '/v1/act/' + actionId + '/confirm', { body: {} })],
    ['自己伪造已批准头', () => call('POST', '/v1/act/' + actionId + '/confirm', { body: {}, headers: { 'X-Approved': 'true', __approved: '1' } })],
    ['带上审批 id 冒充放行', () => call('POST', '/v1/act/' + actionId + '/confirm', { body: { approval_id: approvalId, approved: true } })],
    ['直接打内部动作名', () => call('POST', '/v1/act/' + actionId + '/execute', { body: {} })],
    ['走兼容别名路径', () => call('POST', '/v1/act/confirm', { body: { action_id: actionId } })],
  ];
  let allBlocked = true;
  for (const [label, fn] of tricks) {
    const r = await fn();
    const blocked = r.status === 403 || r.status === 404 || r.status === 405 || r.status === 400;
    if (!blocked) allBlocked = false;
    kv(label, 'HTTP ' + r.status + ' ' + (blocked ? C.g + '已挡' + C.x : C.r + '★ 穿透' + C.x));
  }
  const budgetAfter = (await call('GET', '/v1/state/bundle')).json.data.budget.used;
  ck('T6.1 五种绕过尝试无一穿透', allBlocked, allBlocked ? '5/5 被挡' : '存在穿透路径');
  ck('T6.2 绕过过程中的副作用为零（预算未动）', budgetBefore === budgetAfter,
    '¥' + budgetBefore + ' → ¥' + budgetAfter);

  // ────────────────────────────────────────────────────────────────
  sec('T7  结果收敛：人批了之后，agent 怎么知道');
  const pre = await call('GET', '/v1/state/bundle');
  kv('批准前 agent 能看到的', '动作=' + pre.json.data.actions.find(a => a.id === actionId)?.status);
  const dec = await call('POST', '/v1/approvals/' + approvalId + '/decide', {
    body: { decision: 'approve', by: 'human:trial' }
  });
  kv('（模拟人）批准', 'HTTP ' + dec.status);
  const post = await call('GET', '/v1/state/bundle');
  const finalStatus = post.json.data.actions.find(a => a.id === actionId)?.status;
  kv('批准后 agent 看到的', '动作=' + finalStatus + ' · 预算 ¥' + post.json.data.budget.used);
  ck('T7.1 人批后 agent 查得到结果（无需内幕）', finalStatus === 'EXECUTED', 'action.status=' + finalStatus);
  const decAgain = await call('POST', '/v1/approvals/' + approvalId + '/decide', { body: { decision: 'approve', by: 'human:trial' } });
  ck('T7.2 重复裁决被挡（409），不会执行两遍', decAgain.status === 409, 'HTTP ' + decAgain.status);
  kv('重复裁决', 'HTTP ' + decAgain.status + ' · ' + (decAgain.json && decAgain.json.error && decAgain.json.error.code));

  // ────────────────────────────────────────────────────────────────
  const passed = checks.filter(c => c.pass).length;
  const failed = checks.length - passed;
  const blockers = findings.filter(f => f.sev === 'blocker').length;
  const frictions = findings.filter(f => f.sev === 'friction').length;

  console.log('\n' + C.B + '══════════════════════════════════════════════════════════════' + C.x);
  console.log(C.B + '  判定汇总' + C.x);
  console.log(C.B + '══════════════════════════════════════════════════════════════' + C.x);
  for (const c of checks) console.log('   ' + (c.pass ? C.g + 'PASS' + C.x : C.r + 'FAIL' + C.x) + '  ' + c.name + (c.detail ? C.d + '  [' + c.detail + ']' + C.x : ''));

  console.log('\n   ' + C.B + '摩擦清单' + C.x + '（这是给产品负责人的部分，不是给 CI 的）');
  if (!findings.length) console.log('   ' + C.g + '（无）' + C.x);
  for (const f of findings) {
    const tag = f.sev === 'blocker' ? C.r + 'BLOCKER ' + C.x : f.sev === 'friction' ? C.y + 'FRICTION' + C.x : C.d + 'NIT     ' + C.x;
    console.log('   ' + tag + ' [' + f.task + '] ' + f.what);
    console.log('            ' + C.d + '证据: ' + f.evidence + C.x);
  }

  console.log('');
  console.log('   ' + C.B + '成本核算（agent 完成这一轮全部任务的真实开销）' + C.x);
  kv('往返总次数', roundtrips + ' 次');
  kv('累计响应体 tokens', '≈ ' + tokensSpent);
  kv('平均每往返 tokens', '≈ ' + Math.round(tokensSpent / roundtrips));
  kv('需人工介入的阻塞点', blockers + ' 个');

  console.log('');
  console.log('   ' + C.B + (failed === 0 ? C.g : C.y) + checks.length + ' 项判定 → ' + passed + ' PASS / ' + failed + ' FAIL' + C.x +
    '   ' + C.d + '· ' + blockers + ' blocker / ' + frictions + ' friction' + C.x);
  console.log('');

  if (JSON_OUT) {
    const fs = await import('node:fs');
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      base: BASE, at: new Date().toISOString(),
      roundtrips, tokens_spent: tokensSpent,
      checks, findings
    }, null, 2));
    console.log('   ' + C.d + 'JSON 写入 ' + JSON_OUT + C.x);
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch(e => { console.error(C.r + 'TRIAL ERROR ' + C.x + e.stack); process.exitCode = 1; });
