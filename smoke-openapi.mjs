/* OpenAPI 导出冒烟
 *
 * 这一套要证的不是「有个 json 能下」，而是一句更强的话：
 *   spec 描述的就是正在跑的那个服务，一条不差，而且它不撒谎。
 * 所以断言分三组：
 *   1. 结构合规 —— 不套信封、根键干净、operationId 唯一、路径用 {id} 不用 :id
 *   2. 不漂移   —— spec 的 (方法,路径) 集合 === /v1/health 自报的 routes，双向差集都为空
 *   3. 不撒谎   —— spec 里标了 x-gate 的端点，真调一次必须真的 403；
 *                  标了 x-idempotency=required 的，不带键真调必须真的 400。
 * 第 3 组是关键：一份「读起来对」但和真实行为不符的 spec，比没有 spec 更坏。
 *
 * 用法： node smoke-openapi.mjs            （默认 http://127.0.0.1:8787）
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const chk = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); }
};
const sec = s => console.log('\n--- ' + s + ' ---');
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function call(method, path, body, idemKey) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      idemKey ? { 'Idempotency-Key': idemKey } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = { parse_error: e.message }; }
  return { status: r.status, body: j, rid: r.headers.get('x-request-id'),
    ctype: r.headers.get('content-type') || '',
    hdr: Object.fromEntries(r.headers.entries()) };
}

// 把 spec 里的 {id} 换回服务端路由表用的 :id，以便逐条比对
const oapiToServer = (method, p) => method.toUpperCase() + ' ' + p.replace(/\{(\w+)\}/g, ':$1');
const flatten = spec => Object.entries(spec.paths).flatMap(([p, item]) =>
  Object.entries(item).map(([m, op]) => ({ path: p, method: m.toUpperCase(), op, key: oapiToServer(m, p) })));

const run = async () => {
  sec('0. 文档可达且是「文档」而不是「操作」');
  const r = await call('GET', '/v1/openapi.json');
  chk('200', r.status === 200, r.status);
  chk('Content-Type 是 application/openapi+json', r.ctype.indexOf('application/openapi+json') === 0, r.ctype);
  chk('X-Request-Id 头仍在（文档也要可观测）', /^req_[0-9a-f]{8}$/.test(r.rid || ''), r.rid);

  const spec = r.body;
  chk('根键没有被统一信封污染（没有 ok / data / _meta）',
    !('_meta' in spec) && !('ok' in spec) && !('data' in spec),
    Object.keys(spec).slice(0, 8).join(','));
  chk('是 OpenAPI 3.1', spec.openapi === '3.1.0', spec.openapi);
  chk('带 info.title / info.description', !!spec.info && !!spec.info.title && !!spec.info.description);
  chk('带 components.schemas.Envelope（统一信封有定义）',
    !!spec.components && !!spec.components.schemas && !!spec.components.schemas.Envelope);
  chk('Envelope 声明了 requires 枚举', (() => {
    const s = spec.components.schemas.Envelope.properties.requires;
    return !!s && Array.isArray(s.enum) && s.enum.indexOf('auto') >= 0 && s.enum.indexOf('human') >= 0;
  })());

  const x = spec['x-agent-console'];
  chk('带 x-agent-console 扩展', !!x);
  chk('扩展里没有 request_id —— 每请求都会变的东西不进文档体', !('request_id' in x));
  chk('扩展里没有 latency_ms / tokens_estimate —— 传输统计归传输层',
    !('latency_ms' in x) && !('tokens_estimate' in x));
  chk('传输统计改走响应头（X-Request-Id / X-Latency-Ms / X-Doc-Tokens）',
    r.hdr['x-request-id'] === r.rid && !!r.hdr['x-latency-ms'] && !!r.hdr['x-doc-tokens'],
    'latency=' + r.hdr['x-latency-ms'] + ' tokens=' + r.hdr['x-doc-tokens']);
  chk('带 contract_digest（内容摘要，替代时间戳）',
    !!(x && /^[0-9a-f]{16}$/.test(x.contract_digest)), x && x.contract_digest);
  chk('响应头里也给出 digest，下游不比文档体就能发现契约变更',
    r.hdr['x-contract-digest'] === x.contract_digest, r.hdr['x-contract-digest']);
  chk('扩展里没有 generated_at —— 时间戳会让「同一份契约」每次都不一样',
    !('generated_at' in x));
  chk('扩展里写明「文档不套信封」的理由', !!(x && x.documents_are_not_operations));
  chk('扩展里写明确定性承诺', !!(x && /逐字节相同/.test(x.deterministic)));
  chk('派生来源如实标注（不是手写文件）',
    !!(x && /ROUTES/.test(x.generated_from) && /不落盘/.test(x.generated_from)), x && x.generated_from);

  sec('1. 不漂移：spec ≡ /v1/health 自报的路由表');
  const h = await call('GET', '/v1/health');
  const served = new Set(h.body.data.routes);
  const ops = flatten(spec);
  const specKeys = new Set(ops.map(o => o.key));
  const missingInSpec = [...served].filter(k => !specKeys.has(k));
  const extraInSpec = [...specKeys].filter(k => !served.has(k));
  chk(`health 自报的 ${served.size} 条路由，spec 一条不少`, missingInSpec.length === 0,
    '缺: ' + missingInSpec.join(' | '));
  chk(`spec 的 ${specKeys.size} 条路由，health 一条不多`, extraInSpec.length === 0,
    '多: ' + extraInSpec.join(' | '));
  chk('spec 覆盖了规范端点 /v1/openapi.json 自己', specKeys.has('GET /v1/openapi.json'));

  sec('2. 元数据登记完整（漏登记不许静默）');
  const cov = x.meta_coverage;
  chk('meta_coverage.missing 为空（没有占位说明）', cov.missing.length === 0, JSON.stringify(cov.missing));
  chk('meta_coverage.extra 为空（没有登记了却不存在的路由）', cov.extra.length === 0, JSON.stringify(cov.extra));
  chk('declared === routes', cov.declared === cov.routes, cov.declared + '/' + cov.routes);
  chk('没有 operationId 撞车', x.duplicate_operation_ids.length === 0, JSON.stringify(x.duplicate_operation_ids));
  const ids = ops.map(o => o.op.operationId);
  chk('operationId 全局唯一（独立复核，不信自报）', new Set(ids).size === ids.length,
    ids.length + ' -> ' + new Set(ids).size);
  chk('每个 operation 都有 operationId / summary / tags / responses',
    ops.every(o => o.op.operationId && o.op.summary && o.op.tags.length && o.op.responses));
  chk('没有「（META 未登记）」的占位说明',
    ops.every(o => o.op.summary.indexOf('META 未登记') < 0));
  chk('operation 的 tags 都在根 tags 列表里', (() => {
    const declared = new Set(spec.tags.map(t => t.name));
    return ops.every(o => o.op.tags.every(t => declared.has(t)));
  })(), spec.tags.map(t => t.name).join(' | '));

  sec('3. 路径与参数写法规范');
  chk('路径模板用 {id} 而不是 :id', ops.every(o => o.path.indexOf(':') < 0));
  chk('带路径参数的 operation 都声明了 required path 参数', ops.every(o => {
    const need = [...o.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (!need.length) return true;
    const got = (o.op.parameters || []).filter(p => p.in === 'path' && p.required).map(p => p.name);
    return need.every(n => got.indexOf(n) >= 0);
  }));
  chk('GET 操作都标了 x-idempotency=safe', ops.filter(o => o.method === 'GET')
    .every(o => o.op['x-idempotency'] === 'safe'));
  chk('每个 operation 都有 x-gate / x-requires / x-idempotency 三个扩展',
    ops.every(o => o.op['x-gate'] && o.op['x-requires'] && o.op['x-idempotency']));

  sec('4. 门控在 spec 里如实标注（agent 能在调用前就知道）');
  const policy = h.body.data.gate.policy;
  const gatedOps = ops.filter(o => o.op['x-gate'].level !== 'none');
  chk(`GATE 的 ${policy.length} 条策略在 spec 里都被标成 gated`, (() => {
    const marked = new Set(gatedOps.map(o => o.key));
    return policy.every(p => marked.has(p.route));
  })(), gatedOps.map(o => o.key).join(' | '));
  chk('反过来，被标 gated 的都在服务端 GATE 里（没多标）', (() => {
    const real = new Set(policy.map(p => p.route));
    return gatedOps.every(o => real.has(o.key));
  })());
  chk('gated 的 operation 声明了 403 响应', gatedOps.every(o => !!o.op.responses['403']));
  chk('gated 的 why 与 health 里的策略一致', (() => {
    const why = new Map(policy.map(p => [p.route, p.why]));
    return gatedOps.every(o => why.get(o.key) === o.op['x-gate'].why);
  })());
  chk('gated 的 operation 说明了执行入口是审批裁决端点',
    gatedOps.every(o => /approvals\/\{id\}\/decide/.test(o.op['x-gate'].execution_entry || '')));
  chk('非 gated 的 operation 也带 x-gate（level=none，而不是缺字段）',
    ops.filter(o => o.op['x-gate'].level === 'none').length === ops.length - gatedOps.length);
  chk('人类专属表面在 spec 里被标出来', (() => {
    const d = ops.find(o => o.key === 'POST /v1/approvals/:id/decide');
    return !!d && d.op['x-human-surface'] === true;
  })());

  sec('5. 幂等强度如实标注');
  const idemOps = ops.filter(o => o.op['x-idempotency'] === 'required');
  chk('只有 act/queue 被标 required（服务端唯一强制幂等键的写端点）',
    idemOps.length === 1 && idemOps[0].key === 'POST /v1/act/queue',
    idemOps.map(o => o.key).join(' | '));
  chk('act/queue 声明了必填的 Idempotency-Key header 参数', (() => {
    const p = (idemOps[0].op.parameters || []).find(z => z.name === 'Idempotency-Key');
    return !!p && p.in === 'header' && p.required === true;
  })());
  const writes = ops.filter(o => o.method !== 'GET');
  /* 幂等档位断言。刻意不断言「某档有 N 条」—— 档位分布会随端点增减而变，
   * 把测试绑在数字上只会让它变成噪声。要证的是**声明的档位与实测行为一致**。 */
  const idemDist = {};
  writes.forEach(o => { const v = o.op['x-idempotency']; idemDist[v] = (idemDist[v] || 0) + 1; });
  chk(`写端点的幂等档位如实标注（${JSON.stringify(idemDist)}）`,
    Object.keys(idemDist).every(k => ['required', 'optional', 'fingerprint_dedup'].includes(k)),
    Object.keys(idemDist).join(','));
  chk('没有写端点被标成「无保护」（not_enforced 这一档已不存在）',
    !('not_enforced' in idemDist), 'not_enforced=' + (idemDist.not_enforced || 0));
  chk('optional 档存在（写端点的默认档）', (idemDist.optional || 0) > 0, 'optional=' + (idemDist.optional || 0));
  chk('optional 端点带了键真能重放（声明的保证真存在，不是话术）', await (async () => {
    const k = 'smoke-opt-' + hex(8);
    const r1 = await call('POST', '/v1/senses/measure', { artifact: 'CH01_smoke.mp3', profile: 'scribl.v1' }, k);
    const r2 = await call('POST', '/v1/senses/measure', { artifact: 'CH01_smoke.mp3', profile: 'scribl.v1' }, k);
    return r1.status === 200 && r2.body.replayed === true &&
      !!r2.body.idempotency && r2.body.idempotency.scope === 'optional';
  })());
  chk('optional 端点不带键则不受约束（「可选」的另一半：默认行为不变）', await (async () => {
    const r = await call('POST', '/v1/senses/measure', { artifact: 'CH01_smoke2.mp3', profile: 'scribl.v1' });
    return r.status === 200 && r.body.replayed === undefined && r.body.idempotency === undefined;
  })());
  chk('同键跨端点 → 拒绝（一个键代表一件事）', await (async () => {
    const k = 'smoke-x-' + hex(8);
    await call('POST', '/v1/senses/measure', { artifact: 'CH01_smoke3.mp3', profile: 'scribl.v1' }, k);
    const r = await call('POST', '/v1/senses/transcribe', { artifact: 'CH01_smoke3.wav' }, k);
    return r.status === 409 && r.body.error.code === 'IDEMPOTENCY_KEY_CONFLICT';
  })());

  sec('6. 兼容别名标了 deprecated 并指回正主');
  const aliases = ops.filter(o => o.op.deprecated);
  chk('两个兼容别名都标了 deprecated', aliases.length === 2, aliases.map(o => o.key).join(' | '));
  chk('别名用 x-alias-of 指回规范端点', aliases.every(o => {
    const target = o.op['x-alias-of'];
    return typeof target === 'string' && specKeys.has(target);
  }), aliases.map(o => o.op['x-alias-of']).join(' | '));
  chk('规范端点本身没被标 deprecated', ops.filter(o => o.op['x-alias-of']).length === 1 ||
    !ops.some(o => o.key === 'POST /v1/act/:id/confirm' && o.op.deprecated));

  sec('7. 关键：spec 不撒谎 —— 拿它声明的去真调');
  // 声明 gated 的端点，真调必须真的被截停
  const gatedTarget = ops.find(o => o.key === 'POST /v1/act/:id/confirm');
  const probe = await call('POST', '/v1/act/' + 'act_' + hex(6) + '/confirm', { action_id: 'act_' + hex(6) });
  chk('spec 说 gated → 真调确实 403', probe.status === 403, probe.status);
  chk('403 的 code 就是 spec 里那句 REQUIRE_APPROVAL', probe.body.error.code === 'REQUIRE_APPROVAL');
  chk('确实挂起了（回执带审批单号）', /^apr_[0-9a-f]{6}$/.test(probe.body.error.approval_id || ''),
    probe.body.error.approval_id);
  chk('挂起回执自己声明没有绕过路径',
    /只从审批回放/.test((probe.body.gate && probe.body.gate.bypass) || ''));
  chk('gatedTarget 在 spec 里标注与实际一致',
    gatedTarget.op['x-gate'].level !== 'none' && gatedTarget.op.responses['403'] !== undefined);

  // 声明 x-idempotency=required 的端点，不带键真调必须被拒
  const noKey = await call('POST', '/v1/act/queue', { kind: 'tts.seed_audio', shard: 'CH01_S01', cost_cny: 0.01 });
  chk('spec 说 required → 不带 Idempotency-Key 真调确实被拒（400）', noKey.status === 400, noKey.status);
  chk('错误码 IDEMPOTENCY_KEY_REQUIRED', noKey.body.error.code === 'IDEMPOTENCY_KEY_REQUIRED');
  const withKey = await call('POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH01_S01', cost_cny: 0.01 }, 'idem_openapi_' + hex(12));
  chk('带上键就正常入队（201，与 spec 声明的成功码一致）', withKey.status === 201, withKey.status);
  chk('成功码与 spec 里声明的 ok 状态一致', withKey.status === (idemOps[0].op.responses['201'] ? 201 : 200));

  // 声明 x-requires 是 auto 的端点，真调不该要人
  const autoOp = ops.find(o => o.key === 'GET /v1/approvals');
  const autoRes = await call('GET', '/v1/approvals');
  chk('spec 说 requires=auto 的端点真调不需要人（200 且 requires 不是 human）',
    autoRes.status === 200 && autoRes.body.requires !== 'human',
    autoRes.status + ' / ' + autoRes.body.requires);

  sec('8. 确定性：同一份路由表派生出同一份 spec');
  const r2 = await call('GET', '/v1/openapi.json');
  // 注意这里不去掉任何东西 —— 从前要把 x-agent-console 剥掉才能比，
  // 因为传输元数据被塞在文档体里。现在文档体里没有每请求都变的东西，
  // 「同一份活元数据 → 逐字节相同的文档」是一条可以直接验的硬承诺。
  chk('两次派生的 spec 逐字节完全相同（不剥离任何字段）',
    JSON.stringify(spec) === JSON.stringify(r2.body),
    'len=' + JSON.stringify(spec).length);
  chk('两次的 contract_digest 相同', spec['x-agent-console'].contract_digest ===
    r2.body['x-agent-console'].contract_digest, spec['x-agent-console'].contract_digest);
  chk('digest 是对内容算的：它不等于任何请求相关的值',
    !/^req_/.test(spec['x-agent-console'].contract_digest) &&
    spec['x-agent-console'].contract_digest !== r.rid);

  sec('9. 已知边界如实写进 spec（而不是藏起来）');
  chk('honesty 列表非空', Array.isArray(x.honesty) && x.honesty.length >= 3, (x.honesty || []).length);
  chk('承认默认无鉴权', x.honesty.some(s => /无鉴权/.test(s)));
  chk('承认网关先于业务校验（不存在的 id 也会被挂起）',
    x.honesty.some(s => /网关先于业务校验/.test(s)));
  chk('承认「幂等是可选的」：不带键就没有任何约束（不笼统说「已幂等」）',
    x.honesty.some(s => /optional/.test(s) && /不带键/.test(s)));
  chk('承认审批单默认永不过期、TTL 是可选能力（不是默认行为）',
    x.honesty.some(s => /TTL/.test(s) && /过期/.test(s)));
  chk('health 里指向了该契约端点', h.body.data.contract.openapi === '/v1/openapi.json',
    h.body.data.contract && h.body.data.contract.openapi);

  sec('10. agent-native 声明：机器语义写进契约，而不是只躺在散文里');
  const env = spec.components.schemas.Envelope.properties;
  const hintAct = env.hints.items.properties.action;
  chk('hints[].action 已声明（agent 分支于它，而不是解析中文）',
    !!hintAct && Array.isArray(hintAct.enum), hintAct && hintAct.enum && hintAct.enum.length);
  chk('action enum 用机器语义命名（全小写下划线，跨语区稳定）',
    hintAct.enum.every(v => /^[a-z][a-z_]*$/.test(v)), hintAct.enum.join(','));
  chk('action enum 含 stop_retry（最省上下文的那条信号）',
    hintAct.enum.indexOf('stop_retry') >= 0);
  chk('hints 的 required 里含 action（没写进去就不算声明）',
    (env.hints.items.required || []).indexOf('action') >= 0, (env.hints.items.required || []).join(','));
  chk('error.code 已声明 enum', Array.isArray(env.error.properties.code.enum),
    env.error.properties.code.enum && env.error.properties.code.enum.length + ' 个');
  chk('error 的必填字段已声明', ['code', 'message'].every(k => (env.error.required || []).indexOf(k) >= 0));
  chk('error 的 approval_id / fingerprint / hits 已声明（403 body 不必靠猜）',
    ['approval_id', 'fingerprint', 'hits'].every(k => k in env.error.properties),
    Object.keys(env.error.properties).join(','));
  chk('gate 声明了属性，不是 type:object 的空壳',
    !!env.gate.properties && Object.keys(env.gate.properties).length >= 4,
    env.gate.properties && Object.keys(env.gate.properties).length);

  const gidPath = Object.keys(spec.paths).filter(p => /^\/v1\/approvals\/\{/.test(p) && p.indexOf('decide') < 0);
  chk('单查端点 /v1/approvals/{id} 已在 spec 里', gidPath.length === 1, gidPath.join(','));
  const gop = gidPath.length ? spec.paths[gidPath[0]].get : null;
  chk('单查端点声明 requires 含 human_or_llm（谁说了算随状态变）',
    gop && Array.isArray(gop['x-requires']) && gop['x-requires'].indexOf('human_or_llm') >= 0,
    gop && JSON.stringify(gop['x-requires']));
  chk('单查端点是 GET 且标为幂等安全', gop && gop['x-idempotency'] === 'safe', gop && gop['x-idempotency']);

  sec('11. 词表与现实对称：enum 不许比现实少写一条，而且兜底真的被断言');
  /* 这一组是补的账。此前 server.js 里**有**运行时探测（不在词表内的 action 会让它现形），
   * 但**没有任何测试断言它恒为空** —— 而 README / 简报里却写着「测试层断言它恒为空」。
   * 一份声明了却没人守的保证，比没有保证更坏：它会让人以为有护栏。
   * 所以这里把三件事一起钉死：静态（enum ≡ 源码字面量）、运行时（探测结果恒为空）、
   * 以及**反空过**（扫到的响应里必须真的有 hints[]，否则这组断言等于没测）。 */
  let skipped = 0;
  const skip = (why) => { skipped++; console.log('  SKIP  ' + why); };

  let src = null;
  try { src = (await import('node:fs')).readFileSync('server.js', 'utf8'); } catch { /* 远程实例跑法下读不到源码 */ }
  if (!src) {
    skip('读不到 server.js（BASE 指向外部实例）→ 静态一致性未测，仅测运行时');
  } else {
    const arr = (name) => {
      const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\]\\s*;'));
      return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : null;
    };
    const srcHint = arr('HINT_ACTIONS'), srcCode = arr('ERROR_CODES');
    chk('源码里能找到两份词表（找不到就没法比对）', !!srcHint && !!srcCode);
    const liveHint = hintAct.enum, liveCode = env.error.properties.code.enum;
    chk('契约的 action enum ≡ 源码 HINT_ACTIONS（逐字、同序）',
      JSON.stringify(liveHint) === JSON.stringify(srcHint),
      '契约 ' + liveHint.length + ' 项 vs 源码 ' + (srcHint || []).length + ' 项');
    chk('契约的 error.code enum ≡ 源码 ERROR_CODES（逐字、同序）',
      JSON.stringify(liveCode) === JSON.stringify(srcCode),
      '契约 ' + liveCode.length + ' 项 vs 源码 ' + (srcCode || []).length + ' 项');

    // 用后行断言挡住 error_code: / hint_action: 这类前缀造成的假命中
    const litAction = new Set([...src.matchAll(/(?<![A-Za-z_])action:\s*['"]([^'"]+)['"]/g)].map(x => x[1]));
    const litCode = new Set([...src.matchAll(/(?<![A-Za-z_])code:\s*['"]([^'"]+)['"]/g)].map(x => x[1]));
    const badAction = [...litAction].filter(v => liveHint.indexOf(v) < 0);
    const badCode = [...litCode].filter(v => liveCode.indexOf(v) < 0);
    chk('源码里每个 action 字面量都在 enum 内（漏一个 = enum 少写一条）',
      badAction.length === 0, badAction.join(','));
    chk('源码里每个 error.code 字面量都在 enum 内',
      badCode.length === 0, badCode.join(','));
    chk('两份词表都不是摆设（源码里确实在用）',
      litAction.size >= 5 && litCode.size >= 10, 'action ' + litAction.size + ' / code ' + litCode.size);

    chk('运行时探测确实存在（提示没了就等于没兜底）',
      /hint_action_violation/.test(src) && /error_code_violation/.test(src));
  }

  // 运行时：把会产生 hints / error 的路径都走一遍，看探测有没有现形
  const probes = [
    ['GET', '/'],                                   // 索引（内容协商）
    ['GET', '/v1/health'],
    ['GET', '/v1/openapi.json'],
    ['GET', '/v1/approvals'],
    ['GET', '/v1/approvals/apr_不存在'],
    ['GET', '/v1/audit?limit=5'],
    ['GET', '/v1/nope'],                            // 404 且带 hints
    ['POST', '/v1/act/confirm', {}],                // 门控 → 403 且带 3 条 hints
    ['POST', '/v1/act/queue', { k: 1 }],            // 缺幂等键 → 400
    ['POST', '/v1/senses/judge', {}]                // 判定类 → requires=human_or_llm
  ];
  let sawHints = 0, sawError = 0;
  const violations = [];
  for (const [m, p, b] of probes) {
    const res = await call(m, p, b);
    const meta = (res.body && res.body._meta) || {};
    if (Array.isArray(res.body && res.body.hints) && res.body.hints.length) sawHints++;
    if (res.body && res.body.error) sawError++;
    if ('hint_action_violation' in meta) violations.push(m + ' ' + p + ' → action ' + JSON.stringify(meta.hint_action_violation));
    if ('error_code_violation' in meta) violations.push(m + ' ' + p + ' → code ' + meta.error_code_violation);
  }
  chk('扫过 ' + probes.length + ' 条路径，两份词表违约恒为空（action + code 一起看）',
    violations.length === 0, violations.join(' ; '));
  chk('反空过：扫到的响应里真的带 hints[]（否则这组断言没测到东西）', sawHints >= 2, '带 hints 的响应 ' + sawHints + ' 条');
  chk('反空过：扫到的响应里真的带 error（探测有对象可查）', sawError >= 2, '带 error 的响应 ' + sawError + ' 条');

  sec('12. x-requires 是数组：类型一致，且运行时返回必落在声明集合内');
  /* 又一组补的账。此前 x-requires 可以是复合字符串 'auto | human' —— 它越出了
   * Envelope.requires 的 enum，还因为含 '|' 把任何直接拼它的 markdown 表格撕成两列
   * （交付物路由表第 13 行就是这么错位的）。旧断言 `x-requires === 'auto'` 恰好放它过去：
   * 复合值不等于 'auto'，于是它连那条真实性检查都不参与。
   * 现在 x-requires 一律是数组，这组断言防止它再退回复合字符串。 */
  const REQ_ENUM = ['auto', 'human', 'agent', 'human_or_llm'];
  chk('每个 operation 的 x-requires 都是数组（不是复合字符串）',
    ops.every(o => Array.isArray(o.op['x-requires'])),
    ops.filter(o => !Array.isArray(o.op['x-requires'])).map(o => o.key + '=' + JSON.stringify(o.op['x-requires'])).join(',') || '全部是数组');
  chk('x-requires 每个元素都在合法枚举内（auto / human / agent / human_or_llm）',
    ops.every(o => Array.isArray(o.op['x-requires']) && o.op['x-requires'].every(v => REQ_ENUM.indexOf(v) >= 0)),
    ops.flatMap(o => Array.isArray(o.op['x-requires']) ? o.op['x-requires'] : []).filter(v => REQ_ENUM.indexOf(v) < 0).join(',') || '全部合法');
  chk('x-requires 非空（不能声明成空数组）',
    ops.every(o => Array.isArray(o.op['x-requires']) && o.op['x-requires'].length >= 1));
  const multiReq = ops.filter(o => Array.isArray(o.op['x-requires']) && o.op['x-requires'].length > 1);
  chk('多态端点用数组列出全部可能值（而不是伪装成单值）', multiReq.length >= 2,
    multiReq.map(o => o.key + '=' + JSON.stringify(o.op['x-requires'])).join(' | '));

  // 动态：抽样真调，运行时返回的 requires 必须落在契约声明的集合里
  const reqProbes = [
    ['GET', '/v1/approvals'],
    ['GET', '/v1/state/checkpoint'],
    ['POST', '/v1/senses/measure', { artifact: 'x.mp3', profile: 'scribl.v1' }],
    ['POST', '/v1/senses/judge', { subject: 'x', question: 'q' }],
  ];
  let reqChecked = 0; const reqBad = [];
  for (const [m, p, b] of reqProbes) {
    const res = await call(m, p, b);
    const got = res.body && res.body.requires;
    const op = ops.find(o => o.key === m + ' ' + p);
    if (!op || got === undefined) continue;
    reqChecked++;
    if (op.op['x-requires'].indexOf(got) < 0) reqBad.push(m + ' ' + p + ' 返回 ' + got + ' 不在 ' + JSON.stringify(op.op['x-requires']));
  }
  chk('抽样 ' + reqChecked + ' 个端点：运行时返回的 requires 都落在契约声明的集合内',
    reqBad.length === 0 && reqChecked >= 3, reqBad.join(' ; ') || ('核对 ' + reqChecked + ' 个端点'));

  console.log('');
  console.log('  ---- ' + pass + ' passed / ' + fail + ' failed' +
    (skipped ? ' / ' + skipped + ' skipped（已在上面逐条说明）' : '') + ' ----');
  process.exit(fail ? 1 : 0);
};

run().catch(e => { console.error('运行失败:', e); process.exit(1); });
