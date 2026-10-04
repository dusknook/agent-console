/* 跨进程测试：两个后端进程共用同一个 SQLite 文件
 *
 * 意义：如果幂等是"应用层 if 判断"或"进程内存 map"，两个进程各自记一份，
 *       同一个幂等键会被两边都当成首次 → 产生两份副作用。
 *       只有把唯一约束放在存储里，才能跨进程成立。
 *
 * 同理验证租约仲裁：B 进程必须能看见 A 进程持有的锁。
 */
const A = 'http://127.0.0.1:8787';
const B = 'http://127.0.0.1:8788';

let pass = 0, fail = 0;
const chk = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + x : '')); }
};
const sec = s => console.log('\n--- ' + s + ' ---');

async function call(base, method, path, body, idemKey) {
  const r = await fetch(base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      idemKey ? { 'Idempotency-Key': idemKey } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const run = async () => {
  sec('0. 两个独立进程 · 同一个数据库文件');
  const ha = await call(A, 'GET', '/v1/health');
  const hb = await call(B, 'GET', '/v1/health');
  chk('进程 A 在线', ha.status === 200);
  chk('进程 B 在线', hb.status === 200);
  chk('确为两个不同 pid', ha.body.data.pid !== hb.body.data.pid,
    ha.body.data.pid + ' vs ' + hb.body.data.pid);
  chk('两个进程指向同一个 sqlite 文件', ha.body.data.db_path === hb.body.data.db_path,
    ha.body.data.db_path);
  chk('A 进程的端口是 8787、B 是 8788',
    ha.body.data.port === 8787 && hb.body.data.port === 8788);

  const base = await call(A, 'GET', '/v1/state/bundle');
  const n0 = base.body.data.actions.length;

  sec('1. 幂等跨进程：同一把钥匙，同时打两个进程');
  // 先确保 cache 里没有这个 key
  const K = 'idem_xproc_' + hex(12);
  const [ra, rb] = await Promise.all([
    call(A, 'POST', '/v1/act/queue', { kind: 'tts.seed_audio', shard: 'CH05_S01', cost_cny: 0.33, route: 'approve' }, K),
    call(B, 'POST', '/v1/act/queue', { kind: 'tts.seed_audio', shard: 'CH05_S01', cost_cny: 0.33, route: 'approve' }, K)
  ]);
  const codes = [ra.status, rb.status].sort();
  chk('两个进程的返回码是 201 + 200（不是 201 + 201）',
    codes[0] === 200 && codes[1] === 201, codes.join(' / '));
  const createdA = ra.status === 201 ? ra : rb;
  const replayedB = ra.status === 200 ? ra : rb;
  chk('只有一个进程真正创建了动作', createdA.body.data.status === 'PENDING_CONFIRMATION');
  chk('另一个返回 replayed=true', replayedB.body.replayed === true);
  chk('两边指向同一个 action_id', replayedB.body.data.action_id === createdA.body.data.action_id,
    replayedB.body.data.action_id + ' vs ' + createdA.body.data.action_id);

  const afterA = await call(A, 'GET', '/v1/state/bundle');
  const afterB = await call(B, 'GET', '/v1/state/bundle');
  chk('数据库里只多出 1 条动作', afterA.body.data.actions.length === n0 + 1,
    n0 + ' -> ' + afterA.body.data.actions.length);
  chk('两个进程看到的队列完全一致（同一份状态）',
    afterA.body.data.actions.length === afterB.body.data.actions.length &&
    afterA.body.data.actions[0].id === afterB.body.data.actions[0].id);

  sec('2. 幂等跨进程 · 高并发扫射两个端口');
  const K2 = 'idem_xproc_burst_' + hex(8);
  const shots = [];
  for (let i = 0; i < 10; i++) {
    const base2 = i % 2 ? A : B;
    shots.push(call(base2, 'POST', '/v1/act/queue',
      { kind: 'tts.seed_audio', shard: 'CH05_S02', cost_cny: 0.05, route: 'approve' }, K2));
  }
  const results = await Promise.all(shots);
  const n201 = results.filter(r => r.status === 201).length;
  const n200 = results.filter(r => r.status === 200 && r.body.replayed === true).length;
  chk('10 次并发跨双进程：恰好 1 次 201', n201 === 1, 'n201=' + n201);
  chk('10 次并发跨双进程：恰好 9 次重放', n200 === 9, 'n200=' + n200);
  const after2 = await call(A, 'GET', '/v1/state/bundle');
  chk('累计只多出 1 条动作', after2.body.data.actions.length === n0 + 2,
    after2.body.data.actions.length);

  sec('3. 租约跨进程仲裁');
  const holders = await call(A, 'GET', '/v1/act/leases');
  const occupied = holders.body.data.leases.map(l => l.shard);
  const free = ['CH06_S01', 'CH06_S02', 'CH06_S03'].find(s => !occupied.includes(s));

  const la = await call(A, 'POST', '/v1/act/lease', { shard: free, holder: 'agent-on-8787', ttl_s: 60 });
  chk('A 进程授予租约', la.status === 200 && la.body.renewed === false);
  const lb = await call(B, 'POST', '/v1/act/lease', { shard: free, holder: 'agent-on-8788', ttl_s: 60 });
  chk('B 进程立刻看见该锁 → 409 SHARD_LOCKED', lb.status === 409 && lb.body.error.code === 'SHARD_LOCKED',
    lb.status);
  chk('B 能指出持有者在哪个进程注册的身份', lb.body.error.holder_at_fault === 'agent-on-8787');
  const lv = await call(B, 'GET', '/v1/act/leases');
  chk('B 的租约列表里含 A 授予的锁（状态是共享的）',
    lv.body.data.leases.some(l => l.shard === free && l.holder === 'agent-on-8787'));

  sec('4. 跨进程 TTL 自动释放');
  const ls = await call(B, 'POST', '/v1/act/lease', { shard: 'CH06_S07', holder: 'agent-crash', ttl_s: 1 });
  chk('授予 1 秒租约', ls.status === 200);
  await new Promise(s => setTimeout(s, 1700));
  const lv2 = await call(A, 'GET', '/v1/act/leases');
  chk('A 进程能回收 B 进程留下的过期锁（simulate agent 崩溃）',
    lv2.body.data.expired_released_now >= 1 && !lv2.body.data.leases.some(l => l.shard === 'CH06_S07'),
    'released=' + lv2.body.data.expired_released_now);

  sec('5. 单条写入对另一进程立即可见（无缓存不一致）');
  const w = await call(B, 'PUT', '/v1/state/decisions', { key: 'xproc.probe', value: 'written-from-8788' });
  chk('B 写入新决策 201', w.status === 201);
  const seen = await call(A, 'GET', '/v1/state/decisions');
  chk('A 立即读到 B 写的内容', seen.body.data.decisions.some(d => d.key === 'xproc.probe'));

  console.log(`\n  ---- ${pass} passed / ${fail} failed ----`);
  return fail;
};

run().then(f => process.exit(f ? 1 : 0))
  .catch(e => { console.error('\n  跨进程测试自身异常:', e.message); process.exit(2); });
