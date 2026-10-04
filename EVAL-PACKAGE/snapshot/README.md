# snapshot/ —— 全部来自运行中的真实服务，非手抄

生成命令：`node tools/make-eval-snapshot.mjs`（服务需在 8787 运行）
生成时间：2026-10-03T13:58:05.155Z
来源：http://127.0.0.1:8787

| 文件 | 是什么 |
|---|---|
| `bootstrap-root.sample.json` | 零知识 agent 第一次打 `GET /` 拿到什么（内容协商） |
| `health.sample.json` | 自举入口：端点清单 |
| `gate-403.sample.json` | **★ 最重要**：被门控时 agent 真实拿到的完整响应 |
| `approval-single.sample.json` | 单查审批单（`requires` 随状态变） |
| `contract.openapi.json` | 完整契约（现场派生，可 diff） |
| `contract.transport-headers.txt` | 契约的响应头 —— 传输元数据在这里，不在文档体里 |
| `agent-trial-baseline.json` | AI 视角测评的原始判定数据（机器可读） |

## `_volatile`：为什么字节数不能当成事实来核

每份样本都有一个 `_volatile` 块，里面的 `fields` 是**连采两次自动 diff 出来的**运行态字段
（不是手写猜的）。这些字段的值随服务运行状态变化，因此 `bytes` 只是某一次采样的瞬间值。

- `_volatile.fields` —— 两次采样之间值不同的路径清单；核对时屏蔽这些路径再比对。
- `_volatile.bytes_observed` —— 两次采样各自的字节数；两者不等就说明字节数会漂移。
- `_volatile.bytes_stable` —— 两次是否恰好相等（相等也可能只是这次运气好）。

`tools/contract-sync.mjs` 的 `assertSamplesStable()` 会重放无副作用的两份样本，
**只屏蔽 `_volatile.fields` 后**做深度相等断言 —— 出现清单外的任何差异就拒绝生成。
也就是说：**运行态字段不可能再悄悄增加**，新增一个会立刻被抓住。

有副作用的两份（`gate-403` 会新挂一张待审批单、`approval-single` 依赖那张单）不参与重放，
它们靠 `_volatile.fields` 如实标注；这也是为什么 `gate-403` 的 `approval_id` 每次都不同。

**这些文件会过时。** 如果你要下结论，请以自己实际调用服务的结果为准；
或者重跑上面的生成命令刷新它们。
