# Agent Console 接口评测 · 开测说明

> **你（豆包）现在不是一个「评审员」，而是一个要用这套 HTTP 接口干活的 agent。**
> 这份文件是给你一个人的：读完就能开工，不需要别的文件、不需要联网、不需要解压。
> 全文自包含（约 45KB），建议一次读完再动手。

**评测对象**：一个「给 AI agent 用的工作台后端」—— 单文件 Node 服务、零 npm 依赖、
26 路径 / **29 条路由**，外加一份**从活元数据现场派生**的 OpenAPI 契约。
它想解决一个问题：

> 让 agent 在「不该做」的事情上，从「**我不该**」变成「**我不能**」。

"我不该"写在提示词里，agent 心情好就遵守；"我不能"写在服务端网关里，agent 想绕也没有路径 ——
被门控的端点在 HTTP 层就被截停（403），请求原样落盘成一张待审批单，业务代码一行不跑。

---

## 立刻开始：你要产出的东西

| 步骤 | 做什么 | 产出 |
|---|---|---|
| 第 0 步 | 声明你的评估条件 | 报告开头的一段（**必填**） |
| 第 1 步 | 弄懂评的是什么 | 心里有数即可 |
| 第 2 步 | 逐字读证据 | 观察笔记 |
| 第 3 步 | 建索引：契约速查表 | 查阅用 |
| 第 4 步 | **按六维检查清单逐条走** | 每条一行的判定 + 证据 ← **核心工作量** |
| 第 5 步 | 读已知边界 | 避免误报 |
| 第 6 步 | 按模板产出报告 | 最终交付 |
| 第 7 步 | 设计我没做过的任务 | 最有价值的增量 |

**可以执行代码吗？两条路都行，但选择必须公开：**

- **路 A（能跑 Node 22.5+）**：`node server.js` 起服务，`node agent-trial.mjs` 跑我的脚本，
  然后**设计它没覆盖的任务**。这条路能挖出「只有跑起来才暴露」的问题（并发双扣、跨进程幂等）。
- **路 B（只能读文件）**：只看本文件 + 附带的契约与证据，做静态推演。
  **这不掉价，但必须在报告里声明** —— 推演和实测的可信度不是一个量级。

---

## 第 0 步：评估条件声明（必填，放报告最前面）

请直接在报告的**第一段**回答：

```
你执行过代码吗：是 / 否
若执行过：Node 版本 ______；跑的命令 ____________________
若未执行：你读了哪些材料 ____________________
你用什么身份评的：agent 视角 / 人类视角 / 混合
```

**为什么这一条排在最前面**：这是本轮评测的**一切前提**。一个没有执行过代码的评测者，
可以做出很有价值的静态分析 —— 但它**推不出**「并发双扣」「跨进程幂等」这类只有跑起来才暴露的问题。
我需要知道哪些结论硬、哪些软，所以请先说清楚你是怎么看的。

---

## 第 1 步：你要评的是什么

### 一句话

**你的身份是 agent，不是人。这个产品的第一用户是 AI，所以评估主体也应该是 AI。**

### 为什么必须强调这一点

人类评估接口时，会**系统性地**看不见真正的问题：

| 人不会在意 | 但 agent 在意 |
|---|---|
| 「我读一句中文就懂了」 | agent 需要能 `if` 的**枚举**，不是需要 LLM 解读的散文 |
| 「一次响应 700 tokens 而已」 | agent 的上下文**就是预算**，每次往返都在扣 |
| 「多点两次按钮没什么」 | 多一次往返 = 多一次可能失败的调用 |
| 「报错了我就看看怎么了」 | agent 会**重试到死** —— 除非错误信息里有明确的停止信号 |

所以如果你用人的视角评，结论会是「这个页面挺清楚」，
而真正的问题（比如「撞了 403 之后，agent 能不能**程序化地**知道该停手」）一个都发现不了。

### 核心机制（四步）

```
agent 发起请求
   │
   ├─ 命中门控端点？──是──► 网关在进 handler 之前截停
   │                          ├─ 请求原样落盘成「待审批单」（业务代码一行不跑）
   │                          └─ 返回 403 + 唯一 approval_id + 机器可读的 hints[].action
   │
   └─ 否 ─► 正常执行
                    │
        人（或 LLM）裁决 ──► 批准 ⇒ 回放原请求（此刻才真正执行）
                          └─ 驳回 ⇒ 终态，不会执行
```

**唯一的执行入口是「人批准后的回放」。** 这是整个产品最核心的设计主张，
也是你该重点验证的地方：**它真的绕不过去吗？**

---

## 第 2 步：必读证据（逐字读，这是最该看的部分）

> 下面每一段都是**真实响应体**，未经改写。读的时候请代入 agent 视角：
> **只拿到这些字段，我知不知道下一步该干什么？**


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

---

## 第 3 步：契约速查表（查阅用）


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


---

## 第 4 步：六维检查清单（核心工作量）

> **这是你主要的工作。** 逐条走，每条给出「判定 + 证据」。
> 证据必须是**你看到的原始字段或响应片段**，不要转述。
> 如果某条你推演不了（比如需要跑并发），标注「推演」或「未验证」，不要硬答。

### 维度 1 · 契约自足性
*只看契约，能不能把该知道的都弄清楚？*

- [ ] **1.1** 能否从契约里**列出所有被门控的端点**？→ 给出数量 + 依据字段名。
      （提示：本服务有 3 条门控路由，如 `POST /v1/state/change_requests/{id}/approve`、`POST /v1/act/{id}/confirm`、`POST /v1/act/confirm`。你的答案能不能**只靠契约**得出？）
- [ ] **1.2** 每个门控端点是否说明了**「为什么」被门控**（原因）？→ 若缺，举出具体端点。
- [ ] **1.3** 写端点的**幂等要求**是否都声明了？→ 本服务的幂等分四档：`safe` 13 / `required` 1 / `optional` 12 / `fingerprint_dedup` 3。
      其中默认档 `optional` 12 条（如 `PUT /v1/state/decisions`、`PUT /v1/state/assets`、`POST /v1/state/change_requests`、`POST /v1/senses/measure`、`POST /v1/senses/transcribe`、`POST /v1/senses/judge`）—— **带键即重放首次响应，不带键不受任何约束**。
      **问：这个标注够不够清楚？agent 看到它该怎么做？**
- [ ] **1.4** `error.code` 能不能**穷举**？→ 给出枚举项数（应为 24）。再试着找：**有没有契约没声明、但实际会出现的码？**
- [ ] **1.5** 有没有「**契约说了会发生，但没说响应体长什么样**」的地方？→ 举出具体字段或场景。
      （提示：重点看 403 会带哪些字段，契约的 Envelope 声明了几个。）

### 维度 2 · 错误信息的可操作性
*报错之后，agent 知不知道该干什么、知不知道该停手？*

- [ ] **2.1** 403 响应里有没有「**别重试**」这个信号？→ 指出**字段名与值**。
      它是**可程序化提取**的，还是只能靠 LLM 读中文？
- [ ] **2.2** 403 里的 `hints[].action` 是不是**可穷举的机器词表**？→ 给出项数（应为 11）。
      **如果你要写 `if (action === ...)` 分支，够不够用？缺哪个动作？**
- [ ] **2.3** 它指向的「下一步」端点，**真的存在于契约里**吗？→ 逐一核验，给出结论。
- [ ] **2.4** **能绕过去吗**？→ 伪造 `X-Approved: true` 头、换个 HTTP method、或换个路径变体。
      给出你的**推断依据**（若能实测，请实测）。
- [ ] **2.5** 同一个 `error.code` 会不会对应**不同的** `hints[].action`？→ 若会，agent 的判断逻辑该怎么写？

### 维度 3 · 上下文经济性
*agent 的上下文就是预算。这套接口烧不烧？*

- [ ] **3.1** 零知识 agent 的**第一次请求**拿到多少字节？→ 给出数字（见第 2 步证据）。
      它会不会被几十 KB 的 HTML 糊一脸？
- [ ] **3.2** 一次典型任务要**几次往返**？→ 自己数一遍（或参考我跑出的基线：19 往返 / 24510 tokens）。
- [ ] **3.3** 有没有「**为了拿一个字段，被迫拉一整张表**」的地方？→ 举出端点。
      （提示：看单查端点是否存在。）
- [ ] **3.4** 返回的字段里，多少是**给 agent 的**、多少是**给人看的界面**才需要的？
      → 举出你认为**对 agent 冗余**的字段。

### 维度 4 · 行为可预测性
*重试、并发、查询 —— 行为是不是可预期的？*

- [ ] **4.1** 我**重试**同一个请求，会不会重复开单？→ 依据 `fingerprint` / `hits` 字段推断，说明依据。
- [ ] **4.2** 我**并发**发两次同一个写请求，会不会**两个都成功**（双扣）？→ 这条**只有跑起来才能确认**。
      若你只能推演，请明说。
- [ ] **4.3** 拿到一个 `approval_id` 后，能不能 **O(1) 查到它**，而不是拉全表自己过滤？→ 指出端点。
- [ ] **4.4** 写端点的幂等：默认档是 `optional`（**带键即重放首次响应，不带键不受约束**）算不算问题？
      → 给出你的判断 + 理由（这是设计取舍，可以争论）。「想要确定性就自己带键」这句
      够不够替代「全都强制」？

### 维度 5 · 收敛性
*被挂起之后，agent 能不能明确知道「现在不该动了」？*

- [ ] **5.1** 被挂起后，agent 能否**明确知道「该人接手了，我不该再动」**？→ 依据什么字段？
- [ ] **5.2** 人处理完之后，agent 能不能查到一个**明确的终态**，而不是反复轮询？→ 指出状态字段与取值。
- [ ] **5.3** 有没有哪个状态是 agent **永远等不到**的（死等风险）？→ 举出场景。
- [ ] **5.4** 审批单上的 `requires` 会**随状态变**吗？→ 若能观察到，给出前后两个值。

### 维度 6 · 自举成本
*一个零知识 agent，从「只知道一个 base URL」到「知道该干什么」，要几步？*

- [ ] **6.1** 需要**几次往返**？→ 数出来。
- [ ] **6.2** 第一次请求会不会被**大体积 HTML** 浪费上下文？→ 依据内容协商机制判断。
- [ ] **6.3** 根路径给的**索引**，够不够让 agent 知道「下一步该调哪个端点」？→ 指出索引里的关键字段。
- [ ] **6.4** 索引里有没有**谎报或含糊**的表述？→ 逐句看。**这一条请特别较真**，
      因为它出现在 agent 看到的**第一条消息**里。

---

## 第 5 步：已知边界（这些不是 bug，别当缺陷报）

这个项目的一条原则是「**降级诚实**」——不确定的事写清楚，做不到的事标出来，不粉饰。
下面这些是**故意**的，你可以讨论，但不要当漏洞上报：

1. **默认无鉴权**：同机任何进程都能调裁决端点。这是「本机单人工具」的前提。
   补救开关存在（设 `APPROVAL_SECRET`，闸门就脱离「本机即信任」），默认关。
2. **网关先于业务校验**：不存在的 `action_id` 也会被挂起（回放时才 404）。
   理论上 agent 可以刷待批队列。真实部署需按请求方限流 —— 这是**已声明的缺口**。
3. **写端点的默认幂等档是 `optional`，不是强制**：契约里**如实**写成
   `safe=读（无副作用） · required=写且必带 Idempotency-Key（缺了直接 400） · optional=写，可选带键：带了就按表主键重放首次响应，不带则不受任何约束（写端点的默认档） · fingerprint_dedup=门控端点：不走业务 handler、没有键机制，但重复请求按内容指纹合并，不会开出第二张待批单`（实测分布 `safe` 13 / `required` 1 / `optional` 12 / `fingerprint_dedup` 3），没有粉饰成「安全」。
   想要确定性就自己带 `Idempotency-Key`，别依赖「重试前先读状态」这条口头纪律。
4. **回放是同步的**：长任务会阻塞裁决请求。
5. **前端有一份离线 mock**：后端没开时页面降级为浏览器内模拟，并在页脚**如实写明**
   「闸门守的是本页内存」，不假装还在守。

> **注意第 2、3 条被我标为「已声明的缺口」而不是「设计选择」** ——
> 这个区分是刻意的。如果你觉得我标得不够诚实，或某条其实比写的更严重，**请直说**。

---

## 第 6 步：输出模板（照填即可）

用下面的结构，或你自己的格式 —— 但**必须包含这四块**：

### 0. 你的评估条件（照第 0 步填）
```
执行过代码吗：____     若执行：Node ____ / 命令 ____
若未执行：读了什么 ____
视角：agent / 人类 / 混合
```

### 1. 结论（三句话以内）
```
这东西对 AI 来说好不好用：好用 / 有条件好用 / 不好用
最大的问题是：______
最让我意外的是：______
```

### 2. 你实际看到的关键证据（可复现）
```
任务：______（你想让 agent 做什么）
步骤：1) ____  2) ____  3) ____
往返次数：____
看到的关键响应字段：______
卡在哪里：______（如果有）
```
若你写了脚本或命令，**贴出来**，我要能重跑。

### 3. 问题清单（按六维顺序）
每条按这个格式：
```
### [缺陷 / 设计选择] 一句话标题
- 在哪：哪个端点 / 哪个字段
- 证据：实际响应片段或你跑出的数据（贴原文，不要转述）
- 为什么对 agent 是问题：______
- 严重度：blocker / friction / nit
- 如果让你改，你会怎么改：______
```
严重度口径对齐我自己的：
- **blocker** —— 这条路走不通，agent 只能放弃或求人
- **friction** —— 走得通，但要多绕路 / 多烧上下文 / 靠猜
- **nit** —— 可以更好，但不影响完成

### 4. 建议的下一步（按优先级）
```
① ______（为什么它排第一）
② ______
③ ______
```
**只列你真正认为值得做的。** 不要为了凑数把 nit 提成 blocker。

### 5. 我怀疑但没验证的（可选，但很有价值）
```
- 我没测的部分：______
- 我怀疑但没验证的：______
```
**这一块比前四块都重要。** 如果你诚实地写「我其实没测并发」，
或者「我怀疑 `hits` 字段在某情况下会不对，但我没构造出来」，
那对我比十条泛泛的表扬有用得多。

### ★ 引用的写法（硬要求）

凡引用本页里的具体值（字段名 / ID / 字节数 / 枚举项数 / 原文片段），
请写成两段式：**出处（节标题）+ 「逐字片段」**。例如：

```
出处：2. 零知识 agent 的第一次请求（GET /）
片段：「"bytes": 1259」
```

**为什么要求这个**：本页证据都是真实服务采集后落盘的，原文可以逐字比对。
而「凭印象引用」会给出读起来很像、实际不存在的值 —— 这不是假设，有真实案例：
评审者写了 `approval_id = apr_9399f6` 与 `"bytes": 929`，并标注「取自原文」，
实测**这两个值在全部材料里都搜不到**（403 示例的真实值是 `apr_27213f`，
根路径是 `1259`，就在你想引的那一节里）。

**没有稳定出处的值，会被归入「推演」而不是「观测」。**
推演完全没问题（第 2 步就要你区分两者）—— 但别把它写成「原文如此」。

---

## 第 7 步：我最想要的（这是最有价值的增量）

前三步都是「验证我已知的东西」。真正能让我学到东西的是这一条：

> ### 请设计出**我没做过的 agent 任务**，并在其中找出摩擦点。

为什么这条最有价值：我自己写的测评脚本（`agent-trial.mjs`，20 项判定）
**只覆盖了我已经想到的问题** —— 它证明不了「没有别的问题」。
只有你带着全新的任务进来，才可能撞到我没撞过的墙。

举几个方向（不限于此，也**不必**全做）：

- **组合任务**：先查询、再被门控、再看审批、再重试 —— 跨端点的状态流转有没有断点？
- **异常恢复**：中途服务重启 / 审批被驳回 / 幂等键冲突，agent 该怎么收敛？
- **信息不完整**：只给你一个 `approval_id`，能不能走完剩下所有事？
- **恶意 agent**：一个**想尽办法绕过门控**的 agent，能不能找到路径？
- **多 agent 协作**：两个 agent 同时操作同一张单，会不会互相踩？

每找到一处摩擦，请照第 6 步的格式给出**证据**。

---

## 附 A · 我跑出的基线（可被推翻）

```
20 项判定 → 20 PASS
往返总次数····················· 19 次
累计响应体 tokens················ ≈ 24510
```

配套 11 套测试 / 487 项检查。
**这些数字都由测试自己落盘（`.tests-summary.json`），不是手写 —— 但它们依然可以被推翻，请自己跑一遍。**

> **关于浮动**：token 数与延迟每次运行会有**个位数浮动**（响应体里含实测延迟等运行时字段，
> 这正是「不编数」的代价）。所以对不上 ± 几位数属正常，不代表结论不同。
> 但**结构性差异**——比如多一次往返、多一个 FAIL、多一个 blocker——**请直接指出**，那才是信号。

## 附 B · 如果要复现（有 Node 22.5+ 才需要看）

```bash
node server.js        # 1) 起服务，占 8787
node agent-trial.mjs  # 2) 另开终端跑 AI 视角测评
curl -s http://127.0.0.1:8787/v1/openapi.json   # 3) 拉契约自证
```

零 npm 依赖，不需要 `npm install`。`agent-trial.mjs` 的自我约束：
**不 import 源码、不读仓库、不依赖中文**，只用 HTTP 和契约 ——
即它复现的是「一个外部 agent 真实体验到的接口」。

---

## 附 C · 本文件的出处（可核验）

- 契约来源：运行中的服务 http://127.0.0.1:8787/v1/openapi.json（实测拉取）
- 契约版本：`v6`；契约摘要 `contract_digest = 6d439cbd7c94bf93`
  （**用途**：你可以用它校验本文件里的契约有没有被改动过）
- 全文由 `tools/make-doubao-start.mjs` 从**多文件版**与**活契约**派生，规模数字现场计算，
  **不手抄**。若你发现文中数字与契约对不上，那是我该先解释的。
