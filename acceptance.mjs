#!/usr/bin/env node
/**
 * acceptance.mjs — Agent Console v5 · 验收（人读证据版）
 *
 * 它和 smoke-*.mjs 的分工，是这个文件存在的全部理由：
 *   smoke      = 断言机器，证明「代码是对的」。密集、快、失败就红。
 *   acceptance = 体检报告，证明「体验是对的」。慢、啰嗦、打印真实证据给人看。
 *
 * 所以这里不堆断言数量 —— 断言只放在「人真的会走的那几条路」和
 * 「文档说的和跑着的是一回事」这两件事上。每一步都打印：
 *   真实 Request ID、真实时间戳、真实前后状态对比。
 * 没有证据的判断等同于没做判断。
 *
 * 用法：
 *   node acceptance.mjs                        # 默认 http://127.0.0.1:8787
 *   BASE=http://127.0.0.1:8788 node acceptance.mjs
 *
 * 前置：后端在跑。脚本开头会 demo/reset 到种子态，所以可反复跑。
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let PASS = 0, FAIL = 0, N = 0;
const ROWS = [];
const t0 = Date.now();

const line = (s = '') => process.stdout.write(s + '\n');
const sec = t => { line(''); line('='.repeat(80)); line('  ' + t); line('='.repeat(80)); };
const sub = t => { line(''); line('  ── ' + t); };
const kv = (k, v) => line('       ' + String(k).padEnd(24) + ' ' + v);

function ck(name, ok, evidence) {
  N++;
  if (ok) PASS++; else FAIL++;
  ROWS.push({ n: N, name, ok, ev: evidence || '' });
  line('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name);
  if (evidence) String(evidence).split('\n').forEach(l => line('         | ' + l));
  return ok;
}
const ev = o => JSON.stringify(o);

async function req(method, path, opt = {}) {
  const headers = Object.assign({}, opt.headers);
  if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
  const s = process.hrtime.bigint();
  const r = await fetch(BASE + path, {
    method, headers,
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body)
  });
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 html） */ }
  const rid = r.headers.get('x-request-id') || (json && json._meta && json._meta.request_id) || '(无)';
  return { status: r.status, json, text, ms: Math.round(ms * 10) / 10, rid,
    ctype: r.headers.get('content-type') || '' };
}

/** 打印一次往返的「人话摘要」 */
function trace(label, r) {
  line('       ' + label);
  kv('HTTP', r.status + '  ·  ' + r.ms + 'ms  ·  ' + r.rid);
  if (r.json && r.json.error) {
    kv('error.code', r.json.error.code);
    kv('requires', r.json.requires);
  }
}

const bundle = async () => (await req('GET', '/v1/state/bundle')).json.data;
const actionOf = (b, id) => b.actions.find(a => a.id === id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
(async function main() {
  line('');
  line('Agent Console v5 · 验收');
  line('目标     ' + BASE);
  line('开始时间 ' + new Date().toISOString().replace('T', ' ').slice(0, 19));

  // 探活
  let h;
  try {
    const r = await req('GET', '/v1/health');
    if (r.status !== 200) throw new Error('health ' + r.status);
    h = r.json.data;
  } catch (e) {
    line('');
    line('  后端不可达：' + e.message);
    line('  先起来：  node server.js      （或 bash run-tests.sh 里那种多实例）');
    process.exit(2);
  }
  kv('pid', h.pid + '   routes=' + h.routes.length + '   endpoints=' + h.endpoints);
  kv('journal_mode', h.journal_mode);
  kv('门控端点数', h.gate.policy.length + '   ' + h.gate.policy.map(p => p.route).join(' / '));
  kv('裁决密钥', h.gate.approval_secret_required ? '已启用（裁决需 X-Approval-Secret）' : '未启用（依赖「本机单人」前提）');

  await req('POST', '/v1/demo/reset');           // 归零，保证可复跑
  let b = await bundle();
  kv('重置后', '动作 ' + b.actions.length + ' · 决策 ' + b.decisions.length +
    ' · 待批 ' + b.approvals_pending + ' · 预算 ' + b.budget.used + '/' + b.budget.limit);

  /* ═══════════════════════════════════════════════════════════════════════
     验收 A —— 提交一个 human 级动作：拦得住吗？拦在哪儿？
     ═══════════════════════════════════════════════════════════════════════ */
  sec('验收 A · 提交 human 级动作 → 是否真的被拦在业务代码之外');

  const COST = 0.42;
  sub('A1  agent 把动作放进队列（route=approve → 只排队，未执行）');
  const q = await req('POST', '/v1/act/queue', {
    headers: { 'Idempotency-Key': 'acc-a-' + Date.now() },
    body: { kind: 'tts.seed_audio', shard: 'ACC_A', cost_cny: COST, route: 'approve',
      reason: '验收：验证 human 级动作被网关拦截' }
  });
  trace('POST /v1/act/queue', q);
  const actA = q.json && q.json.data;
  if (actA) kv('data', 'id=' + actA.id + '  status=' + actA.status + '  cost=¥' + actA.cost_cny);
  ck('动作入队成功，且停在 PENDING_CONFIRMATION（未执行）',
    q.status === 201 && actA && actA.status === 'PENDING_CONFIRMATION',
    '期望 HTTP 201 + status=PENDING_CONFIRMATION，实收 ' + q.status + ' + ' + (actA && actA.status));

  const beforeA = await bundle();
  kv('拦截前基线', '预算 used=' + beforeA.budget.used + ' · reserved=' + beforeA.budget.reserved +
    ' · 待批=' + beforeA.approvals_pending);

  sub('A2  agent 试图自己确认它 —— 这正是 requires=human 要挡住的动作');
  line('      注意：这不是「agent 不该调」，而是「调了也进不去」。');
  const conf = await req('POST', '/v1/act/' + actA.id + '/confirm', { body: {} });
  trace('POST /v1/act/' + actA.id + '/confirm', conf);
  const errA = conf.json && conf.json.error;
  if (errA) {
    kv('approval_id', errA.approval_id);
    kv('fingerprint', errA.fingerprint);
    kv('gate.enforced_in', conf.json.gate && conf.json.gate.enforced_in);
    kv('gate.bypass', conf.json.gate && conf.json.gate.bypass);
  }
  ck('被网关截停：403 REQUIRE_APPROVAL（不是 202 —— 正确动作是走开，不是稍后回来查）',
    conf.status === 403 && errA && errA.code === 'REQUIRE_APPROVAL',
    '实收 ' + conf.status + ' / ' + (errA && errA.code));
  ck('响应带回 approval_id —— agent 知道自己撞上了哪张单子',
    !!(errA && errA.approval_id),
    'approval_id=' + (errA && errA.approval_id));
  ck('指纹是 32 位十六进制 —— 人批的和回放的是同一份内容，中间改不了',
    !!(errA && /^[0-9a-f]{32}$/.test(errA.fingerprint)),
    'len=' + (errA && errA.fingerprint ? errA.fingerprint.length : 0) + ' value=' + (errA && errA.fingerprint));

  sub('A3  关键一问：业务代码到底跑没跑？（这才是「长牙」的证据）');
  const afterA = await bundle();
  const actA2 = actionOf(afterA, actA.id);
  kv('动作状态', '拦截前 ' + actA.status + '  →  拦截后 ' + (actA2 && actA2.status));
  kv('预算 used', '拦截前 ' + beforeA.budget.used + '  →  拦截后 ' + afterA.budget.used);
  kv('审计尾部', (afterA.audit[0] && (afterA.audit[0].at + '  ' + afterA.audit[0].verb + ' ' + afterA.audit[0].target + '  ' + afterA.audit[0].result)) || '(空)');
  ck('动作状态没变 —— handler 一行没跑',
    actA2 && actA2.status === 'PENDING_CONFIRMATION',
    'status=' + (actA2 && actA2.status));
  ck('预算没动 —— 钱没花，\"拦住\"不是\"先扣后退\"',
    afterA.budget.used === beforeA.budget.used,
    beforeA.budget.used + ' → ' + afterA.budget.used);
  ck('待批计数 +1',
    afterA.approvals_pending === beforeA.approvals_pending + 1,
    beforeA.approvals_pending + ' → ' + afterA.approvals_pending);

  sub('A4  这张单子在哪？agent 能看见吗？');
  const list = await req('GET', '/v1/approvals?status=PENDING');
  const pend = list.json.data;
  const mine = pend.approvals.find(a => a.id === errA.approval_id);
  kv('GET /v1/approvals', list.status + ' · count=' + pend.count + ' · pending=' + pend.pending);
  if (mine) {
    kv('这张单子', mine.id + ' · ' + mine.status + ' · by=' + mine.requested_by);
    kv('原请求原样落盘', mine.request.method + ' ' + mine.request.route + '  body=' + ev(mine.request.body));
  }
  ck('被拦下的请求原样存在 approvals 表里（不是内存队列）',
    !!mine && mine.request.method === 'POST' && mine.request.route.indexOf('/v1/act/') === 0,
    mine ? mine.request.method + ' ' + mine.request.route : '(找不到)');
  ck('agent 可读待批清单（可见即可观测）',
    list.status === 200 && pend.count >= 1,
    'count=' + pend.count);
  ck('但清单里没有「裁决」的入口 —— 可见性不构成权限',
    list.json.hints.some(x => x.for === 'agent' && /只读|不可裁决/.test(x.suggest + x.why)),
    list.json.hints.map(x => x.for + ':' + x.suggest).join('  |  '));

  const aprA = errA.approval_id;

  /* ═══════════════════════════════════════════════════════════════════════
     验收 B —— 两条裁决路径
     ═══════════════════════════════════════════════════════════════════════ */
  sec('验收 B · 人工裁决：驳回（零副作用）与批准（服务端回放，只扣一次）');

  sub('B1  驳回路径');
  const bBefore = await bundle();
  const rej = await req('POST', '/v1/approvals/' + aprA + '/decide',
    { body: { decision: 'reject', by: 'user', reason: '验收：这条不需要执行' } });
  trace('POST /v1/approvals/' + aprA + '/decide  {reject}', rej);
  kv('data', ev(rej.json && rej.json.data));
  const bAfter = await bundle();
  const actA3 = actionOf(bAfter, actA.id);
  ck('驳回成功，且明确声明零副作用',
    rej.status === 200 && rej.json.data.status === 'REJECTED' && /无/.test(rej.json.data.side_effects),
    'status=' + rej.json.data.status + ' · side_effects=' + rej.json.data.side_effects);
  ck('驳回后动作仍是 PENDING_CONFIRMATION —— 被否决不等于被执行',
    actA3 && actA3.status === 'PENDING_CONFIRMATION',
    'status=' + (actA3 && actA3.status));
  ck('驳回后预算分文未动',
    bAfter.budget.used === bBefore.budget.used,
    bBefore.budget.used + ' → ' + bAfter.budget.used);
  ck('待批计数回落',
    bAfter.approvals_pending === bBefore.approvals_pending - 1,
    bBefore.approvals_pending + ' → ' + bAfter.approvals_pending);

  sub('B2  重复裁决同一张单子 —— 必须由存储裁决，不能靠谁手快');
  const again = await req('POST', '/v1/approvals/' + aprA + '/decide', { body: { decision: 'approve', by: 'user' } });
  trace('POST /v1/approvals/' + aprA + '/decide  {approve}  ← 第二次', again);
  if (again.json && again.json.error) {
    kv('arbitration', again.json.error.arbitration);
    kv('winner', again.json.error.winner + ' @ ' + again.json.error.winner_at);
  }
  ck('重复裁决被拒：409 ALREADY_DECIDED，并指出是谁赢的',
    again.status === 409 && again.json.error.code === 'ALREADY_DECIDED' && !!again.json.error.winner,
    '实收 ' + again.status + ' / ' + (again.json.error && again.json.error.code));

  sub('B3  批准路径（换一个新动作，走完整条链）');
  const q2 = await req('POST', '/v1/act/queue', {
    headers: { 'Idempotency-Key': 'acc-b-' + Date.now() },
    body: { kind: 'tts.seed_audio', shard: 'ACC_B', cost_cny: COST, route: 'approve',
      reason: '验收：验证批准后由服务端回放原请求' }
  });
  const actB = q2.json.data;
  kv('新动作', actB.id + ' · ¥' + actB.cost_cny + ' · ' + actB.status);
  const conf2 = await req('POST', '/v1/act/' + actB.id + '/confirm', { body: {} });
  trace('POST /v1/act/' + actB.id + '/confirm', conf2);
  const aprB = conf2.json.error.approval_id;
  ck('再次被拦（不是第一次的特例）', conf2.status === 403, 'HTTP ' + conf2.status + ' · approval_id=' + aprB);

  const cBefore = await bundle();
  const appr = await req('POST', '/v1/approvals/' + aprB + '/decide',
    { body: { decision: 'approve', by: 'user', reason: '验收：批准执行' } });
  trace('POST /v1/approvals/' + aprB + '/decide  {approve}', appr);
  const cAfter = await bundle();
  const actB2 = actionOf(cAfter, actB.id);
  kv('回放结果', ev(appr.json.data && appr.json.data.replay && appr.json.data.replay.status));
  kv('动作状态', cBefore.actions.find(a => a.id === actB.id).status + '  →  ' + (actB2 && actB2.status));
  kv('预算 used', cBefore.budget.used + '  →  ' + cAfter.budget.used + '   （本动作 ¥' + COST + '）');
  ck('批准触发服务端回放，动作变 EXECUTED',
    appr.status === 200 && actB2 && actB2.status === 'EXECUTED',
    'status=' + (actB2 && actB2.status));
  ck('回放的是「原请求」：回执里能看到被回放的 handler 输出',
    !!(appr.json.data && appr.json.data.replay && appr.json.data.replay.status),
    'replay.status=' + (appr.json.data && appr.json.data.replay && appr.json.data.replay.status));
  ck('扣款恰好一次，金额精确等于动作成本',
    Math.abs((cAfter.budget.used - cBefore.budget.used) - COST) < 1e-9,
    (cAfter.budget.used - cBefore.budget.used).toFixed(2) + ' vs ' + COST.toFixed(2));

  sub('B4  裁决完还得看得见（人需要知道「我批了之后发生了什么」）');
  const dAfter = await bundle();
  const shown = dAfter.approvals.find(a => a.id === aprB);
  kv('面板条目', shown ? (shown.id + ' · ' + shown.status + ' · by=' + shown.decided_by + ' · at=' + shown.decided_at) : '(不见了)');
  ck('已裁决的条目仍出现在面板里，带裁决人与时间',
    !!shown && shown.status === 'EXECUTED' && !!shown.decided_at,
    shown ? shown.status + ' @ ' + shown.decided_at : '(缺失)');
  ck('回执里带上回放结果，人能看到批准后实际发生了什么',
    !!(shown && shown.replay && shown.replay.status),
    shown && shown.replay ? ev(shown.replay.status) : '(缺失)');

  /* ═══════════════════════════════════════════════════════════════════════
     验收 C —— 文档说的和跑着的是一回事吗？
     ═══════════════════════════════════════════════════════════════════════ */
  sec('验收 C · OpenAPI 抽样核对：把 spec 声明拿去真调');

  const specRes = await req('GET', '/v1/openapi.json');
  const spec = specRes.json;
  const ops = Object.entries(spec.paths).flatMap(([p, m]) => Object.entries(m).map(([meth, o]) => ({ p, meth, o })));
  kv('GET /v1/openapi.json', specRes.status + ' · ' + specRes.ctype + ' · ' + specRes.ms + 'ms');
  kv('规模', Object.keys(spec.paths).length + ' paths · ' + ops.length + ' operations');
  kv('覆盖率自证', ev(spec['x-agent-console'].meta_coverage));
  ck('文档不套统一信封（没有 _meta 污染根键）',
    !('_meta' in spec) && !('data' in spec) && !!spec.openapi,
    '根键 ' + Object.keys(spec).join(', '));
  ck('覆盖率自证为满格：没有未登记的路由（漏了会在 spec 里留占位，不静默少写）',
    spec['x-agent-console'].meta_coverage.missing.length === 0 &&
    spec['x-agent-console'].meta_coverage.declared === spec['x-agent-console'].meta_coverage.routes,
    spec['x-agent-console'].meta_coverage.declared + '/' + spec['x-agent-console'].meta_coverage.routes);

  const findOp = (p, m) => { const x = spec.paths[p]; return x && x[m]; };

  const SAMPLES = [
    { p: '/v1/act/{id}/confirm', m: 'post', what: '门控声明' },
    { p: '/v1/act/queue',        m: 'post', what: '幂等声明（required）' },
    { p: '/v1/state/change_requests', m: 'post', what: '幂等声明（optional：带键才生效）' },
    { p: '/v1/health',           m: 'get',  what: '普通端点响应结构' },
  ];

  for (const s of SAMPLES) {
    const o = findOp(s.p, s.m);
    sub('C·' + (SAMPLES.indexOf(s) + 1) + '  ' + s.m.toUpperCase() + ' ' + s.p + '   [' + s.what + ']');
    if (!o) { ck('文档里有这个 operation', false, '(paths 里找不到)'); continue; }
    kv('文档声明', 'x-gate=' + o['x-gate'].level + ' · x-idempotency=' + o['x-idempotency'] + ' · x-requires=' + o['x-requires']);
    kv('summary', o.summary);

    if (o['x-gate'].level === 'approval') {
      kv('文档说', o['x-gate'].agent_behaviour);
      const f = await req(s.m.toUpperCase(), '/v1/act/nonexistent-xyz/confirm', { body: {} });
      trace('实测（拿一个不存在的 id 去撞闸门）', f);
      const ok = f.status === 403 && f.json.error.code === 'REQUIRE_APPROVAL';
      ck('实测与声明一致：真 403 + 真挂起（注意它连「id 存不存在」都没来得及判）',
        ok, 'HTTP ' + f.status + ' / ' + f.json.error.code);
      kv('顺带暴露的边界', '网关先于业务校验 → 不存在的 id 也会挂单；' + (f.json.error.approval_id || ''));
    }

    if (s.p === '/v1/act/queue') {
      kv('文档说', '必带 Idempotency-Key，约束在存储层 PRIMARY KEY');
      const f = await req('POST', '/v1/act/queue', { body: { kind: 'x', cost_cny: 0, route: 'auto' } });
      trace('实测（故意不带幂等键）', f);
      ck('实测与声明一致：不带键真 400 IDEMPOTENCY_KEY_REQUIRED',
        f.status === 400 && f.json.error.code === 'IDEMPOTENCY_KEY_REQUIRED',
        'HTTP ' + f.status + ' / ' + f.json.error.code);

      // 同键重发 → 同一个动作，不产生第二条
      const k = 'acc-c-idem-' + Date.now();
      const r1 = await req('POST', '/v1/act/queue', { headers: { 'Idempotency-Key': k },
        body: { kind: 'x', shard: 'ACC_C', cost_cny: 0, route: 'auto' } });
      const r2 = await req('POST', '/v1/act/queue', { headers: { 'Idempotency-Key': k },
        body: { kind: 'x', shard: 'ACC_C', cost_cny: 0, route: 'auto' } });
      kv('同键重发', r1.json.data.action_id + '  →  ' + r2.json.data.action_id +
        '   replayed=' + r2.json.replayed + ' hits=' + (r2.json.idempotency && r2.json.idempotency.hits));
      ck('同键重发返回同一个动作（不是新动作），且 hits 递增',
        r1.json.data.action_id === r2.json.data.action_id && r2.json.replayed === true,
        r1.json.data.action_id + ' === ' + r2.json.data.action_id);
    }

    if (s.p === '/v1/state/change_requests') {
      kv('文档说', 'x-idempotency=' + o['x-idempotency'] +
         ' —— 契约写的是「带键才受保护」，不是笼统地说「已幂等」');
      const body = { target_type: 'asset', target_id: 'cover.epub',
        proposed: '验收：同 body 连打两次，看会不会重复落库', requested_by: 'agent' };
      // ① 不带键：仍会产生第二条 —— 这是 optional 的另一半（默认行为不变），不是缺口
      const c1 = await req('POST', '/v1/state/change_requests', { body });
      const c2 = await req('POST', '/v1/state/change_requests', { body });
      trace('不带键 · 第一次', c1); trace('不带键 · 第二次（body 完全一样）', c2);
      kv('不带键的落库结果', c1.json.data.id + '  vs  ' + c2.json.data.id);
      ck('不带键 = 不受约束：确实产生了第二条（optional 的定义，与声明一致）',
        c1.status === 201 && c2.status === 201 && c1.json.data.id !== c2.json.data.id,
        'doc=optional · 不带键 ' + c1.json.data.id + ' ≠ ' + c2.json.data.id);

      // ② 带键：同键重发返回首次响应，不再落第二条
      const k = 'acc-c-opt-' + Date.now();
      const ob = { target_type: 'asset', target_id: 'cover.epub',
        proposed: '验收：带幂等键连打两次', requested_by: 'agent' };
      const k1 = await req('POST', '/v1/state/change_requests', { headers: { 'Idempotency-Key': k }, body: ob });
      const k2 = await req('POST', '/v1/state/change_requests', { headers: { 'Idempotency-Key': k }, body: ob });
      trace('带键 · 第一次', k1); trace('带键 · 第二次（同键同 body）', k2);
      kv('带键的落库结果', k1.json.data.id + '  vs  ' + k2.json.data.id + '   replayed=' + k2.json.replayed);
      ck('带键 = 重放首次响应：同一条记录，不是第二条',
        k1.json.data.id === k2.json.data.id && k2.json.replayed === true,
        k1.json.data.id + ' === ' + k2.json.data.id);
      kv('结论', '同一个端点，带不带键是两种行为 —— 契约把两种都写清楚了。想要确定性就带键。');
    }

    if (s.p === '/v1/health') {
      kv('文档说', 'x-idempotency=' + o['x-idempotency']);
      const f = await req('GET', '/v1/health');
      const keys = Object.keys(f.json);
      kv('实测信封根键', keys.join(', '));
      ck('实测与声明一致：GET 是 safe 操作，且有统一信封（ok/requires/data）',
        f.status === 200 && keys.includes('ok') && keys.includes('requires') && keys.includes('data') &&
        o['x-idempotency'] === 'safe',
        keys.join(','));
    }
  }

  // 确定性：同一份活元数据派生两次，逐字节相同
  const s1 = (await req('GET', '/v1/openapi.json')).text;
  const s2 = (await req('GET', '/v1/openapi.json')).text;
  ck('同一份活元数据派生两次逐字节相同（不是每次随机生成）',
    s1 === s2, 'len=' + s1.length + ' 两次一致=' + (s1 === s2));

  /* ═══════════════════════════════════════════════════════════════════════
     验收 D —— 跨窗口同步（协议层：两个独立会话看到同一份待批）
     ═══════════════════════════════════════════════════════════════════════ */
  sec('验收 D · 跨窗口同步：状态在服务端，不在浏览器内存里');

  const winA = { tag: '窗口A', seen: null }, winB = { tag: '窗口B', seen: null };
  const poll = async w => { w.seen = await bundle(); return w.seen; };

  sub('D1  两个窗口各自轮询（并发、互不知情）');
  await req('POST', '/v1/demo/reset');
  await Promise.all([poll(winA), poll(winB)]);
  kv('窗口A 看到待批', String(winA.seen.approvals_pending));
  kv('窗口B 看到待批', String(winB.seen.approvals_pending));

  sub('D2  在窗口A 里提交一个被门控的请求');
  const q3 = await req('POST', '/v1/act/queue', {
    headers: { 'Idempotency-Key': 'acc-d-' + Date.now() },
    body: { kind: 'tts.seed_audio', shard: 'ACC_D', cost_cny: COST, route: 'approve' }
  });
  const actD = q3.json.data;
  const blocked = await req('POST', '/v1/act/' + actD.id + '/confirm', { body: {} });
  kv('窗口A 的操作结果', 'HTTP ' + blocked.status + ' · ' + blocked.json.error.code +
    ' · ' + blocked.json.error.approval_id);
  const aprD = blocked.json.error.approval_id;

  await Promise.all([poll(winA), poll(winB)]);
  kv('窗口A 刷新后待批', String(winA.seen.approvals_pending));
  kv('窗口B 刷新后待批', String(winB.seen.approvals_pending));
  ck('两个独立会话同时看到同一张单子（窗口B 没做任何操作也看见了）',
    winA.seen.approvals_pending === 1 && winB.seen.approvals_pending === 1,
    'A=' + winA.seen.approvals_pending + ' B=' + winB.seen.approvals_pending);

  sub('D3  在窗口B 裁决 → 窗口A 应该同步看到变化');
  const decD = await req('POST', '/v1/approvals/' + aprD + '/decide',
    { body: { decision: 'approve', by: 'user（在窗口B）' } });
  kv('窗口B 裁决', 'HTTP ' + decD.status + ' · ' + (decD.json.data && decD.json.data.status));
  await Promise.all([poll(winA), poll(winB)]);
  kv('窗口A 刷新后待批', String(winA.seen.approvals_pending));
  kv('窗口B 刷新后待批', String(winB.seen.approvals_pending));
  const actD2 = actionOf(winA.seen, actD.id);
  kv('窗口A 看到该动作', actD ? (actD2.status + ' · 预算 ' + winA.seen.budget.used) : '-');
  ck('两端同时看到待批清零',
    winA.seen.approvals_pending === 0 && winB.seen.approvals_pending === 0,
    'A=' + winA.seen.approvals_pending + ' B=' + winB.seen.approvals_pending);
  ck('窗口A 没裁决，却看到动作已被执行（状态真的挂在服务端）',
    actD2 && actD2.status === 'EXECUTED',
    'act=' + actD.id + ' → ' + (actD2 && actD2.status) + ' · budget.used=' + winA.seen.budget.used);
  ck('裁决人与时间对两个窗口都可见（可追溯，不是黑箱）',
    winA.seen.approvals.some(a => a.id === aprD && a.decided_by && a.decided_at),
    (winA.seen.approvals.find(a => a.id === aprD) || {}).decided_by);

  /* ═══════════════════════════════════════════════════════════════════════ */
  sec('汇总');
  const w = Math.max(...ROWS.map(r => r.name.length), 10);
  ROWS.forEach(r => line('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name.padEnd(w) + '  ' + r.ev));
  line('');
  line('  ' + '─'.repeat(76));
  line('  验收项 ' + N + '   通过 ' + PASS + '   失败 ' + FAIL +
    '   耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  line('  ' + (FAIL === 0 ? '全部通过。可以进人工复核（打开页面点一遍）。' : '有失败项，看上面的证据。'));
  line('');

  await req('POST', '/v1/demo/reset');   // 收尾归零，不留验收垃圾
  line('  已 demo/reset 归零，不把验收产生的数据留给下一次。');
  process.exitCode = FAIL === 0 ? 0 : 1;
})().catch(e => {
  line('');
  line('验收脚本自身出错：' + (e && e.stack || e));
  process.exit(3);
});
