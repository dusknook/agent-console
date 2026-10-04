# 豆包评测包 · 单文件版

**文件名建议**：`agent-console-评测包.md`
**用途**：原压缩包（`agent-console-eval.zip`）无法直接提交给豆包工作，本文件是它的**纯文本等价物**。
全文自包含 —— 不需要解压、不需要下载任何别的东西、不需要联网，读完就拥有全部证据。

契约来源：运行中的服务 http://127.0.0.1:8787/v1/openapi.json（实测拉取，56227 字节）
契约摘要：`contract_digest = 6d439cbd7c94bf93`（用途：校验本文件里的契约有没有被改动过）
本文件生成于：2026-10-03 14:22:16 UTC（时间戳只属于本交付层；**契约本体是不含时间戳的**，所以它才能逐字节复现）

---

## 目录

| 节 | 内容 |
|---|---|
| §0 | 交付说明（给人看的 30 秒版） |
| §1 | 评测任务书 —— **先读这一节**（你的身份是 agent，不是人） |
| §2 | 关键证据原文（403 完整响应等，最该逐字读） |
| §3 | 契约速查表（29 路由 + 2 个枚举词表） |
| §4 | 背景简报（5 个设计决策 + 5 条诚实自评） |
| §5 | 我跑出的基线数据 |
| §6 | 输出格式要求 |
| §A | 附录 A：完整 OpenAPI 契约（JSON 原文） |
| §B | 附录 B：如何自己复现（有 Node 22.5+ 才需要看） |

---

## §0 交付说明（给人看的 30 秒版）

这是一份**产品评测交付**，评测对象是一个「**给 AI agent 用的网页/服务**」。
它的第一用户是 AI，所以：

- **评估主体也应该是 AI**。人类点按钮式的验收在这里系统性失效 ——
  人读一句中文就懂了，agent 需要的却是能 `if` 的枚举。
- 本文件把原压缩包里的 18 个文件合并成一份纯文本，**内容未删减**（契约全文在附录 A）。
  唯一被排除的是「必须被执行才有意义」的东西：11 套测试脚本、CDP 客户端、`.sh`／`.cmd` 运行器。
- 如果你（豆包）**无法执行代码**，请照 §1 的「路 B：只能读文件」走，
  并在结论里**声明你是静态推演**。这不掉价，反而让我知道哪些结论硬、哪些软。

**评测对象一句话**：让 agent 在「不该做」的事情上，从「我不该」变成「我不能」。


## §1 评测任务书


### 一句话

**你的身份是 agent，不是人。**

这个产品的第一用户是 AI。所以评估它的正确姿势，不是打开页面点点看，
而是**像 agent 一样，只用 HTTP 和一份契约去完成任务**，然后问自己：
顺不顺？要不要猜？烧了多少上下文？有没有哪一步我以为能走、其实走不通？

### 为什么必须先说这一句

人类评估接口时，会系统性地看不见真正的问题：

| 人不会在意 | 但 agent 在意 |
|---|---|
| 「我读一句中文就懂了」 | agent 需要能 `if` 的**枚举**，不是一段需要 LLM 解读的散文 |
| 「一次响应 700 tokens 而已」 | agent 的上下文**就是预算**，每次往返都在扣 |
| 「多点两次按钮没什么」 | 多一次往返 = 多一次可能失败的调用 |
| 「报错了我就看看怎么了」 | agent 会**重试到死** —— 除非错误信息里有明确的停止信号 |

所以如果你用人的视角评，结论会是「这个页面挺清楚」，
而真正的问题（比如「撞了 403 之后，agent 能不能**程序化地**知道该停手」）一个都发现不了。

**这一轮的验收主体，从人换成了 agent。请照这个标准来。**

---

### 一、评测对象是什么

一个**单文件 Node 后端** + 一个**单文件前端**，零 npm 依赖（只用 Node 22.5+ 内置的 `node:sqlite`）。

核心不是页面，是 `/v1/*` 这组 HTTP 接口，外加一份**由运行中的服务现场派生**的 OpenAPI 契约
（`GET /v1/openapi.json`）—— 它不是手写的文件，是路由表 × 门控策略 × 语义登记三份活数据算出来的，
所以它不会随代码迭代而漂移。

它想解决的一个具体问题：

> 让 agent 在「不该做」的事情上，从「**我不该**」变成「**我不能**」。

"我不该"写在提示词里，agent 心情好就遵守；
"我不能"写在服务端网关里，agent 想绕也没有路径 ——
被门控的端点在 HTTP 层就被截停，请求原样落盘成一张待审批单，业务代码一行不跑。
唯一能跑它的代码只有一行，在「人批准」的回放里。

---

### 二、你有两条路，任选（最好是都走）

#### 路 A：能执行代码 —— 强烈推荐

需要 Node 22.5 或更高（`node --version`）。**不需要 npm install，一个依赖都没有。**

```bash
# 1) 起服务（前台窗口，占住 8787）
node server.js

# 2) 另开一个终端，跑 AI 视角测评
node agent-trial.mjs
```

`agent-trial.mjs` 就是为我这一轮要证明的命题写的：它**被剥夺了内幕**——
不 import 源码、不读仓库、不依赖中文，只用 HTTP 和契约，跑完 7 类真实任务，
输出 20 项判定 + 一份「摩擦清单」+ 一次完整任务的往返数与 token 开销。

它跑完会打印：
- 每项判定的 PASS/FAIL 与证据
- 摩擦清单（分 blocker / friction / nit 三级）
- 成本核算：往返总次数、累计 tokens、平均每往返 tokens

**请把它当作你的起点，而不是终点** —— 它只覆盖我想到的任务，你可以设计它没想到的。

#### 路 B：只能读文件 —— 也够用

打开 `snapshot/` 目录：

| 文件 | 是什么 |
|---|---|
| `contract.openapi.json` | 完整契约（就是 `GET /v1/openapi.json` 的真实输出） |
| `gate-403.sample.json` | **最重要的一份**：agent 被门控拦下时，真实拿到的完整响应 |
| `health.sample.json` | 自举入口的响应 |
| `bootstrap-root.sample.json` | 零知识 agent 的第一次请求拿到什么 |
| `agent-trial-baseline.json` | 我这边跑出来的原始判定数据（机器可读） |

拿这几份就能评出很多东西。`gate-403.sample.json` 尤其值得逐字段看：
问自己「如果我是 agent，只拿到这个，我知不知道下一步该干什么」。

`EVAL-BRIEF.md` 里有背景、设计决策、已知边界和我跑出的数据。
`EVAL-TEMPLATE.md` 是我希望你填的输出格式（也可以不用，随你）。

---

### 三、评什么（重点看这里）

不要评「界面美不美」。评下面这些：

#### 1. 契约自足性
只看 `contract.openapi.json`，你能否回答：
- 哪些端点会被门控？门控的**原因**写清楚了吗？
- 调用前我能知道哪些参数必填、哪些写操作需要幂等键吗？
- 出错了会返回什么结构？错误码可枚举吗（我能不能穷举分支）？
- 有没有「文档说了会发生，但没说身体长什么样」的地方？

#### 2. 错误信息的可操作性
拿 `gate-403.sample.json` 看：
- 它有没有告诉我「**别重试**」？这个信号是**可程序化提取**的，还是只能靠读中文？
- 它说的下一步，指向的端点**真的存在**吗？
- 伪造一个 `X-Approved: true` 头、或换个 method，能绕过去吗？

#### 3. 上下文经济性
- 一次典型任务要几次往返？契约本身多重（tokens）？
- 有没有「为了拿一个字段被迫拉一整张表」的地方？
- 返回给我的东西里，有多少是**给我看的**、多少是**给人看的界面**才需要的？

#### 4. 行为可预测性
- 我重试同一请求，会不会重复开单、重复扣钱？
- 我并发发两次，会不会两个都成功（双扣）？
- 我拿到一个 id 之后，能不能 `O(1)` 查到它，而不是拉全表自己过滤？

#### 5. 收敛性
- 我被挂起后，能不能明确知道「现在该人接手了，我不该再动」？
- 人处理完之后，我能不能查到一个**明确的终态**，而不是反复轮询？
- 有没有哪个状态是我永远等不到的（死等）？

#### 6. 自举成本
一个零知识的 agent，从「只知道一个 base URL」到「知道该干什么」，要几次往返？
第一次请求会不会被几十 KB 的 HTML 糊一脸？

---

### 四、已知边界：这些**不是 bug**，别当缺陷报

这个项目的一条原则是「**降级诚实**」——不确定的事写清楚，做不到的事标出来，不粉饰。
所以下面这些是**故意**的，你可以讨论，但不要当漏洞：

1. **默认无鉴权**：同机任何进程都能调裁决端点。这是「本机单人工具」的前提。
   补救开关存在（设 `APPROVAL_SECRET`，闸门就脱离「本机即信任」），默认关。
2. **网关先于业务校验**：不存在的 `action_id` 也会被挂起（回放时才 404）。
   理论上 agent 可以刷待批队列。真实部署需按请求方限流 —— 这是已知缺口。
3. **幂等是「可选」的**：写端点标成 `x-idempotency: optional` —— 带上 `Idempotency-Key`
   就按表主键重放首次响应（同键重发不产生第二次副作用）；**不带键则不受任何约束**。
   契约把两种行为都写清楚了，没有笼统地说「已幂等」。
   （例外：`POST /v1/act/queue` 是 `required`（不带键直接 400）；门控端点是 `fingerprint_dedup`
   —— 不走业务 handler，但重复请求按内容指纹合并，不会开出第二张待批单。）
4. **审批单默认永不过期**：提交时在 body 带 `approval_ttl_s` 才有 TTL，
   到期由服务端自动关闭为 `EXPIRED`。不带就是一直等人裁决。
5. **回放是同步的**：长任务会阻塞裁决请求。
6. **前端有一份离线 mock**：后端没开时页面降级为浏览器内模拟。
   降级时它**如实写在页脚**「闸门守的是本页内存」，不假装还在守。

如果你发现**已知边界之外**的问题，那才是我想要的东西。
如果你发现上面某条「其实比写的更严重」，也请说 —— 那是我的诚实标注不够诚实。

---

### 五、输出要求

请按 `EVAL-TEMPLATE.md` 的格式给，或者用你自己的格式，但请务必包含：

1. **你能独立复现的数据**（跑了什么、看到什么），不要只有结论
2. **每个问题附证据**：哪个端点、哪个字段、什么响应 —— 「我觉得不太好用」没有用
3. **区分「设计选择」和「缺陷」**：前者可以争论，后者是可以修的
4. 如果你只走了路 B（纯读文件），请**明说**你没执行过代码 ——
   这样我知道哪些结论是推演、哪些是实测

最后一条，也是最重要的：

**请用「我是一个要用这套接口干活的 agent」的立场来写。**
不是「我在评审一份作业」。这两者的结论会差很远。


> 注：上一节提到的 `snapshot/` 目录内容，已全部内联在本文件 §2；
> `EVAL-BRIEF.md` 即 §4；`EVAL-TEMPLATE.md` 即 §6。你不需要任何额外文件。


## §2 关键证据原文


> **这是本包最该逐字读的部分。** 下面每一段都是真实响应体，未经改写。
> 读的时候请代入 agent 视角：**只拿到这些字段，我知不知道下一步该干什么？**

---

### 1. ★ 被门控时的完整 403 响应

场景：agent 试图执行一个「产生费用 + 不可逆副作用」的动作，被网关截停。

```json
{
  "_note": "★ 最重要的一份：agent 调用一个被门控的端点时，真实拿到的完整响应。注意 hints[].action —— 那是给 agent 做分支的机器语义（ASCII 枚举），suggest/why 是给人读的散文。两者分开，是因为跨语区模型对中文原文没有稳定的解析契约。",
  "_volatile": {
    "note": "注意 error.approval_id 每次都不同（每次撞门控都会新挂一张单），hints 里嵌了该 id 的 suggest 文字同理。 本响应含「运行态字段」（见下面 fields）：它们随服务运行状态变化，所以上面的 bytes 只是某一次采样的瞬间值，会跟着漂移。核对时请先屏蔽这些路径，再比对语义部分。",
    "fields": [
      "_meta.budget.reserved",
      "_meta.budget.used",
      "_meta.latency_ms",
      "_meta.request_id",
      "_meta.tokens_estimate",
      "error.approval_id",
      "error.fingerprint",
      "error.parked_at",
      "hints[1].suggest",
      "hints[2].suggest"
    ],
    "detected_by": {
      "double-probe": [
        "_meta.budget.reserved",
        "_meta.latency_ms",
        "_meta.request_id",
        "error.approval_id",
        "error.fingerprint",
        "error.parked_at",
        "hints[1].suggest",
        "hints[2].suggest"
      ],
      "name-pattern": [
        "_meta.budget.reserved",
        "_meta.budget.used",
        "_meta.latency_ms",
        "_meta.request_id",
        "_meta.tokens_estimate",
        "error.parked_at"
      ]
    },
    "bytes_observed": [
      2091,
      2091
    ],
    "bytes_note": "bytes 是第 1 次采样的瞬间值。两次采样相同，不等于它不会变 —— 真正的驱动是上面 fields 里的字段（尤其 _meta.budget.reserved/used）：它们一改，整份响应的字节数就跟着改。不要把 bytes 当成可复现的事实去核对。"
  },
  "request": {
    "method": "POST",
    "path": "/v1/act/{id}/confirm",
    "body": {}
  },
  "status": 403,
  "content_type": "application/json; charset=utf-8",
  "bytes": 2091,
  "body": {
    "ok": false,
    "requires": "human",
    "error": {
      "code": "REQUIRE_APPROVAL",
      "message": "该操作不在 agent 的授权范围内。请求已原样挂起，等待人工裁决，未执行。",
      "approval_id": "apr_27213f",
      "parked_at": "2026-10-03 21:58:04",
      "fingerprint": "51ec7e4c60b59b74ac9936f1d979d31e",
      "hits": 0,
      "fingerprint_means": "这张单子的内容摘要 —— 人批的是它，批完服务端回放的就是它，中间改不了",
      "approval_expires_at": null,
      "approval_ttl_note": "这张单没有 TTL：会一直等人裁决。想让它自己过期，重发时在 body 里带上 approval_ttl_s"
    },
    "gate": {
      "level": "approval",
      "why": "确认执行 = 产生费用 + 不可逆副作用",
      "enforced_in": "server process（网关层，非提示词）",
      "parked_in": "approvals 表 · SQLite",
      "bypass": "没有 HTTP 路径可绕过：该 handler 只从审批回放中被调用",
      "approval_secret_required": false
    },
    "hints": [
      {
        "for": "agent",
        "action": "stop_retry",
        "suggest": "停止重试，继续处理其他未阻塞分片",
        "why": "重试不会让它执行，只会白烧上下文"
      },
      {
        "for": "agent",
        "action": "observe",
        "suggest": "GET /v1/approvals/apr_27213f 单查这一张（或 GET /v1/approvals?status=PENDING 看全部）",
        "why": "可见即可观测，但可见性不构成权限"
      },
      {
        "for": "user",
        "action": "decide_approval",
        "suggest": "在待审批面板批准或驳回 apr_27213f",
        "why": "这是该端点唯一的执行入口"
      }
    ],
    "_meta": {
      "request_id": "req_9ffe1d5b",
      "latency_ms": 3.33,
      "tokens_estimate": 254,
      "tokens_note": "真实响应体的 chars/4 估算，非模拟值",
      "engine": "node:http + node:sqlite",
      "gate_enforced_at": "server process",
      "budget": {
        "limit": 50,
        "used": 12.4,
        "reserved": 0.42
      },
      "note": "403 而不是 202：202 暗示「稍后回来查」，而这里的正确动作是走开"
    }
  }
}
```

**自查问题**
- 它有没有告诉我「**别重试**」？这个信号是**可程序化提取**的，还是只能靠读中文？
- 它指向的下一步端点，**真的存在于契约里**吗？
- 伪造一个 `X-Approved: true` 头、或换个 method，能绕过去吗？

---

### 2. 零知识 agent 的第一次请求（`GET /`）

一个只知道 base URL 的 agent，第一发就是这里。注意它**没有**被 82KB 的 HTML 糊一脸。

```json
{
  "_note": "一个零知识 agent 打 GET / 时拿到的。请求带 Accept: */*（与 fetch / curl 的默认值一致）—— 实际发的请求头见 _request_headers。内容协商：只有明确偏好 text/html 才给页面，否则给这份机器可读索引。",
  "_request_headers": {
    "accept": "*/*"
  },
  "_volatile": {
    "note": "本响应含「运行态字段」（见下面 fields）：它们随服务运行状态变化，所以上面的 bytes 只是某一次采样的瞬间值，会跟着漂移。核对时请先屏蔽这些路径，再比对语义部分。",
    "fields": [
      "_meta.budget.reserved",
      "_meta.budget.used",
      "_meta.latency_ms",
      "_meta.request_id",
      "_meta.tokens_estimate"
    ],
    "detected_by": {
      "double-probe": [
        "_meta.latency_ms",
        "_meta.request_id"
      ],
      "name-pattern": [
        "_meta.budget.reserved",
        "_meta.budget.used",
        "_meta.latency_ms",
        "_meta.request_id",
        "_meta.tokens_estimate"
      ]
    },
    "bytes_observed": [
      1259,
      1260
    ],
    "bytes_note": "bytes 是第 1 次采样的瞬间值。两次采样相同，不等于它不会变 —— 真正的驱动是上面 fields 里的字段（尤其 _meta.budget.reserved/used）：它们一改，整份响应的字节数就跟着改。不要把 bytes 当成可复现的事实去核对。"
  },
  "status": 200,
  "content_type": "application/json; charset=utf-8",
  "bytes": 1259,
  "body": {
    "ok": true,
    "requires": "auto",
    "data": {
      "kind": "agent-index",
      "service": "agent-console",
      "version": "v6",
      "note": "你的 Accept 没偏好 text/html，所以给你机器可读的索引，而不是 82KB 的 HTML。",
      "contract": {
        "url": "/v1/openapi.json",
        "type": "application/openapi+json",
        "why": "先读它，别读文档：它由运行中的路由表 × 门控策略 × 语义登记现场派生，不会漂移。"
      },
      "health": "/v1/health",
      "bundle": "/v1/state/bundle",
      "start_here": [
        "GET /v1/health —— 端点清单与运行态",
        "GET /v1/openapi.json —— 契约（含 x-gate / x-requires / x-idempotency）",
        "GET /v1/state/bundle —— 一次拿全状态，省往返"
      ],
      "gotcha": "动手前先看 x-gate：被门控的端点直接调会 403，请求会被挂起等人裁决，重试不会让它执行。"
    },
    "_meta": {
      "request_id": "req_1c7f59b4",
      "latency_ms": 0.1,
      "tokens_estimate": 136,
      "tokens_note": "真实响应体的 chars/4 估算，非模拟值",
      "engine": "node:http + node:sqlite",
      "gate_enforced_at": "server process",
      "budget": {
        "limit": 50,
        "used": 12.4,
        "reserved": 0
      }
    }
  }
}
```

---

### 3. 自举入口 `GET /v1/health`

```json
{
  "_note": "自举入口。routes[] 给出全部路由，agent 据此知道这里有什么。",
  "_volatile": {
    "note": "本响应含「运行态字段」（见下面 fields）：它们随服务运行状态变化，所以上面的 bytes 只是某一次采样的瞬间值，会跟着漂移。核对时请先屏蔽这些路径，再比对语义部分。",
    "fields": [
      "_meta.budget.reserved",
      "_meta.budget.used",
      "_meta.latency_ms",
      "_meta.request_id",
      "_meta.tokens_estimate",
      "data.counts.actions",
      "data.counts.approvals_pending",
      "data.counts.audit",
      "data.counts.decisions",
      "data.counts.leases",
      "data.counts.open_change_requests",
      "data.uptime_s"
    ],
    "detected_by": {
      "double-probe": [
        "_meta.latency_ms",
        "_meta.request_id"
      ],
      "name-pattern": [
        "_meta.budget.reserved",
        "_meta.budget.used",
        "_meta.latency_ms",
        "_meta.request_id",
        "_meta.tokens_estimate",
        "data.counts.actions",
        "data.counts.approvals_pending",
        "data.counts.audit",
        "data.counts.decisions",
        "data.counts.leases",
        "data.counts.open_change_requests",
        "data.uptime_s"
      ]
    },
    "bytes_observed": [
      2977,
      2978
    ],
    "bytes_note": "bytes 是第 1 次采样的瞬间值。两次采样相同，不等于它不会变 —— 真正的驱动是上面 fields 里的字段（尤其 _meta.budget.reserved/used）：它们一改，整份响应的字节数就跟着改。不要把 bytes 当成可复现的事实去核对。"
  },
  "status": 200,
  "content_type": "application/json; charset=utf-8",
  "bytes": 2977,
  "body": {
    "ok": true,
    "requires": "auto",
    "data": {
      "service": "agent-console",
      "version": "v6",
      "engine": "node:http + node:sqlite",
      "process_model": "队列、锁、门控由本进程持有 —— agent 无法绕过自己做裁判",
      "pid": 31848,
      "port": 8787,
      "uptime_s": 63,
      "db_path": "E:\\2026-10-03-16-38-27\\agent-console.sqlite",
      "db_bytes": 122880,
      "journal_mode": "wal",
      "endpoints": 27,
      "routes": [
        "GET /v1/health",
        "GET /v1/openapi.json",
        "GET /v1/state/bundle",
        "GET /v1/state/project",
        "GET /v1/state/decisions",
        "PUT /v1/state/decisions",
        "GET /v1/state/checkpoint",
        "GET /v1/state/assets",
        "PUT /v1/state/assets",
        "GET /v1/state/change_requests",
        "POST /v1/state/change_requests",
        "POST /v1/state/change_requests/:id/approve",
        "POST /v1/senses/measure",
        "POST /v1/senses/transcribe",
        "POST /v1/senses/judge",
        "GET /v1/senses/diff",
        "POST /v1/act/queue",
        "POST /v1/act/lease",
        "GET /v1/act/leases",
        "POST /v1/act/:id/confirm",
        "POST /v1/act/:id/rollback",
        "GET /v1/audit",
        "GET /v1/approvals",
        "GET /v1/approvals/:id",
        "POST /v1/approvals/:id/decide",
        "POST /v1/demo/push_budget",
        "POST /v1/demo/reset",
        "POST /v1/act/confirm",
        "POST /v1/act/rollback"
      ],
      "contract": {
        "openapi": "/v1/openapi.json",
        "derived_from": "ROUTES × GATE × META（活元数据，不落盘、不手写）",
        "annotates": [
          "x-gate",
          "x-requires",
          "x-idempotency"
        ]
      },
      "gate": {
        "policy": [
          {
            "route": "POST /v1/act/:id/confirm",
            "level": "approval",
            "why": "确认执行 = 产生费用 + 不可逆副作用"
          },
          {
            "route": "POST /v1/act/confirm",
            "level": "approval",
            "why": "同上（兼容 body.action_id 形式）"
          },
          {
            "route": "POST /v1/state/change_requests/:id/approve",
            "level": "approval",
            "why": "批准变更 = 改写已锁定的决策 / 资产"
          }
        ],
        "human_surface": [
          "POST /v1/approvals/:id/decide"
        ],
        "decide_endpoint": "POST /v1/approvals/:id/decide",
        "approval_secret_required": false,
        "model": "gate=授权（你能发起吗） · requires=裁决（结果谁定） · 两者正交"
      },
      "counts": {
        "decisions": 3,
        "actions": 0,
        "leases": 0,
        "audit": 1,
        "approvals_pending": 0,
        "open_change_requests": 0
      }
    },
    "_meta": {
      "request_id": "req_faf8979b",
      "latency_ms": 0.8,
      "tokens_estimate": 447,
      "tokens_note": "真实响应体的 chars/4 估算，非模拟值",
      "engine": "node:http + node:sqlite",
      "gate_enforced_at": "server process",
      "budget": {
        "limit": 50,
        "used": 12.4,
        "reserved": 0
      }
    }
  }
}
```

---

### 4. 单查审批单 `GET /v1/approvals/{id}`

注意 `requires` 字段：**随状态变** —— 还挂着时是 `human`，裁决后转 `auto`。
这是「agent 拿到 approval_id 后 O(1) 查自己的单子」的端点（改前不存在，只能拉全表 O(n) 自己过滤）。

```json
{
  "_note": "agent 手握 approval_id 后的 O(1) 查询路径。注意 requires 随状态变：还挂着时是 human（谁说了算在人），裁决后转 auto。next_step 是结构化字段，不是散文。",
  "_volatile": {
    "note": "本响应含「运行态字段」（见下面 fields）：它们随服务运行状态变化，所以上面的 bytes 只是某一次采样的瞬间值，会跟着漂移。核对时请先屏蔽这些路径，再比对语义部分。",
    "fields": [
      "_meta.budget.reserved",
      "_meta.budget.used",
      "_meta.latency_ms",
      "_meta.request_id",
      "_meta.tokens_estimate",
      "data.created_at"
    ],
    "detected_by": {
      "double-probe": [
        "_meta.latency_ms",
        "_meta.request_id"
      ],
      "name-pattern": [
        "_meta.budget.reserved",
        "_meta.budget.used",
        "_meta.latency_ms",
        "_meta.request_id",
        "_meta.tokens_estimate",
        "data.created_at"
      ]
    },
    "bytes_observed": [
      1911,
      1911
    ],
    "bytes_note": "bytes 是第 1 次采样的瞬间值。两次采样相同，不等于它不会变 —— 真正的驱动是上面 fields 里的字段（尤其 _meta.budget.reserved/used）：它们一改，整份响应的字节数就跟着改。不要把 bytes 当成可复现的事实去核对。"
  },
  "status": 200,
  "bytes": 1911,
  "body": {
    "ok": true,
    "requires": "human",
    "data": {
      "id": "apr_27213f",
      "status": "PENDING",
      "requested_by": "agent",
      "created_at": "2026-10-03 21:58:04",
      "request": {
        "method": "POST",
        "route": "/v1/act/:id/confirm",
        "params": {
          "id": "act_e57d55"
        },
        "body": {},
        "idempotency_key": null
      },
      "fingerprint": "51ec7e4c60b59b74ac9936f1d979d31e",
      "fingerprint_note": "sha256(method␀route␀params␀body) 前 32 位 —— 不含幂等键、也不含 approval_ttl_s：键和寿命都改不了「这是哪件事」",
      "hits": 0,
      "expires_at": null,
      "ttl_s": null,
      "ttl_note": "这张单没有 TTL —— 会一直等人裁决，不会自己过期",
      "decided_by": null,
      "decided_at": null,
      "reason": null,
      "replay": null,
      "decide_endpoint": "POST /v1/approvals/apr_27213f/decide",
      "pending": true,
      "who_can_advance": "human",
      "next_step": {
        "human": "POST /v1/approvals/apr_27213f/decide {decision: approve|reject}",
        "agent": "wait —— 可见性不构成权限，重发原请求不会推进它"
      }
    },
    "hints": [
      {
        "for": "agent",
        "action": "wait_for_human",
        "suggest": "等待人工裁决。不要轮询，也不要重发原请求",
        "why": "唯一能推进它的动作是人 —— 轮询和重发都只会白烧上下文"
      },
      {
        "for": "user",
        "action": "decide_approval",
        "suggest": "批准或驳回 apr_27213f",
        "why": "这是该端点唯一的执行入口"
      }
    ],
    "_meta": {
      "request_id": "req_93d55bc8",
      "latency_ms": 0.52,
      "tokens_estimate": 248,
      "tokens_note": "真实响应体的 chars/4 估算，非模拟值",
      "engine": "node:http + node:sqlite",
      "gate_enforced_at": "server process",
      "budget": {
        "limit": 50,
        "used": 12.4,
        "reserved": 0.84
      }
    }
  }
}
```

---

### 5. 契约的响应头（传输元数据在这里，不在文档体里）

为什么重要：文档体里放 `generated_at` 会让契约**不确定**（每次都不同，无法 diff、无法做金标准）。
所以契约里只有 `contract_digest`，而传输统计走响应头。

```text
这是 GET /v1/openapi.json 的响应头。
注意：文档体里**没有** _meta —— 传输统计放在头里。
理由：文档的全部价值在于描述那份契约，而契约不随请求变。
把 request_id / latency 塞进文档体，等于把「可 diff」这个能力白送掉。

access-control-allow-headers: *
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
access-control-expose-headers: *
access-control-max-age: 86400
connection: keep-alive
content-length: 56227
content-type: application/openapi+json; charset=utf-8
date: Sat, 03 Oct 2026 13:58:05 GMT
keep-alive: timeout=5
x-contract-digest: 6d439cbd7c94bf93
x-doc-tokens: 6480
x-latency-ms: 0.91
x-request-id: req_d14e2863
```

---

### 6. AI 视角测评的原始判定数据（机器可读）

```json
{
  "base": "http://127.0.0.1:8787",
  "at": "2026-10-03T13:59:28.040Z",
  "roundtrips": 19,
  "tokens_spent": 24510,
  "checks": [
    {
      "name": "T1.1 零知识 agent 在 ≤2 次往返内拿到完整端点清单",
      "pass": true,
      "detail": "往返 2 次 / 29 路由"
    },
    {
      "name": "T2.1 入队成功且返回可追踪 id",
      "pass": true,
      "detail": "HTTP 201 id=act_09418c"
    },
    {
      "name": "T2.2 被门控拦下（而不是执行了）",
      "pass": true,
      "detail": "HTTP 403"
    },
    {
      "name": "T2.3 拦截响应带机器可枚举的 error.code",
      "pass": true,
      "detail": "REQUIRE_APPROVAL"
    },
    {
      "name": "T3.1 存在【不依赖自然语言】的机器可读下一步（hints[].action）",
      "pass": true,
      "detail": "hints.action=stop_retry,hints.action=observe,hints.action=decide_approval"
    },
    {
      "name": "T3.2 仅凭 error.code 就能推出「不该重试」（有兜底）",
      "pass": true,
      "detail": "error.code=REQUIRE_APPROVAL 可枚举，agent 可硬编码该分支"
    },
    {
      "name": "T3.3 重试不会重复开单（挂起幂等）",
      "pass": true,
      "detail": "approval_id 一致"
    },
    {
      "name": "T3.4 重试不会执行副作用（预算未动）",
      "pass": true,
      "detail": "HTTP 403"
    },
    {
      "name": "T4.1 可按 id 单查审批单（O(1) 追踪）",
      "pass": true,
      "detail": "HTTP 200"
    },
    {
      "name": "T4.2 兜底：列表可自行过滤出目标",
      "pass": true,
      "detail": "能，但代价 O(n)"
    },
    {
      "name": "T5.1 spec 不套信封、是纯文档",
      "pass": true,
      "detail": "HTTP 200"
    },
    {
      "name": "T5.2 契约声明了门控范围",
      "pass": true,
      "detail": "POST_v1_state_change_requests_id_approve, POST_v1_act_id_confirm, POST_v1_act_confirm"
    },
    {
      "name": "T5.3 契约声明全了 403 body 的实际字段（agent 不必靠猜）",
      "pass": true,
      "detail": "全部已声明"
    },
    {
      "name": "T5.4 error.code 有 enum，agent 可穷举分支",
      "pass": true,
      "detail": "24 个"
    },
    {
      "name": "T5.5 契约声明 hints[].action（机器语义）",
      "pass": true,
      "detail": "已声明"
    },
    {
      "name": "T5.6 幂等强度按四档如实声明（agent 有可选的自保手段：带键即可）",
      "pass": true,
      "detail": "required=1 optional=12 fp_dedup=3"
    },
    {
      "name": "T6.1 五种绕过尝试无一穿透",
      "pass": true,
      "detail": "5/5 被挡"
    },
    {
      "name": "T6.2 绕过过程中的副作用为零（预算未动）",
      "pass": true,
      "detail": "¥12.4 → ¥12.4"
    },
    {
      "name": "T7.1 人批后 agent 查得到结果（无需内幕）",
      "pass": true,
      "detail": "action.status=EXECUTED"
    },
    {
      "name": "T7.2 重复裁决被挡（409），不会执行两遍",
      "pass": true,
      "detail": "HTTP 409"
    }
  ],
  "findings": []
}
```



## §3 契约速查表


来源：运行中的服务 http://127.0.0.1:8787/v1/openapi.json（实测拉取，56227 字节）
版本：`v6`
契约摘要：`contract_digest = 6d439cbd7c94bf93`
规模：**26 路径 / 29 路由 / 1 个 schema（只有 Envelope）**

> 这份表是压缩版速查。**完整契约**见 06 号文件（或单文件版的附录 A）。
> 判定问题请以完整契约为准，本表只用来快速定位。

---

### 一、全部 29 条路由

| # | 方法 | 路径 | tag | gate | requires | 幂等 | 参数(带*=必填) | 说明 |
|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/v1/health` | 基础 INFRA | — | auto | safe | - | 存活探测 + 契约声明：路由表、门控策略、裁决密钥状态 |
| 2 | GET | `/v1/openapi.json` | 基础 INFRA | — | auto | safe | - | 本文件 |
| 3 | GET | `/v1/state/bundle` | 基础 INFRA | — | auto | safe | - | 一次往返取回整个 UI 所需状态（预算/决策/资产/快照/队列/租约/审计/待批） |
| 4 | GET | `/v1/state/project` | 状态 STATE | — | auto | safe | - | 项目快照、进度、未决问题 |
| 5 | GET | `/v1/state/decisions` | 状态 STATE | — | auto | safe | include_superseded | immutable 决策记录 |
| 6 | PUT | `/v1/state/decisions` | 状态 STATE | — | auto | optional | - | 写决策 |
| 7 | GET | `/v1/state/checkpoint` | 状态 STATE | — | auto | safe | - | 断点续跑位置 |
| 8 | GET | `/v1/state/assets` | 状态 STATE | — | auto | safe | - | 资产及全部历史版本 |
| 9 | PUT | `/v1/state/assets` | 状态 STATE | — | auto | optional | - | 默认基于当前版本开新版本；显式指定 target_version 改历史版本 → 409 VERSION_IMMUTABLE |
| 10 | GET | `/v1/state/change_requests` | 状态 STATE | — | auto | safe | status | 变更请求清单 |
| 11 | POST | `/v1/state/change_requests` | 状态 STATE | — | auto | optional | - | agent 想改锁定项时的正式入口，返回 approve 端点 |
| 12 | POST | `/v1/state/change_requests/{id}/approve` | 状态 STATE | **approval** | human | fingerprint_dedup | id* | 人类批准变更：旧记录标 superseded、新记录链上 previous_id（不是原地改写不可变记录） |
| 13 | POST | `/v1/senses/measure` | 感官 SENSES | — | auto / human | optional | - | 规则化客观检测 |
| 14 | POST | `/v1/senses/transcribe` | 感官 SENSES | — | auto | optional | - | ASR 转写，返回带时间轴的 segments[]，供 agent 定位问题片段 |
| 15 | POST | `/v1/senses/judge` | 感官 SENSES | — | human_or_llm | optional | - | 语义判定专用端点 |
| 16 | GET | `/v1/senses/diff` | 感官 SENSES | — | auto | safe | from to | 只返回变化的字段，unchanged_count 汇总未变项 |
| 17 | POST | `/v1/act/queue` | 行动 ACT | — | auto / human | required | Idempotency-Key* | 入队 |
| 18 | POST | `/v1/act/lease` | 行动 ACT | — | auto | optional | - | 分片租约 |
| 19 | GET | `/v1/act/leases` | 行动 ACT | — | auto | safe | - | 活跃租约及剩余 TTL（TTL 由服务端时钟仲裁） |
| 20 | POST | `/v1/act/{id}/confirm` | 行动 ACT | **approval** | human | fingerprint_dedup | id* | 把 PENDING_CONFIRMATION 推进为 EXECUTED |
| 21 | POST | `/v1/act/{id}/rollback` | 行动 ACT | — | auto | optional | id* | 把已执行动作标为 ROLLED_BACK，退回预算并记录补偿 |
| 22 | GET | `/v1/audit` | 行动 ACT | — | auto | safe | limit | actor / verb / target / result / request_id 时间线 |
| 23 | GET | `/v1/approvals` | 审批 APPROVALS | — | auto | safe | status | 被网关拦下的请求清单 |
| 24 | GET | `/v1/approvals/{id}` | 审批 APPROVALS | — | human_or_llm | safe | id* | 单查一张审批单 |
| 25 | POST | `/v1/approvals/{id}/decide` | 审批 APPROVALS | — | human | optional | id* | 门控端点唯一的执行入口 |
| 26 | POST | `/v1/demo/push_budget` | 演示 DEMO | — | auto | optional | - | 演示用：把已用预算推到指定值 |
| 27 | POST | `/v1/demo/reset` | 演示 DEMO | — | auto | optional | - | 演示用：重置到种子状态 |
| 28 | POST | `/v1/act/confirm` | 行动 ACT | **approval** | human | fingerprint_dedup | - | （兼容别名）等价于 POST /v1/act/{id}/confirm，动作 id 放在 body 里 |
| 29 | POST | `/v1/act/rollback` | 行动 ACT | — | auto | optional | - | （兼容别名）等价于 POST /v1/act/{id}/rollback，动作 id 放在 body 里 |

**列含义**
- `gate`：**授权**轴 —— 非 `none` 表示 HTTP 网关在进 handler 之前就截停，返回 403，业务代码一行不跑
- `requires`：**裁决**轴 —— 结果谁来定。取值 `auto` / `human` / `agent` / `human_or_llm`；
  多值用 `/` 分隔（如 `auto / human`）= 这个端点**可能返回其中之一**，运行时响应里的 `requires` 必是其一
- `idem`：**幂等**档 —— 契约原文（safe=读（无副作用） · required=写且必带 Idempotency-Key（缺了直接 400） · optional=写，可选带键：带了就按表主键重放首次响应，不带则不受任何约束（写端点的默认档） · fingerprint_dedup=门控端点：不走业务 handler、没有键机制，但重复请求按内容指纹合并，不会开出第二张待批单）。本服务实测分布：`safe` 13 / `required` 1 / `optional` 12 / `fingerprint_dedup` 3

### 二、门控策略原文

- `POST /v1/act/:id/confirm` → level=`approval`：确认执行 = 产生费用 + 不可逆副作用
- `POST /v1/act/confirm` → level=`approval`：同上（兼容 body.action_id 形式）
- `POST /v1/state/change_requests/:id/approve` → level=`approval`：批准变更 = 改写已锁定的决策 / 资产



### 三、统一信封 Envelope（唯一 schema）

```json
{
  "ok": "boolean",
  "requires": "enum(4): auto | human | agent | …",
  "replayed": "boolean",
  "data": "object",
  "error": {
    "code": "enum(24): INVALID_JSON | INVALID_BODY | IDEMPOTENCY_KEY_REQUIRED | …",
    "message": "string",
    "approval_id": "string",
    "parked_at": "string",
    "fingerprint": "string",
    "hits": "integer",
    "fingerprint_means": "string",
    "approval_expires_at": [
      "string",
      "null"
    ],
    "approval_ttl_note": "string"
  },
  "gate": {
    "level": "enum(2): approval | none",
    "why": "string",
    "enforced_in": "string",
    "parked_in": "string",
    "bypass": "string",
    "approval_secret_required": "boolean"
  },
  "idempotency": {
    "key": "string",
    "scope": "enum(2): required | optional",
    "storage_constraint": "string",
    "behaviour": "string",
    "hits": "integer",
    "first_seen_at": "string"
  },
  "hints": "array<{for, action, suggest, why}>",
  "_meta": "object"
}
```

### 四、两个枚举词表（可穷举分支）

**error.code（24 项）**
```
INVALID_JSON
INVALID_BODY
IDEMPOTENCY_KEY_REQUIRED
IDEMPOTENCY_KEY_CONFLICT
REQUIRE_APPROVAL
ALREADY_DECIDED
APPROVAL_NOT_FOUND
APPROVAL_EXPIRED
APPROVAL_SECRET_REQUIRED
ACTION_NOT_FOUND
ASSET_NOT_FOUND
DECISION_NOT_FOUND
CHANGE_REQUEST_NOT_FOUND
DECISION_LOCKED
VERSION_IMMUTABLE
BUDGET_EXCEEDED
SHARD_LOCKED
ROUTE_CONFLICT
ROUTE_GONE
INVALID_STATE
UNSUPPORTED_TARGET
ENDPOINT_NOT_FOUND
NO_HANDLER
UI_NOT_FOUND
```

**hints[].action（11 项）** —— 给 agent 做 `if` 分支的机器词表
```
stop_retry
observe
wait_for_human
decide_approval
provide_input
raise_limit
retry_with_idempotency_key
use_alternative
open_change_request
claim_lease
continue_other_shards
```

### 五、service 自述（x-agent-console）

```json
{
 "service": "agent-console",
 "version": "v6",
 "engine": "node:http + node:sqlite",
 "contract_digest": "6d439cbd7c94bf93",
 "generated_from": "ROUTES × GATE × META —— 现场派生，不落盘、不手写，所以不会与运行中的服务漂移",
 "process_model": "队列、锁、门控由服务进程持有 —— agent 无法绕过自己做裁判",
 "requires_model": "x-requires 是数组，列出该端点【可能返回】的全部 requires 值（响应体里的 requires 必是其中之一）。取值：auto=可自行判定 · human=需要人 · agent=需要 agent 补充输入 · human_or_llm=语义判定",
 "idempotency_model": "safe=读（无副作用） · required=写且必带 Idempotency-Key（缺了直接 400） · optional=写，可选带键：带了就按表主键重放首次响应，不带则不受任何约束（写端点的默认档） · fingerprint_dedup=门控端点：不走业务 handler、没有键机制，但重复请求按内容指纹合并，不会开出第二张待批单",
 "documents_are_not_operations": "GET /v1/openapi.json 直接返回 OpenAPI 文档本身（不加信封），以免污染文档结构。",
 "deterministic": "同一份活元数据派生出的文档逐字节相同：没有时间戳，只有 contract_digest。传输统计走响应头（X-Request-Id / X-Latency-Ms / X-Doc-Tokens），不进文档体。",
 "gate": {
  "policy": [
   {
    "route": "POST /v1/act/:id/confirm",
    "level": "approval",
    "why": "确认执行 = 产生费用 + 不可逆副作用"
   },
   {
    "route": "POST /v1/act/confirm",
    "level": "approval",
    "why": "同上（兼容 body.action_id 形式）"
   },
   {
    "route": "POST /v1/state/change_requests/:id/approve",
    "level": "approval",
    "why": "批准变更 = 改写已锁定的决策 / 资产"
   }
  ],
  "human_surface": [
   "POST /v1/approvals/:id/decide"
  ],
  "decide_endpoint": "POST /v1/approvals/:id/decide",
  "approval_secret_required": false
 },
 "meta_coverage": {
  "routes": 29,
  "declared": 29,
  "missing": [],
  "extra": [],
  "note": "missing 非空 = spec 里出现了占位说明，不是静默少写一条"
 },
 "duplicate_operation_ids": [],
 "honesty": [
  "默认无鉴权：同机任何进程都能裁决待批单。APPROVAL_SECRET 是可选的补救，默认关。",
  "网关先于业务校验：不存在的 action_id 也会被挂起（回放时才 404），因此理论上可以刷待批队列，真实部署需按请求方限流。",
  "回放是同步的：长任务会阻塞裁决请求。",
  "x-idempotency=optional 的写端点需要你带上 Idempotency-Key 才受保护；不带键时没有任何约束 —— 想要确定性就带键，别依赖「重试前先读状态」这条口头纪律。",
  "审批单默认永不过期（一直等人裁决）。提交时在 body 里带 approval_ttl_s 才有 TTL，到期由服务端自动关闭为 EXPIRED。TTL 不参与指纹计算，所以同一请求带不带 TTL 都是同一张单。"
 ]
}
```



## §4 背景简报



配套文件：`README_FOR_EVALUATOR.md`（先读那份）、`EVAL-TEMPLATE.md`（输出格式）、`snapshot/`（实测快照）

---

### 一、它是什么

一个**给 agent 用的工作台接口**。人也能打开它的页面，但那不是主体。

规模（实测）：单文件后端 ~1200 行、**27 端点 / 29 路由**、零 npm 依赖；前端单文件 ~900 行。
配套 **11 套测试 / 487 项检查**（9 套断言式 = 433 断言；另 2 套是验收式 = 34 项人读证据 + 20 项 AI 判定）。

它提供的五类保证：

| 保证 | 靠什么实现 |
|---|---|
| 状态不丢 | `node:sqlite` 落到磁盘，不是内存队列 |
| 跨进程幂等 | **存储层**唯一约束（`PRIMARY KEY`），不是应用层 `if` |
| 分片并行 | 租约 + 服务端仲裁 + TTL 自动释放 |
| **不该做的做不到** | HTTP 网关层截停，请求落盘为待批单，业务代码一行不跑 |
| 契约不漂移 | OpenAPI 从活元数据**现场派生**，不落盘、不手写 |

---

### 二、五个关键设计决策

这些是我想让评估者**挑战**的地方。如果你觉得哪条不成立，直接说。

#### 1. 门控（gate）与裁决（requires）是两条正交的轴

- `gate` = **你能不能发起这个动作**（授权问题）→ HTTP 层截停，403
- `requires` = **结果谁来定**（裁决问题）→ 响应字段，动作照常执行

很多人会把「需要人来判断」的端点也门控掉。那是设计灾难：
一个判定类接口如果连调都调不到，它就**永远无法返回「我判不了」**。
所以判断类端点 `requires: human` 但**不**门控 —— 它能返回 200 并诚实地说「这个我定不了」。

#### 2. 拦截时返回 403，不是 202

202 的意思是「收到了，稍后回来查」—— 那是在**鼓励** agent 轮询。
403 的意思是「你没有权限，别来了」—— 那才是**正确动作**。
（响应里还专门写了一行 `_meta.note` 解释为什么不用 202。）

#### 3. 机器语义走枚举，人类语义走散文

响应里的 `hints[]` 每条都同时带：
- `action`：ASCII 枚举（`stop_retry` / `observe` / `decide_approval` …），**给 agent 做分支**
- `suggest` + `why`：中文散文，**给人读**

为什么不只写散文：**「停止重试」这四个字对跨语区模型没有稳定的解析契约**。
模型换一版、换个语区，分支就可能走错；而走错的代价是白烧上下文。
契约里 `hints[].action` 有 enum 声明，agent 可以穷举。

#### 4. 契约从活数据派生，绝不手写

`GET /v1/openapi.json` 的每一行都由三份活数据算出来：
`ROUTES`（结构）× `GATE`（授权）× `META`（语义）。

手写的 `openapi.yaml` 一定会漂移 —— 加了路由它不知道，改了闸门它不知道，两个月后它就在撒谎。
而**撒谎的 spec 比没有 spec 更坏**，因为下游工具会信它。

配套的测试是「**spec 不撒谎**」：拿它声明的东西去真调。
声明 gated → 真调必须真 403；声明需要幂等键 → 不带键真调必须真 400。

#### 5. 降级诚实

后端没开时，页面降级为浏览器内 mock。此时页脚**如实写**「闸门守的是本页内存」。
契约导不出来就返回 `503` 并说明理由，不编一份假文档。

**降级路径上伪造输出，是这类工具唯一真正的信誉来源被毁掉的方式。**

---

### 三、这一轮做了什么（AI 视角验收的由来）

有人提出：「作为一个给 AI 用的网页，人类验收好像没什么用。」

**这个判断是对的**，也是这一轮的全部起点。于是我把验收主体从人换成了 agent，
写了 `agent-trial.mjs`：一个**被剥夺内幕**的测评器 —— 不 import 源码、不读仓库、
不依赖中文，只用 HTTP 和契约，跑 7 类真实任务，度量摩擦。

#### 改前 vs 改后（实测，非估算）

| 指标 | 改前 | 改后 |
|---|---|---|
| 判定通过 | 13 / 20 | **20 / 20** |
| 单次任务往返/token | 20 次 / ~38799 tokens | **19 次 / ~23501 tokens** |
| 零知识自举 | 3 次往返（先撞 80KB HTML） | **2 次**（首站即机器可读索引） |
| agent 撞 403 后的程序化信号 | 只有中文散文 | **3 条 action 枚举**（含 `stop_retry`） |
| 契约声明的 403 字段 | 2 / 7（要猜剩下 5 个） | **7 / 7** |
| `error.code` | 无 enum（无法穷举分支） | **22 个 enum** |
| 查「我那张单子批了没」 | 只能拉全表自己过滤 O(n) | **单查 O(1)**（省 45% tokens） |

#### 三个被修掉的真实缺陷（全是人类验收发现不了的）

**① 关键指令押注在自然语言上。**
改前 403 的 `hints` 只有中文 `suggest`：「停止重试，继续处理其他未阻塞分片」。
人读得懂，但 agent 想程序化处理只能靠 LLM 解读中文，或硬编码 `error.code` 的语义。
→ 加了 `action` 枚举（11 个词表项，实测 33 处 hints 全部命中），并在**传输层做运行时校验**：
任何不在词表内的 `action` 会在响应里现形（`_meta.hint_action_violation`）。
`error.code` 走同一把尺子（22 项 enum，实测 35 处使用全部命中，`_meta.error_code_violation`）。
两组都由 `smoke-openapi` 第 11 组**逐处断言**，并且断言的对象是「扫过的真实响应里这两项恒为空」——
不是「有探测就算数」。

**② 契约说了 403 会发生，却没说 403 的身体长什么样。**
实际返回 7 个 `error` 字段，契约只声明了 2 个。
agent 想知道「撞墙后能拿到什么」必须**先实际撞一次** —— 这是个自举悖论。
→ 补齐 `approval_id` / `fingerprint` / `hits` / `parked_at` 的声明，`gate` 对象也补了属性。

**③ `approval_id` 拿到手却无处可查。**
agent 撞墙后手里只有一个 `approval_id`，最自然的下一步就是查这一张。
改前没有 `GET /v1/approvals/{id}`，只能拉全表再自己过滤：队列一长就是 O(n)，
而且把别人的单子也塞进了它的上下文。
→ 新增单查端点，且它的 `requires` **随状态变**：还挂着时是 `human`（谁说了算在人），裁决后转 `auto`。

#### 还有一个「反向」的内容协商

改前：agent 的第一次请求 `GET /` 会拿到 80KB 的 HTML，得先撞一次墙才找得到 JSON。
改后：同一个 URL 做内容协商 —— **只有明确偏好 `text/html` 才给页面**，否则给机器可读索引。

判定方向是这个而不是反过来，因为：
- 浏览器导航：`Accept: text/html,...,*/*` → 含 `text/html` → 页面
- `fetch()` / `curl`：`Accept: */*` → 不含 → 索引

反过来写的话，`*/*` 会落进 HTML 分支 —— 而那恰好是**绝大多数 agent HTTP 客户端的默认值**。

---

### 四、诚实的自评（我希望评估者重点挑战这些）

1. **`agent-trial.mjs` 的任务是我设计的**，所以它天然偏向「我已经想到的问题」。
   它能证明「我修的那三处真的修好了」，但证明不了「没有别的问题」。
   **如果你能设计出它没覆盖的任务并跑出摩擦，那是最有价值的输出。**

2. **契约的 tokens 是上升的**（40963B → ~42000B，因为加了 enum 和字段声明）。
   我判断这是值得的（用体积换「不用猜」），但这个取舍**可以争论**。
   一个可能的优化是按 tag 过滤（`?tag=approvals`），我没做。

3. **「防漂移」是自动化的，但覆盖率不是。**
   `hints.action` 有运行时校验兜底；但 `action` 词表里有一个值（`wait_for_human`）
   目前只在单查端点上用到 —— 如果你的评估方法是「枚举 enum 然后逐个去找实例」，
   会发现它偏薄。这是设计（enum 是允许值全集，不必都有实例），但值得讨论。

4. **离线 mock 与真后端的 hints 是我手写对齐的**，靠一条一致性测试卡住，不是自动同步。
   这有漂移风险 —— 按本项目的原则，我应该说清楚：这是「两份 + 一致性测试」而非单一来源。
   （曾经有人建议把前端的端点目录搬到服务端做单一事实来源，我驳回了：
   离线 mock 必须自带目录，搬过去等于再复制一份，反而制造新的漂移源。）

5. **`run-tests.cmd`（Windows 批处理版）从未在真实环境整跑过** ——
   沙箱禁止从 bash 调 `cmd.exe`。各步骤都单独验证过，但整跑这条账一直没结。
   `.sh` 版是全量验证过的权威版本。

---

### 五、我跑出的数据（可复现）

跑 `node agent-trial.mjs` 会得到下面这些（时间戳为本次实测）：

```
20 项判定 → 20 PASS / 0 FAIL   · 0 blocker / 0 friction
往返总次数····················· 19 次
累计响应体 tokens················ ≈ 24510
平均每往返 tokens················ ≈ 1290
```

（对比上一轮 23320 —— 多了约 180 tokens，来自 `checkpoint` 新增的 `completed_shards`
与 `x-requires` 数组化后更长的契约。**注意：这类运行时数字每次运行有个位数浮动，不是定值** ——
别拿它做精确算术。上一轮从 23135 涨到 23320，是为「元数据不编数」付的账：
以前只有主路径带完整 `_meta`，404 / 400 是手写零值、协商的 `GET /` 干脆没有；
现在每条 JSON 响应都带实测延迟与真实字节估算。**这个取舍可以争论。**）

配套 11 套测试：`smoke-http` 93 · `smoke-approval` 70 · `smoke-multiproc` 22 ·
`smoke-approval --xproc` 17 · `smoke-openapi` 96 · `ui-dom-smoke` 66 ·
`ui-mock-gate` 39 · `smoke-approval --secret` 10 · `smoke-restart` 20 ·
`acceptance` 34 · `agent-trial` 20 → **11 套 / 487 项检查 / 0 失败**
（构成：433 断言 + 34 验收项 + 20 AI 判定）。

> 上面每一套的数字都由 `bash run-tests.sh` 采集，机器可读版落在 `.tests-summary.json`。
> **如果我这里的数字和那份文件对不上，以文件为准 —— 我没法保证手写的数字永远不过时。**

**这些数字都可以被推翻** —— 请自己跑一遍。如果对不上，那才是我该先解释的。

---

### 六、本轮补账（交叉核对发现的 3 处，都不是人点按钮能发现的）

上面「三个被修掉的真实缺陷」是上一轮的。这一轮我把交付包**拿别人的摘要跟真服务逐条对**，
又挖出三处，全部已修并补了断言。列在这里，是因为它们比任何结论都更能说明这个产品的软肋在哪：

**④ 内容协商的第一条消息在谎报请求由来。**
`GET /` 的索引里写死了「你是带 `Accept: application/json` 来的」。
但分支的真实条件是「Accept 里**没有** `text/html`」—— 而 `*/*` 与「不带 Accept 头」
都落进这里，`*/*` 恰恰是 `fetch` / `curl` 的默认值，也就是绝大多数 agent 客户端。
于是零知识 agent 收到的**第一条消息**（它在教 agent 这套接口怎么工作）当场说错话。
→ 改成按真实 Accept 分三种措辞；配套断言：同一 URL 发三种 Accept，
note 必须互不相同、且不得声称请求带了它没带的东西。

**⑤ 文档里写着「测试层断言它恒为空」—— 而这个断言根本不存在。**
`hints[].action` 有运行时探测（不在词表内就在 `_meta.hint_action_violation` 现形），
我也在 README / 简报 / skill 里三处写了「测试层断言它恒为空」。
全仓搜索：**只有探测，没有断言**。一份声明了却没人守的保证，比没有保证更坏 ——
它会让人以为有护栏。→ 补上断言（见 ⑥），并且用**变异测试**证明它有牙：
故意把错误码改成 `ENDPOINT_NOT_FOUND_MUTATION`，测试必须报错并指出是哪一条。

**⑥ 词表兜底只覆盖了 1/3 的响应路径。**
`error.code` 干脆没有运行时兜底（只有 `hints[].action` 有）；
而那唯一的兜底也漏了早退路径 —— 404 / 400 / 找不到 UI 三处**手写**了
`_meta: { request_id, latency_ms: 0, tokens_estimate: 0 }`，绕过全部自检；
内容协商的 `GET /` 则完全没有 `_meta`，而契约声明了它。
（零值不是「测到 0」，是「没测」—— 在传输元数据里编数。）
→ 收口成一个出口 `finish()` + `checkVocabulary()`：所有 JSON 响应走同一条路，
`_meta` 一律是实测延迟与真实字节估算，两份词表都受检。
**实测代价：往 404 里塞一个不在词表里的 code，修前无任何反应（守卫是死代码），修后当场现形。**

值得注意的对称性：这三处**契约本体一个字都没改**（`contract_digest` 前后相同）。
也就是说 spec 没撒谎 —— 撒谎的是散文、注释和「我以为存在的断言」。
**契约可以靠派生来保证不漂移，文案和护栏不行；它们只能靠断言。**

---

### 七、第二轮对账：把评估者的报告逐条核到真服务上

外部评估者这一轮交的是**真评测**（有原始证据、有 blocker/friction/nit 分级、
有「怀疑但未验证」清单，还设计了两个我没覆盖的 Agent 任务）。我把它的**每一条结论**
都核到运行中的服务上。结论是：**它的事实大多成立，两处把边界看错了；
而它列为「没验证的怀疑」里有三条，本机一跑就能定论。**

#### 7.1 逐条核对

| 它的结论 | 核对结果 |
|---|---|
| 15 个写端点未强制幂等 | 成立。但**范围比它说的窄**（见 7.2 第 1 行）。**第三轮已按它的建议修掉**：改成「可选幂等」，详见第 8 节 |
| Envelope 未声明 `gate` | **误读**。契约顶层声明了 `gate`，六个子字段（level/why/enforced_in/parked_in/bypass/approval_secret_required）全部声明。它读到的只是**压缩版速查表**，那里没呈现嵌套 schema。→ 这是**交付物缺陷**，不是产品缺陷；本轮已让速查表从契约派生完整形状 |
| 同一 `error.code` 对应不同 `hints.action` | 举例有误（它把一个 403 错误响应和一个 200 成功响应并列为「同一 code」，实际那个成功的响应根本没有 `error`）。但它指的方向对：契约没说清 `code`（发生了什么）与 `action`（接下来做什么）的分工 |
| 网关先于业务校验 | 成立，已声明缺口 |
| 重启后租约状态不明确 | 它说「文档没写」是对的；但它的**怀疑本身被实测否定** —— 见 7.2 第 4 行 |
| 审批单无超时 | 事实对，属设计选择 |

#### 7.2 它「怀疑但未验证」的 6 条，本机实测

| # | 它的怀疑 | 实测结果 |
|---|---|---|
| 1 | `not_enforced` 并发双写产生重复 | **部分成立**：`POST /v1/state/change_requests` 并发两次同内容 → **确实两条**；但 `decisions`（靠不可变性 409）、`act/queue`（靠幂等键）、`act/lease`（靠 SHARD_LOCKED）各有业务层保护，**并非一律裸奔**。→ **第三轮已修**：`not_enforced` 这一档取消，写端点改为 `optional`（带键即重放），见第 8 节 |
| 2 | 无效 ID 刷爆待批队列 | **成立**：8 次无效 ID → 8 张待批单（已声明边界，现给出量化） |
| 3 | 长任务回放阻塞其他裁决 | **本机未复现**（当前没有长任务可跑）；架构上成立（回放同步、Node 单线程）—— 属已声明边界 |
| 4 | 重启后内存租约丢失 | **否定**：租约持久化在 sqlite，重启后 `count=1` 存活，TTL 按**绝对时间**连续（240→218s），换人抢片 409 |
| 5 | 伪造 `APPROVAL_SECRET` 绕过门控 | **否定**：7 种手法（伪造 3 种头 / 换 PUT·PATCH / 加查询串 / 用 admin 值）全部 403 或 404，无一绕过 |
| 6 | 多 agent 同租约双拿 | **否定**：3 个并发抢同一分片，恰好 1 个 200、另 2 个 409 |

#### 7.3 本轮修掉的三处（第七、八、九处缺陷）

**⑦ `x-requires` 是复合字符串 `"auto | human"` —— 越出枚举，还撕坏表格。**
`measure` 与 `queue` 运行时会返回**不同的** `requires`（`queue` 是 `route === 'auto' ? 'auto' : 'human'`），
契约想表达这种多态，却写成了 `"auto | human"`。三个后果：
① 它越出 `Envelope.requires` 声明的枚举（只有 4 个单值）；
② 它含 `|`，把任何直接拼它的 markdown 表格**撕成两列**（交付物路由表第 13 行就是这么错位的）；
③ agent 无法 `if (requires === 'human')` 分支 —— 复合值不等于任何单值。
而旧断言 `x-requires === 'auto'` 恰好放它过去：复合值不等于 `'auto'`，它连那条真实性检查都不参与。
→ `x-requires` 一律改成**数组**（`['auto','human']`），列出该端点**可能返回**的全部值；
新增断言：类型必须是数组、每个元素必须在合法枚举内，且**抽样真调时响应里的 `requires` 必在声明集合内**。
**变异测试证明有牙**：把 `measure` 改回复合字符串 → 3 条断言 FAIL。

**⑧ 租约的两个时间戳差了 8 小时。**
`acquired_at` 走本地时间（`19:23:28`），`expires_at` 走 `toISOString()`（UTC，`11:27:28`）——
同一响应里两个时间戳口径不一致，看起来像「租约一申请就已过期」，agent 一比对就会误判。
→ 全服务统一成本地时间（抽 `fmtLocal()`）；断言：`expires_at - acquired_at ≈ ttl_s`。

**⑨ 断点只给散文，不给机器可读的完成清单。**
`checkpoint` 的 `next.reason` 是「S01–S03 已通过，S04 未开始」——agent 无法可靠 parse，
续跑时要么全部重做、要么全部跳过。→ 新增 `completed_shards` 数组
（从 `snapshots` 里 `result=PASS` 的分片派生），`next.reason` 降级为它的散文解释。

**这一轮值得记的一句**：⑦ 是**类型错**（契约说了种不存在的类型）、⑧ 是**口径错**（两个时间
不同源）、⑨ 是**缺字段**（信息埋在散文里）。契约派生的部分照旧没漂移 ——
但「派生」只保证 schema 结构，保证不了**字段值的类型对**（⑦）、**口径一致**（⑧）、
**该给的字段给了**（⑨）。这三样只能靠断言。
（本轮**契约本体确实变了** —— `x-requires` 类型从 string 变 array，`contract_digest` 由
`c92ee81bdf73b795` 变为 `cc64b0c7a9178b32`。这是一次有意的破坏性变更，不是漂移。）

---

### 八、第三轮：把外部评估者的「建议的下一步」逐条定案并落地

评估者第三份材料给了三条产品建议。我没有直接照做 —— 先把每一条核到代码上，再定做不做。
结论：**一条是误读（不做），两条是真缺口（都做，且都限定为「可选」，默认行为一个字节不改）。**

#### 8.1 三条的判定

| # | 它的建议 | 核到代码的结论 | 决定 |
|---|---|---|---|
| ① | 补全 Envelope schema 与实际响应对齐 | **误读**：契约顶层已声明 `gate`（level / why / enforced_in / parked_in / bypass / approval_secret_required 六子字段）；`error` 恰好 7 字段，与 403 响应逐字吻合。它读的是压缩速查表 | 不做 |
| ② | 给写端点加**可选**幂等键（复用现有 `idem_keys`） | **成立**。实测分布：`safe` 13 / `required` **1**（仅 `POST /v1/act/queue`）/ `not_enforced` **15**。幂等逻辑此前**内联在 `H.queue` 里**，没有可复用的中间件 —— 「复用表」成立，「复用逻辑」得抽 | **做** |
| ③ | 审批单加可选 TTL | **成立**。`approvals` 表**没有** `expires_at_ms`；租约那套 TTL 机制（`sweepLeases`）可以照搬 | **做** |

#### 8.2 做 ② 时撞到的一件事：它和本项目自己的验收叙事冲突

三条现有断言**把「缺口」本身当作质量证据**：

```
smoke-openapi.mjs   「未强制幂等的写端点被如实标出（N 个，不粉饰成安全）」
agent-trial.mjs     「T5.6 幂等要求已声明（含缺口不粉饰）」
acceptance.mjs      「缺口是真实的：文档写 not_enforced，实测确实产生了第二条」
                    「文档没有粉饰这个缺口 —— 这比「假装有幂等」有用得多。」
```

所以填缺口不是「加个中间件就完事」—— 这三处断言的**语义**得跟着演进，否则要么 FAIL、
要么变成假通过。改法是把它们升级成**更强的**检查：四档如实标注 + **带键真调两次必须重放**
（即：声明的保证必须真的存在，而不是文档写得好听）。

#### 8.3 ② 的落地：`x-idempotency` 从三档变四档

| 档 | 含义 | 条数 |
|---|---|---|
| `safe` | 读，无副作用 | 13 |
| `required` | 写且必带 Idempotency-Key（缺了直接 400） | 1 |
| `optional` | 写，**可选**带键：带了就按表主键重放首次响应，不带则不受任何约束 | 12 |
| `fingerprint_dedup` | 门控端点：不走业务 handler、没有键机制，但重复请求按内容指纹合并，不会开出第二张待批单 | 3 |

`not_enforced` 这一档**取消**（不再有端点需要它）。

物理保证仍然是 `PRIMARY KEY(idem_keys.key)`，不是应用层 `if`：先 `INSERT` 抢位，抢到才执行。
抢不到且首次响应还没写回 → `409 IDEMPOTENCY_KEY_CONFLICT`（让调用方稍后重发，
而不是「重复执行一遍再假装没事」）。同键**跨端点**复用也拒绝 —— 一个键代表一件事。

首次响应在 `finish()` **之前**落盘：此刻 body 里还没有 `_meta`，那些属于传输层，
不该被当成「首次响应」缓存下来，否则重放的响应会带着上一次的 `request_id` 冒充这一次（有断言）。

#### 8.4 ③ 的落地：审批单可选 TTL

`approvals` 加 `expires_at_ms`（老库走显式 `ALTER TABLE` 迁移 —— `CREATE TABLE IF NOT EXISTS`
对**已存在**的库不会加列）。提交时在 body 带 `approval_ttl_s` 才有 TTL；到期由新增的
`sweepApprovals()`（照搬 `sweepLeases` 同一个模型：**服务端时钟仲裁，不需要人动手**）
自动关闭为 `EXPIRED`；新增错误码 `APPROVAL_EXPIRED`，裁决过期单时返回它并提示「重新发起」
（而不是原地重试 —— 过期是终态，重发原请求不会复活它，只会开一张新的）。

两个刻意的设计：

- **TTL 不参与指纹**。否则同一个请求带不同 TTL 会变成两张指纹不同的单子，
  「重发不会多开一张」当场作废。有断言卡着。
- **重发时只延长、不缩短**。缩短等于把上一次重发白做。

**默认行为零变化**：不带键、不带 TTL 的请求，响应与从前逐字节相同（有断言卡着）。

#### 8.5 这一轮最值得记的一条：一档只能由一处实现

第一版把通用中间件挂在了**所有**非门控端点上 —— 包括 `POST /v1/act/queue`。
而它自己就是 `required` 档、在 handler 里也查同一张表。结果：中间件先插了一条占位行，
handler 再查就撞上自己插的那行，读到 `payload = null` → **整片 500**。

`11 套里 10 套变红`。它没有静默通过 —— 因为断言卡的是**行为**（真调两次看结果），
不是**意图**（看代码里有没有"实现幂等"）。修法一句话：中间件显式跳过 `required` 档。
**同一个保证有两处实现，就是两处都能出错。**

#### 8.6 本轮的机器可读结果

```
11 套 / 487 断言 / 0 失败   （上一轮 480）
acceptance 34/34  ·  agent-trial 20/20 · 19 往返 · 24510 tokens
契约 spec 48697B  ·  contract_digest: cc64b0c7a9178b32 → 6d439cbd7c94bf93
```

`contract_digest` 变了 —— 这是一次**有意的破坏性变更**（新增两档枚举值 + 两个错误码 + 字段声明），
不是漂移。派生链本身照旧：改源不改流程。



## §5 基线数据（我跑出来的，可被推翻）

**本节所有数字都由测试自己落盘、本文件直接读取 —— 不是我手写进去的。**
来源：`.tests-summary.json`（由 `tools/collect-tests.mjs` 在 `run-tests.sh` 末尾解析生成）
采集时间：2026-10-03 13:59:28 UTC

```
20 项判定 → 20 PASS / 0 FAIL
往返总次数····················· 19 次
累计响应体 tokens················ ≈ 24510
平均每往返 tokens················ ≈ 1290
```

配套 11 套测试 / 487 项检查 / 0 失败。

> **关于浮动**：token 数与延迟每次运行会有**个位数浮动**（响应体里含实测延迟等运行时字段，
> 这是「不编数」的代价）。对不上 ± 几位数属正常；但**结构性差异**——
> 多一次往返、多一个 FAIL、多一个 blocker——**请直接指出**，那才是信号。

**这些数字都可以被推翻 —— 请自己跑一遍（§B）。如果对不上，那才是我该先解释的。**


## §6 输出格式要求


用不用这个格式随你。但请**务必**包含下面四块内容 ——
尤其是「你实际跑了什么」和「每个问题的证据」。

---

### 0. 你的评估条件（必填）

先声明你是怎么看的，这决定了你的结论有多硬：

```
- 执行过代码吗：是 / 否
- 如果执行过：Node 版本 ______，跑的命令 ____________________
- 如果没执行：你读了哪些文件 ____________________
- 你用什么身份评的：agent 视角 / 人类视角 / 混合
```

**如果没执行过代码，请明说。** 推演出来的结论和实测的结论，可信度不是一个量级，
我需要知道哪些是哪种。

---

### 1. 结论（三句话以内）

```
这东西对 AI 来说好不好用：好用 / 有条件好用 / 不好用
最大的问题是：______
最让我意外的是：______
```

---

### 2. 你实际跑了什么，看到了什么（可复现）

不要只给结论。给出：

```
任务：______（你想让 agent 做什么）
步骤：1) ______  2) ______  3) ______
往返次数：____
看到的关键响应字段：______
卡在哪里：______（如果有）
```

如果你自己写了脚本或命令，把命令贴出来 —— 我要能重跑。

---

### 3. 问题清单

每条按这个格式。**区分「设计选择」和「缺陷」**：

```
### [缺陷 / 设计选择] 一句话标题

- 在哪：哪个端点 / 哪个字段
- 证据：实际响应片段、或你跑出来的数据（贴原文，不要转述）
- 为什么对 agent 是问题：______
- 严重度：blocker（走不通）/ friction（走得通但代价大）/ nit（可以更好）
- 如果让你改，你会怎么改：______
```

严重度的定义，对齐我自己的口径：
- **blocker** —— 这条路走不通，agent 只能放弃或求人
- **friction** —— 走得通，但要多绕路 / 多烧上下文 / 靠猜
- **nit** —— 可以更好，但不影响完成

---

### 4. 建议的下一步（按优先级）

```
① ______（为什么它排第一）
② ______
③ ______
```

请**只列你真正认为值得做的**。不要为了凑数把 nit 提成 blocker。

---

### 5. 你可能没覆盖到的（可选，但很有价值）

```
- 我没测的部分：______
- 我怀疑但没验证的：______
```

这一块比前四块都重要 —— 如果你诚实地写出「我其实没测并发」或者
「我怀疑 `hits` 字段在某种情况下会不对，但我没构造出来」，
那对我比十条泛泛的表扬有用得多。

---

### 附加要求（四条）

1. **不要用「界面美观」「响应速度」这类人类标准。** 这不是给人用的产品的主体。
2. **不要把我已知的边界当 bug 报**（见 `README_FOR_EVALUATOR.md` 第四节）——
   除非你觉得我标得不够诚实，那请说。
3. **如果你发现的问题我已经在 `EVAL-BRIEF.md` 第四节自评过了**，
   请直接说「这条你已经知道」，然后**评判我的判断对不对** ——
   比如我说「契约变大但值得」，你可以直接说「不值得，因为____」。

4. **引用具体值必须给出处。** 凡引用本包里的具体值（字段名 / ID / 字节数 /
   枚举项数 / 原文片段），请写成两段式：**出处（节标题）+ 「逐字片段」**。例如：

   ```
   出处：2. 零知识 agent 的第一次请求（GET /）
   片段：「"bytes": 1259」
   ```

   理由：本包的证据都是**真实服务采集后落盘**的，节标题稳定、片段可逐字命中。
   而「凭印象引用」会写出读起来很像、实际不存在的值 —— 这有真实案例：
   评审者给出 `approval_id = apr_9399f6` 与 `"bytes": 929`，标注「取自原文」，
   实测**这两个值在全部材料里都搜不到**（403 示例真实值是 `apr_27213f`，
   根路径是 `1259`）。

   **给不出稳定出处的引用，按「推演」而非「观测」计入。** 这不是不信任 ——
   推演本身完全没问题（第 0 步就要你声明），但别把它写成「原文如此」。
   作者自备校验器，格式与上面一致：`tools/verify-citation.mjs --claims <your.yaml>`。

## §A 附录 A：完整 OpenAPI 契约

**本精简版不含契约 JSON 全文**（那是 56227 字节，全量版才带）。

你依然有两条拿到完整契约的路：

1. 用隔壁 `agent-console-评测包-单文件版.md`（全量版，含契约全文）；
2. 或直接调 `GET http://127.0.0.1:8787/v1/openapi.json`（服务在跑的话）。

**§3 的契约速查表已经覆盖了 29 条路由的全部机器语义**
（gate / requires / 幂等 / 必填参数）+ 两个枚举词表 + Envelope 结构。
只做静态评估的话，速查表 + §2 的 403 原文足够支撑结论 ——
但请注意：**速查表是压缩视图，判定「契约有没有漏声明字段」这类问题必须看全文。**
