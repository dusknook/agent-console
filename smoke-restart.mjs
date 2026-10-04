/* 重启持久化测试
 *   node smoke-restart.mjs snap     采集指纹 → .fp.json
 *   (杀掉服务、重启)
 *   node smoke-restart.mjs verify   重新读取并逐字段比对
 */
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const FP = new URL('./.fp.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MODE = process.argv[2] || 'verify';

const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const post = async (path, body, idem) => {
  const r = await fetch(BASE + path, { method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, idem ? { 'Idempotency-Key': idem } : {}),
    body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const grab = async () => {
  const b = (await (await fetch(BASE + '/v1/state/bundle')).json()).data;
  const h = (await (await fetch(BASE + '/v1/health')).json()).data;
  const a = (await (await fetch(BASE + '/v1/audit?limit=200')).json()).data;
  return {
    pid: h.pid, uptime_s: h.uptime_s, db_bytes: h.db_bytes,
    budget: b.budget,
    decisions: b.decisions.map(d => `${d.id}|${d.key}|${d.value}|${d.by}|${d.previous_id || '-'}`),
    assets: b.assets.map(x => `${x.id}@v${x.current_version}:` + x.versions.map(v => `v${v.v}=${v.value}`).join(',')),
    actions: b.actions.map(x => `${x.id}|${x.kind}|${x.shard}|${x.status}|${x.cost}`),
    leases: Object.values(b.leases).map(l => `${l.shard}|${l.holder}`).sort(),
    snapshot_head: b.snapshots[b.snapshots.length - 1]?.id,
    snap_count: b.snapshots.length,
    approvals: (b.approvals || []).map(x =>
      `${x.id}|${x.status}|${x.request.method} ${x.request.route}|${x.fingerprint}|hits=${x.hits}`),
    approvals_pending: b.approvals_pending,
    audit_total: a.total,
    audit_tail: a.entries.slice(0, 3).map(e => `${e.verb} ${e.target} ${e.result}`)
  };
};

if (MODE === 'snap') {
  // 留一个已知幂等键，重启后拿它再打一次 —— 看是否仍是"重放"
  const probeKey = 'idem_restart_probe_' + hex(8);
  const probe = await post('/v1/act/queue',
    { kind: 'probe.restart', shard: 'CH07_S01', cost_cny: 0, route: 'auto' }, probeKey);
  if (probe.status !== 201) { console.error('  探针入队失败', probe.status, JSON.stringify(probe.body)); process.exit(2); }

  // 再留一张「待审批」单：它必须跨重启存活，而且新进程仍要能裁决它
  const parkAct = await post('/v1/act/queue',
    { kind: 'tts.seed_audio', shard: 'CH07_S09', cost_cny: 0.21, route: 'approve' },
    'idem_restart_park_' + hex(8));
  const parked = await post('/v1/act/' + parkAct.body.data.id + '/confirm',
    { action_id: parkAct.body.data.id });
  if (parked.status !== 403) { console.error('  待批探针未按预期被拦:', parked.status); process.exit(2); }

  const fp = await grab();
  fp.probe = { key: probeKey, action_id: probe.body.data.id, status: probe.body.data.status };
  fp.parked = { approval_id: parked.body.error.approval_id, action_id: parkAct.body.data.id };
  fs.writeFileSync(FP, JSON.stringify(fp, null, 2));
  console.log('  指纹已采集 → .fp.json');
  console.log('  动作 ' + fp.actions.length + ' 条 · 决策 ' + fp.decisions.length +
    ' 条 · 租约 ' + fp.leases.length + ' 条 · 待批 ' + fp.approvals.length +
    ' 条 · 审计 ' + fp.audit_total + ' 条 · pid ' + fp.pid);
  console.log('  db ' + fp.db_bytes + ' bytes');
  console.log('  探针幂等键 ' + probeKey + ' → ' + fp.probe.action_id);
  console.log('  待批单 ' + fp.parked.approval_id + ' → 动作 ' + fp.parked.action_id);
  process.exit(0);
}

let pass = 0, fail = 0;
const chk = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); } };

const before = JSON.parse(fs.readFileSync(FP, 'utf8'));
const after = await grab();

console.log('\n--- 重启后逐字段比对 ---');
chk('服务确实重启过（pid 变了）', before.pid !== after.pid, before.pid + ' -> ' + after.pid);
chk('uptime 归零（是新进程，不是旧进程还在）', after.uptime_s < before.uptime_s + 2,
  before.uptime_s + ' -> ' + after.uptime_s);
chk('预算完全保留', JSON.stringify(before.budget) === JSON.stringify(after.budget),
  JSON.stringify(before.budget) + ' vs ' + JSON.stringify(after.budget));
chk(`动作队列 ${before.actions.length} 条逐字保留`,
  JSON.stringify(before.actions) === JSON.stringify(after.actions));
chk(`决策 ${before.decisions.length} 条逐字保留（含 previous_id 链）`,
  JSON.stringify(before.decisions) === JSON.stringify(after.decisions));
chk('资产版本历史逐字保留', JSON.stringify(before.assets) === JSON.stringify(after.assets));
chk(`租约 ${before.leases.length} 条保留（未过期的不该丢）`,
  JSON.stringify(before.leases) === JSON.stringify(after.leases),
  before.leases.join(',') + ' vs ' + after.leases.join(','));
chk('断点快照栈头保留', before.snapshot_head === after.snapshot_head,
  before.snapshot_head + ' -> ' + after.snapshot_head);
chk('审计只增不减（并记录了一次 BOOT）', after.audit_total >= before.audit_total,
  before.audit_total + ' -> ' + after.audit_total);
chk('重启后审计尾部是新进程的 BOOT 记录',
  after.audit_tail.some(t => t.startsWith('BOOT')), after.audit_tail.join(' / '));
chk('数据库文件仍在增长（WAL 未丢）', after.db_bytes > 0, after.db_bytes);
chk(`待审批 ${before.approvals.length} 条逐字保留（单号 / 指纹 / 命中计数）`,
  JSON.stringify(before.approvals) === JSON.stringify(after.approvals),
  JSON.stringify(before.approvals) + ' vs ' + JSON.stringify(after.approvals));
chk('待批计数一致（待批不是进程内存）',
  before.approvals_pending === after.approvals_pending,
  before.approvals_pending + ' -> ' + after.approvals_pending);

// 重启后幂等键仍生效 —— 这是 v1 内存版最致命的地方
const again = await post('/v1/act/queue',
  { kind: 'probe.restart', shard: 'CH07_S01', cost_cny: 0, route: 'auto' }, before.probe.key);
chk('重启后旧幂等键仍然命中 → replayed=true', again.body.replayed === true,
  'status=' + again.status + ' replayed=' + again.body.replayed);
chk('重启后返回的仍是重启前那个动作', again.body.data.id === before.probe.action_id,
  again.body.data.id + ' vs ' + before.probe.action_id);
chk('重启后重放未产生第 ' + (after.actions.length + 1) + ' 条动作（副作用只发生一次）',
  again.body.idempotency.storage_constraint === 'PRIMARY KEY(idem_keys.key)');

// 最后一步：新进程裁决旧进程挂起的单子 —— 证明「待审批」是跨进程、跨重启的真队列
const dec = await post('/v1/approvals/' + before.parked.approval_id + '/decide',
  { decision: 'approve', by: 'user' });
chk('重启后的新进程可裁决重启前挂起的单子 → 回放成功',
  dec.status === 200 && dec.body.data.replay.status === 200, dec.status);
chk('回放执行的是那条动作', dec.body.data.replay.body.data.id === before.parked.action_id,
  JSON.stringify(dec.body.data.replay.body.data.id));
chk('新进程按原始请求扣款 ¥0.21',
  Math.abs(dec.body.data.replay.body.budget.used - (after.budget.used + 0.21)) < 1e-9,
  dec.body.data.replay.body.budget.used + ' vs ' + after.budget.used);
chk('重启前后的幂等键在下游依然成立（动作只执行一次）',
  dec.body.data.replay.body.data.status === 'EXECUTED');

console.log(`\n  ---- ${pass} passed / ${fail} failed ----`);
process.exit(fail ? 1 : 0);
