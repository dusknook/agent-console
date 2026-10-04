/* 离线 mock 模式下的闸门测试
 *
 * 为什么单独测：后端没开时页面会降级成浏览器内 mock。如果降级等于「闸门消失」，
 * 那这个工具的全部卖点在最常见的使用姿势（双击打开 HTML）下就是假的。
 * 这里故意把地址栏指到一个死端口，强制走 mock 分支，再跑一遍完整的
 * 挂起 → 裁决 → 回放。
 *
 * 不需要任何后端在跑。
 */
import { baseStub, runStubbed } from './stub-run.mjs';

// 死端口 + 非 file: 协议 → API 取相对路径 → 探测必然失败 → LIVE 保持 false → 走页面内 mock
const STUB = baseStub({ protocol: 'http:', port: '59999' });

const TESTS = `
let pass=0, fail=0;
const chk=(n,c,x)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(x!==undefined?'  -> '+x:''));} };
const wait = ms => new Promise(s=>setTimeout(s,ms));

(async () => {
  await wait(500);

  console.log('--- 1. 确实降级了（否则这一套等于没测） ---');
  chk('后端不可达 → LIVE=false', LIVE === false);
  chk('顶栏如实标注是兜底模式', __els.storepill.textContent.indexOf('兜底') >= 0 ||
    __els.storepill.textContent.indexOf('内存') >= 0, __els.storepill.textContent);
  chk('页脚如实写明闸门守的是本页内存',
    __els.srv.innerHTML.indexOf('本页内存') >= 0 && __els.srv.innerHTML.indexOf('换') >= 0);
  chk('页脚没有假装有后端', __els.srv.innerHTML.indexOf('后端在线') < 0);

  console.log('--- 2. mock 里的闸门：同样拦得住 ---');
  const qEp = EPS.find(e=>e.id==='act.queue');
  const q = handle(qEp, { kind:'tts.seed_audio', shard:'CH01_S01', cost_cny:0.42, route:'approve' }, { 'Idempotency-Key':'mk_1' });
  chk('mock 入队 201 且挂起等确认', q.status===201 && q.body.data.status==='PENDING_CONFIRMATION', q.status);
  const id = q.body.data.id;
  const used0 = S.budget.used;

  const cEp = EPS.find(e=>e.id==='act.confirm');
  const c1 = handle(cEp, { action_id:id }, { 'Idempotency-Key':'mk_2' });
  chk('mock 的 confirm 也被截停 → 403 REQUIRE_APPROVAL',
    c1.status===403 && c1.body.error.code==='REQUIRE_APPROVAL', c1.status);
  chk('回执带 mock 指纹（32 位十六进制）',
    /^[0-9a-f]{32}$/.test(c1.body.error.fingerprint||''), c1.body.error.fingerprint);
  chk('回执同样声明无绕过路径', c1.body.gate.bypass.indexOf('只从审批回放') >= 0);
  chk('动作没有被执行', S.actions.find(a=>a.id===id).status==='PENDING_CONFIRMATION');
  chk('账目一字未动（used 与 reserved 都保持）',
    Math.abs(S.budget.used-used0)<1e-9 && Math.abs(S.budget.reserved-0.42)<1e-9,
    'used='+S.budget.used+' reserved='+S.budget.reserved);
  chk('审批单落进 S.approvals', S.approvals.filter(a=>a.status==='PENDING').length===1, S.approvals.length);

  const c2 = handle(cEp, { action_id:id }, { 'Idempotency-Key':'mk_3' });
  chk('mock 挂起同样幂等：换 key 仍是同一张单',
    c2.body.error.approval_id===c1.body.error.approval_id, c2.body.error.approval_id);
  chk('命中计数递增', c2.body.error.hits===1, c2.body.error.hits);

  const dEp = EPS.find(e=>e.id==='approvals.decide');
  const apId = c1.body.error.approval_id;
  const list = handle(EPS.find(e=>e.id==='approvals.list'), null, {});
  chk('mock 的 GET /approvals 能列出这张单', list.status===200 && list.body.data.pending===1, list.body.data.pending);

  console.log('--- 3. mock 的驳回 / 批准 / 回放 ---');
  const rej = handle(dEp, { id:apId, decision:'reject', by:'user' }, {});
  chk('驳回 200 且零副作用', rej.status===200 && rej.body.data.status==='REJECTED' &&
    S.actions.find(a=>a.id===id).status==='PENDING_CONFIRMATION', rej.status);
  const rej2 = handle(dEp, { id:apId, decision:'reject' }, {});
  chk('mock 重复裁决 409 ALREADY_DECIDED',
    rej2.status===409 && rej2.body.error.code==='ALREADY_DECIDED', rej2.status);
  const badD = handle(dEp, { id:apId, decision:'maybe' }, {});
  chk('mock 非法 decision 400', badD.status===400, badD.status);

  const c3 = handle(cEp, { action_id:id }, { 'Idempotency-Key':'mk_4' });
  chk('驳回后再试开新单', c3.status===403 && c3.body.error.approval_id!==apId, c3.body.error.approval_id);
  const ap2 = c3.body.error.approval_id;
  const ok = handle(dEp, { id:ap2, decision:'approve', by:'user' }, {});
  chk('批准 200', ok.status===200, ok.status);
  chk('mock 回放走的是原路由', ok.body.data.replay.route==='/v1/act/{id}/confirm',
    ok.body.data.replay.route);
  chk('mock 回放真的执行了（内层 200）', ok.body.data.replay.status===200, ok.body.data.replay.status);
  chk('动作最终 EXECUTED', S.actions.find(a=>a.id===id).status==='EXECUTED');
  chk('扣款只发生一次', Math.abs(S.budget.used-(used0+0.42))<1e-9, S.budget.used);
  chk('预留已释放', Math.abs(S.budget.reserved)<1e-9, S.budget.reserved);
  const dup = handle(EPS.find(e=>e.id==='approvals.decide'), { id:ap2, decision:'approve' }, {});
  chk('mock 重复裁决已批准的单 → 409', dup.status===409, dup.status);

  console.log('--- 4. mock 的待批面板 ---');
  renderAll();
  chk('面板渲染出已放行的单据', __els.apr.innerHTML.indexOf('已放行') >= 0);
  chk('面板写明门控在服务端（而不是本页）', __els.apr.innerHTML.indexOf('门控在服务端') >= 0);
  chk('计数徽标归零（无待批）', String(__els.aprcnt.textContent)==='0', __els.aprcnt.textContent);

  const q2 = handle(qEp, { kind:'tts.seed_audio', shard:'CH01_S02', cost_cny:0.11, route:'approve' }, { 'Idempotency-Key':'mk_5' });
  handle(cEp, { action_id:q2.body.data.id }, { 'Idempotency-Key':'mk_6' });
  renderAll();
  chk('新挂起一张后计数徽标回到 1', String(__els.aprcnt.textContent)==='1', __els.aprcnt.textContent);
  chk('面板出现「批准执行」与「驳回」按钮',
    __els.apr.innerHTML.indexOf('批准执行') >= 0 && __els.apr.innerHTML.indexOf('驳回') >= 0);
  chk('队列区说明「申请确认」只会得到 403',
    __els.queue.innerHTML.indexOf('403') >= 0);

  console.log('--- 5. 离线时契约导出如实说「导不了」，不伪造 spec ---');
  const oa = handle(EPS.find(e=>e.id==='contract.openapi'), null, {});
  chk('离线导出 → 503，而不是编一份 spec 出来',
    oa.status===503 && oa.body.error.code==='CONTRACT_NEEDS_BACKEND', oa.status);
  chk('说清了为什么（spec 必须描述真在跑的那个进程）',
    oa.body.error.message.indexOf('现场派生') >= 0, oa.body.error.message);
  chk('提示 agent 别把这个 503 当契约缓存',
    oa.body.hints.some(h => h.for==='agent' && h.suggest.indexOf('不要') >= 0));
  chk('提示人真正的下一步是启动后端',
    oa.body.hints.some(h => h.for==='human' && h.suggest.indexOf('node server.js') >= 0));
  chk('页脚在离线时也点明契约导出需要后端',
    __els.srv.innerHTML.indexOf('契约导出') >= 0);
  chk('契约端点已进左侧目录（离线也能看见它存在）',
    __els.catalog.innerHTML.indexOf('/openapi.json') >= 0);
  chk('目录里 INFRA 分组只出现一次（新条目落进原组，没有在末尾另起一组）',
    (__els.catalog.innerHTML.match(/基础 INFRA/g)||[]).length === 1);
  chk('目录里的端点条目数与 EPS 一致（没有漏渲染）',
    (__els.catalog.innerHTML.match(/class="ep/g)||[]).length === EPS.length, EPS.length);

  console.log('');
  console.log('  ---- ' + pass + ' passed / ' + fail + ' failed ----');
  clearInterval(HEART);
  process.exit(fail ? 1 : 0);
})();
`;

runStubbed({ stub: STUB, tests: TESTS, tmpName: '.ui-mock.mjs' });
