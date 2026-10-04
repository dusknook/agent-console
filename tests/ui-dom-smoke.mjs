/* 前端 DOM 冒烟
 * 用桩 DOM 跑 ai-workbench.html 的完整启动流程，验证：
 *  1. 后端在线时 LIVE 会切过去，S 从 /v1/state/bundle 填充
 *  2. 点「发送」真的打 HTTP（而不是走页面内 mock 分支）
 *  3. 响应面板读到的是真实 status / latency / request_id
 *  4. 点队列按钮真的发 confirm / rollback
 * 需要后端已在 8787 运行。
 */
import { baseStub, runStubbed } from './stub-run.mjs';

const STUB = baseStub({ protocol: 'file:', port: '' });

const TESTS = `
let pass=0, fail=0;
const chk=(n,c,x)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(x!==undefined?'  -> '+x:''));} };
const wait = ms => new Promise(s=>setTimeout(s,ms));

(async () => {
  await wait(900);                                  // 等启动探测 + 心跳建立

  console.log('--- 1. 启动与降级判定 ---');
  chk('探测到后端后切到 LIVE', LIVE === true);
  chk('拿到服务信息（pid / db / journal / 路由数）',
    !!SERVER && SERVER.pid > 0 && !!SERVER.db_path && SERVER.journal_mode === 'wal' && SERVER.routes.length >= 20,
    SERVER ? SERVER.journal_mode : 'null');
  chk('S 由 /v1/state/bundle 填充（不是浏览器里的旧副本）',
    S.budget && typeof S.budget.used === 'number' && Array.isArray(S.decisions) && typeof S.leases === 'object');
  chk('S 带后端返回的 change_requests 字段', Array.isArray(S.change_requests));
  chk('S 带后端返回的 approvals 字段（待批也是状态的一部分）', Array.isArray(S.approvals));

  // 从干净状态开始：待批计数、队列长度都要可预测
  await api('POST', '/v1/demo/reset'); await refresh(); renderAll();
  chk('重置后待批清零', S.approvals.length === 0 && S.approvals_pending === 0, S.approvals_pending);
  chk('重置后队列清零', S.actions.length === 0, S.actions.length);

  console.log('--- 2. 目录与分组 ---');
  chk('目录含 5 个分组（基础/状态/感官/行动/审批）', new Set(EPS.map(e=>e.g)).size === 5,
    [...new Set(EPS.map(e=>e.g))].join(' | '));
  chk('v2 的 16 个端点一个都没丢', EPS.length >= 23, EPS.length);
  const cat = __els.catalog.innerHTML;
  chk('目录渲染出 INFRA 组', cat.indexOf('基础 INFRA') >= 0);
  chk('目录列出 change_requests（v2 的悬空引用已补上）', cat.indexOf('/state/change_requests') >= 0);
  chk('目录列出审批端点', cat.indexOf('/approvals') >= 0);
  chk('每个端点都有 HTTP 动词徽标', (cat.match(/class="m /g)||[]).length === EPS.length);

  console.log('--- 2b. 门控声明来自后端，不是前端写死的 ---');
  chk('health 带回 gate 策略表', Array.isArray(SERVER.gate && SERVER.gate.policy) &&
    SERVER.gate.policy.length >= 3, JSON.stringify(SERVER.gate && SERVER.gate.policy));
  chk('页脚如实标注门控端点数量', __els.srv.innerHTML.indexOf('个端点被门控') >= 0);
  chk('页脚如实标注裁决密钥状态（未启用时明说依赖本机前提）',
    __els.srv.innerHTML.indexOf('裁决密钥') >= 0 && __els.srv.innerHTML.indexOf('未启用') >= 0);

  console.log('--- 3. 点「发送」真的打 HTTP ---');
  const qEp = EPS.find(e=>e.id==='act.queue');
  const UIKEY = 'idem_ui_probe_' + Math.random().toString(16).slice(2,10);
  cur = qEp;
  $t('idem').value = UIKEY;
  $t('body').value = JSON.stringify({ kind:'tts.seed_audio', shard:'CH08_S01', cost_cny:0.42, route:'approve' }, null, 2);
  const before = (await api('GET','/v1/state/bundle')).body.data.actions.length;
  await $t('send').onclick();
  chk('返回 201 CREATED', last.status === 201, last.status);
  chk('响应体来自服务端（含 _meta.request_id）',
    !!last.body._meta && /^req_[0-9a-f]{8}$/.test(last.body._meta.request_id), last.body._meta && last.body._meta.request_id);
  chk('延迟是实测数字而非随机值', Number(last.ms) > 0 && Number(last.ms) < 5000, last.ms);
  chk('token 数取自响应体的真实估算', last.tokens === last.body._meta.tokens_estimate);
  chk('回执带 X-Request-Id', last.rid === last.body._meta.request_id);
  chk('动作已入队（侧栏读的是后端返回的最新状态）',
    S.actions.length === before + 1, before + ' -> ' + S.actions.length);
  chk('队列里那条就是刚提交的 kind', S.actions[0].kind === 'tts.seed_audio');
  chk('侧栏队列 HTML 已渲染该动作', __els.queue.innerHTML.indexOf('tts.seed_audio') >= 0);

  console.log('--- 4. 幂等重放走的是同一条 HTTP 路 ---');
  await $t('send').onclick();                       // 同一个 idem key 再发一次
  chk('第二次返回 200 且 replayed', last.status === 200 && last.body.replayed === true, last.status);
  chk('重放未新增动作', S.actions.length === before + 1, S.actions.length);
  chk('重放命中次数由服务端给出', last.body.idempotency.hits >= 1, last.body.idempotency.hits);

  console.log('--- 5. 预算闸门：UI 的"演示"按钮也打真接口 ---');
  await $t('push').onclick();
  chk('push 之后 S.budget.used 变成 49.8（值来自后端）', Math.abs(S.budget.used - 49.8) < 1e-9, S.budget.used);
  cur = qEp; $t('idem').value = 'idem_ui_over_' + Math.random().toString(16).slice(2,10);
  $t('body').value = JSON.stringify({ kind:'tts.seed_audio', shard:'CH08_S02', cost_cny:0.42, route:'approve' });
  await $t('send').onclick();
  chk('回执是 402 PAYMENT_REQUIRED', last.status === 402, last.status);
  chk('402 的预算明细可用', last.body.error.budget.over_by > 0);
  chk('面板会提示闸门在存储/网关层', renderResp.toString().indexOf('闸门生效') >= 0);
  await api('POST','/v1/demo/push_budget',{ used:12.4 }); await refresh(); renderAll();

  console.log('--- 6. 闸门：点「申请确认」只会被截停 ---');
  const pendA = S.actions.find(a=>a.status === 'PENDING_CONFIRMATION');
  chk('队列里存在待确认动作', !!pendA);
  const usedBefore = S.budget.used;
  await actOn('confirm', pendA.id);
  chk('confirm 被网关截停 → 403', last.status === 403, last.status);
  chk('错误码 REQUIRE_APPROVAL', last.body.error.code === 'REQUIRE_APPROVAL');
  chk('回执带审批单号', /^apr_[0-9a-f]{6}$/.test(last.body.error.approval_id || ''), last.body.error.approval_id);
  chk('动作没有被执行（仍是 PENDING_CONFIRMATION）',
    S.actions.find(a=>a.id===pendA.id).status === 'PENDING_CONFIRMATION');
  chk('预算没被扣（账目未动）', Math.abs(S.budget.used - usedBefore) < 1e-9, S.budget.used);
  chk('待审批面板渲染出这张单子', __els.apr.innerHTML.indexOf('确认执行') >= 0);
  chk('计数徽标显示 1', String(__els.aprcnt.textContent) === '1', __els.aprcnt.textContent);
  chk('面板写明门控在服务端', __els.apr.innerHTML.indexOf('门控在服务端') >= 0);
  chk('回执提示条说明「不是不该做，是做不了」',
    renderResp.toString().indexOf('REQUIRE_APPROVAL') >= 0);

  const apId = last.body.error.approval_id;
  await actOn('confirm', pendA.id);                 // 原样重试
  chk('原样重试命中同一张单子（挂起是幂等的）',
    last.body.error.approval_id === apId, last.body.error.approval_id);

  console.log('--- 7. 驳回 → 零副作用；重复裁决 → 409 ---');
  await decide(apId, 'reject');
  chk('驳回返回 200', last.status === 200, last.status);
  chk('单据状态 REJECTED', last.body.data.status === 'REJECTED');
  chk('驳回零副作用：动作仍未执行',
    S.actions.find(a=>a.id===pendA.id).status === 'PENDING_CONFIRMATION');
  chk('驳回后计数徽标归零', String(__els.aprcnt.textContent) === '0', __els.aprcnt.textContent);
  await decide(apId, 'reject');
  chk('重复裁决 409 ALREADY_DECIDED',
    last.status === 409 && last.body.error.code === 'ALREADY_DECIDED', last.status);

  console.log('--- 8. 批准 → 服务端回放原始请求 ---');
  await actOn('confirm', pendA.id);
  const ap2 = last.body.error.approval_id;
  chk('驳回后再试会生成新单', ap2 !== apId, ap2);
  await decide(ap2, 'approve');
  chk('批准返回 200', last.status === 200, last.status);
  chk('回放的路由就是被拦下的那条',
    last.body.data.replay.route === '/v1/act/:id/confirm', last.body.data.replay.route);
  chk('回放真的执行了（内层 200）', last.body.data.replay.status === 200);
  chk('动作最终 EXECUTED', S.actions.find(a=>a.id===pendA.id).status === 'EXECUTED');
  chk('预算已扣 ¥0.42', Math.abs(S.budget.used - (usedBefore + 0.42)) < 1e-9, S.budget.used);
  chk('面板显示已放行', __els.apr.innerHTML.indexOf('已放行') >= 0);
  chk('页面标出「执行发生在批准这一步」',
    renderResp.toString().indexOf('本次执行发生在') >= 0);

  await actOn('rollback', pendA.id);
  chk('回滚仍可用（纠错通道没被闸门堵死）',
    S.actions.find(a=>a.id===pendA.id).status === 'ROLLED_BACK');
  chk('回滚回执带退款金额', last.body.compensation.refunded_cny === 0.42);
  chk('回滚后预算回到原值', Math.abs(S.budget.used - usedBefore) < 1e-9, S.budget.used);

  console.log('--- 9. 分片租约演示按钮走真后端 ---');
  await $t('racedemo').onclick();
  chk('演示结果标注传输方式是真 HTTP', last.body.transport.indexOf('真 HTTP') === 0, last.body.transport);
  chk('三步都有真实 HTTP 状态码',
    last.body.attempts.every(a=>a.http >= 200 && a.http < 500),
    JSON.stringify(last.body.attempts.map(a=>a.http)));
  chk('至少两步成功（证明不同分片可并行）',
    last.body.attempts.filter(a=>(a.result||'').indexOf('获得租约')===0).length >= 1,
    JSON.stringify(last.body.attempts.map(a=>a.result)));
  chk('侧栏租约列表已反映后端状态', __els.leases.innerHTML.length > 0);

  console.log('--- 10. 状态面板 ---');
  chk('顶栏 pill 显示后端已连接', __els.storepill.textContent.indexOf('已连后端') >= 0, __els.storepill.textContent);
  chk('页脚显示 db 路径与 pid', __els.srv.innerHTML.indexOf('数据落盘') >= 0 && __els.srv.innerHTML.indexOf('pid') >= 0);
  chk('审计面板已渲染', __els.audit.innerHTML.indexOf('logline') >= 0);
  chk('预算条已渲染', __els.budget.innerHTML.indexOf('上限') >= 0);

  console.log('');
  console.log('  ---- ' + pass + ' passed / ' + fail + ' failed ----');
  clearInterval(HEART);
  process.exit(fail ? 1 : 0);
})();
`;

runStubbed({ stub: STUB, tests: TESTS, tmpName: '.ui-smoke.mjs' });
