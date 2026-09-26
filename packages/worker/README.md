# packages/worker —— 生产运行时（Cloudflare Workers + D1，无 Durable Objects）

> **状态：已完整落地并在线上运行**（<https://haiguitang.luowanx70636.workers.dev>）。
> 该账号的 Durable Objects 需要付费，因此按 [`docs/CF-WITHOUT-DO.md`](../../docs/CF-WITHOUT-DO.md) 的**方案 A** 实现：
> **D1（云端 SQLite）+ 惰性推进 + 客户端轮询 + 乐观锁 CAS + Cron 清理**。
> 下面的"已实测"与"文件职责"保持更新；**待办清单是历史记录**（当时还没写 room-api，现已完成）。

## 已实测（本地 workerd，`wrangler dev`）

| 项 | 结果 |
|---|---|
| Worker 启动 | ✅ `wrangler dev` 正常 |
| **D1 绑定 + 迁移** | ✅ `0001_init.sql` 20 条语句执行成功；`/api/health` 真实查询 `SELECT COUNT(*) FROM rooms` 返回 `{ok:true, rooms:0}` |
| 静态资源托管 | ✅ `GET /` 返回 200（35 KB，含前端标题） |
| 安全响应头 | ✅ CSP / nosniff / frame-ancestors 等 |
| 未完成端点 | ✅ 返回 501 + `MIGRATION_IN_PROGRESS`（不假装可用） |
| D1 免费额度可用性 | ✅ 建库/建表/CAS 更新已在你的账号实测通过（见 `docs/CF-WITHOUT-DO.md` §0） |

## 架构（方案 A）

```
Worker（无状态，边缘）
├─ 静态资源（Static Assets）      → packages/web/public
├─ GET  /api/health /api/config   → 直接返回（含 D1 探活）
├─ POST /api/rooms                → 建房（分配房间码 + 成员 + 令牌）
├─ POST /api/rooms/:code/join     → 加入
├─ GET  /api/session              → 令牌 → {roomId, memberId, view}
├─ GET  /api/rooms/:id/state      → 全量快照
├─ GET  /api/rooms/:id/events?since=seq → 增量事件（原 WebSocket 广播的内容）
├─ POST /api/rooms/:id/actions    → 提交动作（提问/提示/揭秘/投票/参数/房主操作）
├─ GET  /api/recap                → 复盘（汤底唯一出口，三道门禁不变）
└─ POST|DELETE /api/credentials   → 房主自备 Key（连接测试 + WebCrypto 加密入库）

D1（单个数据库，room_id 分区）
rooms / members / questions / matches / votes / credentials / verdict_cache
audit_events / usage_counters / credit_grants / sessions / room_events / room_codes
```

**每个请求的三段式**（`store-d1.ts` 已实现第 ①③ 段）：

```
① 预读（async）：房间 + 成员 + 当前对局 + 凭据 + 用量 + 判定缓存（+ 复盘时的问题记录）
② 纯计算（sync，复用原逻辑）：catch-up 补算过期事件 → 处理本次动作 → 生成事件
③ 写回（async，单事务批次）：
     UPDATE rooms SET <全部内容>, state_version = state_version + 1
      WHERE id = ? AND state_version = ?            -- ← CAS：抢占版本
     INSERT OR REPLACE INTO members(...) SELECT ... WHERE EXISTS(SELECT 1 FROM rooms WHERE id=? AND state_version=?)  -- ← 新版本为条件
     （questions / votes / room_events / audit / usage 同理）
   第 ① 条影响 0 行 → 有人抢先 → 重新预读并重放动作（最多 3 次）
```

**为什么定时器没了也不影响正确性**：核心规则全是阈值型纯函数（`now >= deadline`），所以
「每个请求先补算」与「每秒 tick 一次」结果等价；顺序固定为
`tickTurn → presenceTick → 移交判定 → 投票截止 → 中断超时自动投票`（与 Node 版 tick 顺序一致）。
Cron（每小时）只负责清理无人访问的房间与过期密钥，**不承担对局计时**。

## 文件职责

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/index.ts` | ✅ | 路由入口：健康检查（D1 探活）、配置、静态资源、安全头、**Cron 清理 `scheduled()`** |
| `src/http.ts` | ✅ | JSON 响应、请求体解析、昵称清洗、固定文案、房间码、令牌哈希（WebCrypto） |
| `src/vault.ts` | ✅ | WebCrypto AES-256-GCM 保险箱（AAD 绑定 `credential|owner|room`，与 Node 版行为等价） |
| `src/log.ts` | ✅ | 控制台脱敏日志（与 Node 版同一套屏蔽字段） |
| `src/store-d1.ts` | ✅ | D1 仓储：预读快照 + 请求级同步仓储 + CAS 单事务批次写回 + 事件表 + 会话表 |
| `migrations/0001…0010*.sql` | ✅ | 全部表与唯一索引；线上已应用到 `0010_room_solo`（单人房标记） |
| `src/room-api.ts` | ✅ | 无状态房间 API：载入 → catch-up → 动作 → flush → 返回事件；单人房的多人动作在这里被拒（`SOLO_BLOCKED_ACTIONS`） |

## 待办（**历史记录**：写下这段时 room-api 还没写，现已全部完成）

1. ~~`src/room-api.ts`~~ ✅ 已完成（`withRoom()` + 动作分发 + 事件落表 + 会话/房间码 + 复盘 + 凭据）
2. ~~`src/index.ts` 路由收口~~ ✅ 已完成（501 全部换成了真实实现）
3. ~~前端 WebSocket → 轮询~~ ✅ 已完成（`GET /api/rooms/state` 一个端点拿全量）
4. Cron 清理（✅ 在 `src/index.ts` 的 `scheduled()` 里，不在单独的 `src/cron.ts`）：
   空房间 / 等待开局超时 / **没人了**（无状态变化且无心跳，`PLATFORM.roomDestroySec`）/ 过期密钥 TTL。
   判据与 Node 参考实现共用 `core/room.ts` 的 `isRoomAbandoned()` 语义；每次销毁写 `room_destroyed` 审计。
5. 测试（✅ 188 项：core 纯函数 + 集成真服务器 + 前端契约）
6. 部署（✅ GitHub Actions：验证 → D1 迁移 → 部署 → 健康检查）

## 本地开发

```bash
pnpm install
pnpm cf:preflight                 # 环境自检
pnpm cf:migrate:local             # 建/更新本地表（拉了新迁移后要跑；漏跑会 500）
pnpm cf:dev                       # http://127.0.0.1:8787
curl http://127.0.0.1:8787/api/health   # 应返回 storage:"d1", db.ok:true
```

线上迁移与密钥（部署时执行；CI 会自动做迁移那一步）：

```bash
pnpm cf:migrate                       # = wrangler d1 migrations apply haiguitang --remote
npx wrangler secret put MASTER_KEY
npx wrangler secret put AI_KEY        # 可选
pnpm cf:deploy
```

## 安全红线（与运行时无关，全部保留）

- 汤底唯一出口是 `/api/recap`（settled + 非 aborted + 参与者三者齐备），DTO 白名单投影 + `assertNoLeak` 兜底
- Key 明文只在「入站提交」与「出站调用前一刻」存在；`MASTER_KEY` 是 Worker secret，不入仓库
- 提交权限由服务端（房间 API）校验；前端按钮只是 UX
- 预输入草稿只存在浏览器 `localStorage`，服务端无对应字段
