# packages/worker —— 生产运行时（Cloudflare Workers + Durable Objects）

> **状态：移植进行中（WIP）**。端口层与大部分适配器已完成，尚缺 Library DO；**当前不要执行 `pnpm cf:dev`**
> （`src/index.ts` 引用了尚未落地的 `library-do.ts`）。生产运行时以本目录为准，Node 版仅作备份/回归夹具。

## 目标架构

```
Worker（边缘）
├─ 静态资源（Static Assets）           → packages/web/public
├─ /api/health, /api/config            → Library DO
├─ /api/rooms*, /api/session/recap/... → Library DO（鉴权）→ Room DO
├─ /ws?token=...                       → Room DO（每房一个，WebSocket Hibernation）
└─ /debug/*（DEV_TOOLS=1 时）          → Room DO

LibraryDurableObject（单例）  · 房间码索引 · 会话令牌索引（只存哈希）· 题库种子 · 站点用量
RoomDurableObject（每房一个） · 房间状态（内存 + SQLite）· 该房 SQLite · WS · alarm tick · 密钥密文
```

## 为什么是 Durable Object（对应《产出/阶段6》）

| 原设计（自托管） | CF 等价物 | 性质 |
|---|---|---|
| 自研「房间级 Promise 串行队列」 | DO 单线程强一致 | 自研 → **平台保证**（跨网络/跨重启/跨实例） |
| `setInterval` 扫描 | DO **alarm** | 常驻进程 → 可休眠的平台定时器 |
| `node:sqlite` | DO **SQLite**（表结构与唯一索引原样保留） | API 换掉，schema 不变 |
| JSONL 日志文件 | Workers Logs / `wrangler tail` | 无文件系统 |
| `node:crypto` AES-GCM | **WebCrypto** AES-GCM（AAD 绑定不变） | 算法不变，异步化 |
| `MASTER_KEY` 环境变量 | **Worker secret** | 更安全、不进配置 |

## 文件职责

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/index.ts` | ✅ | Worker 入口：静态资源、API 路由、WS 升级、安全响应头 |
| `src/http.ts` | ✅ | JSON 响应、请求体解析、昵称清洗、固定错误文案、房间码、令牌哈希 |
| `src/vault.ts` | ✅ | WebCrypto AES-256-GCM 保险箱（与 Node 版行为等价，含 AAD 绑定与所有权校验） |
| `src/log.ts` | ✅ | 控制台脱敏日志（与 Node 版同一套屏蔽字段） |
| `src/store-do.ts` | ✅ | DO SQLite 仓储，实现 `RoomStorePort`（20 个方法，schema 与 Node 版一致） |
| `src/room-do.ts` | ✅ | 房间 DO：alarm 驱动 tick、WS 休眠、帧分发、房主自备 Key 的连接测试与加密入库 |
| `src/library-do.ts` | ⬜ **待实现** | 单例 DO：房间码分配、会话令牌索引（token 哈希 → roomId/memberId）、题库种子、站点用量 |

## 复用关系（不重复实现规则）

```
@ht/core                    ← 规则：零依赖纯函数，两个运行时逐字复用
packages/server/src/rooms.ts ← 房间编排（RoomRuntime / RoomRegistry），只依赖 ports.ts 的结构化端口
packages/server/src/ai.ts    ← AI 代理（判定 + 连接测试 + 错误分类），已移除 node:crypto 依赖
packages/server/src/{ports,protocol,data/seed-puzzles}.ts ← 端口、协议文案、题库种子
──────────────────────────────────────────────
Node 适配器（备份）   packages/server/src/{store,vault,log,config,server,index}.ts
CF  适配器（生产）   packages/worker/src/{store-do,vault,log,index,room-do,library-do}.ts
```

## 待办（按顺序）

1. `library-do.ts`：`POST /api/rooms`（分配房间码 + 房间 id + 成员 + 令牌）、`POST /api/rooms/:code/join`、
   `GET /api/session`、`GET /api/config`、`GET /api/health`、`POST /session/lookup`
2. 收口 `index.ts` 路由：`/api/credentials` 与 `/api/recap` 走鉴权后转发 Room DO
3. `pnpm cf:dev` 端到端跑通：建房 → 加入 → 开局 → 提问 → 判定 → 提示 → 揭秘 → 复盘
4. **同一组集成测试跑两个运行时**（差分验证：规则不得因运行时不同而改变）
5. GitHub Actions：PR 跑测试/类型检查/自检；main 自动 `wrangler deploy`
6. 用真实账号 `wrangler deploy` + `wrangler tail` 验证（免费计划，SQLite 后端 DO）

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars      # 填 MASTER_KEY / AI_KEY（.dev.vars 已被 gitignore）
pnpm cf:dev                          # 本地 workerd，无需 CF 账号
```

`.dev.vars` 与 `.env` 都不得提交；生产密钥用 `wrangler secret put MASTER_KEY` / `wrangler secret put AI_KEY`。
