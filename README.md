# AI 海龟汤（haiguitang）

朋友之间小规模私人对局的网页推理游戏：玩家读「汤面」，用 **是 / 否 / 部分接近 / 无关 / 无法回答** 五类结论逼近唯一「汤底」，
AI 担任主持人负责判定、提示与复盘。支持单人与多人联机（房间码入局、轮流提问、超时跳过、断线重连、房主移交）。

> 本仓库是《AI 海龟汤 · 分阶段提示词包》的落地实现。
> 规划文档位于仓库**之外**的同级目录 `../产出/`（阶段 1～5 的方案 + **阶段 6：部署形态改为 Cloudflare 的修订**）。
> 实现与规划不一致的地方都在 `docs/DESIGN.md` 里逐条列出并说明理由。

## 部署目标（已确定）

**Cloudflare Workers + Durable Objects（免费计划）**，源码托管在 **GitHub**，main 分支由 Actions 自动部署。

- 每个房间 = 一个 Durable Object：**平台级串行化**（取代自研的房间队列）、SQLite 内置存储、alarm 定时、WebSocket 休眠
- 规则与编排（`@ht/core` + `packages/server/src/rooms.ts`）被两个运行时**逐字复用**，不存在第二套规则实现
- Node 版服务端（`pnpm reference`）保留为**备份/回归夹具**，不参与生产部署

**开始配置请看 [`docs/DEPLOY.md`](docs/DEPLOY.md)**（GitHub 建仓库、Cloudflare API Token、Secrets 的点选路径都写好了），
部署前的环境自检：`pnpm cf:preflight`。迁移方案与风险清单见 [`docs/CF-MIGRATION.md`](docs/CF-MIGRATION.md)。

## 快速开始

```bash
pnpm install
pnpm cf:preflight     # 部署前置自检（只检查、不改动；并打印下一步命令）

# 生产运行时（Cloudflare）——移植进行中，见 packages/worker/README.md
pnpm cf:dev           # 本地 workerd（不需要 CF 账号）
pnpm cf:deploy        # 部署到线上

# 备份/参考实现（Node，本机可跑，用于回归验证与无网环境）
pnpm reference        # 启动本地 Node 服务器，浏览器打开 http://127.0.0.1:8787
```

- **不需要任何 API Key**：未配置 `AI_KEY` 时使用内置的规则主持人（离线可玩、判定确定）。
- 想让房主能提交自备 Key：配 `MASTER_KEY`（32 字节 base64）。未配置时该功能**明确关闭**，不会退化成明文或弱加密。
- 多客户端试玩：用**多个标签页 + 隐身窗口**分别以不同昵称加入同一房间码。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm cf:preflight` | 部署前置自检（环境、配置、密钥格式、移植完成度、git 状态、CF 登录） |
| `pnpm cf:dev` / `pnpm cf:deploy` / `pnpm cf:tail` | 本地 workerd / 部署 / 线上日志 |
| `pnpm typecheck` | 类型检查（`tsc --noEmit`） |
| `pnpm test` | 全部测试（核心规则 50 项 + 集成 19 项），零网络、假时钟、真实 WebSocket |
| `pnpm verify` | 测试 + 工程自检（core 零依赖扫描、密钥扫描、汤底不下发、启动烟雾） |
| `pnpm seed` | 打印题库种子（4 道题）以供核对 |
| `pnpm reference` | 启动 Node 参考实现（备份形态） |

## 目录结构

```
haiguitang/
├─ packages/
│  ├─ core/            ★ 核心规则域：纯函数、零依赖、零 IO（两个运行时共用同一份）
│  │  └─ src/          types / constants / text / verdict / facts / mock-host
│  │                   room / presence / vote / turn / host / dto / reduce
│  ├─ server/          房间编排 + AI 代理（与运行时无关）+ Node 适配器（备份形态）
│  │  └─ src/          rooms / ai / ports / protocol      ← 被 worker 复用
│  │                   config / log / vault / store / server / index  ← 仅 Node 适配器
│  ├─ worker/          ★ 生产运行时：Cloudflare Workers + Durable Objects
│  │  └─ src/          index（路由）/ http / vault（WebCrypto）/ log
│  │                   store-do（DO SQLite）/ room-do（alarm + WS 休眠）/ library-do（待完成）
│  └─ web/public/      前端（阶段性零依赖单页；正式版将替换为 React + Vite）
├─ tests/
│  ├─ core/            判定口径与防越狱、回合与两条独立判定线、投票与 DTO 泄露防护
│  ├─ integration/     真实多客户端 WebSocket + 假时钟 + 重启恢复
│  └─ fixtures/
├─ scripts/            selfcheck.ts / cf-preflight.ts / seed-puzzles.ts
├─ .github/workflows/  ci.yml（PR+push）/ deploy.yml（main 自动部署 + 健康检查）
├─ docs/               DEPLOY.md（零基础配置指南）/ CF-MIGRATION.md（迁移方案）/ DESIGN.md
├─ data/               Node 参考实现的 SQLite 与日志（.gitignore）
├─ wrangler.toml       Cloudflare 配置（DO SQLite 后端 + 静态资源 + 变量）
├─ .dev.vars.example   wrangler dev 的本地变量模板（.dev.vars 已被忽略）
└─ .env.example        Node 参考实现的配置模板
```

## 六条不可放宽的红线（实现位置一目了然）

| 红线 | 落地方式 | 验证 |
|---|---|---|
| API Key 绝不进入前端 | 提交接口只在服务端加密入库；所有下发都经过 `core/dto.ts` 白名单投影 + `assertNoLeak` 兜底 | `tests/integration` I-16、I-18；`pnpm verify` 的密钥扫描 |
| 密钥原文只进不出 | `packages/server/src/vault.ts`：AES-256-GCM + AAD 绑定 `credential|owner|room`，接口只回掩码，销毁=物理清空 | I-17、I-18；`credentialUsable()` 的所有权断言 |
| 汤底不下发 | 唯一出口是 `GET /api/recap`，且要求「已结束 + 非 aborted + 是参与者」；`aborted` 永不揭晓 | I-12、I-14、I-15 |
| 提交权限由服务端校验 | `packages/core/src/turn.ts` 的 `canSubmit()` 校验归属/回合号/相位/接收时刻，前端禁用按钮只是 UX | I-02、I-03、I-05、I-06 |
| 站点额度只在四种情形可用 | `core` 里额度来源由状态决定（未配置/已撤销/移交挂起/投票通过）；运行时调用失败**永不**改来源 | I-04、I-07、I-08 |
| 预输入草稿不上传 | 只写浏览器 `localStorage`，服务端不存在任何草稿字段 | 代码审查 + `dto.ts` 无草稿字段 |

## 已实现 / 未实现

**已实现（可跑、可测）**
- 核心规则域：回合状态机（含宽限期与临界提交）、两条互相独立的成员状态判定线、投票规则、房主移交、额度来源解析、判定口径与 L0 预检、L3 输出校验（schema/自洽/泄露/「无法回答」滥用）、提示梯度、揭秘尺度、DTO 白名单投影
- 服务端：房间与成员管理、per-room 串行队列、SQLite 持久化与重启恢复、判定缓存在库（跨进程一致）、站内模拟主持人 + 真实模型代理（严格 JSON、超时、重试、错误分类）、密钥保险箱、脱敏结构化日志、`/debug/*`
- 集成验证：19 项（含"非当前回合提交被服务端拒绝""移交后 Key 挂起且额度切站点""AI 中断不降级→自动投票→授权恢复""重启后对局进入暂停且不重复判定"）

**未实现（下一步）**
- React + Vite 正式客户端（当前 `packages/web/public` 是阶段性单页）
- 题库采集/生成脚本与 Q1–Q8 坏题检测、举报下架流程
- 生产部署形态（Docker Compose + Caddy + HTTPS）与运维手册
- 复盘导出（Markdown/PNG）、申诉队列、房间席位接管（换设备恢复）

规划的当前进展与待办见 `../产出/README.md`。
