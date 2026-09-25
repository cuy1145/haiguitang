# 替代方案：在没有 Durable Objects 的情况下部署到 Cloudflare 免费计划

> 触发原因：实测你的账号上 **Durable Objects 需要付费、当前不可用**（免费计划拿不到）。
> 本文件给出替代方案对比与推荐方案，是《阶段6》的**再次修订**（《阶段6》里"每房一个 DO"的部分作废，
> 其余结论——域名、CI/CD、密钥、红线、复用策略——继续有效）。

---

## 0. 我在你账号上实测到的结论（不是推测）

| 实测项 | 命令 | 结果 |
|---|---|---|
| 创建 D1 数据库 | `wrangler d1 create haiguitang-probe` | ✅ 免费计划可用（region WNAM） |
| 建表 / 插入 / 读回 | `wrangler d1 execute ... --remote` | ✅ 全部成功 |
| **乐观锁 CAS**（并发控制的关键） | `UPDATE rooms SET state_version = state_version + 1 ... WHERE id='r1' AND state_version = 0` | ✅ `changes: 1`，条件不满足时为 0（可据此做重试） |
| Durable Objects | 你账号内的提示 | ❌ 需要付费，当前不可用 |
| `workers.dev` 子域 | `wrangler deploy` | ❌ 未注册（**与 DO 无关，任何方案都必须先注册**） |

探针数据库与临时 Worker 已删除，账号里没有留下任何东西。

**结论：D1（= 云端 SQLite，免费额度 5 GB / 每天 500 万行读 / 10 万行写）完全可以承担本项目的状态存储。
唯一失去的是"平台提供的串行执行单元与定时器"——而这两件事我都有替代设计。**

---

## 1. 四个替代方案对比

| | A. **CF 免费 + D1 + 轮询 + 惰性推进**（推荐） | B. 换 Deno Deploy（KV + 原生 WebSocket） | C. 免费 PaaS 跑现有 Node 版 | D. 升级 Workers Paid |
|---|---|---|---|---|
| 费用 | 0 | 0 | 0 | $5/月 |
| 需要新账号 | 否 | **是**（Deno） | 是（Render/Koyeb 等） | 否 |
| 保留你的 GitHub CI/CD | ✅ 完全保留 | 需改 | 需改 | ✅ |
| 实时性 | 轮询 1.5～2 秒（可加长轮询压到 <1 秒） | 原生推送（最好） | 原生 WebSocket | 原生推送 |
| 代码改动量 | **小**：只换"广播"与"定时"两层（见 §3） | 中：Store 需从 SQL 改成 KV + 原子操作 | **零**（现有 Node 版直接跑） | **零** |
| 现有 69 项测试 | 全部继续有效 | 部分要重写 | 全部有效 | 全部有效 |
| 主要风险 | 无服务器推送；D1 单一主库写入串行 | Deno KV 无 SQL 查询/唯一索引，需模拟；平台绑定变化 | **免费 PaaS 的容器文件系统不持久**（SQLite 文件会丢），要改外部 Postgres；且 15 分钟无流量会休眠，冷启动 30～60 秒 | 花钱 |
| 适合本项目吗 | ✅ 回合制游戏对延迟不敏感（每回合 30～180 秒） | 可以，但为一个朋友间游戏迁移平台不值 | 可行但体验有冷启动毛刺 | 如果愿意每月 5 元人民币级别…（$5 ≈ 36 元/月） |

**推荐 A**，理由：保留你已经配好的一切（CF 账号、GitHub、CI/CD、密钥方式），改动集中在我已经隔离好的适配层，
且免费额度对"朋友间 1～5 个房间"绰绰有余。

---

## 2. 方案 A 的核心设计：把"定时器"和"推送"换成两件更简单的事

### 2.1 定时器 → **惰性推进（lazy catch-up）**

没有常驻进程，就没有 `setInterval`。但我的核心规则**本来就是纯函数**：
`tickTurn(state, now)` / `presenceTick(state, now)` / `transferGate(state, now)` / 投票截止 ——
它们的判定依据是"时间戳 + 当前时间"，而不是"被调用了几次"。

所以：**任何一个请求在处理业务之前，先把房间里所有"早该发生的事"补算完**。

```
POST /api/rooms/:id/actions  { type: 'submit', ... }
  1. 从 D1 读房间状态
  2. 循环 catch-up（最多 200 次，直到没有新的状态转移）：
       tickTurn(now) → presenceTick(now) → 移交判定 → 投票截止 → 中断超时自动投票
     · 顺序与我原来的 tick 顺序完全一致（保证结果确定、可复现）
  3. 处理本次动作（同一个纯函数 reduce 路径）
  4. 用 CAS 写回（见 2.3），并把产生的事件写入房间事件表
  5. 返回本次请求产生的新事件 + 最新 seq
```

**这与"每秒 tick 一次"的结果等价**，因为所有判定都是阈值型（`now >= deadline`）。
差别只有一个：**没人访问时，房间不会"自己动"**——但没人在看的时候，本来也不需要动；
一旦有人回来（或轮询），所有过期事件会在一次请求里按顺序materialize。

为了兜底"完全无人访问的房间"的生命周期清理（等待开局 6h / **没状态变化且没心跳 6h**），再加一个
**Cron Trigger**（免费计划可用，最小粒度 1 分钟）做每小时一次的清理扫描。Cron 只是"提醒者"，不承担对局计时。
判据见 `packages/core/src/room.ts` 的 `isRoomAbandoned()`：`updatedAt`（状态变化）+ 成员心跳**都**过期才算"没人了"。

### 2.2 推送 → **轮询（可选加长轮询）**

去掉 WebSocket 后，客户端改为：

```
GET /api/rooms/:id/events?since=<seq>     # 增量事件（绝大多数请求只返回空数组）
GET /api/rooms/:id/state                  # 全量快照（首次进入 / seq 过期 / 重连）
POST /api/rooms/:id/actions               # 提交动作（提交/提示/揭秘/投票/参数/房主操作）
```

- 平时 **1.5～2 秒轮询一次**；自己刚提交过动作 → 立刻再拉一次（自己的操作零等待）
- **可选优化（长轮询）**：服务端在 `since` 之后没有新事件时，用 `await scheduler.wait(500)` 循环最多 ~20 秒再返回
  （Workers 只对 CPU 计费，等待不算 CPU），可把别人的动作传播延迟压到 <1 秒
- 我的协议已经是 `seq + 增量 + 快照`，这套语义**原样复用**，只是把"服务端主动推"换成"客户端来拉"

**成本试算**（4 人一局 30 分钟）：4 × 30 × 60 / 2 ≈ **3600 次请求**；
免费额度是每天 10 万次请求、D1 每天 500 万行读 —— 余量三个数量级。

### 2.3 串行队列 → **CAS 重试（我原本的第二层防线）**

原来的三层防线是：① 房间级串行队列 ② 版本号乐观锁 ③ 唯一索引。
没有 DO 就没有 ①，但**②③ 原样保留**，而且我当初就是按"队列可能不存在"设计的：

```sql
-- 写回时带上前一次读到的版本号；写不进去说明有人抢先
UPDATE rooms SET state_version = state_version + 1, turn_json = ?, ... 
 WHERE id = ? AND state_version = ?;      -- changes=0 → 重新读取并重放本次动作（最多 3 次）
```

D1 是**单一主库、写入串行**，配合唯一索引（`UNIQUE(room_id, turn_seq)` 等）足以保证：
一次提问只产生一条判定、一人一票、同一问题同一结论。
对 2～8 个朋友的即时操作量，冲突概率极低；即便冲突也只是重试一次纯函数计算。

### 2.4 顺带的好处：状态线判定更准了

没有 WebSocket 心跳后，"在线"的定义自然变成 **"最近 N 秒内轮询过"**：
- 轮询 = 连接线心跳（`lastHeartbeatAt`）
- 页面内的点击/输入 = 活动线（`lastActivityAt`，随轮询一起上报）

**两条独立判定线的语义完全不变**（挂机只跳过回合、断连才触发移交），只是信号来源从 WS 帧换成 HTTP 请求。

---

## 3. 需要改的文件（工作量：小）

| 文件 | 改动 |
|---|---|
| `wrangler.toml` | 删掉 `[[durable_objects.bindings]]` 与 `[[migrations]]`；加 `[[d1_databases]]` 绑定、`[triggers] crons` |
| `packages/worker/src/store-do.ts` | → `store-d1.ts`：把 `ctx.storage.sql.exec()` 换成 `env.DB.prepare().bind().all()/run()` + `batch()`；`saveRoom` 改成带 CAS 的写 |
| `packages/worker/src/room-do.ts` | → `room-api.ts`：无 WS、无 alarm；每个请求 = 载入 → catch-up → 动作 → CAS 写回 → 返回事件 |
| `packages/worker/src/library-do.ts` | → 合并进 D1（房间码索引、会话令牌哈希表），不再需要单例对象 |
| `packages/worker/src/index.ts` | 路由改为上面 3 个端点；静态资源与安全头不变 |
| `packages/web/public/index.html` | WebSocket 客户端 → 轮询客户端（约 30 行改动：`send()` 改成 `POST actions`，`onmessage` 改成轮询回调） |
| `packages/core/**` | **不动**（规则完全复用） |
| `packages/server/src/{rooms,ai,ports,protocol}.ts` | **基本不动**（`RoomRuntime` 用"载入→catch-up→动作→persist"就能跑，队列变成无意义但无害；`broadcast` 改成写事件表） |
| `tests/` | 核心 50 项不动；集成 19 项需要把"WS 客户端"换成"HTTP 客户端 + 手动触发 catch-up"（假时钟仍然有效） |

---

## 4. 新风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 无服务端推送，延迟 1.5～2 秒 | 别人提问后你最多 2 秒后才看到 | 回合制游戏每回合 30～180 秒，无感；可开长轮询压到 <1 秒 |
| 无服务器定时器 | 挂机/超时/移交不会"自己发生" | 惰性推进（每次访问补算）+ Cron 每小时清理；**语义与实时 tick 等价**（阈值型判定） |
| D1 写入限额（免费 10 万行/天） | 每回合约 1～3 行写入，正常用量远低于上限 | 只在状态真的变化时写；事件表按需裁剪（每房保留最近 N 条） |
| D1 单一主库、写入串行 | 高并发写入会排队 | 本项目并发极低（朋友间 1～5 房间）；CAS + 重试已覆盖 |
| 长轮询占用请求配额 | 每次长轮询 = 1 次请求 | 默认用短轮询；长轮询作为可选开关（房主/部署配置） |
| 免费计划 CPU 10ms/请求 | 单次请求里做太多 SQL 会被杀 | catch-up 循环有上限（200 次）、单次动作只写 1～3 行；实测 D1 单条 SQL 约 0.08ms |
| 房间"自己动"的前提是有人在线 | 全员离线时对局冻结 | 这是**期望行为**（和原设计的"全员挂起→暂停"一致），不消耗额度 |

---

## 5. 数据表的落地方式

D1 就是 SQLite，所以《阶段1》/`store.ts` 的表结构**几乎可以原样执行**：

- 单库、所有房间共用（room_id 作为分区键）——朋友间规模下完全够用，且比"每房一个库"更省 D1 配额
- 需要保留的唯一索引：`UNIQUE(rooms.code)`、`UNIQUE(questions.room_id, turn_seq)`、`UNIQUE(verdict_cache 四列)`、
  `UNIQUE(members.room_id, player_id)`
- 新增一张 **`room_events(room_id, seq, kind, payload_json, text, created_at)`**（原 WS 广播的内容改存这里，
  客户端按 `seq` 增量拉取；每房保留最近 500 条，超出裁剪）
- 新增一张 **`sessions(token_hash, room_id, member_id, created_at)`**（原来放在 Library DO）
- 密钥密文仍存 `credentials` 表（WebCrypto AES-256-GCM + Worker secret 的 `MASTER_KEY`，红线不变）

---

## 6. 迁移步骤（修订后的清单）

1. ✅ 端口化（`packages/server/src/ports.ts`）——已完成，本轮改动才能这么小
2. ✅ Worker 侧适配器起步（入口/保险箱/脱敏日志/DO 仓储）——其中 DO 相关部分本轮作废重写
3. ✅ `store-d1.ts`：D1 版仓储（预读快照 + 缓冲写 + CAS 单事务批次 + 事件表 + 会话表）
4. ⬜ `room-api.ts`：无状态房间 API（载入 → catch-up → 动作 → CAS 写回 → 返回事件）
5. 🟡 `wrangler.toml` 已换 D1 绑定 + Cron；`index.ts` 基础层就绪（health/config/静态资源/501），路由收口待完成
6. ⬜ 前端从 WS 改轮询
7. 🟡 本地迁移已应用、`wrangler dev` 已验证 D1 绑定；端到端待房间 API 完成
8. ⬜ 把集成测试搬到 HTTP 形态（假时钟继续用），核心 50 项不动
9. ⬜ 部署 + 两台设备试玩验收（`docs/DEPLOY.md` §4）
10. ⬜ GitHub Actions 的 CI/CD 不变（deploy 前需先 `wrangler d1 create` 并在仓库里记录 database_id）

---

## 7. 需要你拍板

1. **选 A 吗？**（推荐）如果你更看重"原生实时推送"、愿意迁移平台，可以选 B；如果你想**今天就上线**、
   不改一行代码，可以先用 C（但要接受冷启动，且需要把 SQLite 换成外部 Postgres 才能持久化）。
2. **无论选哪个，都请先注册 `workers.dev` 子域**（若选 C 则不需要）：
   <https://dash.cloudflare.com/cc4c2dfb7c9cf38819d09cae71ab7d0f/workers/onboarding>
3. 如果你愿意每月付 $5 上 Workers Paid，架构可以完全不动（DO 全功能可用）——我不推销，只把选项摆出来。

选 A 的话我立刻开始第 3～9 步；其中 4、6 两步是这次"去掉 DO"的主要工作量，其余是搬运。

