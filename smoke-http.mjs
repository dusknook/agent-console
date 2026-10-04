/* Agent Console 后端 · 真实 HTTP 冒烟
 * 打的是跑着的服务进程，不是页面里的 mock 引擎。
 * 用法： node smoke-http.mjs            （默认 http://127.0.0.1:8787）
 *        BASE=http://127.0.0.1:8788 node smoke-http.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const chk = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); }
};
const sec = s => console.log('\n--- ' + s + ' ---');

async function call(method, path, body, idemKey) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      idemKey ? { 'Idempotency-Key': idemKey } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = { parse_error: e.message }; }
  return { status: r.status, body: j, rid: r.headers.get('x-request-id') };
}
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const newKey = () => 'idem_smoke_' + hex(12);

// ─────────────────────────────────────────────────────────────
const run = async () => {
  sec('0. 服务与契约');
  const h = await call('GET', '/v1/health');
  chk('health 200', h.status === 200 && h.body.ok === true);
  chk('健康检查暴露 db 路径与 pid', !!h.body.data.db_path && !!h.body.data.pid, h.body.data.db_path);
  chk('暴露端点数量', h.body.data.endpoints >= 20, h.body.data.endpoints);
  chk('响应头带 X-Request-Id', /^req_[0-9a-f]{8}$/.test(h.rid || ''), h.rid);
  chk('_meta.latency_ms 是实测值（非 0、非固定）', typeof h.body._meta.latency_ms === 'number' && h.body._meta.latency_ms >= 0);
  chk('_meta.tokens_estimate 按真实字节估算', h.body._meta.tokens_estimate > 0 &&
    h.body._meta.tokens_note === '真实响应体的 chars/4 估算，非模拟值');
  chk('_meta 声明闸门在服务进程', h.body._meta.gate_enforced_at === 'server process');

  const nf = await call('GET', '/v1/nope');
  chk('未知端点 404 ENDPOINT_NOT_FOUND', nf.status === 404 && nf.body.error.code === 'ENDPOINT_NOT_FOUND');

  // 契约一致性：前端目录里声明的每个端点，后端必须真实存在（反向也会被下面的断言覆盖）
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('./ai-workbench.html', import.meta.url), 'utf8');
  const declared = [...html.matchAll(/method:"(\w+)",\s*path:"([^"]+)"/g)]
    .map(m => m[1] + ' ' + m[2].replace(/\{(\w+)\}/g, ':$1'));
  const served = new Set(h.body.data.routes);
  const missing = declared.filter(r => !served.has(r));
  chk(`前端声明的 ${declared.length} 个端点后端全部实现`, missing.length === 0,
    '缺失: ' + missing.join(' | '));

  sec('1. 重置到种子状态');
  const rs = await call('POST', '/v1/demo/reset');
  chk('重置成功', rs.status === 200 && rs.body.data.reset === true);
  const b0 = await call('GET', '/v1/state/bundle');
  chk('bundle 一次返回全部 UI 状态',
    b0.body.data.budget.used === 12.4 && b0.body.data.decisions.length === 3 &&
    b0.body.data.assets.length === 1 && typeof b0.body.data.leases === 'object');
  chk('bundle 含快照栈与审计', b0.body.data.snapshots.length === 3 && b0.body.data.audit.length >= 1);

  sec('2. 状态层 · 决策锁定 + 变更通路（接上悬空引用）');
  const w1 = await call('PUT', '/v1/state/decisions', { key: 'voice.lead', value: 'hacked' });
  chk('覆盖锁定决策 409 DECISION_LOCKED', w1.status === 409 && w1.body.error.code === 'DECISION_LOCKED');
  chk('409 自动开出 change_request（不只是字面承诺）',
    w1.body.change_request && w1.body.change_request.open === true && /^CHG-\w{6}$/.test(w1.body.change_request.id),
    w1.body.change_request && w1.body.change_request.id);
  const crId = w1.body.change_request.id;
  const crList = await call('GET', '/v1/state/change_requests');
  chk('变更请求已落库、可列取', crList.status === 200 && crList.body.data.open === 1);
  chk('该端点此前在 v2 里是悬空的（只有承诺没有实现）', !!crList.body.data.change_requests[0].approve);
  const ap = await call('POST', `/v1/state/change_requests/${crId}/approve`, { by: 'user' });
  chk('「人工批准」这个动作本身也在门控内 → agent 直接调得到 403 挂起',
    ap.status === 403 && ap.body.error.code === 'REQUIRE_APPROVAL', ap.status);
  const crApr = ap.body.error.approval_id;
  const apDecided = await call('POST', `/v1/approvals/${crApr}/decide`, { decision: 'approve', by: 'user' });
  chk('经审批放行后，服务端回放原始请求 → 200',
    apDecided.status === 200 && apDecided.body.data.replay.status === 200, apDecided.status);
  const inner = apDecided.body.data.replay.body;
  chk('批准后旧记录被 superseded 而非改写', !!inner.data.superseded && !!inner.data.superseded.id);
  chk('新记录沿用同一 key 并链上 previous_id',
    inner.data.current.value === 'hacked' && inner.data.current.previous_id === inner.data.superseded.id);
  const ap2 = await call('POST', `/v1/state/change_requests/${crId}/approve`, { by: 'user' });
  chk('再次调用仍被门控拦下（拦的是「调用」，与业务状态无关）', ap2.status === 403, ap2.status);
  const ap2d = await call('POST', `/v1/approvals/${ap2.body.error.approval_id}/decide`, { decision: 'approve' });
  chk('放行后由业务状态机拒绝（外层 200 / 内层 409 / 单据标 FAILED）',
    ap2d.status === 200 && ap2d.body.data.replay.status === 409 && ap2d.body.data.status === 'FAILED',
    JSON.stringify([ap2d.body.data.status, ap2d.body.data.replay.status]));
  const dl = await call('GET', '/v1/state/decisions?include_superseded=1');
  chk('历史决策仍可回溯（4 条 = 3 现役 + 1 被替代）', dl.body.data.count === 4, dl.body.data.count);
  const w2 = await call('PUT', '/v1/state/decisions', { key: 'scene.pov', value: 'third person, close' });
  chk('新键可写入并锁定', w2.status === 201 && w2.body.data.immutable === true);

  sec('3. 状态层 · 版本化资产');
  const a1 = await call('GET', '/v1/state/assets');
  chk('资产含完整版本历史', a1.body.data.assets[0].versions.length === 2 && a1.body.data.assets[0].current_version === 2);
  const a2 = await call('PUT', '/v1/state/assets', { asset_id: 'voice.lead.ref', value: 'breathy', note: '客户要求' });
  chk('变更默认开新版本，不返回 409', a2.status === 201 && a2.body.data.new_version === 3, a2.status);
  chk('旧版本全部保留', a2.body.data.previous_versions_kept === 2);
  const a3 = await call('PUT', '/v1/state/assets', { asset_id: 'voice.lead.ref', value: 'x', target_version: 1 });
  chk('显式改历史版本才 409 VERSION_IMMUTABLE', a3.status === 409 && a3.body.error.code === 'VERSION_IMMUTABLE');
  const a4 = await call('PUT', '/v1/state/assets', { asset_id: 'nope.ref', value: 'x' });
  chk('不存在的资产 404', a4.status === 404 && a4.body.error.code === 'ASSET_NOT_FOUND');

  sec('4. 状态层 · 断点');
  const cp = await call('GET', '/v1/state/checkpoint');
  chk('断点带 snapshot_head 与来源', !!cp.body.data.snapshot_head && cp.body.data.source.startsWith('sqlite:'),
    cp.body.data.source);
  chk('断点给出下一步分片', cp.body.data.next.shard === 'CH03_S04');
  chk('断点暴露未决异常且标注可自修', cp.body.data.open_exceptions[0].requires === 'auto');

  sec('5. 感官层 · 能力边界');
  const m = await call('POST', '/v1/senses/measure', { artifact: 'CH02.mp3', profile: 'scribl.v1' });
  chk('measure 可判定 FAIL', m.body.data.verdict === 'FAIL' && m.body.data.failed_metrics.includes('tail_silence_s'));
  chk('measure 诚实标注未覆盖维度', m.body.data.coverage.not_covered.length === 3);
  chk('measure requires=auto', m.body.requires === 'auto');
  const j1 = await call('POST', '/v1/senses/judge', { subject: 'CH03_S04', question: '情绪连贯?', kind: 'semantic' });
  chk('语义判定不假装能做：escalated + UNDETERMINED',
    j1.body.data.escalated === true && j1.body.data.verdict === 'UNDETERMINED' && j1.body.requires === 'human_or_llm');
  chk('语义判定列出"不可自动化"原因', j1.body.data.not_automatable.length === 2);
  const j2 = await call('POST', '/v1/senses/judge', { subject: 'CH03_S04', question: '时长在范围?', kind: 'rule' });
  chk('规则判定仍走自动', j2.body.requires === 'auto' && j2.body.data.escalated === false);
  const tr = await call('POST', '/v1/senses/transcribe', { artifact: 'CH03_S04.wav', language: 'en-US' });
  chk('转写返回时间轴片段', tr.body.data.segments.length === 4 && tr.body.data.segments[2].speaker === 'mara');
  const df = await call('GET', '/v1/senses/diff?from=v11&to=v12');
  chk('diff 只回变化项并汇总未变数', df.body.data.changed_count === 3 && df.body.data.unchanged_count === 1847);

  sec('6. 行动层 · 幂等（存储层 UNIQUE，非应用层 if）');
  const q0 = await call('POST', '/v1/act/queue', { kind: 'tts', cost_cny: 0.42 });
  chk('缺幂等键 400 IDEMPOTENCY_KEY_REQUIRED',
    q0.status === 400 && q0.body.error.code === 'IDEMPOTENCY_KEY_REQUIRED');

  const K = newKey();
  const q1 = await call('POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH03_S04', cost_cny: 0.42, route: 'approve', reason: '续生成第四段' }, K);
  chk('首次入队 201 且挂起', q1.status === 201 && q1.body.data.status === 'PENDING_CONFIRMATION');
  chk('gate 声明由服务进程持有且下一步本身也被门控',
    q1.body.gate && q1.body.gate.enforced_in.indexOf('server process') === 0 &&
    q1.body.gate.next_is_gated === true, JSON.stringify(q1.body.gate && q1.body.gate.enforced_in));
  const assetId = q1.body.data.id;
  const q2 = await call('POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH03_S04', cost_cny: 0.42, route: 'approve' }, K);
  chk('同键重发 200 replayed=true', q2.status === 200 && q2.body.replayed === true);
  chk('重放返回首次响应的 action_id', q2.body.data.action_id === assetId);
  chk('首次与重放的响应字段名一致（客户端不必先判断是不是重放）',
    q2.body.data.id !== undefined && q2.body.data.id === q1.body.data.id,
    'q1.id=' + q1.body.data.id + ' q2.id=' + q2.body.data.id);
  chk('重放命中次数自增（可观测）', q2.body.idempotency.hits === 1, q2.body.idempotency.hits);
  chk('幂等约束标明是表主键', q2.body.idempotency.storage_constraint === 'PRIMARY KEY(idem_keys.key)');

  const Krace = newKey();
  const race = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH03_S07', cost_cny: 0.11, route: 'approve' }, Krace)));
  const created = race.filter(r => r.status === 201).length;
  const replayed = race.filter(r => r.body.replayed === true).length;
  chk('并发 6 次同键：仅 1 次真正创建', created === 1, 'created=' + created);
  chk('并发 6 次同键：其余 5 次全部重放', replayed === 5, 'replayed=' + replayed);
  const bundleAfter = await call('GET', '/v1/state/bundle');
  chk('并发后队列里只有 2 条动作（未产生重复副作用）',
    bundleAfter.body.data.actions.length === 2, bundleAfter.body.data.actions.length);

  sec('7. 行动层 · 路由与预算闸门');
  const q3 = await call('POST', '/v1/act/queue', { kind: 'tts', cost_cny: 0.42, route: 'auto' }, newKey());
  chk('花钱动作走 auto → 422 ROUTE_CONFLICT', q3.status === 422 && q3.body.error.code === 'ROUTE_CONFLICT');
  const q4 = await call('POST', '/v1/act/queue', { kind: 'snapshot.prune', cost_cny: 0, route: 'auto' }, newKey());
  chk('零成本动作 auto 直接执行', q4.status === 201 && q4.body.data.status === 'EXECUTED');
  const q5 = await call('POST', '/v1/act/queue', { kind: 'tts', cost_cny: 1, route: 'conditional' }, newKey());
  chk('conditional 路由挂起等条件', q5.status === 201 && q5.body.data.status === 'AWAITING_CONDITION');
  const bPre = await call('GET', '/v1/state/bundle');
  chk('挂起动作只占预留，不计入已用',
    bPre.body.data.budget.used === 12.4 && bPre.body.data.budget.reserved >= 0.42,
    JSON.stringify(bPre.body.data.budget));

  await call('POST', '/v1/demo/push_budget', { used: 49.8 });
  const K402 = newKey();
  const z = await call('POST', '/v1/act/queue', { kind: 'tts', cost_cny: 0.42, route: 'approve' }, K402);
  chk('超预算 402 BUDGET_EXCEEDED', z.status === 402 && z.body.error.code === 'BUDGET_EXCEEDED');
  chk('402 附预算明细（含 over_by）', typeof z.body.error.budget.over_by === 'number');
  const zRetry = await call('POST', '/v1/act/queue', { kind: 'tts', cost_cny: 0.42, route: 'approve' }, K402);
  chk('被拦动作未记住幂等键（提高上限后可重试）', zRetry.status === 402);
  const bAfter = await call('GET', '/v1/state/bundle');
  chk('被拦动作未入队', bAfter.body.data.actions.length === bPre.body.data.actions.length,
    bAfter.body.data.actions.length + ' vs ' + bPre.body.data.actions.length);
  await call('POST', '/v1/demo/push_budget', { used: 12.4 });

  sec('8. 行动层 · 门控状态机与回滚');
  const used0 = (await call('GET', '/v1/state/bundle')).body.data.budget;
  const cf = await call('POST', `/v1/act/${assetId}/confirm`);
  chk('agent 直接 confirm 被网关截停 → 403 REQUIRE_APPROVAL',
    cf.status === 403 && cf.body.error.code === 'REQUIRE_APPROVAL', cf.status);
  const bMid = (await call('GET', '/v1/state/bundle')).body.data.budget;
  chk('被拦后账目一字未动（业务代码没跑）',
    Math.abs(bMid.used - used0.used) < 1e-9 && Math.abs(bMid.reserved - used0.reserved) < 1e-9,
    JSON.stringify(bMid) + ' vs ' + JSON.stringify(used0));
  const okCf = await call('POST', `/v1/approvals/${cf.body.error.approval_id}/decide`,
    { decision: 'approve', by: 'user' });
  chk('人放行后由服务端回放原始请求 → 200', okCf.status === 200 && okCf.body.data.replay.status === 200,
    okCf.status);
  const cfBody = okCf.body.data.replay.body;
  chk('确认后 EXECUTED', cfBody.data.status === 'EXECUTED', cfBody.data.status);
  chk('确认后扣款并释放预留',
    Math.abs(cfBody.budget.used - (used0.used + 0.42)) < 1e-9 &&
    Math.abs(cfBody.budget.reserved - (used0.reserved - 0.42)) < 1e-9, JSON.stringify(cfBody.budget));

  const cf2 = await call('POST', `/v1/act/${assetId}/confirm`);
  chk('已执行的动作再申请确认仍被拦（网关不关心业务状态）', cf2.status === 403, cf2.status);
  const cf2d = await call('POST', `/v1/approvals/${cf2.body.error.approval_id}/decide`, { decision: 'approve' });
  chk('放行后状态机拒绝（外层 200 / 内层 409 INVALID_STATE）',
    cf2d.status === 200 && cf2d.body.data.replay.status === 409 &&
    cf2d.body.data.replay.body.error.code === 'INVALID_STATE',
    JSON.stringify([cf2d.body.data.replay.status, cf2d.body.data.replay.body.error.code]));
  const cf3 = await call('POST', '/v1/act/confirm', { action_id: assetId });
  chk('v2 兼容路径 /v1/act/confirm + body.action_id 同样在门控内', cf3.status === 403, cf3.status);

  const rb = await call('POST', `/v1/act/${assetId}/rollback`);
  chk('回滚未被门控（纠错通道不上锁）',
    rb.status === 200 && rb.body.data.status === 'ROLLED_BACK' && rb.body.compensation.refunded_cny === 0.42,
    rb.status);
  chk('退款后 used 回到 ' + used0.used, Math.abs(rb.body.budget.used - used0.used) < 1e-9, rb.body.budget.used);
  const rb2 = await call('POST', `/v1/act/${assetId}/rollback`);
  chk('重复回滚 409', rb2.status === 409);

  const cf4 = await call('POST', '/v1/act/act_zzzzzz/confirm');
  chk('网关先于业务校验：不存在的动作也会被挂起（回放时才知道是 404）', cf4.status === 403, cf4.status);
  const cf4d = await call('POST', `/v1/approvals/${cf4.body.error.approval_id}/decide`, { decision: 'approve' });
  chk('放行后回放得到 404，外层单据标 FAILED',
    cf4d.body.data.replay.status === 404 && cf4d.body.data.status === 'FAILED',
    JSON.stringify([cf4d.body.data.status, cf4d.body.data.replay.status]));

  sec('9. 分片租约 · 服务端仲裁 + TTL 自动释放');
  const l1 = await call('POST', '/v1/act/lease', { shard: 'CH03_S04', holder: 'agent-A', ttl_s: 300 });
  chk('A 拿到 S04', l1.status === 200 && l1.body.renewed === false);
  chk('租约返回服务端计算的剩余 TTL', l1.body.data.ttl_s > 290 && l1.body.data.granted_ttl_s === 300,
    l1.body.data.ttl_s);
  const l2 = await call('POST', '/v1/act/lease', { shard: 'CH03_S04', holder: 'agent-B', ttl_s: 300 });
  chk('B 抢同片 409 SHARD_LOCKED', l2.status === 409 && l2.body.error.code === 'SHARD_LOCKED', l2.status);
  chk('409 指出是谁持有（holder_at_fault）', l2.body.error.holder_at_fault === 'agent-A');
  chk('409 说明仲裁方是服务进程', l2.body.arbitration && l2.body.arbitration.by === 'server');
  const l3 = await call('POST', '/v1/act/lease', { shard: 'CH03_S05', holder: 'agent-B', ttl_s: 300 });
  chk('B 换片立刻拿到 → 真并行', l3.status === 200 && l3.body.concurrency.active_leases === 2);
  const l4 = await call('POST', '/v1/act/lease', { shard: 'CH03_S04', holder: 'agent-A', ttl_s: 300 });
  chk('同持有者重复申请 = 续约', l4.status === 200 && l4.body.renewed === true);
  const lShort = await call('POST', '/v1/act/lease', { shard: 'CH03_S09', holder: 'agent-C', ttl_s: 1 });
  chk('短租约已授予', lShort.status === 200 && lShort.body.data.ttl_s <= 1);
  const leasesNow = await call('GET', '/v1/act/leases');
  chk('活跃租约 3 条', leasesNow.body.data.count === 3, leasesNow.body.data.count);
  await new Promise(s => setTimeout(s, 1600));
  const leasesAfter = await call('GET', '/v1/act/leases');
  chk('TTL 到期由服务端自动释放（崩溃的 agent 不会永久占锁）',
    leasesAfter.body.data.count === 2 && leasesAfter.body.data.expired_released_now === 1,
    'count=' + leasesAfter.body.data.count + ' released=' + leasesAfter.body.data.expired_released_now);

  sec('10. 审计');
  const au = await call('GET', '/v1/audit?limit=200');
  chk('审计有记录且带 request_id', au.body.data.count > 0 && !!au.body.data.entries[0].rid);
  chk('审计含完整时间戳与阶段时间', !!au.body.data.entries[0].at && !!au.body.data.entries[0].ts);
  const verbs = new Set(au.body.data.entries.map(e => e.verb));
  chk('审计覆盖多类动作', verbs.has('POST') && verbs.has('PUT') && verbs.has('DEMO'),
    [...verbs].join(','));

  sec('11. 内容协商 · 索引不得谎报请求头');
  /* 这一组是「文案是否属实」的断言，不是「行为是否正确」的断言 —— 两者要分开测。
   * 曾经漏测：行为对了（协商生效），但索引里写死了「你是带 Accept: application/json 来的」，
   * 而 * / * 与空头都落进同一分支 → 对大多数 agent 客户端的默认请求**谎报由来**。
   * 注意 fetch 会默认补 Accept: * / *，所以必须用 node:http 才能造出「真的不带 Accept 头」。 */
  const http = await import('node:http');
  const u = new URL(BASE);
  const rawGet = (headers) => new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: '/', method: 'GET', headers },
      (res) => {
        let b = ''; res.on('data', d => (b += d));
        res.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch { j = null; }
          resolve({ ct: res.headers['content-type'] || '', j, note: j && j.data ? j.data.note : '' });
        });
      });
    r.on('error', reject); r.end();
  });

  const noHead = await rawGet({});
  chk('不带 Accept 头 → 给机器可读索引（不是大体积 HTML）',
    noHead.ct.indexOf('application/json') >= 0 && !!noHead.j && noHead.j.data.kind === 'agent-index', noHead.ct);
  chk('不带 Accept 头 → note 如实说「没带」，不得声称要了 JSON',
    noHead.note.indexOf('没带 Accept') >= 0 && noHead.note.indexOf('application/json') < 0, noHead.note);

  const star = await rawGet({ accept: '*/*' });
  chk('Accept: */* → 给索引（这是 fetch/curl 的默认值，也是最常见的 agent 请求）',
    !!star.j && star.j.data.kind === 'agent-index', star.ct);
  chk('Accept: */* → note 不得谎称「你明确要 application/json」',
    star.note.indexOf('application/json') < 0, star.note);

  const asJson = await rawGet({ accept: 'application/json' });
  chk('Accept: application/json → 给索引', !!asJson.j && asJson.j.data.kind === 'agent-index');
  chk('Accept: application/json → note 允许如实点名', asJson.note.indexOf('application/json') >= 0, asJson.note);

  const asHtml = await rawGet({ accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' });
  chk('浏览器式 Accept → 给 HTML 页面（不是索引）',
    asHtml.ct.indexOf('text/html') >= 0 && asHtml.j === null, asHtml.ct);

  chk('三种索引分支的 note 互不相同 → 说明是按真实请求派生，不是写死的',
    new Set([noHead.note, star.note, asJson.note]).size === 3,
    [noHead.note, star.note, asJson.note].join('  |  '));

  console.log(`\n  ---- ${pass} passed / ${fail} failed ----`);
  return fail;
};

run().then(f => process.exit(f ? 1 : 0))
  .catch(e => { console.error('\n  冒烟脚本自身异常:', e.message); process.exit(2); });
