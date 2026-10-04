#!/usr/bin/env node
/* Agent Console · 后端 v4
 * 零 npm 依赖：node:http + node:sqlite（Node 22.5+ 内置）
 *
 * v3 把队列/锁/状态从浏览器进程里拿了出来。
 * v4 补的是最后一步：把「requires」从标注变成真正的闸门。
 *
 *  - 状态落 SQLite：跨标签页、跨浏览器、重启不丢
 *  - 幂等由表的 UNIQUE 约束保证，不是应用层 if
 *  - 分片租约由服务端仲裁，TTL 到期自动释放
 *  - 门控端点不可被 agent 直接执行：请求落盘为待审批，唯一执行路径是审批回放
 *
 * 两条正交的轴，别混：
 *   requires（响应字段） = 这个结果需要谁来裁决
 *   gate    （路由策略） = 这个动作谁有权发起
 * 把语义判定塞进 gate 会让 /senses/judge 无法返回「我判不了」——那才是设计灾难。
 *
 * 启动： node server.js                         （默认 http://127.0.0.1:8787）
 *        PORT=9000 node server.js
 *        APPROVAL_SECRET=xxx node server.js      （裁决端点开始要密钥，闸门脱离「本机即信任」）
 */
'use strict';

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT     = __dirname;
const PORT     = Number(process.env.PORT || 8787);
const DB_PATH  = process.env.DB || path.join(ROOT, 'agent-console.sqlite');
const HTML     = path.join(ROOT, 'ai-workbench.html');
// 前端页体积：内容协商的文案用它。**从文件算，不写死** ——
// 写死「80KB」这类数字，改了前端它就会和事实不符；而这条文案出现在
// **一个零知识 agent 看到的第一条消息**里，在那里说错话代价最大。
const HTML_KB  = (() => { try { return Math.round(fs.statSync(HTML).size / 1024) + 'KB'; } catch { return '几十 KB'; } })();
const BOOT_MS  = Date.now();
const DEMO     = process.env.DEMO !== '0';      // demo/* 端点开关
const APR_KEY  = process.env.APPROVAL_SECRET || null;  // 设了就要求裁决方出示密钥

// ───────────────────────────── 小工具 ─────────────────────────────
const pad2    = n => String(n).padStart(2, '0');
// 全服务只用一种时间口径：**本地时间**，格式 YYYY-MM-DD HH:MM:SS。
// 具体时区是本地环境（本机单人工具，不跨时区部署）。
// 为什么抽成函数：曾出现 acquired_at 走本地、expires_at 走 toISOString()(UTC)，
// 同一响应里两个时间戳差 8 小时 —— agent 一比对就误判「租约已过期」。
const fmtLocal = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const nowFull = () => fmtLocal(new Date());
const nowTime = () => { const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const hex      = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const genRid   = () => 'req_' + hex(8);
const r2       = n => Math.round(n * 100) / 100;

// ───────────────────────────── 存储 ─────────────────────────────
const db = new DatabaseSync(DB_PATH);
// 注意顺序：busy_timeout 必须先设，否则 journal_mode 在并发启动时会直接抛 database is locked
db.exec('PRAGMA busy_timeout = 8000');
db.exec('PRAGMA foreign_keys = ON');
let journalMode = 'unknown';
for (let i = 0; i < 5; i++) {
  try { db.exec('PRAGMA journal_mode = WAL'); journalMode = 'wal'; break; }
  catch (e) {                                   // 另一个进程正持有锁；WAL 是持久属性，重试即可
    try { journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode; } catch {}
    if (journalMode === 'wal') break;
    if (i === 4) console.warn('[agent-console] 未能切到 WAL，当前模式:', journalMode, '(' + e.message + ')');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS budget (
  id INTEGER PRIMARY KEY CHECK (id = 1), limit_cny REAL, used_cny REAL);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, key TEXT, value TEXT, immutable INTEGER,
  by TEXT, locked_at TEXT, superseded_at TEXT, previous_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decisions_live
  ON decisions(key) WHERE superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, current_version INTEGER);
CREATE TABLE IF NOT EXISTS asset_versions (
  asset_id TEXT, v INTEGER, value TEXT, by TEXT, at TEXT,
  superseded INTEGER, note TEXT, PRIMARY KEY (asset_id, v));
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, at TEXT, action TEXT, shard TEXT, result TEXT, seq INTEGER);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, kind TEXT, shard TEXT, cost REAL, route TEXT,
  status TEXT, idem TEXT, created_at TEXT, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS ix_actions_status ON actions(status);
-- 幂等的物理保证：主键唯一。并发同键请求，第二个必然撞约束。
-- route/response 两列供「可选幂等」用（见 idemClaim）：
--   带了 Idempotency-Key 的写请求，把首次响应整份存这里供重放；
--   act/queue 的 required 路径不用它们（它按 payload 里的 action_id 重新构造响应）。
CREATE TABLE IF NOT EXISTS idem_keys (
  key TEXT PRIMARY KEY, action_id TEXT, payload TEXT, created_at TEXT,
  hits INTEGER NOT NULL DEFAULT 0, route TEXT, response TEXT);
CREATE TABLE IF NOT EXISTS leases (
  shard TEXT PRIMARY KEY, holder TEXT, granted_ttl_s INTEGER,
  acquired_at TEXT, expires_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, at TEXT,
  verb TEXT, target TEXT, result TEXT, rid TEXT);
CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, target_key TEXT,
  current_value TEXT, proposed TEXT, requested_by TEXT, created_at TEXT,
  status TEXT, resolved_at TEXT, resolved_by TEXT);
-- 待审批：被网关拦下的请求原样躺在这里。它不是日志，是唯一的执行入口。
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL, route TEXT NOT NULL, params TEXT NOT NULL, body TEXT,
  idem_key TEXT, fingerprint TEXT NOT NULL,
  requested_by TEXT, created_at TEXT NOT NULL,
  status TEXT NOT NULL,                          -- PENDING | EXECUTED | REJECTED | FAILED | EXPIRED
  hits INTEGER NOT NULL DEFAULT 0,               -- 被重复请求命中几次（可观测性）
  decided_by TEXT, decided_at TEXT, reason TEXT,
  replay_status INTEGER, replay_body TEXT, replayed_at TEXT,
  expires_at_ms INTEGER);                        -- 可选 TTL：NULL = 无 TTL（永不过期，等人工）
CREATE INDEX IF NOT EXISTS ix_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS ix_approvals_fp ON approvals(fingerprint, status);
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY, value INTEGER);
`);

/* 列迁移 —— CREATE TABLE IF NOT EXISTS 对**已经存在**的库不会加列。
 * 本机跑着的那份 .sqlite 是先建的，所以新列必须显式 ALTER：
 * 否则 CREATE 里写了新列、实际表里没有，代码一路读到 undefined，
 * 而且不报错 —— 这种「看着加了其实没加」最难查。 */
const columnsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const addColumns = (t, defs) => {
  const have = columnsOf(t);
  for (const [name, decl] of defs)
    if (!have.includes(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${decl}`);
};
addColumns('idem_keys', [['route', 'TEXT'], ['response', 'TEXT']]);
addColumns('approvals', [['expires_at_ms', 'INTEGER']]);

const q = {
  one: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
  tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }
};

// ───────────────────────────── 种子 ─────────────────────────────
function seed() {
  q.tx(() => {
    for (const t of ['budget','decisions','assets','asset_versions','snapshots','actions',
                     'idem_keys','leases','audit','change_requests','approvals','counters']) q.run(`DELETE FROM ${t}`);
    q.run('INSERT INTO budget (id, limit_cny, used_cny) VALUES (1, 50, 12.4)');
    const dec = [
      ['DEC-001','locale','en-US',1,'user','2026-09-28 10:12:00'],
      ['DEC-002','voice.lead','female, warm, slightly raspy, mid-30s',1,'user','2026-09-29 21:40:00'],
      ['DEC-003','delivery.audio','192k CBR / 44.1k / joint stereo',1,'user','2026-10-01 09:05:00']
    ];
    for (const d of dec) q.run('INSERT INTO decisions (id,key,value,immutable,by,locked_at) VALUES (?,?,?,?,?,?)', ...d);
    q.run('INSERT INTO assets (id, current_version) VALUES (?,?)', 'voice.lead.ref', 2);
    q.run('INSERT INTO asset_versions (asset_id,v,value,by,at,superseded,note) VALUES (?,?,?,?,?,?,?)',
      'voice.lead.ref', 1, 'female, warm, mid-30s', 'user', '2026-09-28 10:20:00', 1, '初版');
    q.run('INSERT INTO asset_versions (asset_id,v,value,by,at,superseded,note) VALUES (?,?,?,?,?,?,?)',
      'voice.lead.ref', 2, 'female, warm, slightly raspy, mid-30s', 'user', '2026-09-29 21:40:00', 0, '定稿');
    const snaps = [
      ['snap_0005','2026-10-03 14:12:08','measure','CH03_S03','PASS',5],
      ['snap_0006','2026-10-03 14:26:41','measure','CH03_S02','PASS',6],
      ['snap_0007','2026-10-03 14:39:55','measure','CH03_S01','PASS',7]
    ];
    for (const s of snaps) q.run('INSERT INTO snapshots (id,at,action,shard,result,seq) VALUES (?,?,?,?,?,?)', ...s);
    q.run('INSERT INTO counters (name, value) VALUES (?,?)', 'snap', 7);
    q.run('INSERT INTO audit (ts,at,verb,target,result,rid) VALUES (?,?,?,?,?,?)',
      nowTime(), nowFull(), 'INIT', 'engine', '数据库已初始化（seed）', genRid());
  });
}

function log(verb, target, result, rid) {
  q.run('INSERT INTO audit (ts,at,verb,target,result,rid) VALUES (?,?,?,?,?,?)',
    nowTime(), nowFull(), verb, target, result, rid || genRid());
  q.run('DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT 500)');
}
const nextSnap = () => { q.run('UPDATE counters SET value = value + 1 WHERE name = ?', 'snap');
  return q.one('SELECT value FROM counters WHERE name = ?', 'snap').value; };

// ─────────────────────── 网关：把 requires 变成约束 ───────────────────────
/* 直到 v3，队列闸门靠的是「agent 自觉不去调 confirm」—— 那是最脆弱的实现。
 * 这里改掉：门控端点的 HTTP 入口不再执行任何业务逻辑，只做一件事 —— 把请求原样落盘。
 * 于是「绕开队列」在架构上不存在路径：能跑该 handler 的代码只有一行，在审批回放里。
 *
 * 门控 vs 升级，两条不同的轴：
 *   gate=approval —— 你来都不要来，这是授权问题（花钱、改锁定项）
 *   requires      —— 你做完了，但结论得人来看（语义判定）
 * 把 judge 也门控掉，它就永远无法返回「我判不了」，那不是更安全，是更蠢。 */
const VER = 'v6';  // 单一来源：health / openapi.info / x-agent-console 都引用它

/* hints[].action 的词表 —— 机器可读的「下一步」语义。
 *
 * 为什么要它：hints 原本只有 suggest/why 两句中文。人读一句话就懂了，
 * 但这个产品的第一用户是 agent —— 它要的是能 if 的枚举，不是一段需要 LLM 解读的自然语言。
 * 「停止重试」这四个字对跨语区模型没有稳定的解析契约：模型换一版、换个语区，
 * 分支就可能走错；而走错的代价是白烧上下文，甚至把 403 当成可重试错误反复撞。
 *
 * 所以：机器语义走 action（ASCII 枚举），人类语义走 suggest（自然语言）。
 * 这份数组同时是契约 enum 的唯一来源 —— 见 §启动校验，写了不在词表里的 action 会在启动时直接报错。 */
const HINT_ACTIONS = [
  'stop_retry',                 // 此路不通，别重试（最省上下文的信号）
  'observe',                    // 可读不可写：去查看
  'wait_for_human',             // 等人工，别空转
  'decide_approval',            // （给人）裁决审批单
  'provide_input',              // （给人）提供判断或输入
  'raise_limit',                // （给人）调整额度上限
  'retry_with_idempotency_key', // 补幂等键后重发
  'use_alternative',            // 换参数或换端点
  'open_change_request',        // 走变更请求通路，不要绕开锁定
  'claim_lease',                // 先占租约再动手
  'continue_other_shards'       // 挂起当前分片，继续其他未阻塞的
];
const HINT_ACTION_SET = new Set(HINT_ACTIONS);

/* error.code 的全集 —— 契约 enum 的唯一来源。
 * agent 应当穷举这些值做分支，而不是解析 message 的散文。 */
const ERROR_CODES = [
  'INVALID_JSON', 'INVALID_BODY', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_CONFLICT',
  'REQUIRE_APPROVAL',
  'ALREADY_DECIDED', 'APPROVAL_NOT_FOUND', 'APPROVAL_EXPIRED', 'APPROVAL_SECRET_REQUIRED',
  'ACTION_NOT_FOUND', 'ASSET_NOT_FOUND', 'DECISION_NOT_FOUND', 'CHANGE_REQUEST_NOT_FOUND',
  'DECISION_LOCKED', 'VERSION_IMMUTABLE', 'BUDGET_EXCEEDED', 'SHARD_LOCKED',
  'ROUTE_CONFLICT', 'ROUTE_GONE', 'INVALID_STATE', 'UNSUPPORTED_TARGET',
  'ENDPOINT_NOT_FOUND', 'NO_HANDLER', 'UI_NOT_FOUND'
];
const ERROR_CODE_SET = new Set(ERROR_CODES);

const GATE = new Map([
  ['POST /v1/act/:id/confirm',
    { level: 'approval', why: '确认执行 = 产生费用 + 不可逆副作用' }],
  ['POST /v1/act/confirm',
    { level: 'approval', why: '同上（兼容 body.action_id 形式）' }],
  ['POST /v1/state/change_requests/:id/approve',
    { level: 'approval', why: '批准变更 = 改写已锁定的决策 / 资产' }]
]);
/* 人类专属表面：不是「门控」，而是这些端点本身代表人的意志。
 * 没有鉴权时它挡不住同机进程 —— 所以给了 APPROVAL_SECRET 这个开关，
 * 默认关（本机单人工具），开了就是真的：agent 拿不到密钥就裁决不了。 */
const HUMAN_SURFACE = new Set(['POST /v1/approvals/:id/decide']);

// 稳定序列化：同样的语义内容必得同样的指纹，不受对象键序影响
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
/* 指纹不掺幂等键 —— 挂起的幂等按「操作内容」算，不按「调用者的键」算。
 * 否则 agent 每换一个 key 重发就多一张重复单子，人就得在一堆同义请求里挑。
 * 两个不同 key 打同一件事 = 同一件事。 */
/* 指纹只算「这件事的内容」——approval_ttl_s 描述的是这张单子活多久，
 * 不是它要干什么。掺进指纹，同一个请求带不同 TTL 就变成两张指纹不同的单子，
 * 「重发不会多开一张」当场作废。 */
const APPROVAL_TTL_FIELD = 'approval_ttl_s';
const withoutTtl = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !(APPROVAL_TTL_FIELD in body)) return body;
  const { [APPROVAL_TTL_FIELD]: _ttl, ...rest } = body;
  return rest;
};
const fingerprint = (method, route, params, body) =>
  crypto.createHash('sha256')
    .update([method, route, stable(params), stable(withoutTtl(body))].join('\u0000'))
    .digest('hex').slice(0, 32);

/* 可选 TTL：只在提交时显式带了 approval_ttl_s 才生效。
 * 没带 = 无 TTL = 永不过期（等人工），与从前逐字节相同。
 * 上限 30 天：再长就等于没有 TTL，那个值没有意义。 */
const ttlOf = (body) => {
  const s = Number(body && body[APPROVAL_TTL_FIELD]);
  return s > 0 ? Math.min(s, 86400 * 30) : null;
};

function parkRequest(method, routeKey, req) {
  const route = routeKey.includes(' ') ? routeKey.slice(routeKey.indexOf(' ') + 1) : routeKey;
  const fp = fingerprint(method, routeKey, req.params, req.body);
  const ttlS = ttlOf(req.body);
  const expMs = ttlS ? Date.now() + ttlS * 1000 : null;
  const dup = q.one("SELECT * FROM approvals WHERE fingerprint = ? AND status = 'PENDING'", fp);
  if (dup) {
    /* 重发时若这次带了更长的 TTL，就把它续上 —— 否则人会对着一个刚重发过的单子看它过期。
     * 只延长、不缩短：缩短等于把上一次重发白做。 */
    if (expMs && (dup.expires_at_ms === null || expMs > dup.expires_at_ms)) {
      q.run('UPDATE approvals SET hits = hits + 1, expires_at_ms = ? WHERE id = ?', expMs, dup.id);
    } else {
      q.run('UPDATE approvals SET hits = hits + 1 WHERE id = ?', dup.id);
    }
    log('POST', routeKey, '已挂起 · 重复请求命中 ' + dup.id, req.rid);
    return { ap: q.one('SELECT * FROM approvals WHERE id = ?', dup.id), deduped: true };
  }
  const id = 'apr_' + hex(6);
  q.run(`INSERT INTO approvals (id,method,route,params,body,idem_key,fingerprint,
         requested_by,created_at,status,hits,expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?,'PENDING',0,?)`,
    id, method, route, JSON.stringify(req.params || {}),
    req.body === null || req.body === undefined ? null : JSON.stringify(req.body),
    req.idemKey || null, fp, (req.body && req.body.requested_by) || 'agent', nowFull(), expMs);
  log('POST', routeKey, '403 已挂起待批 · ' + id + (ttlS ? ` · TTL ${ttlS}s` : ' · 无 TTL'), req.rid);
  return { ap: q.one('SELECT * FROM approvals WHERE id = ?', id), deduped: false };
}

const approvalRow = a => ({
  id: a.id, status: a.status,
  requested_by: a.requested_by, created_at: a.created_at,
  request: { method: a.method, route: a.route, params: JSON.parse(a.params || '{}'),
    body: a.body ? JSON.parse(a.body) : null, idempotency_key: a.idem_key || null },
  fingerprint: a.fingerprint,
  fingerprint_note: 'sha256(method␀route␀params␀body) 前 32 位 —— 不含幂等键、也不含 approval_ttl_s：键和寿命都改不了「这是哪件事」',
  hits: a.hits,
  /* 可选 TTL：只有提交时带了 approval_ttl_s 才有值。
   * null = 无 TTL，单子一直等人裁决（默认，与从前逐字节相同）。 */
  expires_at: a.expires_at_ms ? fmtLocal(new Date(a.expires_at_ms)) : null,
  ttl_s: a.expires_at_ms ? Math.max(0, Math.round((a.expires_at_ms - Date.now()) / 1000)) : null,
  ttl_note: a.expires_at_ms
    ? '这张单带 TTL：到期由服务端自动关闭为 EXPIRED，不需要人动手'
    : '这张单没有 TTL —— 会一直等人裁决，不会自己过期',
  decided_by: a.decided_by || null, decided_at: a.decided_at || null, reason: a.reason || null,
  replay: a.replay_status ? { method: a.method, route: a.route,
    params: JSON.parse(a.params || '{}'),
    status: a.replay_status, body: a.replay_body ? JSON.parse(a.replay_body) : null,
    at: a.replayed_at } : null,
  decide_endpoint: `POST /v1/approvals/${a.id}/decide`
});
/* 数「还挂着几张」之前先扫一遍过期 —— 收口在一个地方，
 * 免得某个读端点忘了扫、把已经不作数的单当成待批给人看。 */
const approvalsPending = () => {
  sweepApprovals();
  return q.one("SELECT COUNT(*) c FROM approvals WHERE status='PENDING'").c;
};

// ─────────────────── 派生读取（不存冗余状态） ───────────────────
const budgetRow  = () => q.one('SELECT limit_cny, used_cny FROM budget WHERE id = 1');
const reservedOf = () => q.one(
  "SELECT COALESCE(SUM(cost),0) AS s FROM actions WHERE status IN ('PENDING_CONFIRMATION','AWAITING_CONDITION')").s;
const budgetView = () => { const b = budgetRow();
  return { limit: b.limit_cny, used: r2(b.used_cny), reserved: r2(reservedOf()) }; };

const RELEASED = { n: 0 };
function sweepLeases() {                       // TTL 到期自动释放 —— 服务端时钟说了算
  const gone = q.all('SELECT shard, holder FROM leases WHERE expires_at_ms <= ?', Date.now());
  if (gone.length) {
    q.run('DELETE FROM leases WHERE expires_at_ms <= ?', Date.now());
    for (const g of gone) log('LEASE', 'act/lease/' + g.shard, '已过期自动释放 · ' + g.holder);
    RELEASED.n += gone.length;
  }
  return gone.length;
}
/* 审批单的 TTL —— 与租约同一个模型：到期由服务端时钟仲裁，不需要人动手。
 * 为什么需要它：没有 TTL，人一忙不过来，单子就永久挂在那里，
 * agent 既推进不了它、也无法确认「它还作不作数」，只能无限等。
 * 只对**提交时带了 TTL 的单**生效；没带的单子行为完全不变（永不过期）。 */
function sweepApprovals() {
  const now = Date.now();
  const gone = q.all("SELECT id FROM approvals WHERE status='PENDING' " +
    'AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?', now);
  if (gone.length) {
    q.run("UPDATE approvals SET status='EXPIRED', decided_at=?, reason=? WHERE status='PENDING' " +
      'AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?',
      nowFull(), 'TTL 到期自动关闭 —— 服务端时钟仲裁，未经人工裁决', now);
    for (const g of gone) log('APPROVAL', 'approvals/' + g.id, '已过期自动关闭 · TTL 到期');
  }
  return gone.length;
}
const leaseView = () => q.all('SELECT * FROM leases ORDER BY shard').map(l => ({
  shard: l.shard, holder: l.holder,
  granted_ttl_s: l.granted_ttl_s,
  ttl_s: Math.max(0, Math.round((l.expires_at_ms - Date.now()) / 1000)),
  acquired_at: l.acquired_at,
  expires_at: fmtLocal(new Date(l.expires_at_ms))
}));
const actionRow = a => ({ id: a.id, kind: a.kind, shard: a.shard, cost: a.cost,
  route: a.route, status: a.status, idem: a.idem, created_at: a.created_at, resolved_at: a.resolved_at });
const decisionRow = d => ({ id: d.id, key: d.key, value: d.value, immutable: !!d.immutable,
  by: d.by, locked_at: d.locked_at, previous_id: d.previous_id || undefined });
function assetsOf() {
  return q.all('SELECT * FROM assets').map(a => ({
    id: a.id, current_version: a.current_version,
    versions: q.all('SELECT v,value,by,at,superseded,note FROM asset_versions WHERE asset_id = ? ORDER BY v', a.id)
      .map(v => ({ ...v, superseded: !!v.superseded }))
  }));
}
const PROFILES = {
  'scribl.v1': { requires: 'auto', checks: [
    { metric: 'bitrate_kbps',    value: 192,        target: '== 192',        verdict: 'PASS' },
    { metric: 'sample_rate_hz',  value: 44100,      target: '== 44100',      verdict: 'PASS' },
    { metric: 'channels',        value: 'joint stereo', target: 'joint stereo', verdict: 'PASS' },
    { metric: 'peak_db',         value: -3.2,       target: '< -3.0',        verdict: 'PASS' },
    { metric: 'rms_db',          value: -21.0,      target: '-23 ~ -18',     verdict: 'PASS' },
    { metric: 'head_silence_s',  value: 0.18,       target: '< 0.25',        verdict: 'PASS' },
    { metric: 'tail_silence_s',  value: 0.31,       target: '< 0.25',        verdict: 'FAIL' },
    { metric: 'duration_s',      value: 338.4,      target: 'within 300~420', verdict: 'PASS' }
  ]}
};

// ───────────────────────────── 端点 ─────────────────────────────
// 全部返回 { status, body }；req = { body, headers, query, rid, params }
const H = {};

H.health = () => ({ status: 200, body: { ok: true, requires: 'auto', data: {
  service: 'agent-console', version: VER, engine: 'node:http + node:sqlite',
  process_model: '队列、锁、门控由本进程持有 —— agent 无法绕过自己做裁判',
  pid: process.pid, port: PORT, uptime_s: Math.round((Date.now() - BOOT_MS) / 1000),
  db_path: DB_PATH, db_bytes: (() => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } })(),
  journal_mode: journalMode,
  endpoints: Object.keys(H).length,
  routes: ROUTES.map(([m, p]) => m + ' ' + p),
  // 契约可导出：agent 可以直接把这份 spec 喂给自家工具调用层，不用读文档
  contract: {
    openapi: '/v1/openapi.json',
    derived_from: 'ROUTES × GATE × META（活元数据，不落盘、不手写）',
    annotates: ['x-gate', 'x-requires', 'x-idempotency']
  },
  // 契约的一部分：客户端可以据此知道哪些端点会被截停，不用靠猜
  gate: {
    policy: [...GATE.entries()].map(([route, v]) => ({ route, level: v.level, why: v.why })),
    human_surface: [...HUMAN_SURFACE],
    decide_endpoint: 'POST /v1/approvals/:id/decide',
    approval_secret_required: !!APR_KEY,
    model: 'gate=授权（你能发起吗） · requires=裁决（结果谁定） · 两者正交'
  },
  counts: {
    decisions: q.one('SELECT COUNT(*) c FROM decisions WHERE superseded_at IS NULL').c,
    actions:   q.one('SELECT COUNT(*) c FROM actions').c,
    leases:    q.one('SELECT COUNT(*) c FROM leases').c,
    audit:     q.one('SELECT COUNT(*) c FROM audit').c,
    approvals_pending: approvalsPending(),
    open_change_requests: q.one("SELECT COUNT(*) c FROM change_requests WHERE status='OPEN'").c
  }
} } });

H.bundle = () => ({ status: 200, body: { ok: true, requires: 'auto', data: {
  budget: budgetView(),
  decisions: q.all('SELECT * FROM decisions WHERE superseded_at IS NULL ORDER BY id').map(decisionRow),
  assets: assetsOf(),
  snapshots: q.all('SELECT * FROM snapshots ORDER BY seq DESC LIMIT 8').reverse(),
  actions: q.all('SELECT * FROM actions ORDER BY rowid DESC LIMIT 30').map(actionRow),
  leases: Object.fromEntries(leaseView().map(l => [l.shard, l])),
  audit: q.all('SELECT ts,at,verb,target,result,rid FROM audit ORDER BY seq DESC LIMIT 20'),
  change_requests: q.all("SELECT * FROM change_requests WHERE status='OPEN' ORDER BY created_at DESC"),
  approvals: (() => {
    sweepApprovals();                            // 先扫过期：「还挂着几张」不能把已到期的算进去
    // 待处理的排在最前，最近裁决过的跟在后面 —— 人需要看到「我批了之后发生了什么」
    const live = q.all("SELECT * FROM approvals WHERE status IN ('PENDING','FAILED') ORDER BY created_at DESC");
    const done = q.all("SELECT * FROM approvals WHERE status IN ('EXECUTED','REJECTED','EXPIRED') " +
      'ORDER BY decided_at DESC LIMIT 3');
    return live.concat(done).map(approvalRow);
  })(),
  approvals_pending: approvalsPending(),
  gate_policy: [...GATE.keys()],
  approval_secret_required: !!APR_KEY,
  derived_at: nowFull()
}, _meta: { note: '一次往返取全 UI 所需状态；省掉 N 次轮询' } } });

// ---- 状态 ----
H.project = () => {
  const snaps = q.all('SELECT * FROM snapshots ORDER BY seq DESC LIMIT 1');
  const head = snaps[0];
  return { status: 200, body: { ok: true, requires: 'auto', data: {
    project_id: 'daisy-chain', title: 'Daisy Chain', locale: 'en-US', status: 'IN_PROGRESS',
    progress: { chapters_total: 5, chapters_locked: 2, current: 'CH03' },
    open_questions: q.one("SELECT COUNT(*) c FROM change_requests WHERE status='OPEN'").c,
    updated_at: head ? head.at : nowFull()
  }, hints: [
    { for: 'agent', action: 'observe', suggest: 'GET /v1/state/checkpoint', why: '先取断点，避免重做已完成片段' },
    { for: 'agent', action: 'observe', suggest: 'GET /v1/act/leases', why: '确认没有其他 agent 正持有你要动的分片' }
  ] } };
};

H.decisionsList = req => {
  const inc = req.query.get('include_superseded') === '1';
  const rows = q.all('SELECT * FROM decisions ' + (inc ? '' : 'WHERE superseded_at IS NULL') + ' ORDER BY id');
  return { status: 200, body: { ok: true, requires: 'auto',
    data: { count: rows.length, decisions: rows.map(decisionRow) },
    _meta: { note: 'immutable=true 的记录不接受 agent 直接覆盖' } } };
};

H.decisionsWrite = req => {
  const b = req.body || {};
  if (!b.key) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 key 与 value' } } };
  const hit = q.one('SELECT * FROM decisions WHERE key = ? AND superseded_at IS NULL', b.key);
  if (hit && hit.immutable) {
    const open = q.one("SELECT * FROM change_requests WHERE target_key = ? AND status='OPEN'", b.key);
    const cr = open || (() => {
      const id = 'CHG-' + hex(6);
      q.run(`INSERT INTO change_requests (id,target_type,target_id,target_key,current_value,proposed,
             requested_by,created_at,status) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, 'decision', hit.id, hit.key, hit.value, String(b.value), 'agent', nowFull(), 'OPEN');
      log('PUT', 'change_requests/' + id, '已受理 · 待人工审批', req.rid);
      return q.one('SELECT * FROM change_requests WHERE id = ?', id);
    })();
    log('PUT', 'decisions/' + b.key, '409 已锁定', req.rid);
    return { status: 409, body: {
      ok: false, requires: 'human',
      error: { code: 'DECISION_LOCKED', message: '该决策已锁定，agent 无权覆盖', existing: decisionRow(hit) },
      change_request: { open: true, created: !open, id: cr.id, endpoint: 'POST /v1/state/change_requests/' + cr.id + '/approve',
        payload: { target_type: 'decision', target_id: hit.id, proposed: b.value, requested_by: 'agent' },
        sla: '等待人工审批，不阻塞其他分片' },
      hints: [
        { for: 'agent', action: 'open_change_request', suggest: 'POST /v1/state/change_requests', why: '锁定项的正确出路是提变更请求，不是绕开或另建副本' },
        { for: 'user', action: 'decide_approval', suggest: `是否批准把 ${hit.key} 改为「${b.value}」`, why: '只堵不疏会逼出重复资产，状态体系反而失守' }
      ] } };
  }
  const id = 'DEC-' + String(q.one('SELECT COUNT(*) c FROM decisions').c + 1).padStart(3, '0');
  const rec = { id, key: b.key, value: b.value, immutable: b.immutable !== false, by: 'agent', locked_at: nowFull() };
  q.run('INSERT INTO decisions (id,key,value,immutable,by,locked_at) VALUES (?,?,?,?,?,?)',
    rec.id, rec.key, rec.value, rec.immutable ? 1 : 0, rec.by, rec.locked_at);
  log('PUT', 'decisions/' + b.key, '201 已锁定', req.rid);
  return { status: 201, body: { ok: true, requires: 'auto', data: rec } };
};

H.changeRequests = req => {
  const st = req.query.get('status');
  const rows = q.all('SELECT * FROM change_requests ' + (st ? 'WHERE status = ?' : '') + ' ORDER BY created_at DESC',
    ...(st ? [st] : []));
  return { status: 200, body: { ok: true, requires: 'auto',
    data: { count: rows.length, open: rows.filter(r => r.status === 'OPEN').length,
      change_requests: rows.map(r => ({ ...r, approve: `POST /v1/state/change_requests/${r.id}/approve` })) },
    _meta: { note: '409 里给出的通路在这里落地 —— 之前那个端点只是承诺，现在是实现' } } };
};

H.changeRequestCreate = req => {
  const b = req.body || {};
  if (!b.target_type || !b.target_id) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 target_type 与 target_id' } } };
  const id = 'CHG-' + hex(6);
  q.run(`INSERT INTO change_requests (id,target_type,target_id,target_key,current_value,proposed,
         requested_by,created_at,status) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, b.target_type, b.target_id, b.target_key || null, b.current_value || null,
    String(b.proposed ?? ''), b.requested_by || 'agent', nowFull(), 'OPEN');
  log('POST', 'change_requests/' + id, '已受理 · 待审批', req.rid);
  return { status: 201, body: { ok: true, requires: 'human',
    data: { id, status: 'OPEN', target_type: b.target_type, target_id: b.target_id, proposed: b.proposed },
    approve: { endpoint: `POST /v1/state/change_requests/${id}/approve`, requires: 'human' },
    hints: [{ for: 'user', action: 'decide_approval', suggest: '审批或驳回；未审批不影响其他分片继续', why: '变更走正式通路，历史版本可回溯' }] } };
};

H.changeRequestApprove = req => {
  const cr = q.one('SELECT * FROM change_requests WHERE id = ?', req.params.id);
  if (!cr) return { status: 404, body: { ok: false, requires: 'agent',
    error: { code: 'CHANGE_REQUEST_NOT_FOUND', message: '没有 ' + req.params.id } } };
  if (cr.status !== 'OPEN') { log('POST', 'change_requests/' + cr.id, '409 状态非法', req.rid);
    return { status: 409, body: { ok: false, requires: 'agent',
      error: { code: 'INVALID_STATE', message: '该请求已是 ' + cr.status } } }; }
  const by = (req.body && req.body.by) || 'user';
  const out = q.tx(() => {
    if (cr.target_type === 'decision') {
      const old = q.one('SELECT * FROM decisions WHERE id = ?', cr.target_id);
      if (!old) throw Object.assign(new Error('目标决策不存在'), { http: 404, code: 'DECISION_NOT_FOUND' });
      q.run('UPDATE decisions SET superseded_at = ? WHERE id = ?', nowFull(), old.id);
      const nid = 'DEC-' + String(q.one('SELECT COUNT(*) c FROM decisions').c + 1).padStart(3, '0');
      q.run('INSERT INTO decisions (id,key,value,immutable,by,locked_at,previous_id) VALUES (?,?,?,?,?,?,?)',
        nid, old.key, cr.proposed, 1, by, nowFull(), old.id);
      return { applied_to: 'decision', superseded: decisionRow(old),
        current: decisionRow(q.one('SELECT * FROM decisions WHERE id = ?', nid)) };
    }
    if (cr.target_type === 'asset') {
      const a = q.one('SELECT * FROM assets WHERE id = ?', cr.target_id);
      if (!a) throw Object.assign(new Error('目标资产不存在'), { http: 404, code: 'ASSET_NOT_FOUND' });
      const nv = a.current_version + 1;
      q.run('UPDATE asset_versions SET superseded = 1 WHERE asset_id = ?', a.id);
      q.run('INSERT INTO asset_versions (asset_id,v,value,by,at,superseded,note) VALUES (?,?,?,?,?,?,?)',
        a.id, nv, cr.proposed, by, nowFull(), 0, '经变更请求 ' + cr.id + ' 批准');
      q.run('UPDATE assets SET current_version = ? WHERE id = ?', nv, a.id);
      return { applied_to: 'asset', asset_id: a.id, new_version: nv };
    }
    throw Object.assign(new Error('不支持的 target_type: ' + cr.target_type),
      { http: 422, code: 'UNSUPPORTED_TARGET' });
  });
  q.run('UPDATE change_requests SET status=?, resolved_at=?, resolved_by=? WHERE id=?', 'APPROVED', nowFull(), by, cr.id);
  log('POST', 'change_requests/' + cr.id + '/approve', '已批准 · ' + by, req.rid);
  return { status: 200, body: { ok: true, requires: 'auto',
    data: { change_request_id: cr.id, status: 'APPROVED', ...out },
    _meta: { note: '变更走正式通路：旧记录 superseded 而不是被改写，可回溯' } } };
};

// ---- 审批（人类表面） ----
H.approvalsList = req => {
  sweepApprovals();                              // 先扫过期再查 —— 免得把刚到期的单当 PENDING 列出来
  const st = req.query.get('status');
  const rows = q.all('SELECT * FROM approvals ' + (st ? 'WHERE status = ?' : '') + ' ORDER BY created_at DESC',
    ...(st ? [st] : []));
  return { status: 200, body: { ok: true, requires: 'auto', data: {
    count: rows.length, pending: approvalsPending(), approvals: rows.map(approvalRow),
    gate_policy: [...GATE.keys()]
  }, hints: [
    { for: 'agent', action: 'observe', suggest: '只读。看到自己的请求挂在这里就说明它没被执行', why: 'agent 可见但不可裁决 —— 可见性不构成权限' },
    { for: 'user', action: 'decide_approval', suggest: '在待审批面板逐条批准或驳回', why: '这是门控端点唯一的执行入口' }
  ], _meta: { note: '挂在 SQLite 里，不是内存队列：两个进程、两个标签页看到的是同一份待批' } } };
};

/* 单查一张 —— agent 手握 approval_id 时的 O(1) 路径。
 * 没有它，agent 想知道「我那张批了没」只能拉全表再自己过滤：
 * 队列一长就是 O(n)，而且把别人的单子也塞进了它的上下文。
 * 注意 requires 的语义：单子还挂着时它返回 human ——「这条谁说了算」是人的；裁决后才转 auto。 */
H.approvalGet = req => {
  sweepApprovals();                              // 先扫过期 —— 单查也得看到最新姿态
  const id = req.params.id;
  const a = q.one('SELECT * FROM approvals WHERE id = ?', id);
  if (!a) return { status: 404, body: { ok: false, requires: 'agent',
    error: { code: 'APPROVAL_NOT_FOUND', message: '没有这张审批单', id },
    hints: [{ for: 'agent', action: 'observe',
      suggest: 'GET /v1/approvals?status=PENDING 列出全部待批单',
      why: '确认 id 有没有写错；也可能这张单已被清理' }] } };
  const pending = a.status === 'PENDING';
  return { status: 200, body: { ok: true, requires: pending ? 'human' : 'auto', data:
    Object.assign(approvalRow(a), {
      pending,
      /* 把「谁该干什么」写成结构化字段，而不是让 agent 从散文里推。
       * 这一条正是 agent-native 与 human-native 的分野。 */
      who_can_advance: pending ? 'human' : 'nobody（已裁决，终态）',
      next_step: pending
        ? { human: `POST /v1/approvals/${id}/decide {decision: approve|reject}`,
            agent: 'wait —— 可见性不构成权限，重发原请求不会推进它' }
        : { settled: true, see: 'replay 字段：批准时服务端已回放原请求，你不必再发一次' }
    }),
    hints: pending
      ? [{ for: 'agent', action: 'wait_for_human',
           suggest: '等待人工裁决。不要轮询，也不要重发原请求',
           why: '唯一能推进它的动作是人 —— 轮询和重发都只会白烧上下文' },
         { for: 'user', action: 'decide_approval', suggest: `批准或驳回 ${id}`,
           why: '这是该端点唯一的执行入口' }]
      : [{ for: 'agent', action: 'observe',
           suggest: '已裁决。读 replay 字段看回放结果，不要重发原请求',
           why: '副作用已经发生过了，再发一次不会让它变成两次' }]
  } };
};

H.approvalDecide = req => {
  // 人类表面。无密钥时依赖「本机单人」这一前提；设了 APPROVAL_SECRET 就是真闸门。
  if (APR_KEY && req.headers['x-approval-secret'] !== APR_KEY) {
    log('POST', 'approvals/' + req.params.id + '/decide', '401 缺少裁决密钥', req.rid);
    return { status: 401, body: { ok: false, requires: 'human',
      error: { code: 'APPROVAL_SECRET_REQUIRED', message: '裁决端点已启用密钥保护',
        hint_header: 'X-Approval-Secret' },
      gate: { approval_secret_required: true,
        why: '未设密钥时，同机任何进程都能裁决 —— 这在单人本机工具里可接受，在多 agent 场景里不可接受' } } };
  }
  sweepApprovals();                              // 先扫过期：已到期的单不该还能被批
  const ap = q.one('SELECT * FROM approvals WHERE id = ?', req.params.id);
  if (!ap) return { status: 404, body: { ok: false, requires: 'agent',
    error: { code: 'APPROVAL_NOT_FOUND', message: '没有 ' + req.params.id } } };

  const b = req.body || {};
  if (b.decision !== 'approve' && b.decision !== 'reject')
    return { status: 400, body: { ok: false, requires: 'agent',
      error: { code: 'INVALID_BODY', message: "decision 必须是 'approve' 或 'reject'" } } };
  const by = b.by || 'user';

  /* 原子占用：一条带条件的 UPDATE 决胜负。
   * 别写成「读到 PENDING → 判断 → 再写」—— 那个窗口里两个进程都会以为自己是第一个，
   * 于是各回放一次。这和幂等是同一个教训：check-then-act 必须合并成单次条件写。
   * WHERE status='PENDING' 让并发的第二方 changes=0 —— 不是靠谁跑得快，是靠存储裁决。 */
  const claim = q.run(
    "UPDATE approvals SET status=?, decided_by=?, decided_at=?, reason=? WHERE id=? AND status='PENDING'",
    b.decision === 'reject' ? 'REJECTED' : 'APPROVED', by, nowFull(), b.reason || null, ap.id);
  if (claim.changes === 0) {
    const cur = q.one('SELECT * FROM approvals WHERE id = ?', ap.id);
    /* 过期是**另一类**终态：不是「谁抢得快」，而是「这单已经不作数了」。
     * 两者给 agent 的下一步不同 —— 过期后若还需要执行，得重新发起请求。 */
    if (cur.status === 'EXPIRED') {
      log('POST', 'approvals/' + ap.id + '/decide', '409 单子已过期（TTL 到期自动关闭）', req.rid);
      return { status: 409, body: { ok: false, requires: 'agent',
        error: { code: 'APPROVAL_EXPIRED',
          message: `该审批单已过期（${cur.decided_at}），从未被裁决，请求未被执行`,
          expired_at: cur.decided_at, reason: cur.reason,
          ttl_note: '提交时带了 approval_ttl_s，到期由服务端自动关闭 —— 不需要人动手，也接不回来' },
        data: approvalRow(cur),
        hints: [{ for: 'agent', action: 'use_alternative',
          suggest: '如需执行，重新发起原请求（会开一张新单，可带更长的 approval_ttl_s）',
          why: '过期是终态：这张单不再可裁决，重发原请求不会复活它，只会开一张新的' }] } };
    }
    log('POST', 'approvals/' + ap.id + '/decide', `409 并发/重复裁决（现状 ${cur.status}）`, req.rid);
    return { status: 409, body: { ok: false, requires: 'agent',
      error: { code: 'ALREADY_DECIDED', message: `该审批单已是 ${cur.status}`, current: cur.status,
        arbitration: '由 approvals 表的条件写裁决（UPDATE ... WHERE status=\'PENDING\'）',
        winner: cur.decided_by, winner_at: cur.decided_at },
      data: approvalRow(cur),
      hints: [{ for: 'agent', action: 'stop_retry', suggest: '不要重复裁决', why: '先到的那次已经产生了副作用，第二次不会再执行' }] } };
  }

  if (b.decision === 'reject') {
    log('POST', 'approvals/' + ap.id + '/decide', '已驳回 · ' + by, req.rid);
    return { status: 200, body: { ok: true, requires: 'auto', data: {
      approval_id: ap.id, status: 'REJECTED', decided_by: by, decided_at: nowFull(),
      side_effects: '无 —— 请求从未被执行，账没动，资产没动' },
      hints: [{ for: 'agent', action: 'stop_retry', suggest: '该路径已被否决，不要原样重发', why: '重发只会再堆一张同样的单子' }],
      _meta: { note: '驳回是零副作用的：被拦下的请求从未进入 handler' } } };
  }

  // 批准 → 服务端取出原请求回放。注意是「回放」，不是「让 agent 再发一次」。
  const tpl = ROUTES.find(([m, p]) => m === ap.method && p === ap.route);
  let out;
  if (!tpl) {
    out = { status: 500, body: { ok: false, requires: 'agent',
      error: { code: 'ROUTE_GONE', message: '原路由已不存在：' + ap.method + ' ' + ap.route } } };
  } else {
    try {
      out = tpl[2]({
        body: ap.body ? JSON.parse(ap.body) : null,
        headers: ap.idem_key ? { 'idempotency-key': ap.idem_key } : {},
        query: new URLSearchParams(),
        rid: genRid(), params: Object.assign({}, JSON.parse(ap.params || '{}')),
        __approved: true, __decided_by: by
      }) || { status: 500, body: { ok: false, requires: 'agent',
        error: { code: 'NO_HANDLER', message: tpl[2].name } } };
    } catch (e) {
      out = { status: e.http || 500, body: { ok: false, requires: 'agent',
        error: { code: e.code || 'REPLAY_FAILED', message: e.message } } };
    }
  }
  const final = out.status >= 200 && out.status < 300 ? 'EXECUTED' : 'FAILED';
  q.run('UPDATE approvals SET status=?, replay_status=?, replay_body=?, replayed_at=? WHERE id=?',
    final, out.status, JSON.stringify(out.body), nowFull(), ap.id);
  log('POST', 'approvals/' + ap.id + '/decide',
    `已批准 · 回放 ${ap.method} ${ap.route} → ${out.status}`, req.rid);
  return { status: 200, body: { ok: true, requires: out.status < 300 ? 'auto' : 'human', data: {
    approval_id: ap.id, status: final, decided_by: by, decided_at: nowFull(),
    fingerprint: ap.fingerprint,
    // 字段名与 approvalRow.replay 保持一致（结构也同形）——
    // 同一个概念只有一个名字，且只在一个地方定义形状。agent 不必猜。
    replay: { method: ap.method, route: ap.route, params: JSON.parse(ap.params || '{}'),
      status: out.status, body: out.body, at: nowFull() } },
    _meta: { note: '执行发生在批准这一步，由服务端回放原始请求 —— agent 从未拿到直接执行的路径' } } };
};

H.checkpoint = () => {
  const head = q.all('SELECT * FROM snapshots ORDER BY seq DESC LIMIT 1')[0];
  const recent = q.all('SELECT * FROM snapshots ORDER BY seq DESC LIMIT 5').reverse();
  // 机器可读的完成清单：从 snapshots 里 result=PASS 的分片派生。
  // 为什么不是只给「next.reason」那种散文：agent 无法可靠 parse「S01–S03 已通过」，
  // 续跑时要么全部重做要么全部跳过。给出数组，agent 就能 filter 出还差哪几片。
  const completed = q.all("SELECT DISTINCT shard FROM snapshots WHERE result = 'PASS' AND shard IS NOT NULL ORDER BY shard").map(r => r.shard);
  const short = completed.map(s => String(s).replace(/^.*_/, ''));
  return { status: 200, body: { ok: true, requires: 'auto', data: {
    snapshot_head: head ? head.id : null,
    last_atomic_action: head ? { action: head.action, shard: head.shard, result: head.result, at: head.at } : null,
    // 结构化进度：completed_shards 是机器可读源；next.reason 只是它的散文解释。
    completed_shards: completed,
    next: { shard: 'CH03_S04', reason: short.length ? `${short.join('、')} 已通过，S04 未开始` : '尚未开始' },
    open_exceptions: [{ shard: 'CH03_S02', issue: 'tail_silence 0.31s > 0.25s', requires: 'auto',
      remedy: '规则内可修：裁到 0.20s' }],
    recent_snapshots: recent,
    source: 'sqlite:' + path.basename(DB_PATH)
  }, _meta: { note: '断点跟着原子动作走，不跟着计划走 —— 中途改大纲也不会指向失效断点。completed_shards 从 snapshots 派生，next.reason 只是它的散文解释。' } } };
};

H.assetsGet = () => ({ status: 200, body: { ok: true, requires: 'auto',
  data: { count: q.one('SELECT COUNT(*) c FROM assets').c, assets: assetsOf() },
  hints: [{ for: 'agent', action: 'use_alternative', suggest: 'PUT /v1/state/assets',
    why: '需要变更时开新版本，不要试图修改历史版本' }] } });

H.assetsPut = req => {
  const b = req.body || {};
  if (!b.asset_id) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 asset_id 与 value' } } };
  const a = q.one('SELECT * FROM assets WHERE id = ?', b.asset_id);
  if (!a) return { status: 404, body: { ok: false, requires: 'agent',
    error: { code: 'ASSET_NOT_FOUND', message: '没有资产 ' + b.asset_id } } };
  if (b.target_version !== undefined && b.target_version !== null) {
    const tv = q.one('SELECT * FROM asset_versions WHERE asset_id = ? AND v = ?', a.id, b.target_version);
    log('PUT', `assets/${a.id}/v${b.target_version}`, '409 版本不可变', req.rid);
    return { status: 409, body: { ok: false, requires: 'human',
      error: { code: 'VERSION_IMMUTABLE', message: `版本 v${b.target_version} 已提交，永久不可修改`, target: tv },
      hints: [{ for: 'agent', action: 'use_alternative', suggest: '去掉 target_version 重新提交',
        why: '变更 = 开新版本；历史版本留着做回溯和断点续跑' }] } };
  }
  const nv = q.one('SELECT COALESCE(MAX(v),0) m FROM asset_versions WHERE asset_id = ?', a.id).m + 1;
  q.tx(() => {
    q.run('UPDATE asset_versions SET superseded = 1 WHERE asset_id = ?', a.id);
    q.run('INSERT INTO asset_versions (asset_id,v,value,by,at,superseded,note) VALUES (?,?,?,?,?,?,?)',
      a.id, nv, b.value, 'agent', nowFull(), 0, b.note || '');
    q.run('UPDATE assets SET current_version = ? WHERE id = ?', nv, a.id);
  });
  log('PUT', `assets/${a.id}/v${nv}`, '201 已开新版本', req.rid);
  return { status: 201, body: { ok: true, requires: 'auto', data: {
    asset_id: a.id, new_version: nv, value: b.value,
    previous_versions_kept: q.one('SELECT COUNT(*) c FROM asset_versions WHERE asset_id = ?', a.id).c - 1
  }, hints: [{ for: 'agent', action: 'use_alternative', suggest: '旧版本仍可回滚：由状态引用切回 v1',
    why: '约束与变更兼得，不必绕开锁定' }], _meta: { note: '锁的是版本，不是资产本身' } } };
};

// ---- 感官 ----
H.measure = req => {
  const p = PROFILES[(req.body && req.body.profile)] || PROFILES['scribl.v1'];
  const fails = p.checks.filter(c => c.verdict === 'FAIL');
  log('POST', 'senses/measure', fails.length ? 'FAIL' : 'PASS', req.rid);
  return { status: 200, body: { ok: true, requires: p.requires, data: {
    artifact: (req.body && req.body.artifact) || 'unknown',
    profile: (req.body && req.body.profile) || 'scribl.v1',
    verdict: fails.length ? 'FAIL' : 'PASS', checks: p.checks,
    failed_metrics: fails.map(c => c.metric),
    coverage: { automated: ['格式','码率','峰值','RMS','静音时长'],
      not_covered: ['情绪','语义连贯','风格统一'] }
  }, hints: fails.length ? [
    { for: 'agent', action: 'use_alternative', suggest: '规则内可修 → 本地剪辑后复测，无需唤醒决策层', why: 'tail_silence 属于规则化可判定项' },
    { for: 'agent', action: 'use_alternative', suggest: '若修复策略超出既定规则 → POST /v1/senses/judge', why: '越界异常不要猜，升级比乱改便宜' }
  ] : [], _meta: { note: 'requires=auto 表示此项无需人工介入；not_covered 诚实标注能力边界' } } };
};

H.transcribe = req => ({ status: 200, body: { ok: true, requires: 'auto', data: {
  artifact: (req.body && req.body.artifact) || 'unknown',
  language: (req.body && req.body.language) || 'en-US', word_count: 2847,
  segments: [
    { i:0, start:'00:00.00', end:'00:04.82', speaker:'narrator', text:'The letter arrived on a Tuesday, which was itself a kind of warning.', conf:0.94 },
    { i:1, start:'00:04.82', end:'00:09.31', speaker:'narrator', text:'Nobody in Bellflower sent letters on a Tuesday.', conf:0.96 },
    { i:2, start:'00:09.31', end:'00:13.77', speaker:'mara',     text:"You're telling me the postman waited.", conf:0.91 },
    { i:3, start:'00:13.77', end:'00:18.05', speaker:'narrator', text:'He had. For forty minutes, in the rain, without knocking twice.', conf:0.88 }
  ], truncated: true
}, _meta: { note: 'truncated=true：需要更多请带 offset，别一次全取' } } });

H.judge = req => {
  const b = req.body || {}, kind = b.kind || 'semantic', isRule = kind === 'rule';
  log('POST', 'senses/judge', isRule ? '自动判定' : '已升级', req.rid);
  if (isRule) return { status: 200, body: { ok: true, requires: 'auto', data: {
    subject: b.subject || '-', question: b.question || '-', kind,
    verdict: 'PASS', escalated: false, decided_by: 'rules' } } };
  return { status: 200, body: { ok: true, requires: 'human_or_llm', data: {
    subject: b.subject || '-', question: b.question || '-', kind,
    verdict: 'UNDETERMINED', escalated: true, decided_by: null, queued_as: 'APPROVAL',
    auto_checks: [{ name:'duration_in_range', verdict:'PASS' }, { name:'loudness_match_prev', verdict:'PASS' }],
    not_automatable: [
      { name:'emotional_continuity', why:'需要理解 CH02 结尾的语境' },
      { name:'style_consistency',    why:'无客观阈值可定义' }
    ] }, hints: [
    { for: 'user', action: 'provide_input', suggest: '审听 CH03_S04，与 CH02 结尾对照判断情绪连贯', why: '此类判定无法规则化，接口不假装能自动给出答案' },
    { for: 'agent', action: 'continue_other_shards', suggest: '挂起该分片，继续处理未阻塞的其他分片', why: '升级不等于全局阻塞' }
  ], _meta: { note: '诚实标注能力边界：能自动的自动，不能自动的明确升级' } } };
};

H.diff = req => ({ status: 200, body: { ok: true, requires: 'auto', data: {
  from: req.query.get('from') || 'v11', to: req.query.get('to') || 'v12',
  changed_count: 3, unchanged_count: 1847,
  changed: [
    { field:'chapters[2].title', before:'The Third Loop', after:'Before the Loop' },
    { field:'chapters[2].scenes[3].lines[11].text', before:'You told me first.', after:'You told me before I asked.' },
    { field:'metadata.updated_at', before:'2026-10-02 18:22:11', after:'2026-10-03 15:04:52' }
  ] }, _meta: { note: '1847 项未变，已折叠' } } });

// ---- 行动 ----

/* ── 可选幂等（x-idempotency=optional）──
 * 与 act/queue 的 required 只差一条：**带不带键都行**。
 *   带了 Idempotency-Key → 同键重发返回首次响应，不产生第二次副作用；
 *   不带               → 行为与从前逐字节相同（不多一个字段、不多一次查询）。
 *
 * 为什么要有它：15 个写端点此前是 not_enforced —— 契约如实承认「没有保护」，
 * 但承认缺口不等于 agent 有办法自保。给一个**可选**的键：想要确定性时自己带上，
 * 不想要时代码一行都不用改。
 *
 * 物理保证仍然是 PRIMARY KEY(idem_keys.key)，不是应用层 if：谁抢到占位谁执行。
 * 抢不到且首次响应还没写回 → 409 IDEMPOTENCY_KEY_CONFLICT，让调用方稍后重发，
 * 而不是「重复执行一遍再假装没事」。 */
const idemClaim = (method, routeKey, req) => {
  const key = req.idemKey;
  if (!key || method === 'GET') return null;             // 没带键 = 不受任何约束（这正是「可选」）
  /* required 档的端点（act/queue）自己管幂等：它在 handler 里做「必带键校验 + 事务抢占 + 按 payload 重建响应」。
   * 中间件若也插一脚，会先占掉那个键，handler 再查表就撞上自己插的占位行 —— 读 payload 得 null，直接 500。
   * 一档只由一处实现：两个地方实现同一个保证，就是两个地方都能出错。 */
  if (META[routeKey] && META[routeKey].idem) return null;
  const seen = q.one('SELECT * FROM idem_keys WHERE key = ?', key);
  if (seen) {
    if (seen.route && seen.route !== routeKey)
      return { status: 409, body: { ok: false, requires: 'agent',
        error: { code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: `该 Idempotency-Key 已用于 ${seen.route}，不能跨端点复用`,
          used_by: seen.route, this_route: routeKey, first_seen_at: seen.created_at },
        hints: [{ for: 'agent', action: 'use_alternative',
          suggest: '换一个 Idempotency-Key，或回到原端点重发',
          why: '一个键代表同一件事；跨端点复用会让重放把 A 的响应回给 B' }] } };
    if (seen.response) {                                  // 执行过 → 重放首次响应
      q.run('UPDATE idem_keys SET hits = hits + 1 WHERE key = ?', key);
      const hits = q.one('SELECT hits FROM idem_keys WHERE key = ?', key).hits;
      const stored = JSON.parse(seen.response);
      log(method, routeKey, '幂等重放（optional）', req.rid);
      return { status: stored.status,
        body: Object.assign({}, stored.body, { replayed: true,
          idempotency: { key, scope: 'optional', storage_constraint: 'PRIMARY KEY(idem_keys.key)',
            behaviour: 'first_response_returned', hits, first_seen_at: seen.created_at,
            note: '只有带了 Idempotency-Key 的写请求才受此约束 —— 这是可选保障，不是默认行为' } }) };
    }
    return { status: 409, body: { ok: false, requires: 'agent',      // 已抢位、首次响应尚未写回
      error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: '同键的首次请求仍在处理中',
        state: 'in_flight', key, route: routeKey },
      hints: [{ for: 'agent', action: 'observe',
        suggest: '稍后用同一个键重发 —— 拿到的是首次响应，不会重复执行',
        why: '幂等键此刻被另一个请求持有；重发安全，重复执行不安全' }] } };
  }
  const claim = q.run('INSERT OR IGNORE INTO idem_keys ' +
    '(key, action_id, payload, created_at, hits, route, response) VALUES (?,?,?,?,0,?,NULL)',
    key, null, null, nowFull(), routeKey);
  if (claim.changes === 0) {                              // 极小窗口的竞态：让调用方重发（带键重发是安全的）
    return { status: 409, body: { ok: false, requires: 'agent',
      error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: '同键的另一请求刚刚抢先登记',
        state: 'race', key },
      hints: [{ for: 'agent', action: 'observe', suggest: '重发同一个请求即可拿到首次响应',
        why: '竞态只会发生一次；带键重发不会重复执行' }] } };
  }
  req.__idemClaimed = true;
  return null;
};

/* 执行完成后把首次响应整份落盘，下次同键直接重放它。
 * 刻意在 finish() **之前**调用：此刻 body 里还没有 _meta（request_id / latency），
 * 那些属于传输层，不该被当成「首次响应」缓存 —— 否则重放的响应会带着
 * 上一次的 request_id 冒充这一次。 */
const idemSettle = (routeKey, req, out) => {
  if (!req.__idemClaimed || !out || out.raw) return;
  if (out.status >= 500) {                                // 服务端错误不固化，删掉占位让重试有意义
    q.run('DELETE FROM idem_keys WHERE key = ? AND response IS NULL', req.idemKey);
    return;
  }
  q.run('UPDATE idem_keys SET response = ? WHERE key = ? AND response IS NULL',
    JSON.stringify({ status: out.status, body: out.body }), req.idemKey);
  log(routeKey.split(' ')[0], routeKey, '已登记幂等键（optional）', req.rid);
};

/* handler 抛异常：撤掉占位，否则这个键会永久停在 in_flight */
const idemAbort = (req) => {
  if (req.__idemClaimed) q.run('DELETE FROM idem_keys WHERE key = ? AND response IS NULL', req.idemKey);
};

H.queue = req => {
  const key = req.headers['idempotency-key'];
  if (!key) { log('POST', 'act/queue', '400 缺幂等键', req.rid);
    return { status: 400, body: { ok: false, requires: 'agent',
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写操作必须携带 Idempotency-Key' },
      hints: [{ for: 'agent', action: 'retry_with_idempotency_key', suggest: '重试并附带 Header: Idempotency-Key',
        why: '幂等键是存储层唯一约束的入口，不是可选项' }] } }; }

  const seen = q.one('SELECT * FROM idem_keys WHERE key = ?', key);
  if (seen) {                                     // 重放：返回首次响应载荷
    const p = JSON.parse(seen.payload);
    q.run('UPDATE idem_keys SET hits = hits + 1 WHERE key = ?', key);
    const hits = q.one('SELECT hits FROM idem_keys WHERE key = ?', key).hits;
    log('POST', 'act/queue', '幂等重放', req.rid);
    return { status: 200, body: { ok: true, replayed: true, requires: 'auto',
      data: { id: p.action_id, action_id: p.action_id, status: p.status, cost_cny: p.cost },
      idempotency: { key, storage_constraint: 'PRIMARY KEY(idem_keys.key)', behaviour: 'first_response_returned',
        hits, first_seen_at: seen.created_at },
      hints: [{ for: 'agent', action: 'stop_retry', suggest: '该动作已在队列中，不要轮询', why: '重发已生效，未产生第二次副作用' }] } };
  }

  const b = req.body || {}, cost = Number(b.cost_cny) || 0;
  const bv = budgetView(), spent = bv.used + bv.reserved;
  if (cost > 0 && spent + cost > bv.limit) {      // 闸门在服务端，agent 无法自行绕过
    log('POST', 'act/queue', '402 超预算', req.rid);
    return { status: 402, body: { ok: false, requires: 'human',
      error: { code: 'BUDGET_EXCEEDED', message: '超出本月预算上限，动作未入队',
        budget: { limit_cny: bv.limit, used_cny: r2(spent), requested_cny: cost, over_by: r2(spent + cost - bv.limit) } },
      hints: [{ for: 'user', action: 'raise_limit', suggest: '提高上限，或改为本地剪辑修复',
        why: '闸门在存储与网关层，agent 无法自行绕过' }] } };
  }

  const route = b.route || 'approve';
  if (route === 'auto' && cost > 0) { log('POST', 'act/queue', '422 路由冲突', req.rid);
    return { status: 422, body: { ok: false, requires: 'agent',
      error: { code: 'ROUTE_CONFLICT', message: 'route=auto 不允许花钱动作', route, cost_cny: cost },
      hints: [{ for: 'agent', action: 'use_alternative', suggest: '改为 route:approve', why: '自动队列只放行零成本、幂等、规则内的动作' }] } }; }

  const id = 'act_' + hex(6);
  const status = route === 'auto' ? 'EXECUTED' : route === 'conditional' ? 'AWAITING_CONDITION' : 'PENDING_CONFIRMATION';
  const rec = { id, kind: b.kind || 'unknown', shard: b.shard || '-', cost, route, status };
  let dup = false;
  try {
    q.tx(() => {                                  // 并发同键：第二个必撞 UNIQUE，落进 catch
      q.run('INSERT INTO actions (id,kind,shard,cost,route,status,idem,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, rec.kind, rec.shard, cost, route, status, key, nowFull());
      q.run('INSERT INTO idem_keys (key, action_id, payload, created_at, hits) VALUES (?,?,?,?,0)',
        key, id, JSON.stringify({ action_id: id, status, cost }), nowFull());
      const sn = nextSnap();
      q.run('INSERT INTO snapshots (id,at,action,shard,result,seq) VALUES (?,?,?,?,?,?)',
        'snap_' + String(sn).padStart(4, '0'), nowFull(), rec.kind, rec.shard, status, sn);
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) dup = true; else throw e;
  }
  if (dup) {
    const s = q.one('SELECT * FROM idem_keys WHERE key = ?', key);
    const p = JSON.parse(s.payload);
    log('POST', 'act/queue', '并发同键 · 返回首次响应', req.rid);
    return { status: 200, body: { ok: true, replayed: true, requires: 'auto',
      data: { id: p.action_id, action_id: p.action_id, status: p.status, cost_cny: p.cost },
      idempotency: { key, storage_constraint: 'PRIMARY KEY(idem_keys.key)', behaviour: 'first_response_returned',
        race:'lost', first_seen_at: s.created_at },
      hints: [{ for: 'agent', action: 'stop_retry', suggest: '该动作已在队列中，不要轮询', why: '并发下只有一次副作用生效' }] } };
  }
  log('POST', 'act/queue', route + ' → ' + status, req.rid);
  return { status: 201, body: { ok: true, requires: route === 'auto' ? 'auto' : 'human',
    data: { ...rec, action_id: id, idem: key, created_at: nowFull() },
    routing: { route, why: route === 'auto' ? '零成本 + 幂等 + 规则内'
      : route === 'conditional' ? '等待条件满足' : '涉及成本，必须人工放行' },
    gate: { policy: 'confirm-before-call', reason: 'cost > 0',
      next: `POST /v1/act/${id}/confirm`,
      next_is_gated: true, next_requires: 'approval',
      next_note: '确认端点本身也在门控内 —— 你去调它只会得到 403 并把请求挂到待审批；真正执行它的是人的批准',
      enforced_in: 'server process（网关层，不是提示词）' },
    hints: [
      { for: 'agent', action: 'stop_retry', suggest: '不要轮询，继续处理其他未阻塞分片', why: '轮询浪费上下文且不会加速' },
      { for: 'agent', action: 'claim_lease', suggest: 'POST /v1/act/lease 先占住该分片', why: '避免其他 agent 同时动手' }
    ] } };
};

H.confirm = req => {
  const id = req.params.id || (req.body && req.body.action_id);
  if (!id) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 action_id（路径或 body）' } } };
  const a = q.one('SELECT * FROM actions WHERE id = ?', id);
  if (!a) return { status: 404, body: { ok: false, requires: 'agent',
    error: { code: 'ACTION_NOT_FOUND', message: '队列中没有 ' + id } } };
  /* 条件写：「检查状态 + 改状态 + 扣款」压成事务里的一条 UPDATE。
   * 写成「读到 PENDING_CONFIRMATION → 判断 → 再写」，两个进程会同时通过判断然后各扣一次。
   * 判据是 changes（存储说了算），不是内存里刚读到的那个值。 */
  const won = q.tx(() => {
    const r = q.run("UPDATE actions SET status='EXECUTED', resolved_at=? WHERE id=? AND status='PENDING_CONFIRMATION'",
      nowFull(), id);
    if (r.changes === 0) return false;
    q.run('UPDATE budget SET used_cny = used_cny + ? WHERE id = 1', a.cost);
    return true;
  });
  if (!won) { const cur = q.one('SELECT status FROM actions WHERE id = ?', id);
    log('POST', `act/${id}/confirm`, '409 状态非法（并发或重复）', req.rid);
    return { status: 409, body: { ok: false, requires: 'agent',
      error: { code: 'INVALID_STATE', message: `当前状态 ${cur.status} 不可确认`, current: cur.status,
        arbitration: "条件写 UPDATE ... WHERE status='PENDING_CONFIRMATION'" } } }; }
  log('POST', `act/${id}/confirm`, `已执行 · ¥${a.cost.toFixed(2)}`, req.rid);
  return { status: 200, body: { ok: true, requires: 'auto',
    data: actionRow(q.one('SELECT * FROM actions WHERE id = ?', id)),
    budget: budgetView(), _meta: { note: '已扣除预算并写入审计' } } };
};

H.rollback = req => {
  const id = req.params.id || (req.body && req.body.action_id);
  if (!id) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 action_id（路径或 body）' } } };
  const a = q.one('SELECT * FROM actions WHERE id = ?', id);
  if (!a) return { status: 404, body: { ok: false, requires: 'agent',
    error: { code: 'ACTION_NOT_FOUND', message: '队列中没有 ' + id } } };
  const won = q.tx(() => {                       // 同上：条件写，防跨进程双退款
    const r = q.run("UPDATE actions SET status='ROLLED_BACK', resolved_at=? WHERE id=? AND status='EXECUTED'",
      nowFull(), id);
    if (r.changes === 0) return false;
    q.run('UPDATE budget SET used_cny = MAX(0, used_cny - ?) WHERE id = 1', a.cost);
    return true;
  });
  if (!won) { const cur = q.one('SELECT status FROM actions WHERE id = ?', id);
    log('POST', `act/${id}/rollback`, '409 状态非法（并发或重复）', req.rid);
    return { status: 409, body: { ok: false, requires: 'agent',
      error: { code: 'INVALID_STATE', message: '只有 EXECUTED 可回滚', current: cur.status,
        arbitration: "条件写 UPDATE ... WHERE status='EXECUTED'" } } }; }
  log('POST', `act/${id}/rollback`, `已回滚 · 退还 ¥${a.cost.toFixed(2)}`, req.rid);
  return { status: 200, body: { ok: true, requires: 'auto',
    data: actionRow(q.one('SELECT * FROM actions WHERE id = ?', id)),
    compensation: { refunded_cny: a.cost, artifacts_deleted: 1 }, budget: budgetView() } };
};

H.lease = req => {
  const b = req.body || {}; sweepLeases();
  if (!b.shard || !b.holder) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 shard 与 holder' } } };
  const held = q.one('SELECT * FROM leases WHERE shard = ?', b.shard);
  if (held && held.holder !== b.holder) {
    log('POST', 'act/lease/' + b.shard, `409 已被 ${held.holder} 持有`, req.rid);
    const nextShard = b.shard.replace(/(\d+)$/, m => String(+m + 1).padStart(m.length, '0'));
    return { status: 409, body: { ok: false, requires: 'agent',
      error: { code: 'SHARD_LOCKED', message: `分片 ${b.shard} 已被持有`,
        holder_at_fault: held.holder,
        expires_at: fmtLocal(new Date(held.expires_at_ms)),
        ttl_s: Math.max(0, Math.round((held.expires_at_ms - Date.now()) / 1000)) },
      arbitration: { by: 'server', sqlite_file: path.basename(DB_PATH),
        why: '锁由本进程的表持有，agent 无法自行绕过' },
      hints: [
        { for: 'agent', action: 'use_alternative', suggest: '改领空闲分片，例如 ' + nextShard, why: '并行靠分片，不靠抢占' },
        { for: 'agent', action: 'observe', suggest: 'GET /v1/act/leases 查看哪些片空闲', why: '先看再动，别撞' }
      ], _meta: { note: '锁粒度=原子任务片；同章节的不同片之间不冲突' } } };
  }
  const renewed = !!held, ttl = b.ttl_s || 300;
  const exp = Date.now() + ttl * 1000;
  q.run(`INSERT INTO leases (shard,holder,granted_ttl_s,acquired_at,expires_at_ms) VALUES (?,?,?,?,?)
         ON CONFLICT(shard) DO UPDATE SET holder=excluded.holder, granted_ttl_s=excluded.granted_ttl_s,
         acquired_at=excluded.acquired_at, expires_at_ms=excluded.expires_at_ms`,
    b.shard, b.holder, ttl, nowFull(), exp);
  log('POST', 'act/lease/' + b.shard, renewed ? '续约' : '已获取 · ' + b.holder, req.rid);
  const rec = leaseView().find(l => l.shard === b.shard);
  return { status: 200, body: { ok: true, requires: 'auto', data: rec, renewed,
    concurrency: { note: '同一分片同一时间只有一个持有者；不同分片可并行',
      active_leases: leaseView().length, expires_in_s: ttl,
      auto_release: '服务端 TTL 到期自动释放，崩溃的 agent 不会永久占锁' } } };
};

H.leases = () => { const freed = sweepLeases();
  return { status: 200, body: { ok: true, requires: 'auto',
    data: { count: leaseView().length, leases: leaseView(), expired_released_now: freed },
    _meta: { note: '细粒度锁让 N 个 agent 各领一片，而不是排队等整个章节' } } }; };

H.audit = req => {
  const lim = Math.min(Number(req.query.get('limit')) || 50, 200);
  const rows = q.all('SELECT ts,at,verb,target,result,rid FROM audit ORDER BY seq DESC LIMIT ?', lim);
  return { status: 200, body: { ok: true, requires: 'auto',
    data: { count: rows.length, total: q.one('SELECT COUNT(*) c FROM audit').c, entries: rows } } };
};

// ---- 演示专用（DEMO=0 可关闭） ----
H.demoBudget = req => { const used = Number((req.body && req.body.used)); 
  if (!Number.isFinite(used)) return { status: 400, body: { ok: false, requires: 'agent',
    error: { code: 'INVALID_BODY', message: '需要 body.used 为数字' } } };
  q.run('UPDATE budget SET used_cny = ? WHERE id = 1', used);
  log('DEMO', 'budget', `已用调整为 ¥${used.toFixed(2)}`);
  return { status: 200, body: { ok: true, requires: 'auto', data: budgetView() } }; };
H.demoReset = () => { seed(); return { status: 200, body: { ok: true, requires: 'auto',
  data: { reset: true, at: nowFull() } } }; };

// ────────────────── 契约导出：OpenAPI 从活元数据派生 ──────────────────
/* 为什么不做成一份手写的 openapi.yaml：
 * 手写的契约会漂移 —— 加了路由它不知道，改了闸门它不知道，两个月后它就在撒谎。
 * 这里改成从三份**活**数据派生：
 *     ROUTES（结构：方法 / 路径 / 路径参数）
 *   × GATE  （授权：哪些端点会被截停、为什么）
 *   × META  （语义：一句话说明 / 结果谁定 / 幂等强度 / 示例 body）
 * 于是 spec 不可能与正在跑的服务不一致 —— 它就是那份路由表本身。
 * 而且 META 漏登记不会静默：x-agent-console.meta_coverage.missing 会把它点出来。 */

const G_INFRA = '基础 INFRA', G_STATE = '状态 STATE', G_SENSES = '感官 SENSES',
      G_ACT = '行动 ACT', G_APPROVALS = '审批 APPROVALS', G_DEMO = '演示 DEMO';
const OPENAPI_TAGS = [G_INFRA, G_STATE, G_SENSES, G_ACT, G_APPROVALS, G_DEMO];

const qp = (name, description) => ({ name, in: 'query', required: false,
  schema: { type: 'string' }, description });

const META = {
  'GET /v1/health': { group: G_INFRA, requires: 'auto',
    summary: '存活探测 + 契约声明：路由表、门控策略、裁决密钥状态。客户端据此判断是否需要门控，不必靠猜。' },
  'GET /v1/state/bundle': { group: G_INFRA, requires: 'auto',
    summary: '一次往返取回整个 UI 所需状态（预算/决策/资产/快照/队列/租约/审计/待批）。给人看的接口，不是给 agent 的。' },

  'GET /v1/state/project': { group: G_STATE, requires: 'auto',
    summary: '项目快照、进度、未决问题。响应固定含 hints[]。' },
  'GET /v1/state/decisions': { group: G_STATE, requires: 'auto', query: [qp('include_superseded', '传 1 时连历史版本一起返回')],
    summary: 'immutable 决策记录。agent 读到后不得自行改写。' },
  'PUT /v1/state/decisions': { group: G_STATE, requires: 'auto',
    example: { key: 'scene.pov', value: 'third person, close', immutable: true },
    summary: '写决策。键已存在且 immutable → 409 DECISION_LOCKED，且响应同时给出 change_request 通路（只堵不疏会让人绕开锁定）。' },
  'GET /v1/state/checkpoint': { group: G_STATE, requires: 'auto',
    summary: '断点续跑位置。断点由原子动作完成时自动推进，不依赖人工预定义章节边界。' },
  'GET /v1/state/assets': { group: G_STATE, requires: 'auto',
    summary: '资产及全部历史版本。旧版本不删除，用于回溯与断点续跑。' },
  'PUT /v1/state/assets': { group: G_STATE, requires: 'auto',
    example: { asset_id: 'voice.lead.ref', value: 'female, warm, breathy, mid-30s', note: '客户要求气声更明显' },
    summary: '默认基于当前版本开新版本；显式指定 target_version 改历史版本 → 409 VERSION_IMMUTABLE。锁的是版本，不是资产。' },
  'GET /v1/state/change_requests': { group: G_STATE, requires: 'auto', query: [qp('status', '按状态过滤，如 OPEN')],
    summary: '变更请求清单。' },
  'POST /v1/state/change_requests': { group: G_STATE, requires: 'auto', ok: 201,
    example: { target_type: 'decision', target_id: 'DEC-002', proposed: 'female, warm, breathy', requested_by: 'agent' },
    summary: 'agent 想改锁定项时的正式入口，返回 approve 端点。通常不必手调：PUT 撞锁时会自动替你开一条。' },
  'POST /v1/state/change_requests/:id/approve': { group: G_STATE, requires: 'human',
    example: { by: 'user' },
    summary: '人类批准变更：旧记录标 superseded、新记录链上 previous_id（不是原地改写不可变记录）。批准后 requires 从 human 降回 auto。' },

  // requires 是**数组**：列出这个端点【可能返回】的全部 requires 值。
  // 运行时响应里的 requires 一定是其中之一（不是复合字符串，agent 可以直接 includes 判定）。
  'POST /v1/senses/measure': { group: G_SENSES, requires: ['auto', 'human'],
    example: { artifact: 'CH02_final_192k.mp3', profile: 'scribl.v1' },
    summary: '规则化客观检测。顶层 requires 标明结果谁定：auto 可自行判定，human / llm 必须升级。coverage.not_covered 显式列出判不了的维度。' },
  'POST /v1/senses/transcribe': { group: G_SENSES, requires: 'auto',
    example: { artifact: 'CH03_S04.wav', language: 'en-US', diarize: true },
    summary: 'ASR 转写，返回带时间轴的 segments[]，供 agent 定位问题片段。' },
  'POST /v1/senses/judge': { group: G_SENSES, requires: 'human_or_llm',
    example: { subject: 'CH03_S04', question: '情绪是否与 CH02 结尾连贯', kind: 'semantic' },
    summary: '语义判定专用端点。判不了的部分显式返回 requires=human_or_llm 并升级，而不是假装能判。' },
  'GET /v1/senses/diff': { group: G_SENSES, requires: 'auto', query: [qp('from', '起始版本，默认 v11'), qp('to', '目标版本，默认 v12')],
    summary: '只返回变化的字段，unchanged_count 汇总未变项。' },

  'POST /v1/act/queue': { group: G_ACT, requires: ['auto', 'human'], idem: true, ok: 201,
    example: { kind: 'tts.seed_audio', shard: 'CH03_S04', cost_cny: 0.42, route: 'approve' },
    summary: '入队。Header 必带 Idempotency-Key。route 三选一：auto 直接执行 / approve 挂起等批 / conditional 条件触发。route=auto 带成本 → 422 ROUTE_CONFLICT。' },
  'POST /v1/act/lease': { group: G_ACT, requires: 'auto',
    example: { shard: 'CH03_S04', holder: 'agent-A', ttl_s: 300 },
    summary: '分片租约。锁的粒度是原子任务片，不是整个章节。同片被占 → 409 SHARD_LOCKED；不同片可并行。' },
  'GET /v1/act/leases': { group: G_ACT, requires: 'auto', summary: '活跃租约及剩余 TTL（TTL 由服务端时钟仲裁）。' },
  'POST /v1/act/:id/confirm': { group: G_ACT, requires: 'human',
    example: { action_id: '', approval_ttl_s: 3600 },
    summary: '把 PENDING_CONFIRMATION 推进为 EXECUTED。此端点被网关门控：agent 直接调只会拿到 403 + 一张待审批单。body 可带 approval_ttl_s 给这张待批单设自过期时间（不带 = 永不过期，等人工）。' },
  'POST /v1/act/:id/rollback': { group: G_ACT, requires: 'auto',
    example: { action_id: '' },
    summary: '把已执行动作标为 ROLLED_BACK，退回预算并记录补偿。刻意不上闸门 —— 出错时再设障碍是帮倒忙。' },
  'GET /v1/audit': { group: G_ACT, requires: 'auto', query: [qp('limit', '返回条数，默认 50，上限 200')],
    summary: 'actor / verb / target / result / request_id 时间线。' },

  'GET /v1/approvals': { group: G_APPROVALS, requires: 'auto',
    query: [qp('status', 'PENDING / EXECUTED / REJECTED / FAILED / EXPIRED')],
    summary: '被网关拦下的请求清单。agent 可读、不可裁决 —— 可见性不构成权限。读取会先扫一遍到期单（到期的转成 EXPIRED）。' },
  'GET /v1/approvals/:id': { group: G_APPROVALS, requires: 'human_or_llm', ok: 200,
    summary: '单查一张审批单。agent 手握 approval_id 时的 O(1) 路径 —— 不必拉全表再自己过滤。requires 会随状态变：还挂着时是 human（谁说了算在人），裁决后转 auto。带 TTL 的单给出 expires_at / ttl_s / ttl_note（null = 无 TTL，永不过期）。' },
  'POST /v1/approvals/:id/decide': { group: G_APPROVALS, requires: 'human',
    example: { decision: 'approve', by: 'user' },
    summary: '门控端点唯一的执行入口。批准时由服务端回放原始请求，agent 因此永远拿不到直接执行的路径。设了 APPROVAL_SECRET 还需带 X-Approval-Secret。' },

  'POST /v1/demo/push_budget': { group: G_DEMO, requires: 'auto', example: { used: 49.8 }, summary: '演示用：把已用预算推到指定值。' },
  'POST /v1/demo/reset': { group: G_DEMO, requires: 'auto', summary: '演示用：重置到种子状态。' },

  // 兼容别名：界面目录里写的是 /v1/act/{id}/confirm，这里同时接受 body.action_id 形式
  'POST /v1/act/confirm': { group: G_ACT, requires: 'human', deprecated: true, aliasOf: 'POST /v1/act/:id/confirm',
    example: { action_id: 'act_xxxxxx' }, summary: '（兼容别名）等价于 POST /v1/act/{id}/confirm，动作 id 放在 body 里。' },
  'POST /v1/act/rollback': { group: G_ACT, requires: 'auto', deprecated: true, aliasOf: 'POST /v1/act/:id/rollback',
    example: { action_id: 'act_xxxxxx' }, summary: '（兼容别名）等价于 POST /v1/act/{id}/rollback，动作 id 放在 body 里。' },

  'GET /v1/openapi.json': { group: G_INFRA, requires: 'auto', ok: 200, raw: true,
    summary: '本文件。从 ROUTES × GATE × META 现场派生，不落盘、不手写，因此不会与运行中的服务漂移。' }
};

const opIdOf = (method, oapiPath) =>
  (method + '_' + oapiPath).replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '').replace(/^_+/, '');

const ENVELOPE = {
  type: 'object',
  description: '所有操作类响应的统一信封。文档类响应（openapi.json）例外，见 x-agent-console.documents_are_not_operations。',
  properties: {
    ok: { type: 'boolean' },
    requires: { type: 'string', enum: ['auto', 'human', 'agent', 'human_or_llm'],
      description: '结果谁来定。auto=可自行判定；human=需要人；agent=需要 agent 补充输入。注意：这与门控（gate）是两条正交的轴。' },
    replayed: { type: 'boolean', description: '仅幂等重放时为 true。' },
    data: { type: 'object' },
    error: { type: 'object',
      description: '出错时的结构。code 是可枚举的机器语义，message 是给人读的散文 —— agent 应当只对 code 分支。',
      properties: {
        code: { type: 'string', enum: ERROR_CODES,
          description: '机器可读的错误码。穷举这些值做分支，不要解析 message 的文本。' },
        message: { type: 'string', description: '人类可读说明（中文）。不承载机器语义。' },
        approval_id: { type: 'string',
          description: '仅 REQUIRE_APPROVAL。被挂起的审批单 id，可拿去 GET /v1/approvals/{id} 单查。' },
        parked_at: { type: 'string', description: '仅 REQUIRE_APPROVAL。挂起的时刻。' },
        fingerprint: { type: 'string',
          description: '仅 REQUIRE_APPROVAL。请求内容摘要。重试同一请求会得到同一 fingerprint —— 可用它判断「这张是不是我刚才那张」。' },
        hits: { type: 'integer',
          description: '仅 REQUIRE_APPROVAL。同一请求被重复挂起的次数。> 0 表示你在重试，应当停手。' },
        fingerprint_means: { type: 'string', description: 'fingerprint 的解释（给人读）。' },
        approval_expires_at: { type: ['string', 'null'],
          description: '仅 REQUIRE_APPROVAL。带 TTL 的单何时自动关闭（本地时间）；null = 无 TTL，会一直等人裁决。' },
        approval_ttl_note: { type: 'string',
          description: '仅 REQUIRE_APPROVAL。这张单的 TTL 行为说明（给人读）。' }
      },
      required: ['code', 'message'] },
    gate: { type: 'object', description: '被门控截停时出现。',
      properties: {
        level: { type: 'string', enum: ['approval', 'none'] },
        why: { type: 'string', description: '为什么这条被门控（给人读）。' },
        enforced_in: { type: 'string', description: '强制点在哪里 —— 网关层，不是提示词。' },
        parked_in: { type: 'string', description: '挂起后存在哪里。' },
        bypass: { type: 'string', description: '为什么没有 HTTP 路径可以绕过。' },
        approval_secret_required: { type: 'boolean', description: '裁决是否需要密钥。' }
      } },
    idempotency: { type: 'object',
      description: '仅幂等重放时出现。说明这次返回的是首次响应，而不是又执行了一遍。',
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', enum: ['required', 'optional'],
          description: 'required=端点强制带键（缺了 400）；optional=带键才生效 —— 不带就没有这层保护。' },
        storage_constraint: { type: 'string', description: '唯一性的物理位置（表主键），不是应用层 if。' },
        behaviour: { type: 'string', description: '重放语义：返回首次响应，不产生第二次副作用。' },
        hits: { type: 'integer', description: '这个键被重发过几次。' },
        first_seen_at: { type: 'string' }
      } },
    hints: { type: 'array', description: '面向 agent 的下一步建议，按受众分组。',
      items: { type: 'object',
        properties: {
          for: { type: 'string', enum: ['agent', 'user'], description: '这条建议给谁。' },
          action: { type: 'string', enum: HINT_ACTIONS,
            description: '机器可读的下一步语义。agent 应当分支于这个字段，而不是解析 suggest 的自然语言 —— 那是跨语区不稳定的。' },
          suggest: { type: 'string', description: '人类可读的建议（中文）。' },
          why: { type: 'string', description: '为什么这么建议（给人读）。' }
        },
        required: ['for', 'action', 'suggest'] } },
    _meta: { type: 'object', description: '传输层统一补齐：request_id / latency_ms（实测）/ tokens_estimate（真实字节 chars/4）。' }
  },
  required: ['ok', 'requires']
};

function buildOpenApi() {
  const gateByRoute = GATE;
  const paths = {}, duplicates = [], seenIds = new Set();
  const live = ROUTES.filter(([m, p, fn, tag]) => !(tag === 'demo' && !DEMO));

  for (const [method, pat, , tag] of live) {
    const key = method + ' ' + pat;
    const meta = META[key] || {};

    const oapiPath = pat.replace(/:([A-Za-z_]\w*)/g, '{$1}');
    const params = [];
    for (const m of oapiPath.matchAll(/\{(\w+)\}/g))
      params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    for (const q of (meta.query || [])) params.push(q);
    if (meta.idem)
      params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' },
        description: '写操作必填。同键重发返回首次响应，不产生第二次副作用（约束在存储层 PRIMARY KEY，不在应用层 if）。' });

    const gate = gateByRoute.get(key);
    const opId = opIdOf(method, oapiPath);
    if (seenIds.has(opId)) duplicates.push(opId);
    seenIds.add(opId);

    const responses = {
      [String(meta.ok || 200)]: { description: '成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } }
    };
    if (gate) responses['403'] = { description: 'REQUIRE_APPROVAL —— 被网关截停，请求已原样落盘为审批单，业务代码一行未执行' };
    responses.default = { description: '统一信封。业务错误码在 error.code 里，不在这份声明里 —— 声明不出来的东西就不写，免得 spec 撒谎。',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } };

    const op = {
      operationId: opId,
      tags: [meta.group || (tag ? String(tag) : '其他')],
      summary: meta.summary || '（META 未登记 —— 见 x-agent-console.meta_coverage.missing）',
      parameters: params,
      responses,
      // x-requires 一律是**数组**：列出这个端点可能返回的 requires 值集合。
      // 单值也用 ['auto'] —— 类型一致，agent 只需 x-requires.includes('human')，
      // 不必再分辨「这次是字符串还是数组」。运行时响应里的 requires 必是其中之一。
      // （历史坑：曾用 'auto | human' 这种复合字符串表达多态，既越出 Envelope.requires 的
      //  enum，又因为含 '|' 把任何直接拼它的 markdown 表格撕成两列。）
      'x-requires': Array.isArray(meta.requires) ? meta.requires : [meta.requires || 'auto'],
      // 四档，如实标注 —— 标了哪一档，那一档的保证就必须真的存在。
      //   safe              = 读，无副作用
      //   required          = 写且必带 Idempotency-Key（缺了直接 400）
      //   optional          = 写，**可选**带键：带了就按表主键重放首次响应，不带则不受任何约束
      //   fingerprint_dedup = 门控端点：不走业务 handler、没有键机制，
      //                       但重复请求按内容指纹合并，不会开出第二张待批单
      'x-idempotency': method === 'GET' ? 'safe'
        : meta.idem ? 'required'
        : gate ? 'fingerprint_dedup'
        : 'optional',
      'x-gate': gate
        ? { level: gate.level, why: gate.why,
            agent_behaviour: '403 REQUIRE_APPROVAL，请求挂起；重试不会让它执行，只会白烧上下文',
            execution_entry: '/v1/approvals/{id}/decide（批准时由服务端回放本请求）' }
        : { level: 'none' },
      // 人类专属表面：不是「门控」，而是这个端点本身代表人的意志。（false → undefined，JSON 里直接不出现）
      'x-human-surface': HUMAN_SURFACE.has(key) || undefined
    };
    if (meta.deprecated) op.deprecated = true;
    if (meta.aliasOf) op['x-alias-of'] = meta.aliasOf;
    if (meta.example) op.requestBody = { required: false,
      content: { 'application/json': { schema: { type: 'object' }, example: meta.example } } };

    (paths[oapiPath] = paths[oapiPath] || {})[method.toLowerCase()] = op;
  }

  const metaKeys = Object.keys(META);
  const routeKeys = live.map(([m, p]) => m + ' ' + p);
  const missing = routeKeys.filter(k => !META[k]);
  const extra = metaKeys.filter(k => !routeKeys.includes(k));

  /* 确定性：同一份活元数据必须派生出逐字节相同的文档。
   * 时间戳会毁掉这一点 —— 下游拿它做契约 diff、缓存、CI 回归时，
   * 每次都不一样的东西等于没法比。所以：
   *   generated_at（时间戳）→ contract_digest（内容摘要）
   * 内容改了摘要才变，没改就是同一份契约。
   * 传输统计（request_id / latency / tokens）属于传输层，走响应头，不进文档。 */
  const contractDigest = crypto.createHash('sha256').update(JSON.stringify({
    paths, tags: OPENAPI_TAGS, meta: META, gate: [...GATE.entries()],
    human_surface: [...HUMAN_SURFACE], envelope: ENVELOPE
  })).digest('hex').slice(0, 16);

  const base = {
    openapi: '3.1.0',
    info: {
      title: 'Agent Console API',
      version: VER,
      summary: '面向 agent 的接口契约：把「我不该」变成「我不能」。',
      description: [
        '两条正交的轴，别混：gate（路由策略）＝授权，你**能不能发起**这个动作；',
        'requires（响应字段）＝裁决，结果**谁来定**。把判定类接口也门控掉，它就永远无法返回「我判不了」。',
        '',
        '于是有 x-gate.level != none 的端点：HTTP 入口在调用 handler 之前就被截停，',
        '请求原样落盘为审批单，业务代码一行不跑。「绕开队列」在架构上不存在路径 ——',
        '能跑该 handler 的代码只有一行，在审批回放里。'
      ].join('\n')
    },
    servers: [{ url: 'http://127.0.0.1:' + PORT, description: '本机实例' }],
    tags: OPENAPI_TAGS.map(name => ({ name })),
    paths,
    components: { schemas: { Envelope: ENVELOPE } }
  };

  return Object.assign(base, { 'x-agent-console': {
      service: 'agent-console', version: VER, engine: 'node:http + node:sqlite',
      contract_digest: contractDigest,
      generated_from: 'ROUTES × GATE × META —— 现场派生，不落盘、不手写，所以不会与运行中的服务漂移',
      process_model: '队列、锁、门控由服务进程持有 —— agent 无法绕过自己做裁判',
      requires_model: 'x-requires 是数组，列出该端点【可能返回】的全部 requires 值（响应体里的 requires 必是其中之一）。取值：auto=可自行判定 · human=需要人 · agent=需要 agent 补充输入 · human_or_llm=语义判定',
      idempotency_model: 'safe=读（无副作用） · required=写且必带 Idempotency-Key（缺了直接 400） · ' +
        'optional=写，可选带键：带了就按表主键重放首次响应，不带则不受任何约束（写端点的默认档） · ' +
        'fingerprint_dedup=门控端点：不走业务 handler、没有键机制，但重复请求按内容指纹合并，不会开出第二张待批单',
      documents_are_not_operations: 'GET /v1/openapi.json 直接返回 OpenAPI 文档本身（不加信封），以免污染文档结构。',
      deterministic: '同一份活元数据派生出的文档逐字节相同：没有时间戳，只有 contract_digest。传输统计走响应头（X-Request-Id / X-Latency-Ms / X-Doc-Tokens），不进文档体。',
      gate: {
        policy: [...GATE.entries()].map(([route, v]) => ({ route, level: v.level, why: v.why })),
        human_surface: [...HUMAN_SURFACE],
        decide_endpoint: 'POST /v1/approvals/:id/decide',
        approval_secret_required: !!APR_KEY
      },
      meta_coverage: {
        routes: routeKeys.length, declared: metaKeys.length,
        missing, extra,
        note: 'missing 非空 = spec 里出现了占位说明，不是静默少写一条'
      },
      duplicate_operation_ids: duplicates,
      honesty: [
        '默认无鉴权：同机任何进程都能裁决待批单。APPROVAL_SECRET 是可选的补救，默认关。',
        '网关先于业务校验：不存在的 action_id 也会被挂起（回放时才 404），因此理论上可以刷待批队列，真实部署需按请求方限流。',
        '回放是同步的：长任务会阻塞裁决请求。',
        'x-idempotency=optional 的写端点需要你带上 Idempotency-Key 才受保护；不带键时没有任何约束 —— ' +
        '想要确定性就带键，别依赖「重试前先读状态」这条口头纪律。',
        '审批单默认永不过期（一直等人裁决）。提交时在 body 里带 approval_ttl_s 才有 TTL，' +
        '到期由服务端自动关闭为 EXPIRED。TTL 不参与指纹计算，所以同一请求带不带 TTL 都是同一张单。'
      ]
    }
  });
}

H.openapi = () => ({ status: 200, raw: true, body: buildOpenApi() });

// ───────────────────────────── 路由表 ─────────────────────────────
const ROUTES = [
  ['GET',  '/v1/health',                              H.health,              'infra'],
  ['GET',  '/v1/openapi.json',                        H.openapi,             'infra'],
  ['GET',  '/v1/state/bundle',                        H.bundle,              'infra'],
  ['GET',  '/v1/state/project',                       H.project],
  ['GET',  '/v1/state/decisions',                     H.decisionsList],
  ['PUT',  '/v1/state/decisions',                     H.decisionsWrite],
  ['GET',  '/v1/state/checkpoint',                    H.checkpoint],
  ['GET',  '/v1/state/assets',                        H.assetsGet],
  ['PUT',  '/v1/state/assets',                        H.assetsPut],
  ['GET',  '/v1/state/change_requests',               H.changeRequests,      'new'],
  ['POST', '/v1/state/change_requests',               H.changeRequestCreate, 'new'],
  ['POST', '/v1/state/change_requests/:id/approve',   H.changeRequestApprove,'new'],
  ['POST', '/v1/senses/measure',                      H.measure],
  ['POST', '/v1/senses/transcribe',                   H.transcribe],
  ['POST', '/v1/senses/judge',                        H.judge],
  ['GET',  '/v1/senses/diff',                         H.diff],
  ['POST', '/v1/act/queue',                           H.queue],
  ['POST', '/v1/act/lease',                           H.lease],
  ['GET',  '/v1/act/leases',                          H.leases,              'new'],
  ['POST', '/v1/act/:id/confirm',                     H.confirm],
  ['POST', '/v1/act/:id/rollback',                    H.rollback],
  ['GET',  '/v1/audit',                               H.audit],
  ['GET',  '/v1/approvals',                           H.approvalsList,       'new'],
  ['GET',  '/v1/approvals/:id',                       H.approvalGet,         'new'],
  ['POST', '/v1/approvals/:id/decide',                H.approvalDecide,      'new'],
  ['POST', '/v1/demo/push_budget',                    H.demoBudget,          'demo'],
  ['POST', '/v1/demo/reset',                          H.demoReset,           'demo']
];

function match(method, pathname) {
  for (const [m, pat, fn, tag] of ROUTES) {
    if (m !== method) continue;
    if (tag === 'demo' && !DEMO) continue;
    const key = m + ' ' + pat;
    if (!pat.includes(':')) { if (pat === pathname) return { fn, params: {}, tag, key }; continue; }
    const pp = pat.split('/'), ap = pathname.split('/');
    if (pp.length !== ap.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return { fn, params, tag, key };
  }
  return null;
}

// 空响应壳：审批单在等裁决，业务代码一行没跑
const parked = (ap, policy, rid) => ({ status: 403, body: {
  ok: false, requires: 'human',
  error: { code: 'REQUIRE_APPROVAL',
    message: '该操作不在 agent 的授权范围内。请求已原样挂起，等待人工裁决，未执行。',
    approval_id: ap.id, parked_at: ap.created_at, fingerprint: ap.fingerprint, hits: ap.hits,
    fingerprint_means: '这张单子的内容摘要 —— 人批的是它，批完服务端回放的就是它，中间改不了',
    approval_expires_at: ap.expires_at_ms ? fmtLocal(new Date(ap.expires_at_ms)) : null,
    approval_ttl_note: ap.expires_at_ms
      ? '这张单带 TTL：到期由服务端自动关闭为 EXPIRED，届时再批会拿到 APPROVAL_EXPIRED'
      : '这张单没有 TTL：会一直等人裁决。想让它自己过期，重发时在 body 里带上 approval_ttl_s' },
  gate: { level: policy.level, why: policy.why,
    enforced_in: 'server process（网关层，非提示词）',
    parked_in: 'approvals 表 · SQLite',
    bypass: '没有 HTTP 路径可绕过：该 handler 只从审批回放中被调用',
    approval_secret_required: !!APR_KEY },
  hints: [
    { for: 'agent', action: 'stop_retry', suggest: '停止重试，继续处理其他未阻塞分片', why: '重试不会让它执行，只会白烧上下文' },
    { for: 'agent', action: 'observe', suggest: `GET /v1/approvals/${ap.id} 单查这一张（或 GET /v1/approvals?status=PENDING 看全部）`, why: '可见即可观测，但可见性不构成权限' },
    { for: 'user', action: 'decide_approval', suggest: `在待审批面板批准或驳回 ${ap.id}`, why: '这是该端点唯一的执行入口' }
  ],
  _meta: { note: '403 而不是 202：202 暗示「稍后回来查」，而这里的正确动作是走开' }
} });

// ─────────────────────── v2 契约兼容：/v1/act/{id}/confirm ───────────────────────
// 目录里写的是 /v1/act/{id}/confirm，这里同时接受 /v1/act/confirm + body.action_id
ROUTES.push(['POST', '/v1/act/confirm',  H.confirm]);
ROUTES.push(['POST', '/v1/act/rollback', H.rollback]);

// ───────────────────────────── HTTP ─────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400'
};
const send = (res, status, payload, extra) => {
  const buf = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length, 'X-Request-Id': payload._meta ? payload._meta.request_id : '-',
    ...CORS, ...(extra || {}) });
  res.end(buf);
};

/* ── 词表自检：hints[].action 与 error.code 都必须来自词表 ──
 * 为什么需要：契约里那两组 enum 是「可穷举分支」的全部依据，
 * 而「加了新值却忘了更新词表」会让 enum 悄悄比现实少一条 ——
 * 那正是让下游工具误判的来源。所以不静默：让它在响应里现形，测试层断言它恒为空。
 * 注意：**只有探测、没有断言**等于没有兜底（本项目踩过这个坑，见 smoke-openapi 第 11 组）。 */
function checkVocabulary(body, rid) {
  if (!body || typeof body !== 'object') return;
  const at = rid ? ' rid=' + rid : '';
  if (!body._meta) body._meta = {};
  if (Array.isArray(body.hints)) {
    const bad = body.hints.filter(h => !HINT_ACTION_SET.has(h.action));
    if (bad.length) {
      const list = bad.map(h => (h.action === undefined ? '<missing>' : String(h.action)));
      console.warn('[hints.action 违约]' + at + ' → ' + list.join(', ') +
        '（不在 HINT_ACTIONS 内，契约 enum 会漏声明这些值）');
      body._meta.hint_action_violation = list;
    }
  }
  if (body.error && body.error.code !== undefined && !ERROR_CODE_SET.has(body.error.code)) {
    console.warn('[error.code 违约]' + at + ' → ' + String(body.error.code) +
      '（不在 ERROR_CODES 内，契约 enum 会漏声明这个值）');
    body._meta.error_code_violation = String(body.error.code);
  }
}

/* ── 统一出口：所有 JSON 响应都必须从这里出去 ──
 * 之前早退路径（404 / 400 / 找不到 UI）各自手写
 *   _meta: { request_id, latency_ms: 0, tokens_estimate: 0 }
 * 有两个后果，都是这个项目最不能出的那种：
 *   1. 零值不是「测到 0」，是「没测」—— 等于在传输元数据里编数；
 *   2. 它们绕过了词表自检，于是「探测覆盖所有响应」是假的：
 *      往 404 里塞一个不在词表里的 error.code，没有任何东西会现形。
 * 现在收口成一条路：同一份 _meta、同一份自检，一个都不漏。
 * （唯一例外是文档类响应 out.raw —— 往 OpenAPI 文档体里注入每请求都会变的东西
 *   会污染结构，那条路刻意不走这里。） */
const finish = (res, status, body, rid, t0, extra) => {
  const raw = JSON.stringify(body);
  body._meta = Object.assign({
    request_id: rid,
    latency_ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2),
    tokens_estimate: Math.ceil(raw.length / 4),
    tokens_note: '真实响应体的 chars/4 估算，非模拟值',
    engine: 'node:http + node:sqlite',
    gate_enforced_at: 'server process',
    budget: budgetView()
  }, body._meta || {});
  checkVocabulary(body, rid);
  return send(res, status, body, extra);
};

function readBody(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { if (!s.trim()) return ok(null); try { ok(JSON.parse(s)); }
      catch (e) { no(Object.assign(new Error(e.message), { http: 400, code: 'INVALID_JSON' })); } });
    req.on('error', no);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  const rid = genRid();
  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { u = { pathname: req.url, searchParams: new URLSearchParams() }; }
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // 同源托管前端：避免 file:// 下的跨域与 preflight
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/ai-workbench.html')) {
    /* 内容协商：同一个 URL，人看见控制台，agent 看见索引。
     * 没有这一步的话，agent 的第 1 次往返必然浪费在大体积的 HTML 上 ——
     * 它得先撞一次墙才知道该去找 /v1/health。
     *
     * 判定方向是「只有明确要 HTML 才给页面」，不是「只有明确要 JSON 才给索引」。
     * 因为：
     *   浏览器导航   Accept: text/html,application/xhtml+xml,...,* / *  → 含 text/html → 页面
     *   fetch()      Accept: * / *                                       → 不含      → 索引
     *   curl         Accept: * / *                                       → 不含      → 索引
     * 反过来写的话，* / * 会落进 HTML 分支 —— 而那恰好是绝大多数 agent HTTP 客户端的默认值。 */
    const accept = String(req.headers.accept || '');
    if (accept.indexOf('text/html') < 0) {
      /* note 必须如实描述**这一次请求**的 Accept。
       * 分支的真实条件是「Accept 里没有 text/html」—— 而 * / * 和「不带 Accept 头」
       * 都落进这里，后者恰恰是多数 agent 客户端的默认值。
       * 曾经写死成「你是带 Accept: application/json 来的」：对 * / * 和空头都是**谎报请求由来**，
       * 而这句是零知识 agent 看到的第一条消息 —— 它在教 agent 这套接口怎么工作。
       * 刻意不回显 Accept 原文，只做枚举，免得把请求头整条搬进响应。 */
      const bare = accept.trim();
      const whyIndex = bare === '' ? '你没带 Accept 头（等同 */*）'
        : bare.indexOf('application/json') >= 0 ? '你明确要 application/json'
        : '你的 Accept 没偏好 text/html';
      return finish(res, 200, { ok: true, requires: 'auto', data: {
        kind: 'agent-index',
        service: 'agent-console', version: VER,
        note: whyIndex + '，所以给你机器可读的索引，而不是 ' + HTML_KB + ' 的 HTML。',
        contract: { url: '/v1/openapi.json', type: 'application/openapi+json',
          why: '先读它，别读文档：它由运行中的路由表 × 门控策略 × 语义登记现场派生，不会漂移。' },
        health: '/v1/health',
        bundle: '/v1/state/bundle',
        start_here: [
          'GET /v1/health —— 端点清单与运行态',
          'GET /v1/openapi.json —— 契约（含 x-gate / x-requires / x-idempotency）',
          'GET /v1/state/bundle —— 一次拿全状态，省往返'
        ],
        gotcha: '动手前先看 x-gate：被门控的端点直接调会 403，请求会被挂起等人裁决，重试不会让它执行。'
      } }, rid, t0);
    }
    try {
      const html = fs.readFileSync(HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch { return finish(res, 404, { ok: false, error: { code: 'UI_NOT_FOUND', message: '找不到 ai-workbench.html' } }, rid, t0); }
  }

  const hit = match(req.method, pathname);
  if (!hit) {
    return finish(res, 404, { ok: false, requires: 'agent',
      error: { code: 'ENDPOINT_NOT_FOUND', message: `${req.method} ${pathname} 不在契约内` },
      hints: [{ for: 'agent', action: 'observe', suggest: 'GET /v1/health', why: '列出服务信息与端点数量' }] }, rid, t0);
  }

  let body = null;
  try { body = await readBody(req); }
  catch (e) {
    return finish(res, e.http || 400, { ok: false, requires: 'agent',
      error: { code: e.code || 'BAD_REQUEST', message: e.message } }, rid, t0);
  }

  let out;
  const reqObj = { body, headers: req.headers, query: u.searchParams, rid, params: hit.params,
    method: req.method, idemKey: req.headers['idempotency-key'] || null, methodKey: hit.key };

  // ── 网关：门控端点在这里被截停。业务代码一行都不会跑。 ──
  const policy = GATE.get(hit.key);
  if (policy) {
    const { ap } = parkRequest(req.method, hit.key, reqObj);
    out = parked(ap, policy, rid);
  } else {
    // 可选幂等：带了键且这个键执行过 → 直接重放，handler 不跑（副作用不重复）
    out = idemClaim(req.method, hit.key, reqObj);
    if (!out) {
      try {
        out = hit.fn(reqObj) ||
              { status: 500, body: { ok: false, error: { code: 'NO_HANDLER', message: hit.fn.name } } };
        idemSettle(hit.key, reqObj, out);    // 在 finish() 之前落盘：_meta 不算「首次响应」
      } catch (e) {
        idemAbort(reqObj);
        log('ERR', pathname, e.message, rid);
        out = { status: e.http || 500, body: { ok: false, requires: 'agent',
          error: { code: e.code || 'INTERNAL_ERROR', message: e.message } } };
      }
    }
  }

  // ── 文档类响应：不加信封 ──
  // OpenAPI 文档本身要是合规的文档，往里塞 _meta 就是在污染结构 ——
  // 那种「顺手加点自己的东西」正是让 spec 没人敢用的原因。
  // 传输元数据挪进 x-agent-console 扩展（3.1 允许 x- 根键）。
  if (out.raw) {
    /* 文档类响应：绝不往文档体里注入「每请求都会变」的东西。
     * 文档体的价值在于它所描述的那份契约 —— 契约不随请求变。
     * 传输统计放响应头（本来就是传输层的东西，放传输层才对），
     * 于是同一份活元数据派生出的文档逐字节相同：可缓存、可 diff、可进 CI 做契约回归。 */
    const buf = JSON.stringify(out.body);
    return send(res, out.status, out.body, {
      'Content-Type': 'application/openapi+json; charset=utf-8',
      'X-Request-Id': rid,
      'X-Latency-Ms': (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2),
      'X-Doc-Tokens': String(Math.ceil(buf.length / 4)),
      'X-Contract-Digest': (out.body['x-agent-console'] || {}).contract_digest || '-'
    });
  }

  // _meta 与词表自检统一走 finish()：早退路径也走它，一条都不漏
  return finish(res, out.status, out.body, rid, t0);
});

server.listen(PORT, '127.0.0.1', () => {
  const fresh = q.one('SELECT COUNT(*) c FROM decisions').c === 0;
  if (fresh) { seed(); console.log('[agent-console] 首次运行，已写入种子数据'); }
  log('BOOT', 'engine', '服务启动 · pid ' + process.pid + ' · :' + PORT);
  console.log(`[agent-console v3] listening on http://127.0.0.1:${PORT}`);
  console.log(`[agent-console v3] db: ${DB_PATH}`);
  console.log(`[agent-console v3] ui: http://127.0.0.1:${PORT}/   (${ROUTES.length} endpoints)`);
});
server.on('error', e => {
  console.error('[agent-console] 启动失败:', e.code === 'EADDRINUSE'
    ? `端口 ${PORT} 已被占用。换一个：PORT=8788 node server.js` : e.message);
  process.exit(1);
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {
  try { log('SHUT', 'engine', '服务停止'); db.close(); } catch {}
  process.exit(0);
});
