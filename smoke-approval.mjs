/* 门控（gate）与审批（approval）冒烟
 *
 * 这一套要证的不是「能挂起」，而是一句更强的话：
 *   门控端点在 HTTP 上根本没有可执行的路径。
 * 所以断言集中在「拦下了吗 / 拦了几次 / 谁放的 / 放行后跑的到底是不是原来那条请求」。
 *
 * 用法： node smoke-approval.mjs                       （8787 单实例）
 *        node smoke-approval.mjs --xproc               （8787 + 8788 跨进程）
 *        node smoke-approval.mjs --secret              （8789 带 APPROVAL_SECRET）
 */
const A = process.env.BASE || 'http://127.0.0.1:8787';
const B = 'http://127.0.0.1:8788';
const S9 = 'http://127.0.0.1:8789';
const MODE = process.argv.includes('--xproc') ? 'xproc'
  : process.argv.includes('--secret') ? 'secret' : 'single';

let pass = 0, fail = 0, skip = 0;
const chk = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); }
};
const sek = n => { skip++; console.log('  SKIP  ' + n); };
const sec = s => console.log('\n--- ' + s + ' ---');

async function call(base, method, path, body, idemKey, extraHeaders) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      idemKey ? { 'Idempotency-Key': idemKey } : {}, extraHeaders || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = { parse_error: e.message }; }
  return { status: r.status, body: j, rid: r.headers.get('x-request-id') };
}
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const key = () => 'idem_gate_' + hex(12);
const bundle = async (base = A) => (await call(base, 'GET', '/v1/state/bundle')).body.data;
const pending = async (base = A) => (await call(base, 'GET', '/v1/approvals?status=PENDING')).body.data.approvals;

// ─────────────────────────────────────────────────────────────
const SINGLE = async () => {
  sec('0. 契约：门控是声明出来的，不是靠猜');
  const h = await call(A, 'GET', '/v1/health');
  chk('health 暴露 gate 策略表', Array.isArray(h.body.data.gate.policy) &&
    h.body.data.gate.policy.length >= 3, JSON.stringify(h.body.data.gate.policy || []).slice(0, 80));
  const routes = h.body.data.gate.policy.map(p => p.route);
  chk('confirm 被声明为门控端点', routes.includes('POST /v1/act/:id/confirm'), routes.join(' | '));
  chk('change_requests approve 被声明为门控端点',
    routes.includes('POST /v1/state/change_requests/:id/approve'));
  chk('每条策略都带 level 与 why', h.body.data.gate.policy.every(p => p.level === 'approval' && !!p.why));
  chk('声明门控只做授权判定（不是把 judge 也锁上）',
    !routes.some(r => r.includes('/senses/')), routes.join(' | '));
  chk('health 声明裁决端点', h.body.data.gate.human_surface.includes('POST /v1/approvals/:id/decide'));

  await call(A, 'POST', '/v1/demo/reset');
  let b = await bundle();
  chk('重置后无待审批', b.approvals_pending === 0, b.approvals_pending);

  sec('1. 门控拦截：请求进不去 handler');
  const q = await call(A, 'POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH03_S04', cost_cny: 0.42, route: 'approve' }, key());
  chk('付费动作已入队且挂起等确认', q.status === 201 && q.body.data.status === 'PENDING_CONFIRMATION');
  const id = q.body.data.id;
  chk('入队回执就说明了下一步本身也被门控',
    q.body.gate.next_is_gated === true && q.body.gate.next_requires === 'approval');

  const before = await bundle();
  const c1 = await call(A, 'POST', '/v1/act/' + id + '/confirm', { action_id: id });
  chk('agent 直接 confirm 被截停 → 403', c1.status === 403, c1.status);
  chk('错误码 REQUIRE_APPROVAL', c1.body.error.code === 'REQUIRE_APPROVAL');
  chk('回执带审批单号与指纹', /^apr_[0-9a-f]{6}$/.test(c1.body.error.approval_id || '') &&
    /^[0-9a-f]{32}$/.test(c1.body.error.fingerprint || ''), c1.body.error.approval_id);
  chk('回执声明无绕过路径', c1.body.gate.bypass.indexOf('只从审批回放') >= 0, c1.body.gate.bypass);
  chk('回执分别给了 agent 和人不同的下一步',
    c1.body.hints.some(x => x.for === 'agent') && c1.body.hints.some(x => x.for === 'user'));

  /* ── hints 的机器语义 ──
   * 第一用户是 agent：它需要能 if 的枚举，不是一段要 LLM 解读的中文。
   * 这一组把「跨语区可用」钉死 —— 将来谁加了新 hint 忘了 action，这里立刻红。 */
  const spec1 = (await call(A, 'GET', '/v1/openapi.json')).body;
  const envP = spec1.components.schemas.Envelope.properties;
  const hintEnum = envP.hints.items.properties.action.enum;
  const noAction = (c1.body.hints || []).filter(h => !h.action);
  chk('403 的每条 hint 都带机器可读 action（不是只有中文）',
    noAction.length === 0,
    noAction.length ? noAction.map(h => h.for).join(',') + ' 缺 action' : c1.body.hints.length + ' 条全带');
  const offEnum = (c1.body.hints || []).filter(h => h.action && hintEnum.indexOf(h.action) < 0);
  chk('hint.action 全部落在契约声明的 enum 内',
    offEnum.length === 0,
    offEnum.length ? offEnum.map(h => h.action).join(',') : '全部在 ' + hintEnum.length + ' 个允许值内');
  chk('最省上下文的那条信号是 stop_retry（agent 据此停止重试）',
    (c1.body.hints || []).some(h => h.action === 'stop_retry'));
  chk('契约声明了 error 的机器字段（approval_id/fingerprint/hits 不必靠猜）',
    ['code', 'message', 'approval_id', 'fingerprint', 'hits'].every(k => k in envP.error.properties),
    Object.keys(envP.error.properties).join(','));
  chk('error.code 可枚举（agent 能穷举分支，不是解析散文）',
    Array.isArray(envP.error.properties.code.enum) && envP.error.properties.code.enum.length >= 20,
    envP.error.properties.code.enum && envP.error.properties.code.enum.length);
  const after = await bundle();
  chk('动作没有被执行（仍是 PENDING_CONFIRMATION）',
    after.actions.find(a => a.id === id).status === 'PENDING_CONFIRMATION');
  chk('预算没有被扣（账目一字未动）',
    Math.abs(after.budget.used - before.budget.used) < 1e-9 && Math.abs(after.budget.reserved - 0.42) < 1e-9,
    'used ' + after.budget.used + ' reserved ' + after.budget.reserved);
  chk('审批单已落盘', after.approvals_pending === 1, after.approvals_pending);

  sec('1b. 单查：agent 手握 approval_id 时的 O(1) 路径');
  const g1 = await call(A, 'GET', '/v1/approvals/' + c1.body.error.approval_id);
  chk('可按 id 单查（不必拉全表再自己过滤）', g1.status === 200, g1.status);
  chk('单查 requires=human —— 谁说了算在人，不在 agent',
    g1.body.requires === 'human', g1.body.requires);
  chk('单查给出结构化的 next_step（agent 不用从散文里推「该谁动」）',
    !!(g1.body.data.next_step && g1.body.data.next_step.human && g1.body.data.next_step.agent),
    JSON.stringify(g1.body.data.next_step));
  chk('单查的 hints 同样全带 action',
    (g1.body.hints || []).length > 0 && (g1.body.hints || []).every(h => !!h.action));
  const g404 = await call(A, 'GET', '/v1/approvals/apr_000000');
  chk('不存在的单号 → 404 APPROVAL_NOT_FOUND（错误路径也给 action）',
    g404.status === 404 && g404.body.error.code === 'APPROVAL_NOT_FOUND' &&
    (g404.body.hints || []).every(h => !!h.action), g404.status);

  sec('2. 挂起是幂等的：按操作内容算，不按调用者的键算');
  const c2 = await call(A, 'POST', '/v1/act/' + id + '/confirm', { action_id: id }, key());
  chk('换一个幂等键、同样的操作 → 还是同一张单子',
    c2.status === 403 && c2.body.error.approval_id === c1.body.error.approval_id,
    c2.body.error.approval_id + ' vs ' + c1.body.error.approval_id);
  chk('重复命中被记进 hits 计数', c2.body.error.hits === 1, c2.body.error.hits);
  const burst = await Promise.all(Array.from({ length: 8 }, () =>
    call(A, 'POST', '/v1/act/' + id + '/confirm', { action_id: id }, key())));
  chk('8 次并发重发全部 403', burst.every(r => r.status === 403));
  chk('没有堆出第二张单子', (await bundle()).approvals_pending === 1,
    (await bundle()).approvals_pending);
  chk('并发下动作依旧没被执行',
    (await bundle()).actions.find(a => a.id === id).status === 'PENDING_CONFIRMATION');

  sec('3. 驳回：零副作用');
  const ap1 = c1.body.error.approval_id;
  const rj = await call(A, 'POST', '/v1/approvals/' + ap1 + '/decide',
    { decision: 'reject', by: 'user', reason: '夜里先别花钱' });
  chk('驳回 200', rj.status === 200, rj.status);
  chk('单子状态 REJECTED', rj.body.data.status === 'REJECTED');
  chk('响应明说零副作用', /无 ——/.test(rj.body.data.side_effects || ''), rj.body.data.side_effects);
  const b3 = await bundle();
  chk('驳回后动作仍未执行',
    b3.actions.find(a => a.id === id).status === 'PENDING_CONFIRMATION');
  chk('驳回后预算仍未动', Math.abs(b3.budget.used - 12.4) < 1e-9, b3.budget.used);
  chk('驳回后待批清零', b3.approvals_pending === 0);

  const rj2 = await call(A, 'POST', '/v1/approvals/' + ap1 + '/decide', { decision: 'reject' });
  chk('重复裁决 → 409 ALREADY_DECIDED', rj2.status === 409 && rj2.body.error.code === 'ALREADY_DECIDED', rj2.status);

  const bad = await call(A, 'POST', '/v1/approvals/' + ap1 + '/decide', { decision: 'maybe' });
  chk('非法 decision → 400', bad.status === 400 && bad.body.error.code === 'INVALID_BODY', bad.status);
  const nf = await call(A, 'POST', '/v1/approvals/apr_zzzzzz/decide', { decision: 'approve' });
  chk('不存在的单子 → 404', nf.status === 404 && nf.body.error.code === 'APPROVAL_NOT_FOUND', nf.status);

  sec('4. 批准：服务端回放原始请求');
  const c3 = await call(A, 'POST', '/v1/act/' + id + '/confirm', { action_id: id });
  const ap2 = c3.body.error.approval_id;
  chk('驳回后再试会开新单（不复用已裁决的）', c3.status === 403 && ap2 !== ap1, ap2);
  const ok = await call(A, 'POST', '/v1/approvals/' + ap2 + '/decide', { decision: 'approve', by: 'user' });
  chk('批准 200', ok.status === 200, ok.status);
  chk('单子状态 EXECUTED', ok.body.data.status === 'EXECUTED', ok.body.data.status);
  chk('回放的路由就是被拦下的那条', ok.body.data.replay.route === '/v1/act/:id/confirm',
    ok.body.data.replay.route);
  chk('回放真的执行了（内层 200）', ok.body.data.replay.status === 200, ok.body.data.replay.status);
  chk('回放体里动作已是 EXECUTED',
    ok.body.data.replay.body.data.status === 'EXECUTED',
    JSON.stringify(ok.body.data.replay.body.data.status));
  chk('裁决回执带指纹（人批的就是它）', /^[0-9a-f]{32}$/.test(ok.body.data.fingerprint || ''));

  /* 给「同一个概念两个名字」这个坑上锁。
   * 裁决回执曾经叫 data.replayed，审批行叫 replay —— 同一个东西两个名字，
   * agent 得猜，改一处漏一处。现在两处同名同形，用断言钉住。 */
  const apList = await call(A, 'GET', '/v1/approvals');
  const rowReplay = apList.body.data.approvals.find(a => a.id === ap2).replay;
  const kDecide = Object.keys(ok.body.data.replay).sort();
  const kRow = Object.keys(rowReplay).sort();
  chk('裁决回执的 replay 与审批行的 replay 同名同形（一个概念只有一个名字）',
    JSON.stringify(kDecide) === JSON.stringify(kRow),
    'decide: ' + kDecide.join(',') + '  |  approvals: ' + kRow.join(','));
  chk('两处的 replay.status 一致（不是各存一份）',
    rowReplay.status === ok.body.data.replay.status,
    rowReplay.status + ' vs ' + ok.body.data.replay.status);

  const b4 = await bundle();
  chk('动作最终 EXECUTED', b4.actions.find(a => a.id === id).status === 'EXECUTED');
  chk('预算已扣 ¥0.42', Math.abs(b4.budget.used - 12.82) < 1e-9, b4.budget.used);
  chk('预留已释放', Math.abs(b4.budget.reserved) < 1e-9, b4.budget.reserved);
  chk('待批归零', b4.approvals_pending === 0);

  const again = await call(A, 'POST', '/v1/act/' + id + '/confirm', { action_id: id });
  chk('已执行的动作再申请确认：本次仍被门控拦下（拦的是「调用」，不是「状态」）',
    again.status === 403 && again.body.error.code === 'REQUIRE_APPROVAL', again.status);
  const ap3 = again.body.error.approval_id;
  const dupBy = await call(A, 'POST', '/v1/approvals/' + ap3 + '/decide', { decision: 'approve' });
  chk('批准它 → 回放时状态机拦住（内层 409）',
    dupBy.status === 200 && dupBy.body.data.replay.status === 409,
    JSON.stringify(dupBy.body.data && dupBy.body.data.replay && dupBy.body.data.replay.status));
  chk('外层单据标 FAILED（回放失败不等于审批失败）', dupBy.body.data.status === 'FAILED', dupBy.body.data.status);
  chk('预算没有被重复扣', Math.abs((await bundle()).budget.used - 12.82) < 1e-9,
    (await bundle()).budget.used);

  sec('5. 第二条门控路径：批准变更');
  const w = await call(A, 'PUT', '/v1/state/decisions', { key: 'voice.lead', value: 'agent 自己改的' });
  chk('改写锁定决策 → 409 DECISION_LOCKED', w.status === 409 && w.body.error.code === 'DECISION_LOCKED', w.status);
  chk('409 同时开了变更请求', w.body.change_request.open === true);
  const crId = w.body.change_request.id;
  const crApprovePath = '/v1/state/change_requests/' + crId + '/approve';
  const ca = await call(A, 'POST', crApprovePath, { id: crId, by: 'user' });
  chk('agent 直接批准变更 → 同样被截停 403',
    ca.status === 403 && ca.body.error.code === 'REQUIRE_APPROVAL', ca.status);
  const crApr = ca.body.error.approval_id;
  const crv = await call(A, 'GET', '/v1/state/decisions');
  chk('被拦后锁定项原封不动',
    crv.body.data.decisions.find(d => d.key === 'voice.lead').value.indexOf('slightly raspy') >= 0);
  const cok = await call(A, 'POST', '/v1/approvals/' + crApr + '/decide', { decision: 'approve', by: 'user' });
  chk('批准变更单 → 回放成功 200', cok.status === 200 && cok.body.data.replay.status === 200, cok.status);
  const crv2 = await call(A, 'GET', '/v1/state/decisions');
  const nv = crv2.body.data.decisions.find(d => d.key === 'voice.lead');
  chk('决策真的变了', nv.value === 'agent 自己改的', nv.value);
  chk('变更走的是 supersede 而非原地改写（带 previous_id 链）', !!nv.previous_id, nv.previous_id);
  chk('回放体也确认了 superseded', !!cok.body.data.replay.body.data.superseded);

  sec('6. 非门控端点不受影响');
  const r1 = await call(A, 'POST', '/v1/act/queue',
    { kind: 'snapshot.prune', cost_cny: 0, route: 'auto' }, key());
  chk('零成本 auto 动作直接执行，不经过审批', r1.status === 201 && r1.body.data.status === 'EXECUTED', r1.status);
  const j1 = await call(A, 'POST', '/v1/senses/judge',
    { subject: 'CH03_S04', question: '情绪连贯?', kind: 'semantic' });
  chk('judge 仍返回 200 并明说判不了（没被门控掉）',
    j1.status === 200 && j1.body.data.escalated === true && j1.body.requires === 'human_or_llm', j1.status);
  const rb = await call(A, 'POST', '/v1/act/' + id + '/rollback', { action_id: id });
  chk('回滚未被门控（纠错通道不能上锁）', rb.status === 200 && rb.body.data.status === 'ROLLED_BACK', rb.status);
  chk('回滚退款到账', Math.abs((await bundle()).budget.used - 12.4) < 1e-9, (await bundle()).budget.used);
};

// ─────────────────────────────────────────────────────────────
const XPROC = async () => {
  const ha = await call(A, 'GET', '/v1/health');
  const hb = await call(B, 'GET', '/v1/health');
  chk('两个进程在线且 pid 不同',
    ha.status === 200 && hb.status === 200 && ha.body.data.pid !== hb.body.data.pid,
    ha.body.data.pid + ' / ' + hb.body.data.pid);
  chk('共享同一个 sqlite 文件', ha.body.data.db_path === hb.body.data.db_path);

  await call(A, 'POST', '/v1/demo/reset');

  sec('7. 跨进程：一个进程挂起，另一个进程裁决');
  const q = await call(A, 'POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH09_S01', cost_cny: 0.42, route: 'approve' }, key());
  const id = q.body.data.id;
  const cA = await call(A, 'POST', '/v1/act/' + id + '/confirm', { action_id: id });
  chk('A 进程截停并挂起', cA.status === 403, cA.status);
  const apId = cA.body.error.approval_id;

  const seenB = await pending(B);
  chk('B 进程立刻看到 A 挂起的那张单子（待批不是进程内存）',
    seenB.some(x => x.id === apId), seenB.map(x => x.id).join(','));

  const cB = await call(B, 'POST', '/v1/act/' + id + '/confirm', { action_id: id });
  chk('B 进程调同一端点 → 命中同一张单子，不另开一张',
    cB.status === 403 && cB.body.error.approval_id === apId, cB.body.error.approval_id);
  chk('跨进程去重后待批仍是 1 张', (await pending(B)).length === 1, (await pending(B)).length);

  const decB = await call(B, 'POST', '/v1/approvals/' + apId + '/decide',
    { decision: 'approve', by: 'user' });
  chk('B 进程批准成功', decB.status === 200 && decB.body.data.status === 'EXECUTED', decB.status);
  const bA = await bundle(A);
  chk('A 进程立刻看到动作已执行（无缓存不一致）',
    bA.actions.find(a => a.id === id).status === 'EXECUTED');
  chk('预算在两个进程的口径一致',
    Math.abs(bA.budget.used - 12.82) < 1e-9 && Math.abs((await bundle(B)).budget.used - 12.82) < 1e-9,
    bA.budget.used);

  sec('8. 跨进程并发裁决同一条：只有一个能改状态');
  const q2 = await call(A, 'POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH09_S02', cost_cny: 0.11, route: 'approve' }, key());
  const id2 = q2.body.data.id;
  const c2 = await call(A, 'POST', '/v1/act/' + id2 + '/confirm', { action_id: id2 });
  const ap2 = c2.body.error.approval_id;
  const racers = await Promise.all([
    call(A, 'POST', '/v1/approvals/' + ap2 + '/decide', { decision: 'approve', by: 'user' }),
    call(B, 'POST', '/v1/approvals/' + ap2 + '/decide', { decision: 'approve', by: 'user' })
  ]);
  const codes = racers.map(r => r.status).sort();
  chk('两个进程同时裁决：恰好一个 200、一个 409',
    codes[0] === 200 && codes[1] === 409, codes.join(' / '));
  const loser = racers.find(r => r.status === 409) || { body: { error: {} } };
  chk('输的一方回执说明了仲裁方式（条件写，不是「谁快谁赢」）',
    /条件写/.test(loser.body.error.arbitration || ''), loser.body.error.arbitration);
  chk('输的一方也能看到是谁赢的', !!loser.body.error.winner, loser.body.error.winner);
  const b2 = await bundle(A);
  chk('动作只被执行一次', b2.actions.find(a => a.id === id2).status === 'EXECUTED');
  chk('钱只扣了一次（12.82 + 0.11）',
    Math.abs(b2.budget.used - 12.93) < 1e-9, b2.budget.used);

  sec('9. 跨进程并发改同一动作状态：也只能有一个赢');
  const rrc = await Promise.all([
    call(A, 'POST', '/v1/act/' + id2 + '/rollback', { action_id: id2 }),
    call(B, 'POST', '/v1/act/' + id2 + '/rollback', { action_id: id2 })
  ]);
  const rc = rrc.map(r => r.status).sort();
  chk('两个进程同时回滚：恰好一个 200、一个 409', rc[0] === 200 && rc[1] === 409, rc.join(' / '));
  chk('退款只发生一次（回到 12.82）',
    Math.abs((await bundle(A)).budget.used - 12.82) < 1e-9, (await bundle(A)).budget.used);
  chk('409 回执说明了仲裁方式（条件写，不是「谁快谁赢」）',
    /条件写/.test((rrc.find(r => r.status === 409) || {}).body.error.arbitration || ''),
    (rrc.find(r => r.status === 409) || {}).body.error.arbitration);
};

// ─────────────────────────────────────────────────────────────
const SECRET = async () => {
  const h = await call(S9, 'GET', '/v1/health');
  if (h.status !== 200) { sek('8789 实例未启动'); return; }
  sec('9. APPROVAL_SECRET：闸门脱离「本机即信任」');
  chk('health 声明已启用裁决密钥', h.body.data.gate.approval_secret_required === true);

  await call(S9, 'POST', '/v1/demo/reset');
  const q = await call(S9, 'POST', '/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH10_S01', cost_cny: 0.42, route: 'approve' }, key());
  const id = q.body.data.id;
  const c = await call(S9, 'POST', '/v1/act/' + id + '/confirm', { action_id: id });
  chk('门控拦截照常生效（密钥只管裁决，不管挂起）', c.status === 403, c.status);
  const apId = c.body.error.approval_id;

  const noKey = await call(S9, 'POST', '/v1/approvals/' + apId + '/decide', { decision: 'approve' });
  chk('无密钥裁决 → 401', noKey.status === 401, noKey.status);
  chk('错误码 APPROVAL_SECRET_REQUIRED', noKey.body.error.code === 'APPROVAL_SECRET_REQUIRED');
  chk('提示了该带哪个头', noKey.body.error.hint_header === 'X-Approval-Secret');

  const wrong = await call(S9, 'POST', '/v1/approvals/' + apId + '/decide',
    { decision: 'approve' }, null, { 'X-Approval-Secret': 'definitely-not-it' });
  chk('错密钥 → 401', wrong.status === 401, wrong.status);
  chk('被拒的裁决没有改动动作',
    (await bundle(S9)).actions.find(a => a.id === id).status === 'PENDING_CONFIRMATION');

  const good = await call(S9, 'POST', '/v1/approvals/' + apId + '/decide',
    { decision: 'approve', by: 'user' }, null, { 'X-Approval-Secret': process.env.APPROVAL_SECRET });
  chk('正确密钥 → 200 且回放执行', good.status === 200 && good.body.data.replay.status === 200, good.status);
  chk('动作已执行', (await bundle(S9)).actions.find(a => a.id === id).status === 'EXECUTED');

  const list = await call(S9, 'GET', '/v1/approvals');
  chk('挂起清单本身不需要密钥（agent 该看得见自己的请求）', list.status === 200, list.status);
};

// ─────────────────────────────────────────────────────────────
(async () => {
  try {
    if (MODE === 'secret') await SECRET();
    else if (MODE === 'xproc') await XPROC();
    else await SINGLE();
  } catch (e) {
    fail++; console.log('  FAIL  测试自身异常: ' + e.message + '\n' + (e.stack || ''));
  }
  console.log('\n  ---- ' + pass + ' passed / ' + fail + ' failed' + (skip ? ' / ' + skip + ' skipped' : '') + ' ----');
  process.exit(fail ? 1 : 0);
})();
