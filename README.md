# Agent Console

> 一个**给 agent 用的工作台接口** —— 第一用户是 AI，所以验收主体也应该是 AI。
> 仓库里还有第二块内容：用这个工作台自己做出来的**短片渲染管线**（零模型、纯代码逐帧）。

零 npm 依赖：只用 `node:http` + `node:sqlite`（Node 22.5+ 内置），不装 express、不编译原生模块。

```
人也能打开它的页面，但那不是主体。
```

---

## 目录结构

```
.
├── server.js                    后端 · 1713 行 · 零依赖 · 27 端点 / 29 路由
├── ai-workbench.html            前端 · 1257 行 · 单文件
├── tests/                       9 套断言式测试（CI 可跑）
├── acceptance.mjs               验收式：人走一遍真流程，验证「体验是对的」
├── agent-trial.mjs              验收式：剥夺内幕，只用 HTTP + 契约，模拟零知识 agent
├── run-tests.sh / run-tests.cmd 一键跑全量
├── tools/                       契约同步 / 快照生成 / 评测包打包 / 引用校验
├── EVAL-PACKAGE/                给外部评审者的评测包（含实测快照）
├── DOUBAO-DELIVERY/             评测包的分发版本
├── site-doubao/                 发布成可抓取的站点（agent 入口 /start.md）
├── video/                       ★ 短片渲染管线（见下文）
├── AI的自白_60s.mp4             第三部 v3 · 60.0s
├── AI的自白_45s.mp4             第三部 v1 · 45.0s
├── AI网页的诞生_38s.mp4          第二部 · 38.0s
├── 本轮制作_一次改动五步落地.mp4   第一部
├── 视频剧本_*.md / 视频体检报告_*.md
└── LICENSE                      代码 MIT；美术素材排除且禁止商用（**务必先读**）
```

---

## 一、Agent Console（后端）

### 它提供的五类保证

| 保证 | 靠什么实现 |
|---|---|
| 状态不丢 | `node:sqlite` 落到磁盘，不是内存队列 |
| 跨进程幂等 | **存储层**唯一约束（`PRIMARY KEY`），不是应用层 `if` |
| 分片并行 | 租约 + 服务端仲裁 + TTL 自动释放 |
| **不该做的做不到** | HTTP 网关层截停，请求落盘为待批单，业务代码一行不跑 |
| 契约不漂移 | OpenAPI 从活元数据**现场派生**，不落盘、不手写 |

### 两条正交的轴（最容易搞错的地方）

- `gate` = **你能不能发起这个动作**（授权问题）→ HTTP 层截停，返回 **403**
- `requires` = **结果谁来定**（裁决问题）→ 响应字段，动作照常执行

判断类端点 `requires: human` 但**不**门控 —— 一个判定接口如果连调都调不到，它就**永远无法返回「我判不了」**。

拦截时返回 403 而不是 202。202 的意思是「收到了，稍后回来查」，那是在**鼓励** agent 轮询；403 才是正确动作。

### 快速开始

```bash
node server.js                      # 默认 http://127.0.0.1:8787
PORT=9000 node server.js
APPROVAL_SECRET=xxx node server.js  # 裁决端点开始要密钥，闸门脱离「本机即信任」
```

```bash
bash run-tests.sh                   # 全量：9 套断言 + 2 套验收
```

### 实测测试结果

| 类别 | 规模 | 结果 |
|---|---|---|
| 断言式（CI） | 9 套 / **433 断言** | 433 PASS / 0 FAIL |
| 验收式 · 人读证据 | **34 项** | 34 PASS / 0 FAIL |
| 验收式 · AI 判定 | **20 项** | 20 PASS / 0 FAIL |

数字由 `tools/collect-tests.mjs` 从测试输出解析生成，不是手写。

---

## 二、Video Pipeline（`video/`）

**零模型、纯代码**的确定性渲染：`scene.js`（画画）→ `page.html`（画布外壳）→ 无头 Chrome 逐帧（puppeteer-core + 独显）→ ffmpeg 编码。

所有运动都是 `t` 的**纯函数** —— 这是断点续渲与并行渲染的前提。

```bash
cd video
node render.mjs --probe            # 先验 GPU（headless 默认会落到核显，必须看到 NVIDIA）
node render.mjs                    # 渲染全部帧
python make-bgm.py                 # 生成 BGM（音画同一份时间轴）
python tools/qc.py                 # 客观体检：分章亮度带 / 切换点 / 闪烁
python probe_blank.py out/frames   # 边缘密度探针：扫「准空白帧」
```

共三部、四个成片（第三部有 v1/v3 两版）：

| 成片 | 时长 | 说明 |
|---|---|---|
| `AI的自白_60s.mp4` | 60.0s | 第三部 v3 · 15 镜 · 1920×1080 / 30fps |
| `AI的自白_45s.mp4` | 45.0s | 第三部 v1 · 12 镜（保留作对照） |
| `AI网页的诞生_38s.mp4` | 38.0s | 第二部 |
| `本轮制作_一次改动五步落地.mp4` | — | 第一部 |

工程细节、踩坑记录与复现步骤见 **`video/README.md`**；逐帧体检数据见 `video/out/qc-60s.md`。

---

## 环境要求

- **Node 22.5+**（`node:sqlite` 内置；低版本跑不起来后端）
- 视频管线额外需要：`puppeteer-core` + 一个 Chrome/Edge，以及 `ffmpeg`
- 本机实测显存：RTX 4060 Laptop 8GB；headless Chrome 需 `--force_high_performance_gpu` 才会用独显

---

## 许可

**先读 [`LICENSE`](LICENSE)。** 三类内容三种授权：

- **代码** → MIT（`server.js` / `tests/` / `tools/` / `video/src/` 等）
- **美术素材**（角色立绘、图标、定妆板、**成片画面**）→ **不适用 MIT，禁止商用**，版权归各权利人（含 AI 生成图）
- **文稿与报告**（剧本、体检报告、评测包）→ 保留权利，禁止商用

逐份声明见 `video/assets/characters/LICENSE.txt` 与 `video/assets/raw/gh/dl/LICENSE_dsh-deep-whale.txt`。
