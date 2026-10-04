#!/usr/bin/env node
/**
 * 采集评测包所需的快照 —— 全部来自**运行中的真实服务**，不是手抄的。
 *
 * 为什么要有这个脚本：手抄的快照会过时、会撒谎，而评测包的全部价值就在于
 * 「评估者看到的，就是服务真的会给的」。所以快照必须能被重新生成，并且带 digest。
 *
 * 用法： node tools/make-eval-snapshot.mjs [--base http://127.0.0.1:8787] [--out EVAL-PACKAGE/snapshot]
 */
import fs from 'node:fs';
import path from 'node:path';
import { diffPaths, assertSamplesStable } from './contract-sync.mjs';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = argOf('--base', 'http://127.0.0.1:8787');
const OUT = path.resolve(argOf('--out', 'EVAL-PACKAGE/snapshot'));

const get = async (p, headers) => {
  const r = await fetch(BASE + p, headers ? { headers } : undefined);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ctype: r.headers.get('content-type'), bytes: Buffer.byteLength(text), text, json, headers: Object.fromEntries(r.headers.entries()) };
};
const post = async (p, body, headers) => {
  const r = await fetch(BASE + p, { method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ctype: r.headers.get('content-type'), bytes: Buffer.byteLength(text), text, json };
};
const write = (name, obj) => {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  console.log('  写出 ' + name + '  (' + fs.statSync(p).size + 'B)');
};

// ─── 「连采两次」：把运行态字段从事实里抠出来 ────────────────────────────────
// 真事故：交付物写 `"bytes": 1260`（GET / 的响应大小），实测 1263。
// 采集没错 —— 是那份响应含运行态字段（_meta.request_id / latency_ms / budget.reserved），
// 采集瞬间 reserved=0，之后变成 0.42，恰好 3 字节。
// **含运行态字段的响应，其字节数必然过期。** 与其猜哪些字段会动，不如连采两次直接 diff。
// 得到的清单会写进样本的 `_volatile.fields`，护栏（contract-sync）据此屏蔽后比对语义。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连采两次同一个端点 → { a, b, volatile } ；volatile 是两次之间值不同的路径清单 */
const probeTwice = async (fn) => {
  const a = await fn();
  await sleep(90);
  const b = await fn();
  const volatile = a.json && b.json ? diffPaths(a.json, b.json) : [];
  return { a, b, volatile };
};

// 慢漂移字段的命名规则。**故意保守**：宁可多屏蔽几个，也不放过一个真会漂的。
// 只写「按名字就能断定它随运行态变」的那些；语义存疑的一律不写（让护栏去抓）。
const isTimestampish = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v);
const matchesVolatilePattern = (p, v) =>
  /(^|\.)request_id$/.test(p) ||
  /(^|\.)latency_ms$/.test(p) ||
  // 它是 Math.ceil(响应字节数/4) 派生的 —— 别的运行态字段一漂，它跟着漂。
  // 双采未必碰得上（要跨过 4 字节的取整边界才显形），所以必须靠命名规则兜住。
  /(^|\.)tokens_estimate$/.test(p) ||
  /(^|\.)uptime_s$/.test(p) ||
  /(^|\.)budget\.(reserved|used)$/.test(p) ||
  /(^|\.)counts\.[^.]+$/.test(p) ||
  /(^|\.)timestamp$/.test(p) ||
  // 时间戳后缀：必须**值也长得像时间戳**才算 ——
  // 否则 _meta.gate_enforced_at（值是 "server process"）会被误伤，白放宽一格护栏。
  (/(^|\.)[a-z_]*_at$/.test(p) && isTimestampish(v));

/** 枚举 JSON 的全部叶子 { path, value }（用于按规则筛运行态字段） */
const allLeaves = (obj, base = '', out = []) => {
  if (obj === null || typeof obj !== 'object') { if (base) out.push({ path: base, value: obj }); return out; }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => allLeaves(v, base + '[' + i + ']', out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) allLeaves(v, base ? base + '.' + k : k, out);
  return out;
};

/** 组装 _volatile 元数据块 */
const volatileBlock = (probe, extraNote) => {
  const byDiff = new Set(probe.volatile);
  // 双采只能抓到「高频漂移」——90ms 窗口内就变的字段。
  // 抓不到「慢漂移」：budget.reserved / uptime_s / counts.* 在一次采样窗口里纹丝不动，
  // 跨分钟才变。护栏（交付时重放）第一次跑就把它们逮出来了，因为交付与采集隔了几十分钟。
  // 所以判定要用两条腿：客观 diff + 命名规则。二者取并集，并分别记下来源。
  const byPattern = new Set();
  if (probe.a.json) {
    allLeaves(probe.a.json).forEach(({ path: p, value: v }) => {
      if (matchesVolatilePattern(p, v)) byPattern.add(p);
    });
  }
  const fields = [...new Set([...byDiff, ...byPattern])].sort();
  return {
    // 注意：这里刻意**不用** markdown 粗体标记。样本会被内联进 .md（合法）和 .html（会显示成
    // 字面星号）两处，所以样本本身不能带 markdown 语法。强调一律用「」。
    note: (extraNote ? extraNote + ' ' : '') +
          '本响应含「运行态字段」（见下面 fields）：它们随服务运行状态变化，' +
          '所以上面的 bytes 只是某一次采样的瞬间值，会跟着漂移。' +
          '核对时请先屏蔽这些路径，再比对语义部分。',
    fields,
    detected_by: {
      'double-probe': [...byDiff].sort(),
      'name-pattern': [...byPattern].sort(),
    },
    bytes_observed: [probe.a.bytes, probe.b.bytes],
    bytes_note: 'bytes 是第 1 次采样的瞬间值。两次采样相同，不等于它不会变 —— ' +
                '真正的驱动是上面 fields 里的字段（尤其 _meta.budget.reserved/used）：' +
                '它们一改，整份响应的字节数就跟着改。不要把 bytes 当成可复现的事实去核对。',
  };
};


(async () => {
  console.log('采集快照 ← ' + BASE + '  →  ' + OUT);
  await post('/v1/demo/reset');

  // 1. 自举：零知识 agent 的第一次请求。
  //    显式写死 Accept: */*，并把它记进快照 —— 之前这里注释写「不带 Accept 头」，
  //    可 fetch 默认就会发 */*：注释和事实不一致，而这份快照正是拿去给人做证据的。
  //    现在请求头进 JSON，注释不可能再和事实分家。
  const REQ_ACCEPT = '*/*';
  const root = await probeTwice(() => get('/', { accept: REQ_ACCEPT }));
  write('bootstrap-root.sample.json', {
    _note: '一个零知识 agent 打 GET / 时拿到的。请求带 Accept: ' + REQ_ACCEPT +
           '（与 fetch / curl 的默认值一致）—— 实际发的请求头见 _request_headers。' +
           '内容协商：只有明确偏好 text/html 才给页面，否则给这份机器可读索引。',
    _request_headers: { accept: REQ_ACCEPT },
    _volatile: volatileBlock(root),
    status: root.a.status, content_type: root.a.ctype, bytes: root.a.bytes,
    body: root.a.json || root.a.text.slice(0, 400)
  });

  // 2. health
  const health = await probeTwice(() => get('/v1/health'));
  write('health.sample.json', {
    _note: '自举入口。routes[] 给出全部路由，agent 据此知道这里有什么。',
    _volatile: volatileBlock(health),
    status: health.a.status, content_type: health.a.ctype, bytes: health.a.bytes, body: health.a.json
  });

  // 3. 撞门控：本包最重要的一份
  //    双采会产生第二张待审批单 —— 这是有意接受的副作用：唯有如此才能**客观地**得到
  //    「哪些字段每次都不一样」的清单（而不是靠我手写猜 approval_id 会变）。
  const step403 = async () => {
    const q = await post('/v1/act/queue', { kind: 'eval_sample', shard: 'EV', cost_cny: 0.42, route: 'approve' },
      { 'Idempotency-Key': 'eval-snapshot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) });
    const actionId = q.json && q.json.data && q.json.data.id;
    return post('/v1/act/' + actionId + '/confirm', {});
  };
  const conf = await probeTwice(step403);
  write('gate-403.sample.json', {
    _note: '★ 最重要的一份：agent 调用一个被门控的端点时，真实拿到的完整响应。' +
           '注意 hints[].action —— 那是给 agent 做分支的机器语义（ASCII 枚举），' +
           'suggest/why 是给人读的散文。两者分开，是因为跨语区模型对中文原文没有稳定的解析契约。',
    _volatile: volatileBlock(conf,
      '注意 error.approval_id 每次都不同（每次撞门控都会新挂一张单），hints 里嵌了该 id 的 suggest 文字同理。'),
    request: { method: 'POST', path: '/v1/act/{id}/confirm', body: {} },
    status: conf.a.status, content_type: conf.a.ctype, bytes: conf.a.bytes, body: conf.a.json
  });

  // 4. 单查那张单子
  const aprId = conf.a.json && conf.a.json.error && conf.a.json.error.approval_id;
  const single = await probeTwice(() => get('/v1/approvals/' + aprId));
  write('approval-single.sample.json', {
    _note: 'agent 手握 approval_id 后的 O(1) 查询路径。注意 requires 随状态变：' +
           '还挂着时是 human（谁说了算在人），裁决后转 auto。next_step 是结构化字段，不是散文。',
    _volatile: volatileBlock(single),
    status: single.a.status, bytes: single.a.bytes, body: single.a.json
  });

  // 5. 契约
  const spec = await get('/v1/openapi.json');
  write('contract.openapi.json', spec.json || { error: 'not json' });
  write('contract.transport-headers.txt',
    '这是 GET /v1/openapi.json 的响应头。\n' +
    '注意：文档体里**没有** _meta —— 传输统计放在头里。\n' +
    '理由：文档的全部价值在于描述那份契约，而契约不随请求变。\n' +
    '把 request_id / latency 塞进文档体，等于把「可 diff」这个能力白送掉。\n\n' +
    Object.entries(spec.headers).map(([k, v]) => k + ': ' + v).join('\n') + '\n');

  // 6. agent-trial 的机器可读数据
  const trialPath = path.resolve('EVAL-PACKAGE/agent-trial-baseline.json');
  if (fs.existsSync(trialPath)) {
    console.log('  （agent-trial-baseline.json 已存在，由 agent-trial.mjs --json 生成，不覆盖）');
  } else {
    console.log('  提示：agent-trial-baseline.json 请用 `node agent-trial.mjs --json EVAL-PACKAGE/agent-trial-baseline.json` 生成');
  }

  // 7. 索引
  write('README.md', [
    '# snapshot/ —— 全部来自运行中的真实服务，非手抄',
    '',
    '生成命令：`node tools/make-eval-snapshot.mjs`（服务需在 8787 运行）',
    '生成时间：' + new Date().toISOString(),
    '来源：' + BASE,
    '',
    '| 文件 | 是什么 |',
    '|---|---|',
    '| `bootstrap-root.sample.json` | 零知识 agent 第一次打 `GET /` 拿到什么（内容协商） |',
    '| `health.sample.json` | 自举入口：端点清单 |',
    '| `gate-403.sample.json` | **★ 最重要**：被门控时 agent 真实拿到的完整响应 |',
    '| `approval-single.sample.json` | 单查审批单（`requires` 随状态变） |',
    '| `contract.openapi.json` | 完整契约（现场派生，可 diff） |',
    '| `contract.transport-headers.txt` | 契约的响应头 —— 传输元数据在这里，不在文档体里 |',
    '| `agent-trial-baseline.json` | AI 视角测评的原始判定数据（机器可读） |',
    '',
    '## `_volatile`：为什么字节数不能当成事实来核',
    '',
    '每份样本都有一个 `_volatile` 块，里面的 `fields` 是**连采两次自动 diff 出来的**运行态字段',
    '（不是手写猜的）。这些字段的值随服务运行状态变化，因此 `bytes` 只是某一次采样的瞬间值。',
    '',
    '- `_volatile.fields` —— 两次采样之间值不同的路径清单；核对时屏蔽这些路径再比对。',
    '- `_volatile.bytes_observed` —— 两次采样各自的字节数；两者不等就说明字节数会漂移。',
    '- `_volatile.bytes_stable` —— 两次是否恰好相等（相等也可能只是这次运气好）。',
    '',
    '`tools/contract-sync.mjs` 的 `assertSamplesStable()` 会重放无副作用的两份样本，',
    '**只屏蔽 `_volatile.fields` 后**做深度相等断言 —— 出现清单外的任何差异就拒绝生成。',
    '也就是说：**运行态字段不可能再悄悄增加**，新增一个会立刻被抓住。',
    '',
    '有副作用的两份（`gate-403` 会新挂一张待审批单、`approval-single` 依赖那张单）不参与重放，',
    '它们靠 `_volatile.fields` 如实标注；这也是为什么 `gate-403` 的 `approval_id` 每次都不同。',
    '',
    '**这些文件会过时。** 如果你要下结论，请以自己实际调用服务的结果为准；',
    '或者重跑上面的生成命令刷新它们。',
    ''
  ].join('\n'));

  // 8. 采完立刻自检 —— 刚写的样本能不能通过护栏的语义核对
  console.log('\n自检：重放无副作用的样本，核对语义一致性…');
  await assertSamplesStable(OUT, BASE);

  console.log('\n采集完成。');
})().catch(e => { console.error('采集失败：' + e.message); process.exitCode = 1; });
