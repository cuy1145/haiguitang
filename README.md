# AI 海龟汤（haiguitang）

朋友之间小规模私人对局的网页推理游戏：玩家读「汤面」，用 **是 / 否 / 无关 / 无法回答** 四类提问逼近唯一「汤底」，
AI 担任主持人负责判定、提示与复盘。支持单人与多人联机（房间码入局、轮流提问、超时跳过、断线重连、房主移交）。

> 本仓库是《AI 海龟汤 · 分阶段提示词包》的落地实现。
> 规划文档位于仓库**之外**的同级目录 `../产出/`（阶段 1～5 的方案、竞态清单、测试清单、阶段间矛盾检查等）。
> 实现与规划不一致的地方都在 `docs/DESIGN.md` 里逐条列出并说明理由。

## 快速开始（M1 本地服务器版）

```bash
pnpm install          # 只装 4 个依赖：ws + @types/* + typescript
pnpm m1               # 启动本地服务器，并在浏览器打开 http://127.0.0.1:8787
```

- **不需要任何 API Key**：未配置 `AI_KEY` 时使用内置的规则主持人（离线可玩、判定确定）。
- 想接真实模型：`cp .env.example .env`，填 `AI_BASE_URL` / `AI_MODEL` / `AI_KEY`（`.env` 已被 `.gitignore` 排除）。
- 想让房主能提交自备 Key：在 `.env` 里配 `MASTER_KEY`（32 字节 base64；`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`）。
  未配置时该功能会**明确关闭**，不会退化成明文或弱加密。
- 端口：默认 8787；未显式指定时被占用会自动 +1 尝试，显式指定（`PORT=8888 pnpm m1`）则直接报错。
- 重置本地数据：删除 `data/`（题库会从种子重建，对局记录会丢失）。

多客户端试玩：用**多个标签页 + 隐身窗口**分别以不同昵称加入同一房间码。
调试辅助（`DEV_TOOLS=1` 且监听回环地址时）：
`POST /debug/bot`（加一个模拟玩家）、`POST /debug/member-state`（手动设挂机/断线）、
`POST /debug/block-ai`（模拟上游 401）、`GET /debug/state?roomId=...`（看队列/版本/额度状态）。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm m1` | 启动本地服务器（M1 形态） |
| `pnpm dev` | 同上，带 `--watch` 自动重启 |
| `pnpm test` | 全部测试（核心规则 50 项 + 集成 19 项），零网络、假时钟、真实 WebSocket |
| `pnpm typecheck` | 类型检查（`tsc --noEmit`） |
| `pnpm seed` | 打印题库种子（4 道题）以供核对 |
| `pnpm verify` | 测试 + 工程自检（零依赖扫描、密钥扫描、汤底不下发、启动烟雾） |

## 目录结构

```
haiguitang/
├─ packages/
│  ├─ core/            ★ 核心规则域：纯函数、零依赖、零 IO（服务端与浏览器共用同一份）
│  │  └─ src/          types / constants / text / verdict / facts / mock-host
│  │                   room / presence / vote / turn / host / dto / reduce
│  ├─ server/          服务端：HTTP + WebSocket + SQLite + 密钥保险箱 + AI 代理
│  │  └─ src/          config / log / vault / store / ai / protocol / rooms / server / index
│  │      └─ data/     题库种子（4 道示例题，含事实集与判定关键词）
│  └─ web/public/      阶段性前端（零依赖单页；正式客户端将替换为 React + Vite）
├─ tests/
│  ├─ core/            判定口径与防越狱、回合与两条独立判定线、投票与 DTO 泄露防护
│  ├─ integration/     真实多客户端 WebSocket + 假时钟 + 重启恢复
│  └─ fixtures/
├─ scripts/            selfcheck.ts / seed-puzzles.ts
├─ data/               SQLite 与日志（.gitignore）
├─ .env.example        配置模板（只有占位符）
└─ docs/DESIGN.md      实现说明与「与规划的偏差」清单
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
