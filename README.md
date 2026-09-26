# AI 海龟汤（haiguitang）

朋友之间玩的情境推理游戏：玩家只看到「汤面」（一个古怪的故事结局），靠**是 / 否 / 部分接近 / 无关 / 无法回答**
五类结论一句句把真相问出来。AI 当主持人负责判定、提示、出题与复盘。

**线上就在跑**：<https://haiguitang.luowanx70636.workers.dev> —— Cloudflare Workers 免费计划（Workers + D1 + Cron + Static Assets），
不依赖任何付费能力（**没有**用 Durable Objects）。

- **单人模式**：一个人推一道题，不限时、不用等人；讨论区/投票/踢人那套多人部件不会出现（服务端直接拒绝）。
- **多人对局**：房间码入局、轮流提问、超时跳过、断线重连、房主移交、待入席排队、全员讨论区。
- **判定不靠模型自觉**：模型只把问题**映射到事实点**，结论由事实表裁决；模型胡来会被逐层兜底拦下（见下）。
- **汤底在猜中前不下发**：唯一出口是结算后的复盘接口，且有测试把整张库导出来断言里面没有真相。

> 这是《AI 海龟汤 · 分阶段提示词包》的落地实现：规划文档在仓库**之外**的 `../产出/`（阶段 1～5 + 阶段 6 的部署修订）。
> 实现与规划的差异、以及每一处改动的理由都记在 [`docs/`](docs/) 里，最全的一篇是
> **[`docs/功能总览.md`](docs/功能总览.md)**（功能、判定引擎、红线、质量验证、已知限制）。

---

## 快速开始

```bash
pnpm install
pnpm verify            # 跑全部测试 + 工程自检（和 CI 是同一条命令）

# 本地开发（workerd + 本地 D1，不需要 Cloudflare 账号）
pnpm cf:migrate:local  # 首次/拉到新迁移后要跑一次（否则新列不存在，提交提问会 500）
pnpm cf:dev            # http://127.0.0.1:8787

# 部署（详见 docs/DEPLOY.md）
pnpm cf:preflight      # 环境自检（密钥格式、CF 登录、git 状态…）
pnpm cf:deploy         # 部署到线上；迁移由 GitHub Actions 在部署前自动执行
pnpm cf:tail           # 线上实时日志
```

- **可以不配任何 API Key**：没有模型额度时用内置规则主持人（离线可玩、判定确定，但不理解自然语言）。
- 想让房主填自己的 Key：配 `MASTER_KEY`（32 字节 base64）。没配这个功能**明确关闭**，不会退化成明文存储。
- 本地试玩多人：开两个标签页 + 一个隐身窗口，填同一房间码。

---

## 架构：方案 A（D1 + 惰性推进 + 轮询，无 Durable Objects）

最初的设计是「每房一个 Durable Object」，但那条路要付费；于是改成
**单个 D1 数据库 + 每个请求先补算过期事件 + 客户端 1.2 秒轮询 + 乐观锁 CAS**。
规则域一行没改，两种运行时**共用同一份源码**（`@ht/core` + `packages/server/src/rooms.ts`）。

```
Worker（无状态，边缘）
├─ 静态资源：/（深夜档案桌）· /classic/（旧版回滚）· /deep/ · /lodge/
├─ GET  /api/health /api/config
├─ POST /api/rooms                    建房（solo:true = 单人房）
├─ POST /api/rooms/:code/join         加入（单人房 → 403 SOLO_NO_JOIN）
├─ GET  /api/session                  令牌 → { roomId, memberId, view }
├─ GET  /api/rooms/state              ← 前端唯一的轮询端点：视图 + 时间线 + 公共记录 + 讨论 + 增量事件
├─ POST /api/rooms/actions            提问/提示/猜底/投票/参数/开局/房主操作/讨论…
├─ GET  /api/recap                    复盘（汤底唯一出口，三道门禁）
└─ POST|DELETE /api/credentials       房主自备 Key（连接测试 + WebCrypto 加密入库）

D1：rooms / members / sessions / questions / matches / votes / credentials / verdict_cache
    room_events / room_chat / audit_events / usage_counters / credit_grants
Cron：每小时清理"没人了"的房间与过期密钥（不承担对局计时）
```

**每个请求三段式**：

```
① 预读：房间 + 成员 + 当前对局 + 凭据 + 用量 + 判定缓存
② 纯计算：catch-up 补算过期事件 → 处理本次动作 → 生成事件（全部是阈值型纯函数）
③ 写回：单事务批次
     UPDATE rooms SET …, state_version = state_version + 1 WHERE id = ? AND state_version = ?
     其余写入都以「新版本」为存在条件 → 版本被抢先则重放动作（最多 3 次）
```

**为什么没有定时器也不会错**：核心规则全是 `now >= deadline` 这类阈值判断，
「每个请求先补算」与「每秒 tick」结果等价。Cron 只做清理，不参与对局推进。

---

## 功能一览

| 玩法 | 说明 |
|---|---|
| 建房/加入 | 房间码入局；房主选题（自己挑 / 投票选汤 / 让 AI 现写一道） |
| 提问判定 | **是 / 否 / 部分接近 / 无关 / 无法回答** 五类；每次都附一句结合提问语境的说明 |
| 单人模式 | 一个人推题：不限时、无回合跳过、无讨论/投票/准备；别人无法加入 |
| 提示（可选） | T1/T2/T3 三档，受配额与冷却限制；文案来自事实点原文，不泄汤底 |
| 猜汤底 | 随时可猜（可设冷却）；命中 → 全桌同时看到汤底；≥60% 只回"接近"与数量 |
| 复盘 | 仅房主、仅结算后；中止的对局永不揭晓 |
| 讨论区 | 全员自由发言，**不参与判定**、不占回合；有自己的限流与幂等键 |
| 房间生命周期 | 最后一人离开即物理清理；"没人了"（无状态变化且无心跳）6 小时后由 Cron 回收 |
| 审计与隐私 | 关键动作落 `audit_events`；客户端 IP 只存 **HMAC 哈希前 16 位**（原始 IP 不落库、不进日志、不下发） |

**判定引擎（"权威"不是模型）**：模型只做「问题 → 事实点」映射；
`decideFromFacts()` 按事实表裁决 —— 命中全真→**是**，全假→**否**，**真假混杂→部分接近**（一句话问了两件事，只说对一半），
一条未命中→**无关**（封闭世界假设，不是"否"）。模型的输出要过 L3 校验（枚举白名单、越界字段、自洽性、8-gram 泄露检查），
失败就走重试 → 规则兜底；**任何一层失败都不会把原始输出展示给玩家**。

**微动效**：换屏、页签、弹窗、汤面出现、短收据都有 130～200ms 的小转场；全部只用 `opacity`/`transform`，
且**只在元素刚出现时播一次**（整页是 `innerHTML` 重渲染，动画挂在常驻节点上会反复重播）。
`prefers-reduced-motion` 下全部关闭。

---

## 六条不可放宽的红线

| 红线 | 落地方式 | 怎么验 |
|---|---|---|
| API Key 绝不进前端 | 只在服务端加密入库；下发一律过 `core/dto.ts` 白名单投影 + `assertNoLeak` | 集成测试 I-16/I-18；`pnpm verify` 的密钥扫描 |
| 密钥原文只进不出 | AES-256-GCM + AAD 绑定 `credential\|owner\|room`；接口只回掩码，销毁=物理清空 | I-17/I-18；所有权断言 |
| 汤底不下发 | 唯一出口 `GET /api/recap`，要求「已结束 + 非中止 + 是参与者」 | I-12/I-14/I-15；导库扫描 |
| 提交权限由服务端校验 | `core/src/turn.ts` 的 `canSubmit()` 校验归属/回合号/相位/接收时刻 | I-02/03/05/06 |
| 站点额度不会偷偷被烧 | 额度来源由状态决定；调用失败**永不**自动改来源（暂停等房主处理或全员投票） | I-04/07/08 |
| 预输入草稿不上传 | 只写浏览器 `localStorage`，服务端没有这个字段 | `dto.ts` 无草稿字段 + 代码审查 |

---

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm test` / `pnpm verify` | 188 项测试（core 纯函数 / 集成真服务器 / 前端渲染与契约）；`verify` 再加工程自检 |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm cf:dev` / `pnpm cf:deploy` / `pnpm cf:tail` | 本地 workerd / 部署 / 线上实时日志 |
| `pnpm cf:migrate` / `pnpm cf:migrate:local` | 线上 / 本地应用 D1 迁移 |
| `pnpm cf:preflight` / `pnpm cf:verify` | 部署前置自检 / 部署后健康检查 |
| `pnpm audit` | **后台记录速查**：审计、用量、提问与判定、**判定体检**（结论被改写的记录、说明与结论自相矛盾的记录）、凭据、房间概览 |
| `pnpm seed` / `pnpm import:puzzles` / `pnpm analyze:puzzles` | 核对内置题库 / 导入第三方题库 / 题库体检 |
| `pnpm reference` | 启动 Node 参考实现（回归夹具，非生产形态） |

---

## 目录结构

```
haiguitang/
├─ packages/
│  ├─ core/            ★ 核心规则域：纯函数、零依赖、零 IO（两种运行时共用同一份）
│  │  └─ src/          types / constants / text / verdict / facts / mock-host / room
│  │                   presence / vote / turn / host / dto / reduce / puzzle-check
│  ├─ server/          房间编排 + AI 代理（与运行时无关）+ Node 适配器（回归夹具）
│  │  └─ src/          rooms / ai / ports / protocol / log / vault / store / request-context
│  │                   server / index / config   ← 仅 Node 适配器用
│  ├─ worker/          ★ 生产运行时：Cloudflare Workers + D1（migrations/ 到 0010）
│  │  └─ src/          index（路由 + Cron）/ room-api（房间 API）/ store-d1（CAS 批次）
│  │                   http / vault（WebCrypto）/ log
│  └─ web/public/      前端（零依赖单页，按皮肤分目录：/ classic deep lodge）
├─ tests/
│  ├─ core/            判定口径与防越狱、回合、生命周期、单人模式、玩家口吻判定电池
│  ├─ integration/     真 HTTP + 真 SQLite + 假时钟（含 IP 哈希、部分接近、单人、生命周期）
│  └─ web/             前端渲染状态机与主力前端静态契约
├─ scripts/            selfcheck / audit（后台速查）/ cf-preflight / verify-deploy / 题库工具
├─ docs/               功能总览（主文档）/ DEPLOY（零基础部署）/ CF-WITHOUT-DO（方案 A 由来）
│                      DESIGN（实现与规划的差异）/ 前端规划 / 前端设计方案 / CF-MIGRATION（历史）
├─ .github/workflows/  ci.yml（push+PR）/ deploy.yml（main：验证 → D1 迁移 → 部署 → 健康检查）
├─ wrangler.toml       Cloudflare 配置（D1 绑定 + 静态资源 + Cron + 非敏感变量）
└─ data/               题库与设计参考资料（.gitignore，不在仓库里）
```

---

## 已知限制（诚实清单）

详见 [`docs/功能总览.md`](docs/功能总览.md) 第十节，几条主要的：

1. **导入题库是繁体、难度未重估、出处写作本地文件名**（Apache-2.0 署名待修正；另有 2 道影射现实公众人物待删）。
2. **`packages/server` 的 Node 参考实现没有 HTTP 轮询端点**，只能当 WS 参考；本地联调请用 `pnpm cf:dev`。
3. **生产环境需要自己跑一次 D1 迁移**才算改完（本地是 `pnpm cf:migrate:local`，漏跑会 500）。
4. `audit_events` 只增不减，没有 TTL 与清理任务；`ip_hash` 也没建索引（量大了再说）。
5. 挂机但在线仍算"有资格"，会挡住开局（房主可强制开局）。
6. **没有**：正式 React 客户端（当前是零依赖单页）、举报下架流程、复盘导出、席位接管（换设备恢复）。

---

## 备份

仓库之外（`D:\test 小项目\海龟汤\备份\`）按时间留快照：git bundle（全历史 + 全分支/标签，`git bundle verify` 通过）、
源码 zip、线上/本地 D1 导出，以及 `data/` 参考资料 zip。说明见 `备份/README.md`。

云端对应关系：GitHub `main` + 标签 `v1-classic-pre-rewrite`、`v2-pre-partial-20260925-1907`、`v3-solo-20260925-2030`。

## 题库来源

内置题库含 Turtle-Bench 等公开数据集（Apache-2.0）与手工整理题目，来源与许可见
[`docs/PUZZLE-SOURCES.md`](docs/PUZZLE-SOURCES.md)；署名修正仍在待办清单里。
