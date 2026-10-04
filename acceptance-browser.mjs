#!/usr/bin/env node
/**
 * acceptance-browser.mjs —— 验收 D 的真人版：两个真浏览器标签页
 *
 * 上一版跨窗口验证是在协议层做的（两个独立 HTTP 会话看到同一份 bundle）。
 * 那能证明「状态在服务端」，但证明不了「打开页面的两个窗口会自己同步」——
 * 因为前者没有前端，没有心跳，没有渲染。
 *
 * 这里补上：CDP 开两个真标签页加载真页面，然后
 *   ① 在窗口 A 里发起一个被门控的请求（页面内 fetch）
 *   ② 窗口 B 不做任何操作，等它自己把待批计数从 0 变成 1（心跳 10s）
 *   ③ 在窗口 B 里点「真按钮」批准
 *   ④ 窗口 A 不做任何操作，等它自己同步到已执行
 * 全程没有人碰过窗口 A 的键盘鼠标 —— 「跨窗口同步」就是这个意思。
 *
 * 前置：
 *   1) 后端在跑          node server.js
 *   2) headless Chrome 开着调试端口：
 *      chrome.exe --headless=new --remote-debugging-port=9222 \
 *        --user-data-dir=.chrome-prof --no-first-run about:blank
 * 用法：
 *   node acceptance-browser.mjs            # CDP 默认 9222
 *   CDP_PORT=9333 node acceptance-browser.mjs
 */

import { CDP, sleep } from './tools/cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const COST = 0.42;

let PASS = 0, FAIL = 0, N = 0;
const ROWS = [];
const t0 = Date.now();

const line = s => process.stdout.write((s === undefined ? '' : s) + '\n');
const sec = t => { line(''); line('='.repeat(80)); line('  ' + t); line('='.repeat(80)); };
const sub = t => { line(''); line('  ── ' + t); };
const kv = (k, v) => line('       ' + String(k).padEnd(24) + ' ' + v);

function ck(name, ok, evidence) {
  N++; if (ok) PASS++; else FAIL++;
  ROWS.push({ n: N, name, ok, ev: evidence || '' });
  line('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name);
  if (evidence) String(evidence).split('\n').forEach(l => line('         | ' + l));
  return ok;
}

(async function main() {
  line('');
  line('Agent Console v5 · 验收 D（真浏览器双窗口）');
  line('后端     ' + BASE);
  line('CDP      http://127.0.0.1:' + CDP_PORT);

  // 归零，保证可复跑
  try { await fetch(BASE + '/v1/demo/reset', { method: 'POST' }); }
  catch (e) { line('\n  后端不可达：' + e.message); process.exit(2); }

  let cdp;
  try { cdp = await CDP.connect(CDP_PORT); }
  catch (e) {
    line('');
    line('  连不上 Chrome：' + e.message);
    line('  先起来： chrome.exe --headless=new --remote-debugging-port=' + CDP_PORT +
      ' --user-data-dir=.chrome-prof --no-first-run about:blank');
    process.exit(2);
  }
  kv('浏览器', cdp.browserVersion);

  const A = await cdp.openPage(BASE + '/');
  const B = await cdp.openPage(BASE + '/');
  kv('已开两个标签页', '窗口A & 窗口B');

  const ready = 'document.readyState === "complete" && (typeof LIVE !== "undefined" ? LIVE : false)';
  const ra = await cdp.waitFor(A.sessionId, ready, 25000);
  const rb = await cdp.waitFor(B.sessionId, ready, 25000);
  kv('两个窗口都连上后端', 'A ' + ra.waitedMs + 'ms · B ' + rb.waitedMs + 'ms   LIVE=true');

  sec('验收 D · 两个真标签页，一个后端');

  const pidA = await cdp.evaluate(A.sessionId, 'SERVER.pid');
  const pidB = await cdp.evaluate(B.sessionId, 'SERVER.pid');
  const verA = await cdp.evaluate(A.sessionId, 'SERVER.version');
  const titleA = await cdp.evaluate(A.sessionId, 'document.title');
  kv('窗口A 认识的后端', 'pid=' + pidA + ' · ' + verA);
  kv('窗口B 认识的后端', 'pid=' + pidB + ' · ' + verA);
  kv('页面标题', titleA);
  ck('两个窗口连的是同一个后端进程（同一份状态的唯一来源）',
    pidA === pidB && !!pidA, 'A.pid=' + pidA + '  B.pid=' + pidB);
  ck('两个窗口都是「在线」模式（真跑 HTTP，不是离线 mock）',
    await cdp.evaluate(A.sessionId, 'LIVE === true') &&
    await cdp.evaluate(B.sessionId, 'LIVE === true'), 'LIVE=true ×2');

  const cnt = async s => Number(await cdp.evaluate(s, 'document.getElementById("aprcnt").textContent'));
  kv('起始待批计数', 'A=' + await cnt(A.sessionId) + '  B=' + await cnt(B.sessionId));

  sub('D1  在窗口 A 的页面里发起一个被门控的请求（没人碰过窗口 B）');
  const init = await cdp.evaluate(A.sessionId, `(async () => {
    const q = await fetch('/v1/act/queue', { method:'POST',
      headers:{'Content-Type':'application/json','Idempotency-Key':'acc-win-${Date.now()}'},
      body: JSON.stringify({ kind:'tts.seed_audio', shard:'ACC_WIN', cost_cny:${COST},
        route:'approve', reason:'验收：真双窗口跨标签同步' }) });
    const qj = await q.json();
    const cf = await fetch('/v1/act/' + qj.data.id + '/confirm', { method:'POST',
      headers:{'Content-Type':'application/json'}, body:'{}' });
    const cj = await cf.json();
    return { queueStatus:q.status, actionId:qj.data.id, confirmStatus:cf.status,
      code:cj.error && cj.error.code, approvalId:cj.error && cj.error.approval_id };
  })()`);
  kv('窗口A 里发起', '入队 HTTP ' + init.queueStatus + ' → ' + init.actionId);
  kv('窗口A 里直调 confirm', 'HTTP ' + init.confirmStatus + ' · ' + init.code);
  kv('拿到的审批单', init.approvalId);
  ck('窗口A 的直调被网关截停（403）',
    init.confirmStatus === 403 && init.code === 'REQUIRE_APPROVAL',
    'HTTP ' + init.confirmStatus + ' · ' + init.code);

  sub('D2  两个窗口都没被碰过 —— 等它们自己发现（心跳 10s）');
  line('       这才是跨窗口同步的定义：没人刷新，状态自己流过去。');
  line('       注意窗口A 是自己发起请求的那个，但它同样没刷新自己 —— 所以两边都要靠心跳。');
  const tD2 = Date.now();
  const [wA1, wB1] = await Promise.all([
    cdp.waitFor(A.sessionId, 'Number(document.getElementById("aprcnt").textContent) >= 1', 25000),
    cdp.waitFor(B.sessionId, 'Number(document.getElementById("aprcnt").textContent) >= 1', 25000)
  ]);
  kv('窗口A 自行刷出待批', '1   用时 ' + wA1.waitedMs + 'ms');
  kv('窗口B 自行刷出待批', '1   用时 ' + wB1.waitedMs + 'ms');
  ck('两个窗口都在无人操作的情况下自己同步到了待批（心跳 10000ms）',
    (await cnt(A.sessionId)) === 1 && (await cnt(B.sessionId)) === 1,
    'A=' + await cnt(A.sessionId) + ' B=' + await cnt(B.sessionId) + ' · 共 ' + (Date.now() - tD2) + 'ms');
  const listA = await cdp.evaluate(A.sessionId,
    `JSON.stringify((S.approvals||[]).filter(a=>a.status==='PENDING').map(a=>a.id))`);
  const listB = await cdp.evaluate(B.sessionId,
    `JSON.stringify((S.approvals||[]).filter(a=>a.status==='PENDING').map(a=>a.id))`);
  kv('两边面板里的待批条目', 'A ' + listA + ' · B ' + listB);
  ck('两边的待批列表逐字一致（同一个 id，不是各存一份）',
    listA === listB && listA.indexOf(init.approvalId) !== -1, listA);

  sub('D3  在窗口 B 里点「真按钮」批准（不是调函数，是 click 那个 button 元素）');
  const tD3 = Date.now();
  const clicked = await cdp.evaluate(B.sessionId, `(() => {
    const b = document.querySelector('#apr button[data-d="approve"]');
    if (!b) return { ok:false, why:'按钮还没渲染出来' };
    const info = { ok:true, id:b.dataset.i, label:b.textContent.trim() };
    b.click();
    return info;
  })()`);
  kv('点到的按钮', JSON.stringify(clicked));
  ck('窗口B 的批准按钮确实渲染出来了且被点到',
    clicked.ok === true && clicked.label === '批准执行',
    clicked.ok ? (clicked.label + '  data-i=' + clicked.id) : clicked.why);

  const wb2 = await cdp.waitFor(B.sessionId, 'Number(document.getElementById("aprcnt").textContent) === 0', 20000);
  kv('窗口B 待批归零', (await cnt(B.sessionId)) + '   用时 ' + wb2.waitedMs + 'ms（这次是点了按钮触发的刷新）');

  sub('D4  窗口 A 什么都没做 —— 它应该自己看到裁决结果');
  line('       等的是「动作变 EXECUTED」，不是「待批变 0」——');
  line('       窗口A 自始至终没见过待批 1 在它自己的视图里停留，等 0 是等了个寂寞。');
  const wa = await cdp.waitFor(A.sessionId,
    `((S.actions||[]).find(x=>x.id==='${init.actionId}')||{}).status === 'EXECUTED'`, 30000);
  kv('窗口A 等到动作变 EXECUTED', wa.waitedMs + 'ms（心跳 10000ms）');
  kv('窗口A 的待批计数', String(await cnt(A.sessionId)));
  kv('窗口A 从窗口B 点按钮算起', (Date.now() - tD3) + 'ms');
  ck('未被操作的窗口 A 自动看到「已执行」',
    (await cnt(A.sessionId)) === 0, 'aprcnt=0 · ' + wa.waitedMs + 'ms 内自愈');

  const stA = await cdp.evaluate(A.sessionId, `(() => {
    const a = (S.actions||[]).find(x => x.id === '${init.actionId}');
    const p = (S.approvals||[]).find(x => x.id === '${init.approvalId}');
    return { action: a && a.status, approval: p && p.status,
      decidedBy: p && p.decided_by, replayed: p && p.replay && p.replay.status,
      replayedRoute: p && p.replay && p.replay.method + ' ' + p.replay.route,
      budget: S.budget && S.budget.used };
  })()`);
  kv('窗口A 看到的动作', stA.action);
  kv('窗口A 看到的审批单', stA.approval + ' · by ' + stA.decidedBy + ' · 回放 HTTP ' + stA.replayed +
    ' (' + stA.replayedRoute + ')');
  kv('窗口A 看到的预算', stA.budget);
  ck('窗口A 没裁决，却看到动作已被执行',
    stA.action === 'EXECUTED', 'action.status=' + stA.action);
  ck('窗口A 看得到是谁批的、以及回放松了没有（可追溯，不是黑箱）',
    stA.approval === 'EXECUTED' && !!stA.decidedBy && stA.replayed === 200,
    'approval=' + stA.approval + ' · by=' + stA.decidedBy + ' · replay=' + stA.replayed);
  ck('扣款只发生一次，两个窗口看到同一个数',
    Math.abs((stA.budget - 12.4) - COST) < 1e-9,
    'budget ' + stA.budget + '（12.40 + ' + COST + '）');

  sub('D5  页面里能直接看到「闸门」这回事，不是靠人记');
  const lockA = await cdp.evaluate(A.sessionId,
    `document.getElementById('apr').innerHTML.indexOf('门控在服务端') >= 0`);
  const footA = await cdp.evaluate(A.sessionId,
    `document.getElementById('srv') ? document.getElementById('srv').innerHTML.length : 0`);
  ck('待审批面板里写明了门控在服务端（不是提示词）', lockA === true, '面板文案含「门控在服务端」');
  kv('页脚渲染长度', footA + ' 字符（真实状态渲染，不是占位）');

  await cdp.closePage(A.targetId);
  await cdp.closePage(B.targetId);
  cdp.disconnect();

  sec('汇总');
  const w = Math.max(...ROWS.map(r => r.name.length), 10);
  ROWS.forEach(r => line('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name.padEnd(w) + '  ' + r.ev));
  line('');
  line('  ' + '─'.repeat(76));
  line('  真浏览器验收项 ' + N + '   通过 ' + PASS + '   失败 ' + FAIL +
    '   耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  line('');

  await fetch(BASE + '/v1/demo/reset', { method: 'POST' });
  line('  已 demo/reset 归零。');
  process.exitCode = FAIL === 0 ? 0 : 1;
})().catch(e => {
  line('');
  line('验收脚本自身出错：' + (e && e.stack || e));
  process.exit(3);
});
