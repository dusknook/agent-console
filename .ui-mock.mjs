
const mkEl = () => ({ innerHTML:'', value:'', textContent:'', className:'', style:{}, dataset:{},
  querySelectorAll:()=>[], classList:{add(){},remove(){}}, onclick:null, disabled:false });
const __els = {};
globalThis.document = { getElementById: id => (__els[id] = __els[id] || mkEl()), querySelectorAll: () => [] };
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { protocol:"http:", port:"59999" };
globalThis.__els = __els;
const $t = id => document.getElementById(id);

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const hex = n => Array.from({length:n}, () => "0123456789abcdef"[Math.floor(Math.random()*16)]).join("");
const idem = () => "idem_" + hex(16);
const reqid = () => "req_" + hex(8);
const now = () => new Date().toISOString().replace("Z","+08:00").slice(0,19).replace("T"," ");
const nowISO = () => new Date().toISOString();

function highlight(str){
  let out = "", last = 0;
  const re = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
  let m;
  while((m = re.exec(str))){
    out += esc(str.slice(last, m.index));
    let cls = "num";
    if(m[0][0] === '"') cls = m[2] ? "key" : "str";
    else if(m[0] === "true" || m[0] === "false") cls = "bool";
    else if(m[0] === "null") cls = "null";
    out += '<span class="j-' + cls + '">' + esc(m[0]) + "</span>";
    last = re.lastIndex;
  }
  return out + esc(str.slice(last));
}

function tree(v){
  if(v === null) return '<span class="j-null">null</span>';
  if(Array.isArray(v)) return '<div class="tree">' + v.map((x,i) =>
    '<div class="trow"><span class="tkey">[' + i + ']</span><span class="tval">' + tree(x) + '</span></div>').join("") + "</div>";
  if(typeof v === "object") return '<div class="tree">' + Object.entries(v).map(([k,x]) =>
    '<div class="trow"><span class="tkey">' + esc(k) + '</span><span class="tval">' + tree(x) + '</span></div>').join("") + "</div>";
  return '<span class="tv-' + typeof v + '">' + esc(v) + "</span>";
}

const EPS = [
  { g:"基础 INFRA", id:"infra.health", method:"GET", path:"/v1/health", isNew:true,
    spec:"GET /v1/health\n后端存活探测。返回 pid / 端口 / uptime / db 路径 / journal_mode / 路由表。\n前端靠它判断是「连上真后端」还是「降级为浏览器内 mock」。" },
  { g:"基础 INFRA", id:"infra.bundle", method:"GET", path:"/v1/state/bundle", isNew:true,
    spec:"GET /v1/state/bundle\n一次往返取回整个 UI 所需状态：预算 / 决策 / 资产 / 快照 / 队列 / 租约 / 审计。\n没有它，侧栏每刷新一次要打 5 个请求。这是给人看的接口，不是给 agent 的。" },
  { g:"基础 INFRA", id:"contract.openapi", method:"GET", path:"/v1/openapi.json", isNew:true,
    spec:"GET /v1/openapi.json\n把契约导出成 OpenAPI 3.1 —— 由服务端的路由表 × 门控策略 × 语义登记现场派生。\n\n为什么不是一份手写的 openapi.yaml：手写的会漂移。加了路由它不知道，\n改了闸门它不知道，两个月后它就在撒谎。这里它描述的就是那份路由表本身。\n\n每个 operation 带三个扩展：x-gate（会不会被截停）/ x-requires（结果谁定）/\nx-idempotency（能不能安全重试）。agent 可以直接把这份喂进自家工具调用层，不必读文档。\n\n注意：它是文档不是操作，所以不套统一信封 —— 塞 _meta 进去就是在污染文档结构。\n也正因为它由真服务派生，离线 mock 里导出只会得到 503：拿本页副本假装契约，就是让契约开始撒谎。" },
  { g:"状态 STATE", id:"state.project", method:"GET", path:"/v1/state/project",
    spec:"GET /v1/state/project\n返回项目快照、进度、未决问题。\n响应固定含 hints[]：面向 agent 的下一步建议。" },
  { g:"状态 STATE", id:"state.decisions.list", method:"GET", path:"/v1/state/decisions",
    spec:"GET /v1/state/decisions\n返回 immutable=true 的决策记录。\nagent 读到后不得自行改写。" },
  { g:"状态 STATE", id:"state.decisions.write", method:"PUT", path:"/v1/state/decisions", isNew:true,
    body:{ key:"scene.pov", value:"third person, close", immutable:true },
    spec:"PUT /v1/state/decisions\nbody: { key, value, immutable }\n键已存在且 immutable 时返回 409 DECISION_LOCKED。\n409 响应必须同时携带 change_request 路径 ——\n只堵不疏会让使用者绕开锁定、另建重复资产，状态体系反而失守。" },
  { g:"状态 STATE", id:"state.checkpoint", method:"GET", path:"/v1/state/checkpoint", isNew:true,
    spec:"GET /v1/state/checkpoint\n断点由原子动作完成时自动推进，不依赖人工预定义章节边界。\n返回 snapshot_head / last_atomic_action / next / open_exceptions。\n中途改了大纲也不怕：断点跟着动作走，不跟着计划走。" },
  { g:"状态 STATE", id:"state.assets", method:"GET", path:"/v1/state/assets", isNew:true,
    spec:"GET /v1/state/assets\n列出资产及其全部版本。current_version 是状态当前引用的版本。\n旧版本不删除，用于回溯与断点续跑。" },
  { g:"状态 STATE", id:"state.assets.put", method:"PUT", path:"/v1/state/assets", isNew:true,
    body:{ asset_id:"voice.lead.ref", value:"female, warm, breathy, mid-30s", note:"客户要求气声更明显" },
    spec:"PUT /v1/state/assets\nbody: { asset_id, value, note }\n默认行为：基于当前版本开新版本，旧版本永久保留。\n若显式指定 target_version 去改历史版本 → 409 VERSION_IMMUTABLE。\n结论：锁的是版本，不是资产本身。约束与变更可以兼得。" },

  { g:"状态 STATE", id:"state.change_requests", method:"GET", path:"/v1/state/change_requests", isNew:true,
    spec:"GET /v1/state/change_requests?status=OPEN\n列出变更请求。\n改动背景：v2 的 409 响应里写着 change_request.open=true 并指向\nPOST /v1/state/change_requests —— 但那个端点当时并不存在。\n那是一条悬空引用：接口文档给了出路，系统里没有路。\nv3 把它实现了，这条通路才算真的通了。" },
  { g:"状态 STATE", id:"state.change_requests.create", method:"POST", path:"/v1/state/change_requests", isNew:true,
    body:{ target_type:"decision", target_id:"DEC-002", target_key:"voice.lead", current_value:"female, warm, slightly raspy, mid-30s", proposed:"female, warm, breathy", requested_by:"agent" },
    spec:"POST /v1/state/change_requests\nagent 想改锁定项时的正式入口。返回 201 + approve 端点。\n通常不必手调：PUT /v1/state/decisions 撞锁时会自动替你开一条。" },
  { g:"状态 STATE", id:"state.change_requests.approve", method:"POST", path:"/v1/state/change_requests/{id}/approve", isNew:true,
    body:{ id:"", by:"user" },
    spec:"POST /v1/state/change_requests/{id}/approve\n人类批准。由 service 层执行：旧记录标 superseded、新记录链上 previous_id。\n重点：不是原地改写不可变记录，而是把不可变性保留在版本层。\n批准后 requires 从 human 降回 auto，agent 拿到新值可以继续跑。" },

  { g:"感官 SENSES", id:"senses.measure", method:"POST", path:"/v1/senses/measure",
    body:{ artifact:"CH02_final_192k.mp3", profile:"scribl.v1" },
    spec:"POST /v1/senses/measure\nbody: { artifact, profile }\n只覆盖规则化客观检测。\n响应顶层带 requires：auto = 可自行判定；human / llm = 必须升级。\ndata.coverage.not_covered 显式列出本接口判不了的维度。" },
  { g:"感官 SENSES", id:"senses.transcribe", method:"POST", path:"/v1/senses/transcribe",
    body:{ artifact:"CH03_S04.wav", language:"en-US", diarize:true },
    spec:"POST /v1/senses/transcribe\nbody: { artifact, language, diarize }\n返回带时间轴的 segments[]，供 agent 定位问题片段。" },
  { g:"感官 SENSES", id:"senses.judge", method:"POST", path:"/v1/senses/judge", isNew:true,
    body:{ subject:"CH03_S04", question:"情绪是否与 CH02 结尾连贯", kind:"semantic" },
    spec:"POST /v1/senses/judge\nbody: { subject, question, kind }\n语义判定专用端点。规则内的部分当场给 verdict；\n无法自动化的部分显式返回 requires:\"human_or_llm\" 并升级为审批项。\n接口不假装能判定它判不了的东西 —— 诚实标注边界优于虚假自动化。" },
  { g:"感官 SENSES", id:"senses.diff", method:"GET", path:"/v1/senses/diff",
    spec:"GET /v1/senses/diff?from=v11&to=v12\n只返回变化的字段，unchanged_count 汇总未变项。" },

  { g:"行动 ACT", id:"act.queue", method:"POST", path:"/v1/act/queue",
    body:{ kind:"tts.seed_audio", shard:"CH03_S04", cost_cny:0.42, route:"approve", reason:"前段已 ACCEPT，续生成第四段" },
    spec:"POST /v1/act/queue\nHeader 必须带 Idempotency-Key。\n路由三选一：auto 直接执行 / approve 挂起等批 / conditional 条件触发。\nroute=auto 若带成本 → 422 ROUTE_CONFLICT，自动队列只放行零成本幂等动作。\n幂等由存储层 UNIQUE(idem_key) 保证，不是应用层 if 判断。" },
  { g:"行动 ACT", id:"act.confirm", method:"POST", path:"/v1/act/{id}/confirm",
    body:{ action_id:"" }, spec:"POST /v1/act/{id}/confirm\n把 PENDING_CONFIRMATION 推进为 EXECUTED，写入审计。" },
  { g:"行动 ACT", id:"act.rollback", method:"POST", path:"/v1/act/{id}/rollback",
    body:{ action_id:"" }, spec:"POST /v1/act/{id}/rollback\n把已执行动作标记为 ROLLED_BACK，退回预算并记录补偿。" },
  { g:"行动 ACT", id:"act.lease", method:"POST", path:"/v1/act/lease", isNew:true,
    body:{ shard:"CH03_S04", holder:"agent-A", ttl_s:300 },
    spec:"POST /v1/act/lease\nbody: { shard, holder, ttl_s }\n锁的粒度是原子任务片，不是整个章节。\n同一片被他人持有时 409 SHARD_LOCKED；不同片可同时持有。\n\"谁先抢到\"是伪问题，\"拆多细、怎么合并\"才是真问题。" },
  { g:"行动 ACT", id:"act.leases", method:"GET", path:"/v1/act/leases", isNew:true,
    spec:"GET /v1/act/leases\n返回活跃租约及剩余 TTL。" },
  { g:"行动 ACT", id:"act.audit", method:"GET", path:"/v1/audit",
    spec:"GET /v1/audit?limit=50\n返回 actor / verb / target / result / request_id 时间线。" },

  { g:"审批 APPROVALS", id:"approvals.list", method:"GET", path:"/v1/approvals", isNew:true,
    spec:"GET /v1/approvals?status=PENDING\n被网关拦下的请求清单。agent 可读、不可裁决 —— 可见性不构成权限。\n\nv3 之前 requires=human 只是响应里的一个字符串：写在那里，没人执行。\nv4 它有了对应的表。门控端点的请求进不来 handler，只能落在这里。" },
  { g:"审批 APPROVALS", id:"approvals.get", method:"GET", path:"/v1/approvals/{id}", isNew:true,
    spec:"GET /v1/approvals/{id}\n单查一张审批单 —— agent 手握 approval_id 时的 O(1) 路径。\n\n为什么这条重要：agent 撞墙后手里只有一个 approval_id，它最自然的下一步\n就是查这一张。没有这条路，它只能拉全表再自己过滤：队列一长就是 O(n)，\n而且把别人的单子也一并塞进了自己的上下文。\n\n注意 requires 会随状态变：还挂着时是 human（谁说了算在人），裁决后转 auto。\nnext_step 是结构化字段 —— agent 不用从散文里猜「现在该谁动」。" },
  { g:"审批 APPROVALS", id:"approvals.decide", method:"POST", path:"/v1/approvals/{id}/decide", isNew:true,
    body:{ id:"", decision:"approve", by:"user" },
    spec:"POST /v1/approvals/{id}/decide\nbody: { id, decision: approve|reject, by, reason }\n\n这是门控端点唯一的执行入口。批准时由服务端回放原始请求 ——\n不是「让 agent 再发一次」，所以 agent 永远拿不到直接执行的路径。\n\nagent 想绕过这层也做不到：confirm 的 HTTP 入口被截停，业务代码一行不跑。\n设了 APPROVAL_SECRET 的话这里还要带 X-Approval-Secret，闸门就脱离「本机即信任」。" }
];

const PROFILES = {
  "scribl.v1": { requires:"auto", checks:[
    { metric:"bitrate_kbps", value:192, target:"== 192", verdict:"PASS" },
    { metric:"sample_rate_hz", value:44100, target:"== 44100", verdict:"PASS" },
    { metric:"channels", value:"joint stereo", target:"joint stereo", verdict:"PASS" },
    { metric:"peak_db", value:-3.2, target:"< -3.0", verdict:"PASS" },
    { metric:"rms_db", value:-21.0, target:"-23 ~ -18", verdict:"PASS" },
    { metric:"head_silence_s", value:0.18, target:"< 0.25", verdict:"PASS" },
    { metric:"tail_silence_s", value:0.31, target:"< 0.25", verdict:"FAIL" },
    { metric:"duration_s", value:338.4, target:"within 300~420", verdict:"PASS" }
  ]}
};

/* ── 传输层 ────────────────────────────────────────────────
   LIVE = 后端在线：走真 HTTP + SQLite，队列/锁在别的进程里
   LIVE = false  ：降级为页面内 mock，方便离线看交互
   file:// 打开时同源为空，默认打 127.0.0.1:8787；由后端托管则走同源。
   ──────────────────────────────────────────────────────── */
const API = (location.protocol === "file:" || !location.port) ? "http://127.0.0.1:8787" : "";
let LIVE = false, SERVER = null, HEART = null;

async function api(method, path, body, idemKey){
  const r = await fetch(API + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" },
      idemKey ? { "Idempotency-Key": idemKey } : {}),
    body: (body === undefined || body === null) ? undefined : JSON.stringify(body)
  });
  let j;
  try { j = await r.json(); }
  catch(e){ j = { ok:false, requires:"agent", error:{ code:"NON_JSON_RESPONSE", message:e.message } }; }
  return { status:r.status, body:j, rid:r.headers.get("X-Request-Id") };
}

// /v1/act/{id}/confirm 这类路径模板，用请求体里的 id 补齐
function resolvePath(ep, body){
  if(ep.path.indexOf("{") < 0) return ep.path;
  const id = (body && (body.id || body.action_id || body.change_request_id)) || "";
  return ep.path.replace(/\{[^}]+\}/g, id);
}

async function refresh(){
  if(!LIVE) return null;
  const r = await api("GET", "/v1/state/bundle");
  if(r.status === 200 && r.body.ok){
    S = Object.assign({ seen:{}, seq:0 }, r.body.data);
  }
  return r;
}

const KEY = "agent-console-v2";
const STORE = {
  ok:false,
  load(){ try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; } catch(e){ return null; } },
  save(s){ try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch(e){ return false; } },
  clear(){ try { localStorage.removeItem(KEY); } catch(e){} }
};

function seed(){
  return {
    budget:{ limit:50, used:12.4, reserved:0 },
    decisions:[
      { id:"DEC-001", key:"locale", value:"en-US", immutable:true, by:"user", locked_at:"2026-09-28 10:12:00" },
      { id:"DEC-002", key:"voice.lead", value:"female, warm, slightly raspy, mid-30s", immutable:true, by:"user", locked_at:"2026-09-29 21:40:00" },
      { id:"DEC-003", key:"delivery.audio", value:"192k CBR / 44.1k / joint stereo", immutable:true, by:"user", locked_at:"2026-10-01 09:05:00" }
    ],
    assets:[
      { id:"voice.lead.ref", current_version:2, versions:[
        { v:1, value:"female, warm, mid-30s", by:"user", at:"2026-09-28 10:20:00", superseded:true, note:"初版" },
        { v:2, value:"female, warm, slightly raspy, mid-30s", by:"user", at:"2026-09-29 21:40:00", superseded:false, note:"定稿" }
      ]}
    ],
    snapshots:[
      { id:"snap_0005", at:"2026-10-03 14:12:08", action:"measure", shard:"CH03_S03", result:"PASS" },
      { id:"snap_0006", at:"2026-10-03 14:26:41", action:"measure", shard:"CH03_S02", result:"PASS" },
      { id:"snap_0007", at:"2026-10-03 14:39:55", action:"measure", shard:"CH03_S01", result:"PASS" }
    ],
    actions:[], audit:[], leases:{}, approvals:[], change_requests:[], seen:{}, seq:8
  };
}

function log(verb, target, result){
  S.audit.unshift({ ts:now().slice(11), verb, target, result, rid:reqid() });
  if(S.audit.length > 40) S.audit.pop();
}
function persist(){ STORE.ok = STORE.save(S); }

let S, cur = EPS[0], tab = "raw", last = null;

function meta(extra){
  return Object.assign({
    request_id:reqid(),
    latency_ms:+(4 + Math.random()*22).toFixed(1),
    tokens_estimate:120 + Math.floor(Math.random()*260),
    budget:{ limit_cny:S.budget.limit, used_cny:+(S.budget.used + S.budget.reserved).toFixed(2) }
  }, extra || {});
}

/* ── 离线 mock 里的同一套闸门 ────────────────────────────────
   后端不在时这套逻辑也得成立，否则「降级为 mock」就等于「闸门消失」。
   （降级时页面上会写明这一点；但闸门本身照常工作。） */
const GATED = {
  "act.confirm":            "确认执行 = 产生费用 + 不可逆副作用",
  "state.change_requests.approve": "批准变更 = 改写已锁定的决策 / 资产"
};

function mockFp(method, route, body){
  const s = method + "\u0000" + route + "\u0000" + JSON.stringify(body === undefined ? null : body);
  let a = 0x811c9dc5, b = 0x01000193;
  for(let i = 0; i < s.length; i++){
    a = Math.imul(a ^ s.charCodeAt(i), 16777619) >>> 0;
    b = (b + Math.imul(s.charCodeAt(i) + 1, i + 7)) >>> 0;
  }
  return (a.toString(16).padStart(8,"0") + b.toString(16).padStart(8,"0") +
          ((a ^ b) >>> 0).toString(16).padStart(8,"0") +
          ((a + b) >>> 0).toString(16).padStart(8,"0")).slice(0, 32);
}

function parkMock(ep, body, headers){
  const idem = (headers && headers["Idempotency-Key"]) || null;
  const fp = mockFp(ep.method, ep.path, body);      // 不含幂等键，与后端一致
  const dup = S.approvals.find(x => x.fingerprint === fp && x.status === "PENDING");
  if(dup){ dup.hits = (dup.hits || 0) + 1; log("POST", ep.path, "已挂起 · 重复请求命中 " + dup.id);
    return { status:403, body: gateBody(dup, ep, true) }; }
  const id = "apr_" + hex(6);
  const ap = { id, ep_id:ep.id, method:ep.method, route:ep.path, params:{}, body:body || null, idem,
    fingerprint:fp, hits:0, requested_by:"agent", created_at:now(), status:"PENDING", replay:null };
  S.approvals.unshift(ap); log("POST", ep.path, "403 已挂起待批 · " + id); persist();
  return { status:403, body: gateBody(ap, ep, false) };
}

function gateBody(ap, ep, deduped){
  return {
    ok:false, requires:"human",
    error:{ code:"REQUIRE_APPROVAL",
      message:"该操作不在 agent 的授权范围内。请求已原样挂起，等待人工裁决，未执行。",
      approval_id:ap.id, parked_at:ap.created_at, fingerprint:ap.fingerprint, hits:ap.hits || 0,
      fingerprint_means:"这张单子的内容摘要 —— 人批的是它，批完服务端回放的就是它，中间改不了" },
    gate:{ level:"approval", why:GATED[ep.id],
      enforced_in:"server process（网关层，非提示词）",
      parked_in:"approvals 表 · SQLite",
      bypass:"没有 HTTP 路径可绕过：该 handler 只从审批回放中被调用",
      deduped:!!deduped },
    // action 是机器语义（可 if 的枚举），suggest/why 是给人读的散文。
    // 离线 mock 也守同一条契约：跨语区 agent 不该被迫解析中文才能决定「该不该重试」。
    hints:[
      { for:"agent", action:"stop_retry", suggest:"停止重试，继续处理其他未阻塞分片", why:"重试不会让它执行，只会白烧上下文" },
      { for:"agent", action:"observe", suggest:"GET /v1/approvals/" + ap.id + " 单查这一张", why:"可见即可观测，但可见性不构成权限" },
      { for:"user",  action:"decide_approval", suggest:"在上方「待审批」里批准或驳回 " + ap.id, why:"这是该端点唯一的执行入口" }
    ],
    _meta:meta({ note:"403 而不是 202：202 暗示「稍后回来查」，而这里的正确动作是走开" })
  };
}

function handle(ep, body, headers){
  const k = ep.id;

  // 网关：门控端点在这里被截停，业务代码一行都不跑
  if(GATED[k] && !(headers && headers.__approved)) return parkMock(ep, body, headers);

  if(k === "infra.health"){ return { status:200, body:{ ok:true, requires:"auto", data:{
    service:"agent-console", version:"v6（离线 mock）", engine:"浏览器内 mock",
    process_model:"降级模式 —— 队列/锁/闸门都在本页内存里，所以这里的闸门是模拟的",
    pid:"—", port:"—", uptime_s:"—", db_path:"（无）", db_bytes:0, journal_mode:"（无）",
    endpoints:EPS.length, routes:EPS.map(e => e.method + " " + e.path),
    gate:{ policy:Object.keys(GATED).map(id => { const e = EPS.find(x => x.id === id);
        return e ? { route:e.method + " " + e.path, level:"approval", why:GATED[id] } : null; }).filter(Boolean),
      human_surface:["POST /v1/approvals/:id/decide"],
      approval_secret_required:false,
      model:"gate=授权（你能发起吗） · requires=裁决（结果谁定） · 两者正交" },
    counts:{ decisions:S.decisions.length, actions:S.actions.length,
      leases:Object.keys(S.leases).length, audit:S.audit.length,
      approvals_pending:S.approvals.filter(a => a.status === "PENDING").length,
      open_change_requests:S.change_requests.filter(c => c.status === "OPEN").length }
  }, _meta:meta() } }; }

  if(k === "infra.bundle"){ log("GET","state/bundle","200"); return { status:200, body:{
    ok:true, requires:"auto", data:{
      budget:S.budget, decisions:S.decisions.filter(d => !d.superseded_at), assets:S.assets,
      snapshots:S.snapshots.slice(-8), actions:S.actions.slice(0,30), leases:S.leases,
      audit:S.audit.slice(0,20),
      change_requests:S.change_requests.filter(c => c.status === "OPEN"),
      approvals:S.approvals.filter(a => a.status === "PENDING" || a.status === "FAILED")
        .concat(S.approvals.filter(a => a.status === "EXECUTED" || a.status === "REJECTED").slice(0,3)),
      approvals_pending:S.approvals.filter(a => a.status === "PENDING").length,
      gate_policy:Object.keys(GATED), approval_secret_required:false,
      derived_at:now()
    }, _meta:meta({ note:"一次往返取全 UI 所需状态；省掉 N 次轮询" }) } }; }

  // 契约导出只在连上后端时有意义 —— 离线时如实说「导不了」，不拿页内副本假装是契约
  if(k === "contract.openapi"){ log("GET","openapi.json","503 离线无契约"); return { status:503, body:{
    ok:false, requires:"human",
    error:{ code:"CONTRACT_NEEDS_BACKEND",
      message:"OpenAPI 导出只在连上后端时有意义：它由服务端真实的路由表与门控策略现场派生。" +
        "离线 mock 里的路由表是这一页的副本，导出它等于导出一份会撒谎的契约。" },
    hints:[
      { for:"human", suggest:"启动后端后刷新本页：node server.js（或双击 start-agent-console.cmd）",
        why:"spec 的全部价值就在于它描述的是真在跑的那个进程" },
      { for:"agent", action:"stop_retry", suggest:"不要把这份 503 当成契约缓存起来",
        why:"它不是契约，是「契约不可用」的说明" }
    ],
    _meta:meta({ note:"降级诚实：导不出来的东西就不导，不假装。服务端的 /v1/openapi.json 才是契约。" }) } }; }

  if(k === "state.project"){ log("GET","state/project","200"); return { status:200, body:{
    ok:true, requires:"auto",
    data:{ project_id:"daisy-chain", title:"Daisy Chain", locale:"en-US", status:"IN_PROGRESS",
      progress:{ chapters_total:5, chapters_locked:2, current:"CH03" }, open_questions:1, updated_at:nowISO() },
    hints:[
      { for:"agent", action:"observe", suggest:"GET /v1/state/checkpoint", why:"先取断点，避免重做已完成片段" },
      { for:"agent", action:"observe", suggest:"GET /v1/act/leases", why:"确认没有其他 agent 正持有你要动的分片" }
    ],
    _meta:meta() } }; }

  if(k === "state.decisions.list"){ const live = S.decisions.filter(d => !d.superseded_at);
    log("GET","state/decisions","200"); return { status:200, body:{
    ok:true, requires:"auto", data:{ count:live.length, decisions:live },
    _meta:meta({ note:"immutable=true 的记录不接受 agent 直接覆盖；被 supersede 的旧记录仍可回溯" }) } }; }

  if(k === "state.decisions.write"){
    if(!body || !body.key) return { status:400, body:{ ok:false, requires:"agent",
      error:{ code:"INVALID_BODY", message:"需要 key 与 value" }, _meta:meta() } };
    const hit = S.decisions.find(d => d.key === body.key && !d.superseded_at);
    if(hit && hit.immutable){ log("PUT","decisions/" + body.key,"409 已锁定"); return { status:409, body:{
      ok:false, requires:"human",
      error:{ code:"DECISION_LOCKED", message:"该决策已锁定，agent 无权覆盖", existing:hit },
      change_request:{ open:true, endpoint:"POST /v1/state/change_requests",
        payload:{ target_type:"decision", target_id:hit.id, proposed:body.value, requested_by:"agent" },
        sla:"等待人工审批，不阻塞其他分片" },
      hints:[
        { for:"agent", action:"open_change_request", suggest:"POST /v1/state/change_requests", why:"锁定项的正确出路是提变更请求，不是绕开或另建副本" },
        { for:"user", action:"decide_approval", suggest:"是否批准把 " + hit.key + " 改为「" + body.value + "」", why:"只堵不疏会逼出重复资产，状态体系反而失守" }
      ],
      _meta:meta() } }; }
    const rec = { id:"DEC-" + String(S.decisions.length + 1).padStart(3,"0"), key:body.key, value:body.value,
      immutable:body.immutable !== false, by:"agent", locked_at:now() };
    S.decisions.push(rec); log("PUT","decisions/" + body.key,"201 已锁定"); persist();
    return { status:201, body:{ ok:true, requires:"auto", data:rec, _meta:meta() } };
  }

  if(k === "state.checkpoint"){ const head = S.snapshots[S.snapshots.length - 1];
    log("GET","state/checkpoint","200"); return { status:200, body:{
    ok:true, requires:"auto",
    data:{
      snapshot_head:head.id,
      last_atomic_action:{ action:head.action, shard:head.shard, result:head.result, at:head.at },
      next:{ shard:"CH03_S04", reason:"S01–S03 已通过，S04 未开始" },
      open_exceptions:[{ shard:"CH03_S02", issue:"tail_silence 0.31s > 0.25s", requires:"auto", remedy:"规则内可修：裁到 0.20s" }],
      recent_snapshots:S.snapshots.slice(-5)
    },
    _meta:meta({ note:"断点跟着原子动作走，不跟着计划走 —— 中途改大纲也不会指向失效断点" }) } }; }

  if(k === "state.assets"){ log("GET","state/assets","200"); return { status:200, body:{
    ok:true, requires:"auto", data:{ count:S.assets.length, assets:S.assets },
    hints:[{ for:"agent", action:"use_alternative", suggest:"PUT /v1/state/assets", why:"需要变更时开新版本，不要试图修改历史版本" }],
    _meta:meta() } }; }

  if(k === "state.assets.put"){
    if(!body || !body.asset_id) return { status:400, body:{ ok:false, requires:"agent",
      error:{ code:"INVALID_BODY", message:"需要 asset_id 与 value" }, _meta:meta() } };
    const a = S.assets.find(x => x.id === body.asset_id);
    if(!a) return { status:404, body:{ ok:false, requires:"agent",
      error:{ code:"ASSET_NOT_FOUND", message:"没有资产 " + body.asset_id }, _meta:meta() } };
    if(body.target_version !== undefined && body.target_version !== null){
      const tv = a.versions.find(v => v.v === body.target_version);
      log("PUT","assets/" + a.id + "/v" + body.target_version,"409 版本不可变");
      return { status:409, body:{
        ok:false, requires:"human",
        error:{ code:"VERSION_IMMUTABLE", message:"版本 v" + body.target_version + " 已提交，永久不可修改", target:tv },
        hints:[{ for:"agent", action:"use_alternative", suggest:"去掉 target_version 重新提交", why:"变更 = 开新版本；历史版本留着做回溯和断点续跑" }],
        _meta:meta() } };
    }
    const nv = a.versions.length + 1;
    a.versions.forEach(v => v.superseded = true);
    a.versions.push({ v:nv, value:body.value, by:"agent", at:now(), superseded:false, note:body.note || "" });
    a.current_version = nv;
    log("PUT","assets/" + a.id + "/v" + nv,"201 已开新版本"); persist();
    return { status:201, body:{
      ok:true, requires:"auto",
      data:{ asset_id:a.id, new_version:nv, value:body.value, previous_versions_kept:a.versions.length - 1 },
      hints:[{ for:"agent", action:"use_alternative", suggest:"旧版本仍可回滚：由状态引用切回 v1", why:"约束与变更兼得，不必绕开锁定" }],
      _meta:meta({ note:"锁的是版本，不是资产本身" }) } };
  }

  if(k === "senses.measure"){
    const p = PROFILES[body && body.profile] || PROFILES["scribl.v1"];
    const fails = p.checks.filter(c => c.verdict === "FAIL");
    log("POST","senses/measure", fails.length ? "FAIL" : "PASS");
    return { status:200, body:{
      ok:true, requires:p.requires,
      data:{ artifact:(body && body.artifact) || "unknown", profile:(body && body.profile) || "scribl.v1",
        verdict: fails.length ? "FAIL" : "PASS", checks:p.checks, failed_metrics:fails.map(c => c.metric),
        coverage:{ automated:["格式","码率","峰值","RMS","静音时长"], not_covered:["情绪","语义连贯","风格统一"] } },
      hints: fails.length
        ? [{ for:"agent", action:"use_alternative", suggest:"规则内可修 → 本地剪辑后复测，无需唤醒决策层", why:"tail_silence 属于规则化可判定项" },
           { for:"agent", action:"use_alternative", suggest:"若修复策略超出既定规则 → POST /v1/senses/judge", why:"越界异常不要猜，升级比乱改便宜" }]
        : [],
      _meta:meta({ note:"requires=auto 表示此项无需人工介入；not_covered 诚实标注能力边界" }) } };
  }

  if(k === "senses.transcribe"){ log("POST","senses/transcribe","200"); return { status:200, body:{
    ok:true, requires:"auto",
    data:{ artifact:(body && body.artifact) || "unknown", language:(body && body.language) || "en-US", word_count:2847,
      segments:[
        { i:0, start:"00:00.00", end:"00:04.82", speaker:"narrator", text:"The letter arrived on a Tuesday, which was itself a kind of warning.", conf:0.94 },
        { i:1, start:"00:04.82", end:"00:09.31", speaker:"narrator", text:"Nobody in Bellflower sent letters on a Tuesday.", conf:0.96 },
        { i:2, start:"00:09.31", end:"00:13.77", speaker:"mara", text:"You're telling me the postman waited.", conf:0.91 },
        { i:3, start:"00:13.77", end:"00:18.05", speaker:"narrator", text:"He had. For forty minutes, in the rain, without knocking twice.", conf:0.88 }
      ], truncated:true },
    _meta:meta({ note:"truncated=true：需要更多请带 offset，别一次全取" }) } }; }

  if(k === "senses.judge"){
    const kind = (body && body.kind) || "semantic";
    const isRule = kind === "rule";
    log("POST","senses/judge", isRule ? "自动判定" : "已升级");
    if(isRule) return { status:200, body:{
      ok:true, requires:"auto",
      data:{ subject:(body && body.subject) || "-", question:(body && body.question) || "-", kind,
        verdict:"PASS", escalated:false, decided_by:"rules" },
      _meta:meta() } };
    return { status:200, body:{
      ok:true, requires:"human_or_llm",
      data:{ subject:(body && body.subject) || "-", question:(body && body.question) || "-", kind,
        verdict:"UNDETERMINED", escalated:true, decided_by:null, queued_as:"APPROVAL",
        auto_checks:[{ name:"duration_in_range", verdict:"PASS" }, { name:"loudness_match_prev", verdict:"PASS" }],
        not_automatable:[
          { name:"emotional_continuity", why:"需要理解 CH02 结尾的语境" },
          { name:"style_consistency", why:"无客观阈值可定义" }
        ] },
      hints:[
        { for:"user", action:"provide_input", suggest:"审听 CH03_S04，与 CH02 结尾对照判断情绪连贯", why:"此类判定无法规则化，接口不假装能自动给出答案" },
        { for:"agent", action:"continue_other_shards", suggest:"挂起该分片，继续处理未阻塞的其他分片", why:"升级不等于全局阻塞" }
      ],
      _meta:meta({ note:"诚实标注能力边界：能自动的自动，不能自动的明确升级" }) } };
  }

  if(k === "senses.diff"){ log("GET","senses/diff","200"); return { status:200, body:{
    ok:true, requires:"auto",
    data:{ from:"v11", to:"v12", changed_count:3, unchanged_count:1847,
      changed:[
        { field:"chapters[2].title", before:"The Third Loop", after:"Before the Loop" },
        { field:"chapters[2].scenes[3].lines[11].text", before:"You told me first.", after:"You told me before I asked." },
        { field:"metadata.updated_at", before:"2026-10-02 18:22:11", after:"2026-10-03 15:04:52" }
      ] },
    _meta:meta({ note:"1847 项未变，已折叠" }) } }; }

  if(k === "act.queue"){
    if(!headers || !headers["Idempotency-Key"]){ log("POST","act/queue","400 缺幂等键"); return { status:400, body:{
      ok:false, requires:"agent",
      error:{ code:"IDEMPOTENCY_KEY_REQUIRED", message:"写操作必须携带 Idempotency-Key" },
      hints:[{ for:"agent", action:"retry_with_idempotency_key", suggest:"重试并附带 Header: Idempotency-Key", why:"幂等键是存储层唯一约束的入口，不是可选项" }],
      _meta:meta() } }; }

    const key = headers["Idempotency-Key"];
    if(S.seen[key]){ log("POST","act/queue","幂等重放"); return { status:200, body:{
      ok:true, replayed:true, requires:"auto",
      data:{ action_id:S.seen[key].id, status:S.seen[key].status, cost_cny:S.seen[key].cost },
      idempotency:{ key, storage_constraint:"UNIQUE(idem_key)", behaviour:"first_response_returned" },
      hints:[{ for:"agent", action:"stop_retry", suggest:"该动作已在队列中，不要轮询", why:"重发已生效，未产生第二次副作用" }],
      _meta:meta({ note:"重复请求返回首次响应，不是重新执行" }) } }; }

    const cost = Number(body && body.cost_cny) || 0;
    const spent = S.budget.used + S.budget.reserved;
    if(cost > 0 && spent + cost > S.budget.limit){ log("POST","act/queue","402 超预算"); return { status:402, body:{
      ok:false, requires:"human",
      error:{ code:"BUDGET_EXCEEDED", message:"超出本月预算上限，动作未入队",
        budget:{ limit_cny:S.budget.limit, used_cny:+(spent).toFixed(2), requested_cny:cost, over_by:+(spent + cost - S.budget.limit).toFixed(2) } },
      hints:[{ for:"user", action:"raise_limit", suggest:"提高上限，或改为本地剪辑修复", why:"闸门在存储与网关层，agent 无法自行绕过" }],
      _meta:meta() } }; }

    const route = (body && body.route) || "approve";
    if(route === "auto" && cost > 0){ log("POST","act/queue","422 路由冲突"); return { status:422, body:{
      ok:false, requires:"agent",
      error:{ code:"ROUTE_CONFLICT", message:"route=auto 不允许花钱动作", route, cost_cny:cost },
      hints:[{ for:"agent", action:"use_alternative", suggest:"改为 route:approve", why:"自动队列只放行零成本、幂等、规则内的动作" }],
      _meta:meta() } }; }

    const id = "act_" + hex(6);
    const status = route === "auto" ? "EXECUTED" : route === "conditional" ? "AWAITING_CONDITION" : "PENDING_CONFIRMATION";
    const rec = { id, kind:(body && body.kind) || "unknown", shard:(body && body.shard) || "-",
      cost, route, status, idem:key, created_at:now() };
    if(route === "auto") S.budget.used += cost; else S.budget.reserved += cost;
    S.actions.unshift(rec); S.seen[key] = rec;
    S.seq += 1;
    S.snapshots.push({ id:"snap_" + String(S.seq).padStart(4,"0"), at:now(), action:rec.kind, shard:rec.shard, result:status });
    log("POST","act/queue", route + " → " + status); persist();
    return { status:201, body:{
      ok:true, requires: route === "auto" ? "auto" : "human",
      data:rec,
      routing:{ route, why: route === "auto" ? "零成本 + 幂等 + 规则内" : route === "conditional" ? "等待条件满足" : "涉及成本，必须人工放行" },
      gate:{ policy:"confirm-before-call", reason:"cost > 0", next:"POST /v1/act/" + id + "/confirm" },
      hints:[
        { for:"agent", action:"stop_retry", suggest:"不要轮询，继续处理其他未阻塞分片", why:"轮询浪费上下文且不会加速" },
        { for:"agent", action:"claim_lease", suggest:"POST /v1/act/lease 先占住该分片", why:"避免其他 agent 同时动手" }
      ],
      _meta:meta() } };
  }

  if(k === "act.confirm" || k === "act.rollback"){
    const target = (body && body.action_id) || "";
    if(!target) return { status:400, body:{ ok:false, requires:"agent", error:{ code:"INVALID_BODY", message:"需要 action_id" }, _meta:meta() } };
    const rec = S.actions.find(a => a.id === target);
    if(!rec) return { status:404, body:{ ok:false, requires:"agent", error:{ code:"ACTION_NOT_FOUND", message:"队列中没有 " + target }, _meta:meta() } };

    if(k === "act.confirm"){
      if(rec.status !== "PENDING_CONFIRMATION"){ log("POST","act/" + rec.id + "/confirm","409 状态非法"); return { status:409, body:{
        ok:false, requires:"agent", error:{ code:"INVALID_STATE", message:"当前状态 " + rec.status + " 不可确认" }, _meta:meta() } }; }
      rec.status = "EXECUTED"; S.budget.reserved -= rec.cost; S.budget.used += rec.cost;
      log("POST","act/" + rec.id + "/confirm", "已执行 · ¥" + rec.cost.toFixed(2)); persist();
      return { status:200, body:{ ok:true, requires:"auto", data:rec, _meta:meta({ note:"已扣除预算并写入审计" }) } };
    }
    if(rec.status !== "EXECUTED"){ log("POST","act/" + rec.id + "/rollback","409 状态非法"); return { status:409, body:{
      ok:false, requires:"agent", error:{ code:"INVALID_STATE", message:"只有 EXECUTED 可回滚" }, _meta:meta() } }; }
    rec.status = "ROLLED_BACK"; S.budget.used -= rec.cost;
    log("POST","act/" + rec.id + "/rollback", "已回滚 · 退还 ¥" + rec.cost.toFixed(2)); persist();
    return { status:200, body:{ ok:true, requires:"auto", data:rec,
      compensation:{ refunded_cny:rec.cost, artifacts_deleted:1 }, _meta:meta() } };
  }

  if(k === "act.lease"){
    const shard = body && body.shard, holder = body && body.holder;
    if(!shard || !holder) return { status:400, body:{ ok:false, requires:"agent",
      error:{ code:"INVALID_BODY", message:"需要 shard 与 holder" }, _meta:meta() } };
    const held = S.leases[shard];
    if(held && held.holder !== holder){
      log("POST","act/lease/" + shard, "409 已被 " + held.holder + " 持有");
      const nextShard = shard.replace(/(\d+)$/, m => String(+m + 1).padStart(m.length, "0"));
      return { status:409, body:{
        ok:false, requires:"agent",
        error:{ code:"SHARD_LOCKED", message:"分片 " + shard + " 已被持有", holder_at_fault:held.holder, expires_at:held.expires_at },
        hints:[
          { for:"agent", action:"use_alternative", suggest:"改领空闲分片，例如 " + nextShard, why:"并行靠分片，不靠抢占" },
          { for:"agent", action:"observe", suggest:"GET /v1/act/leases 查看哪些片空闲", why:"先看再动，别撞" }
        ],
        _meta:meta({ note:"锁粒度=原子任务片；同章节的不同片之间不冲突" }) } };
    }
    const renewed = !!held;
    const ttl = (body && body.ttl_s) || 300;
    S.leases[shard] = { shard, holder, ttl_s:ttl, acquired_at:now(),
      expires_at:new Date(Date.now() + ttl*1000).toISOString().slice(11,19) };
    log("POST","act/lease/" + shard, renewed ? "续约" : "已获取 · " + holder); persist();
    return { status:200, body:{
      ok:true, requires:"auto",
      data:S.leases[shard], renewed,
      concurrency:{ note:"同一分片同一时间只有一个持有者；不同分片可并行", active_leases:Object.keys(S.leases).length },
      _meta:meta() } };
  }

  if(k === "act.leases"){ log("GET","act/leases","200"); return { status:200, body:{
    ok:true, requires:"auto",
    data:{ count:Object.keys(S.leases).length, leases:Object.values(S.leases) },
    _meta:meta({ note:"细粒度锁让 N 个 agent 各领一片，而不是排队等整个章节" }) } }; }

  if(k === "state.change_requests"){ log("GET","state/change_requests","200"); return { status:200, body:{
    ok:true, requires:"auto",
    data:{ count:S.change_requests.length, open:S.change_requests.filter(c => c.status === "OPEN").length,
      change_requests:S.change_requests.map(c => Object.assign({}, c,
        { approve:"POST /v1/state/change_requests/" + c.id + "/approve" })) },
    _meta:meta({ note:"409 里给出的通路在这里落地 —— 之前那个端点只是承诺，现在是实现" }) } }; }

  if(k === "state.change_requests.create"){
    const id = "CHG-" + hex(6);
    const rec = { id, target_type:(body && body.target_type) || "-", target_id:(body && body.target_id) || "-",
      target_key:(body && body.target_key) || null, current_value:(body && body.current_value) || null,
      proposed:String((body && body.proposed) != null ? body.proposed : ""), requested_by:"agent",
      created_at:now(), status:"OPEN" };
    S.change_requests.unshift(rec); log("POST","change_requests/" + id,"已受理 · 待审批"); persist();
    return { status:201, body:{ ok:true, requires:"human",
      data:{ id, status:"OPEN", target_type:rec.target_type, target_id:rec.target_id, proposed:rec.proposed },
      approve:{ endpoint:"POST /v1/state/change_requests/" + id + "/approve", requires:"human" },
      hints:[{ for:"user", action:"decide_approval", suggest:"审批或驳回；未审批不影响其他分片继续", why:"变更走正式通路，历史版本可回溯" }],
      _meta:meta() } };
  }

  if(k === "state.change_requests.approve"){
    /* 门控已在 handle 顶部截停 —— 能走到这里只有一个原因：本次调用来自审批回放
       （headers.__approved）。这就是「唯一执行路径」在代码里的样子。 */
    const id = (body && body.id) || "";
    const cr = S.change_requests.find(c => c.id === id);
    if(!cr) return { status:404, body:{ ok:false, requires:"agent",
      error:{ code:"CHANGE_REQUEST_NOT_FOUND", message:"没有 " + id }, _meta:meta() } };
    if(cr.status !== "OPEN") return { status:409, body:{ ok:false, requires:"agent",
      error:{ code:"INVALID_STATE", message:"该请求已是 " + cr.status }, _meta:meta() } };
    const by = (body && body.by) || "user";
    let out;
    if(cr.target_type === "decision"){
      const old = S.decisions.find(d => d.id === cr.target_id && !d.superseded_at);
      if(!old) return { status:404, body:{ ok:false, requires:"agent",
        error:{ code:"DECISION_NOT_FOUND", message:"目标决策不存在" }, _meta:meta() } };
      old.superseded_at = now();
      const rec = { id:"DEC-" + String(S.decisions.length + 1).padStart(3,"0"), key:old.key,
        value:cr.proposed, immutable:true, by, locked_at:now(), previous_id:old.id };
      S.decisions.push(rec);
      out = { applied_to:"decision", superseded:{ id:old.id, key:old.key, value:old.value }, current:rec };
    } else if(cr.target_type === "asset"){
      const a = S.assets.find(x => x.id === cr.target_id);
      if(!a) return { status:404, body:{ ok:false, requires:"agent",
        error:{ code:"ASSET_NOT_FOUND", message:"目标资产不存在" }, _meta:meta() } };
      const nv = a.versions.length + 1;
      a.versions.forEach(v => v.superseded = true);
      a.versions.push({ v:nv, value:cr.proposed, by, at:now(), superseded:false, note:"经变更请求 " + cr.id + " 批准" });
      a.current_version = nv;
      out = { applied_to:"asset", asset_id:a.id, new_version:nv };
    } else return { status:422, body:{ ok:false, requires:"agent",
      error:{ code:"UNSUPPORTED_TARGET", message:"不支持的 target_type: " + cr.target_type }, _meta:meta() } };
    cr.status = "APPROVED"; cr.resolved_at = now(); cr.resolved_by = by;
    log("POST","change_requests/" + cr.id + "/approve","已批准 · " + by); persist();
    return { status:200, body:{ ok:true, requires:"auto",
      data:Object.assign({ change_request_id:cr.id, status:"APPROVED" }, out),
      _meta:meta({ note:"变更走正式通路：旧记录 superseded 而不是被改写，可回溯" }) } };
  }

  if(k === "approvals.get"){
    const id = (body && (body.id || body.approval_id)) || "";
    const ap = S.approvals.find(a => a.id === id);
    if(!ap){ log("GET","approvals/" + id,"404");
      return { status:404, body:{ ok:false, requires:"agent",
        error:{ code:"APPROVAL_NOT_FOUND", message:"没有这张审批单", id },
        hints:[{ for:"agent", action:"observe", suggest:"GET /v1/approvals?status=PENDING 列出全部待批单",
          why:"确认 id 有没有写错；也可能这张单已被清理" }], _meta:meta() } }; }
    const pending = ap.status === "PENDING";
    log("GET","approvals/" + id,"200");
    return { status:200, body:{ ok:true, requires:pending ? "human" : "auto",
      data:Object.assign({}, ap, { pending,
        who_can_advance: pending ? "human" : "nobody（已裁决，终态）",
        next_step: pending
          ? { human:"POST /v1/approvals/" + id + "/decide {decision: approve|reject}",
              agent:"wait —— 可见性不构成权限，重发原请求不会推进它" }
          : { settled:true, see:"replay 字段：批准时已回放原请求，你不必再发一次" } }),
      hints: pending
        ? [ { for:"agent", action:"wait_for_human", suggest:"等待人工裁决。不要轮询，也不要重发原请求",
              why:"唯一能推进它的动作是人 —— 轮询和重发都只会白烧上下文" },
            { for:"user", action:"decide_approval", suggest:"批准或驳回 " + id, why:"这是该端点唯一的执行入口" } ]
        : [ { for:"agent", action:"observe", suggest:"已裁决。读 replay 字段看回放结果，不要重发原请求",
              why:"副作用已经发生过了，再发一次不会让它变成两次" } ],
      _meta:meta({ note:"requires 随状态变：还挂着时谁说了算在人，裁决后转 auto" }) } };
  }

  if(k === "approvals.list"){
    const st = (body && body.status) || "";
    const rows = st ? S.approvals.filter(a => a.status === st) : S.approvals;
    log("GET","approvals","200");
    return { status:200, body:{ ok:true, requires:"auto", data:{
      count:rows.length, pending:S.approvals.filter(a => a.status === "PENDING").length,
      approvals:rows, gate_policy:Object.keys(GATED) },
      hints:[
        { for:"agent", action:"observe", suggest:"只读。看到自己的请求挂在这里就说明它没被执行", why:"agent 可见但不可裁决 —— 可见性不构成权限" },
        { for:"user", action:"decide_approval", suggest:"在待审批面板逐条批准或驳回", why:"这是门控端点唯一的执行入口" }
      ],
      _meta:meta({ note:"挂在存储里，不是内存队列：换个标签页看到的还是同一份待批" }) } };
  }

  if(k === "approvals.decide"){
    const id = (body && (body.id || body.approval_id)) || "";
    const ap = S.approvals.find(a => a.id === id);
    if(!ap) return { status:404, body:{ ok:false, requires:"agent",
      error:{ code:"APPROVAL_NOT_FOUND", message:"没有 " + id }, _meta:meta() } };
    if(body.decision !== "approve" && body.decision !== "reject")
      return { status:400, body:{ ok:false, requires:"agent",
        error:{ code:"INVALID_BODY", message:"decision 必须是 'approve' 或 'reject'" }, _meta:meta() } };
    if(ap.status !== "PENDING") return { status:409, body:{ ok:false, requires:"agent",
      error:{ code:"ALREADY_DECIDED", message:"该审批单已是 " + ap.status, current:ap.status }, _meta:meta() } };
    const by = body.by || "user";
    if(body.decision === "reject"){
      ap.status = "REJECTED"; ap.decided_by = by; ap.decided_at = now();
      ap.reason = body.reason || null;
      log("POST","approvals/" + ap.id + "/decide","已驳回 · " + by); persist();
      return { status:200, body:{ ok:true, requires:"auto", data:{
        approval_id:ap.id, status:"REJECTED", decided_by:by, decided_at:now(),
        side_effects:"无 —— 请求从未被执行，账没动，资产没动" }, _meta:meta() } };
    }
    const target = EPS.find(e => e.id === ap.ep_id);
    const t0 = ap.idem || idem();
    const out = handle(target, ap.body,
      { "__approved":true, "Idempotency-Key":t0, __decided_by:by });
    ap.status = out.status >= 200 && out.status < 300 ? "EXECUTED" : "FAILED";
    ap.decided_by = by; ap.decided_at = now();
    ap.replay = { method:ap.method, route:ap.route, params:ap.params, status:out.status, body:out.body, at:now() };
    log("POST","approvals/" + ap.id + "/decide","已批准 · 回放 " + ap.method + " " + ap.route + " → " + out.status);
    persist();
    return { status:200, body:{ ok:true, requires:out.status < 300 ? "auto" : "human", data:{
      approval_id:ap.id, status:ap.status, decided_by:by, decided_at:now(), fingerprint:ap.fingerprint,
      replay:{ method:ap.method, route:ap.route, params:ap.params, status:out.status, body:out.body, at:now() } },
      _meta:meta({ note:"执行发生在批准这一步，由存储层回放原始请求 —— agent 从未拿到直接执行的路径" }) } };
  }

  if(k === "act.audit"){ log("GET","audit","200"); return { status:200, body:{
    ok:true, requires:"auto", data:{ count:S.audit.length, entries:S.audit.slice(0,20) }, _meta:meta() } }; }
}

function renderCatalog(){
  let out = "", g = null;
  EPS.forEach(e => {
    if(e.g !== g){ g = e.g; out += '<div class="grp">' + g + "</div>"; }
    out += '<div class="ep' + (e === cur ? " on" : "") + '" data-id="' + e.id + '">' +
      '<span class="m ' + e.method + '">' + e.method + "</span><code>" + e.path.replace("/v1","") + "</code>" +
      (e.isNew ? '<span class="new">新</span>' : "") + "</div>";
  });
  $("catalog").innerHTML = out;
  $("catalog").querySelectorAll(".ep").forEach(el => el.onclick = () => select(el.dataset.id));
}

function select(id){
  cur = EPS.find(e => e.id === id);
  $("mpill").className = "m " + cur.method;
  $("mpill").textContent = cur.method;
  $("path").value = cur.path;
  $("bodywrap").style.display = cur.method === "GET" ? "none" : "block";
  if(cur.method !== "GET"){
    if(cur.id === "act.confirm" || cur.id === "act.rollback"){
      const t = S.actions.find(a => a.status === (cur.id === "act.confirm" ? "PENDING_CONFIRMATION" : "EXECUTED"));
      $("body").value = JSON.stringify({ action_id: t ? t.id : "" }, null, 2);
    } else if(cur.id === "state.assets.put"){
      $("body").value = JSON.stringify({ asset_id:S.assets[0].id, value:"female, warm, breathy, mid-30s", note:"客户要求气声更明显" }, null, 2);
    } else if(cur.id === "state.change_requests.approve"){
      const cr = (S.change_requests || [])[0];
      $("body").value = JSON.stringify({ id: cr ? cr.id : "", by:"user" }, null, 2);
      $("path").value = "/v1/state/change_requests/" + (cr ? cr.id : "{id}") + "/approve";
    } else if(cur.id === "approvals.decide"){
      const ap = (S.approvals || []).find(a => a.status === "PENDING");
      $("body").value = JSON.stringify({ id: ap ? ap.id : "", decision:"approve", by:"user" }, null, 2);
      $("path").value = "/v1/approvals/" + (ap ? ap.id : "{id}") + "/decide";
    } else if(cur.id === "state.change_requests.create"){
      const d = S.decisions[1] || S.decisions[0] || {};
      $("body").value = JSON.stringify({ target_type:"decision", target_id:d.id || "", target_key:d.key || "",
        current_value:d.value || "", proposed:"female, warm, breathy", requested_by:"agent" }, null, 2);
    } else $("body").value = JSON.stringify(cur.body || {}, null, 2);
  }
  renderCatalog();
  last = null;
  renderResp();
}

const CODES = { 0:"c5", 200:"c2", 201:"c2", 400:"c4", 401:"c5", 402:"c5", 403:"c5", 404:"c4", 409:"c5", 422:"c4", 500:"c5", 503:"c5" };
const LABELS = { 0:"NO_RESPONSE", 200:"OK", 201:"CREATED", 400:"BAD_REQUEST", 401:"UNAUTHORIZED", 402:"PAYMENT_REQUIRED", 403:"FORBIDDEN", 404:"NOT_FOUND", 409:"CONFLICT", 422:"UNPROCESSABLE", 500:"INTERNAL_ERROR", 503:"SERVICE_UNAVAILABLE" };

function renderResp(){
  const box = $("resp");
  if(!last){ box.innerHTML = '<div class="empty">选一个接口，点「发送」看它真正返回什么。带「新」标记的是 v3 新增或改过。</div>'; return; }
  const code = last.status, ep = last.ep;
  const shown = last.path || ep.path;
  let head = '<div class="rhead"><span class="code ' + (CODES[code] || "c5") + '">' + code + " " + LABELS[code] + "</span>" +
    '<span class="tt">' + ep.method + " " + esc(shown) + "</span>" +
    '<span class="tt" style="margin-left:auto">' + (LIVE ? "实测 " : "模拟 ") + last.ms + " ms · ~" + last.tokens + " tokens" +
    (last.rid ? " · " + esc(last.rid) : "") + "</span></div>";

  if(code === 0) head += '<div class="warnstrip">没有收到响应 —— 后端进程不在。启动方式见下方页脚。</div>';

  const req = last.body && last.body.requires;
  if(req === "human") head += '<div class="warnstrip">requires=human —— 这个决策不该由 agent 独自完成，已进入审批队列。</div>';
  else if(req === "human_or_llm") head += '<div class="warnstrip">requires=human_or_llm —— 接口没有假装能自动判定，无法自动化的部分被显式升级。</div>';
  else if(req === "auto") head += '<div class="infostrip">requires=auto —— 系统可自行判定并继续，无需唤醒决策层。</div>';

  const ec = last.body && last.body.error && last.body.error.code;
  if(ec === "SHARD_LOCKED") head += '<div class="warnstrip">分片已被他人持有。注意：冲突的是<b>这一片</b>，不是整个章节 —— 换一片就能继续跑。</div>';
  else if(ec === "DECISION_LOCKED") head += '<div class="warnstrip">决策已锁定，但响应里给了 <b>change_request</b> 通路 —— 只堵不疏会逼出绕路和重复资产。</div>';
  else if(ec === "VERSION_IMMUTABLE") head += '<div class="warnstrip">历史版本不可改。去掉 target_version 重新提交即自动开新版本 —— 堵得住，也走得通。</div>';
  else if(code === 409) head += '<div class="warnstrip">冲突：状态或版本不允许该操作，响应附带合法出路。</div>';
  if(code === 402) head += '<div class="warnstrip">闸门生效：动作未入队，预算未被占用。拦截发生在存储与网关层，不依赖 agent 自觉。</div>';
  if(code === 422) head += '<div class="warnstrip">路由冲突：自动队列只放行零成本幂等动作，花钱的一律走审批。</div>';
  if(ec === "REQUIRE_APPROVAL") head += '<div class="warnstrip">网关截停：请求已挂到<b>待审批</b>，业务代码一行没跑。' +
    '这不是「agent 不该做」，是「agent 做不了」—— 想绕开闸门也没有路径，因为能执行它的代码只有一行，在审批回放里。</div>';
  if(ec === "ALREADY_DECIDED") head += '<div class="warnstrip">这张审批单已经裁决过了。第二次不会再执行 —— 先到的那次已经产生了副作用。</div>';
  if(ec === "APPROVAL_SECRET_REQUIRED") head += '<div class="warnstrip">裁决端点已启用密钥保护：请求需带 <code>X-Approval-Secret</code>。' +
    '此时闸门脱离「本机即信任」——它保护的不是资产，是「谁能裁决」。</div>';
  if(last.replayed) head += '<div class="infostrip">幂等键命中：返回的是<b>首次响应</b>，不是重新执行的结果。</div>';
  if(last.body && last.body.replay && last.body.replay.route)
    head += '<div class="infostrip">本次执行发生在<b>批准</b>这一步：服务端取出原请求回放了一遍（原样回放 ' +
      last.body.replay.method + ' <code>' + last.body.replay.route + '</code>）。agent 自己始终没拿到执行路径。</div>';

  const json = JSON.stringify(last.body, null, 2);
  if(tab === "raw") box.innerHTML = head + "<pre>" + highlight(json) + "</pre>";
  else if(tab === "tree") box.innerHTML = head + '<div style="border:1px solid #EAE8E1;border-radius:9px;padding:12px;background:#FAFAF8;max-height:500px;overflow:auto">' + tree(last.body) + "</div>";
  else box.innerHTML = head + "<pre>" + esc(ep.spec || "（无契约）") + "</pre>";
}

function shortOp(rq){
  const r = (rq && rq.route) || "";
  if(/confirm/.test(r)) return "确认执行";
  if(/change_requests\/[^/]+\/approve/.test(r)) return "批准变更";
  return "受控操作";
}

function renderApprovals(){
  const list = S.approvals || [];
  const pend = list.filter(a => a.status === "PENDING");
  const c = $("aprcnt");
  if(c){ c.className = "cnt" + (pend.length ? "" : " zero"); c.textContent = pend.length; }

  const G = { PENDING:["","待裁决"], EXECUTED:["ok","已放行"], REJECTED:["gr","已驳回"], FAILED:["","回放失败"] };
  let html = '<div class="gatelock">门控在服务端：<code>confirm</code> 与 <code>change_requests/:id/approve</code> 的 HTTP 入口被网关截停，' +
    '业务代码一行不跑。agent 只能把请求挂到这张表里 —— 能执行它的只有下面这个按钮。</div>';

  if(!list.length){
    html += '<div class="empty">无待审批项 —— agent 的请求要么在授权范围内，要么还没发起。</div>';
  } else {
    html += list.slice(0,4).map(a => {
      const g = G[a.status] || ["gr", a.status];
      const rq = a.request || { method:a.method || "?", route:a.route || "?", idempotency_key:a.idem };
      let btns = "";
      if(a.status === "PENDING")
        btns = '<div class="arow"><button class="primary" data-d="approve" data-i="' + a.id + '">批准执行</button>' +
               '<button data-d="reject" data-i="' + a.id + '">驳回</button></div>';
      const rp = a.replay
        ? '<div class="afp">已回放 → HTTP ' + a.replay.status + "</div>" : "";
      return '<div class="apr ' + (a.status === "EXECUTED" ? "done" : a.status === "REJECTED" ? "dead" : "") + '">' +
        '<div class="ahd"><b>' + esc(shortOp(rq)) + '</b><span class="abadge ' + g[0] + '">' + g[1] + "</span></div>" +
        '<div class="areq">' + esc(rq.method + " " + rq.route) + "</div>" +
        '<div class="areq">由 ' + esc(a.requested_by || "-") + " 发起 · " + esc(a.created_at || "-") + "</div>" +
        '<div class="afp">fp ' + esc(a.fingerprint || "-") + "<br>" + esc(a.id) + "</div>" + rp + btns + "</div>";
    }).join("");
    if(list.length > 4) html += '<div class="empty">还有 ' + (list.length - 4) + " 条 —— GET /v1/approvals 看全量。</div>";
  }
  $("apr").innerHTML = html;
  $("apr").querySelectorAll("button[data-d]").forEach(b => b.onclick = () => decide(b.dataset.i, b.dataset.d));
}

async function decide(id, d){
  const ep = EPS.find(e => e.id === "approvals.decide");
  const path = "/v1/approvals/" + id + "/decide";
  const payload = { id, decision:d, by:"user" };
  select(ep.id);                       // 会清空 last，所以放在前面
  $("path").value = path;
  $("body").value = JSON.stringify(payload, null, 2);
  if(LIVE){
    const t0 = performance.now();
    const res = await api("POST", path, payload, idem());
    last = { ep, path, body:res.body, status:res.status, ms:(performance.now() - t0).toFixed(1),
      tokens:(res.body && res.body._meta ? res.body._meta.tokens_estimate : "—"), rid:res.rid };
    await refresh();
  } else {
    const res = handle(ep, payload, {});
    last = { ep, path, body:res.body, status:res.status,
      ms:(4 + Math.random()*18).toFixed(1), tokens:120 + Math.floor(Math.random()*200) };
  }
  renderResp(); renderAll();
}

function renderBudget(){
  const spent = S.budget.used + S.budget.reserved;
  const pct = Math.min(100, spent / S.budget.limit * 100);
  const cls = pct >= 100 ? "over" : pct >= 80 ? "hot" : "";
  $("budget").innerHTML =
    '<div class="brow"><span>已用 ¥' + spent.toFixed(2) + '</span><span>上限 ¥' + S.budget.limit.toFixed(2) + "</span></div>" +
    '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div>' +
    '<div class="brow"><span>已确认 ¥' + S.budget.used.toFixed(2) + '</span><span>挂起 ¥' + S.budget.reserved.toFixed(2) + "</span></div>" +
    '<button class="tiny" id="push" style="margin-top:10px;width:100%">演示：把已用推到 ¥49.80</button>';
  const pb = $("push");
  if(pb) pb.onclick = async () => {
    if(LIVE){
      await api("POST", "/v1/demo/push_budget", { used: 49.8 });
      await refresh(); renderAll();
    } else {
      S.budget.used = 49.8; log("DEMO","budget","已用调整为 ¥49.80"); persist(); renderAll();
    }
  };
}

function renderLeases(){
  const ls = Object.values(S.leases);
  if(!ls.length){ $("leases").innerHTML = '<div class="empty">无活跃租约 —— 调 POST /act/lease 占一片试试。</div>'; return; }
  $("leases").innerHTML = ls.map(l =>
    '<div class="lease"><span class="dot' + (l.holder === "agent-A" ? "" : " other") + '"></span>' +
    '<span class="sh">' + esc(l.shard) + "</span>" +
    '<span class="ho">' + esc(l.holder) + " · " + l.ttl_s + "s</span></div>").join("");
}

function renderQueue(){
  if(!S.actions.length){ $("queue").innerHTML = '<div class="empty">队列为空。</div>'; return; }
  $("queue").innerHTML = S.actions.slice(0,5).map(a => {
    const map = { PENDING_CONFIRMATION:["t-pend","待确认"], EXECUTED:["t-exec","已执行"],
      ROLLED_BACK:["t-roll","已回滚"], AWAITING_CONDITION:["t-cond","等条件"] };
    const t = map[a.status] || ["t-roll", a.status];
    let btns = "";
    if(a.status === "PENDING_CONFIRMATION")
      btns = '<div class="arow"><button data-a="confirm" data-i="' + a.id + '">申请确认</button></div>';
    else if(a.status === "EXECUTED")
      btns = '<div class="arow"><button data-a="rollback" data-i="' + a.id + '">回滚</button></div>';
    return '<div class="act ' + (a.status === "PENDING_CONFIRMATION" ? "" : a.status === "EXECUTED" ? "exec" : "roll") + '">' +
      '<div class="ahead"><b>' + esc(a.kind) + '</b><span class="tag ' + t[0] + '">' + t[1] + "</span></div>" +
      '<div class="ameta">' + a.id + " · " + esc(a.shard) + " · ¥" + a.cost.toFixed(2) + " · route:" + a.route + "</div>" + btns + "</div>";
  }).join("") +
  '<div class="afp" style="margin-top:6px">「申请确认」现在只会得到 403 —— 请求被挂到上方待审批，放行与否由人决定。</div>';
  $("queue").querySelectorAll("button").forEach(b => b.onclick = () => actOn(b.dataset.a, b.dataset.i));
}

function renderAudit(){
  if(!S.audit.length){ $("audit").innerHTML = '<div class="empty">暂无记录。</div>'; return; }
  $("audit").innerHTML = S.audit.slice(0,10).map(l =>
    '<div class="logline"><span class="ts">' + l.ts + '</span><span class="vd">' + esc(l.verb + " " + l.target) +
    '</span><span class="' + (/已执行|已锁定|已回滚|已获取|已开新版本|续约/.test(l.result) ? "ok" : "bad") + '">' + esc(l.result) + "</span></div>").join("");
}

function renderStore(){
  const p = $("storepill");
  const pend = (S.approvals || []).filter(a => a.status === "PENDING").length;
  if(LIVE && SERVER){
    p.className = "pill"; p.textContent = "● 已连后端 · SQLite · pid " + SERVER.pid + (pend ? " · " + pend + " 待批" : "");
  }
  else if(STORE.ok){ p.className = "pill warn"; p.textContent = "● 后端未连接 · 浏览器存储兜底 · 闸门守本页内存"; }
  else { p.className = "pill warn"; p.textContent = "● 内存模式 · 刷新即丢"; }
  renderFooter();
}

function renderFooter(){
  const el = $("srv");
  if(!el) return;
  if(LIVE && SERVER){
    const g = SERVER.gate || {};
    const gp = (g.policy || []).length;
    el.innerHTML =
      '<b style="color:#3B6D11">后端在线</b> · ' + esc(SERVER.engine) + ' · pid ' + SERVER.pid +
      ' · uptime ' + SERVER.uptime_s + 's · ' + SERVER.endpoints + ' 端点 · journal ' + esc(SERVER.journal_mode) + '<br>' +
      '<b>数据落盘</b> <code>' + esc(SERVER.db_path) + '</code> · ' + (SERVER.db_bytes/1024).toFixed(1) + ' KB<br>' +
      '<b>队列与锁</b> 由该进程持有 —— 页面只是客户端，关掉它动作也发不出去<br>' +
      '<b>网关</b> ' + gp + ' 个端点被门控（' + (g.policy || []).map(p => esc(p.route)).join(" · ") + '）—— ' +
      'agent 的调用会被截停并落盘为待审批，业务代码不执行<br>' +
      '<b>裁决密钥</b> ' + (g.approval_secret_required
        ? '<span style="color:#A32D2D">已启用 APPROVAL_SECRET</span> —— 裁决端点需 X-Approval-Secret'
        : '<span style="color:#854F0B">未启用</span> —— 依赖「本机单人」这一前提；设 APPROVAL_SECRET 即可让闸门脱离本机信任') + '<br>' +
      '<b>契约</b> <code>' + esc((SERVER.contract || {}).openapi || "/v1/openapi.json") +
        '</code> —— 由路由表 × 门控策略现场派生（不落盘、不手写，所以不会漂移）；' +
        '每个 operation 带 x-gate / x-requires / x-idempotency，agent 可直接喂给工具调用层<br>' +
      '<b>本页所有「实测」延迟</b> 来自上面的 HTTP 往返；token 数由响应体真实字节数估算。';
  } else {
    el.innerHTML =
      '<b style="color:#854F0B">后端未连接，当前是页面内 mock</b> —— 状态存在浏览器里，刷新或换标签页就不同步。<br>' +
      '注意：<b>闸门在这里也照常工作</b>（mock 里实现了同一套挂起 / 裁决 / 回放），' +
      '但它守的是本页内存 —— 换个标签页就能各说各话。那正是要起后端的原因。<br>' +
      '启动后端：在本目录执行 <code>node server.js</code>，或双击 <code>start-agent-console.cmd</code>，然后刷新本页。<br>' +
      '<b>契约导出</b>（<code>GET /v1/openapi.json</code>）也只在连上后端后可用 —— 它由服务端真实路由表现场派生，' +
      '离线时它会如实返回 503，而不是拿本页副本假装是契约。';
  }
}

function renderAll(){ renderApprovals(); renderBudget(); renderLeases(); renderQueue(); renderAudit(); renderStore(); }

async function actOn(kind, id){
  const ep = EPS.find(e => e.id === (kind === "confirm" ? "act.confirm" : "act.rollback"));
  select(ep.id);                       // 先切目录（它会清空 last），再写回执
  $("body").value = JSON.stringify({ action_id:id }, null, 2);
  if(LIVE){
    const t0 = performance.now();
    const res = await api("POST", "/v1/act/" + id + "/" + kind, { action_id:id }, idem());
    last = { ep, path:"/v1/act/" + id + "/" + kind, body:res.body, status:res.status,
      ms:(performance.now() - t0).toFixed(1),
      tokens:(res.body && res.body._meta ? res.body._meta.tokens_estimate : "—"), rid:res.rid };
    await refresh();
  } else {
    const res = handle(ep, { action_id:id }, { "Idempotency-Key":idem() });
    last = { ep, body:res.body, status:res.status, ms:(4 + Math.random()*18).toFixed(1), tokens:120 + Math.floor(Math.random()*200) };
  }
  renderResp(); renderAll();
}

$("send").onclick = async () => {
  let body = null;
  if(cur.method !== "GET"){
    try { body = JSON.parse($("body").value || "{}"); }
    catch(e){ last = { ep:cur, status:400, body:{ ok:false, requires:"agent", error:{ code:"CLIENT_PARSE_ERROR", message:e.message } }, ms:0, tokens:0 }; renderResp(); return; }
  }
  const btn = $("send"), label = btn.textContent;
  btn.disabled = true; if(LIVE) btn.textContent = "请求中…";
  try {
    if(LIVE){
      const path = resolvePath(cur, body);
      const t0 = performance.now();
      const res = await api(cur.method, path, body, $("idem").value.trim());
      last = { ep:cur, path, body:res.body, status:res.status, ms:(performance.now() - t0).toFixed(1),
        tokens:(res.body && res.body._meta ? res.body._meta.tokens_estimate : "—"),
        replayed:res.body && res.body.replayed, rid:res.rid };
      await refresh();
    } else {
      const res = handle(cur, body, { "Idempotency-Key":$("idem").value.trim() });
      last = { ep:cur, body:res.body, status:res.status, ms:(4 + Math.random()*22).toFixed(1),
        tokens:120 + Math.floor(Math.random()*260), replayed:res.body && res.body.replayed };
    }
  } catch(e){
    last = { ep:cur, status:0, ms:0, tokens:0,
      body:{ ok:false, requires:"agent", error:{ code:"NETWORK_ERROR", message:String(e && e.message || e) } } };
  } finally { btn.disabled = false; btn.textContent = label; }
  renderResp(); renderAll();
};

$("racedemo").onclick = async () => {
  const leaseEp = EPS.find(e => e.id === "act.lease");
  const BODY = { shard:"CH03_S04", holder:"agent-B", ttl_s:300 };
  let a, b, c;
  if(LIVE){
    a = await api("POST", "/v1/act/lease", { shard:"CH03_S04", holder:"agent-A", ttl_s:300 });
    b = await api("POST", "/v1/act/lease", { shard:"CH03_S04", holder:"agent-B", ttl_s:300 });
    c = await api("POST", "/v1/act/lease", { shard:"CH03_S05", holder:"agent-B", ttl_s:300 });
  } else {
    a = handle(leaseEp, { shard:"CH03_S04", holder:"agent-A", ttl_s:300 }, {});
    b = handle(leaseEp, { shard:"CH03_S04", holder:"agent-B", ttl_s:300 }, {});
    c = handle(leaseEp, { shard:"CH03_S05", holder:"agent-B", ttl_s:300 }, {});
  }
  const say = (r) => r.body && r.body.ok
    ? "获得租约"
    : ((r.body && r.body.error && r.body.error.code) || "错误") +
      (r.body && r.body.error && r.body.error.holder_at_fault ? "（被 " + r.body.error.holder_at_fault + " 持有）" : "");
  select("act.lease");
  $("body").value = JSON.stringify(BODY, null, 2);
  last = { ep:leaseEp, status:200, ms:"—", tokens:"—", body:{
    transport: LIVE ? "真 HTTP × 3 → 锁由后端进程仲裁（不是页面内自己判）" : "页面内 mock",
    demo: "两个 agent 抢同一片，结论是：这件事本来就不该靠抢",
    attempts: [
      { step:1, actor:"agent-A", shard:"CH03_S04", http:a.status, result:say(a) },
      { step:2, actor:"agent-B", shard:"CH03_S04", http:b.status, result:say(b) },
      { step:3, actor:"agent-B", shard:"CH03_S05", http:c.status, result:say(c) }
    ],
    conclusion:"锁的粒度是分片不是章节。step2 失败只说明这一片被占；step3 立刻拿到另一片。两个 agent 同时在跑，只是不撞同一片。",
    counterpoint:"如果把锁粒度设成整个 CH03，那 10 个 agent 里永远只有 1 个在干活 —— 并行就是空话。"
  }};
  if(LIVE) await refresh();
  renderResp(); renderAll();
};

$("newkey").onclick = () => $("idem").value = idem();
$("aprall").onclick = async () => {
  const pend = (S.approvals || []).filter(a => a.status === "PENDING");
  if(!pend.length) return;
  const ep = EPS.find(e => e.id === "approvals.decide");
  let res = null, path = "";
  for(const a of pend){
    path = "/v1/approvals/" + a.id + "/decide";
    const payload = { id:a.id, decision:"approve", by:"user" };
    if(LIVE){
      const t0 = performance.now();
      const r = await api("POST", path, payload, idem());
      res = { status:r.status, body:r.body, rid:r.rid, ms:(performance.now() - t0).toFixed(1) };
    } else {
      const r = handle(ep, payload, {});
      res = { status:r.status, body:r.body, ms:(4 + Math.random()*18).toFixed(1) };
    }
  }
  if(LIVE) await refresh();
  select(ep.id);
  $("path").value = path;
  last = { ep, path: path + "  ×" + pend.length, status:res.status, body:res.body, ms:res.ms,
    tokens:(res.body && res.body._meta ? res.body._meta.tokens_estimate : "—"), rid:res.rid };
  renderResp(); renderAll();
};
$("reset").onclick = async () => {
  if(LIVE){ await api("POST", "/v1/demo/reset"); await refresh(); }
  else { STORE.clear(); S = seed(); STORE.ok = STORE.save(S); log("BOOT","engine","状态已重置"); }
  select("state.project"); renderAll();
};
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("on"));
  t.classList.add("on"); tab = t.dataset.t; renderResp();
});

/* 启动：先按 mock 渲染（离线可用），再探测后端；连上就整体切到真 HTTP */
const restored = STORE.load();
S = restored || seed();
STORE.ok = STORE.save(S);
log(restored ? "BOOT" : "INIT", "engine", restored ? "已从浏览器存储恢复状态" : "首次初始化");
$("idem").value = idem();
renderCatalog(); select("state.project"); renderAll();

(async function probe(){
  try {
    const h = await api("GET", "/v1/health");
    if(h.status !== 200 || !h.body.ok) throw new Error("health " + h.status);
    LIVE = true; SERVER = h.body.data;
    await refresh();
    select(cur.id); renderAll();
    // 心跳：顺便证明"两个标签页看到的是同一份状态"
    HEART = setInterval(async () => {
      try {
        const hh = await api("GET", "/v1/health");
        if(hh.status === 200) SERVER = hh.body.data;
        await refresh(); renderAll();
      } catch(e){ LIVE = false; SERVER = null; clearInterval(HEART); renderAll(); }
    }, 10000);
  } catch(e){
    LIVE = false; SERVER = null;
    renderAll();
  }
})();


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
