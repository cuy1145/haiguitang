# 阶段 6（修订）：部署形态改为 Cloudflare Workers + Durable Objects + GitHub

> ⚠️ **这份文档只作历史保留，其中的 Durable Objects 方案没有实现，也不要照着做。**
> 真正落地的是 [`CF-WITHOUT-DO.md`](CF-WITHOUT-DO.md) 的**方案 A**：Cloudflare Workers + **D1** + 惰性推进 + 客户端轮询
> （原因是该账号的 Durable Objects 需要付费，免费计划用不了）。
> 下面关于 DO 的章节（每房一个 DO、DO alarm、DO SQLite、WS 休眠）**全部不适用于当前代码**；
> 仍然有效的部分：领域设计（阶段 2/3/4 与 `@ht/core`）与"两个运行时共用同一份规则"的结论。

> 触发原因：把部署目标从「自托管单实例」改成「Cloudflare + GitHub」。
> 本文件是**对阶段 1～5 的修订**，不是新增功能阶段。凡未在此列出的章节继续有效。
> 结论：**领域设计（阶段 2 / 3 / 4 与 `@ht/core`）几乎不需要改**；需要改的是运行时与部署层（阶段 1 §3.2/§3.3/§3.4/§3.6、阶段 5 §1.1/§2/§3/§6）。

---

## 1. 一句话结论

原来的架构被设计成「单实例 + 进程内状态 + setInterval + 本地 SQLite + 文件日志」，
**这四件事在 Cloudflare 上都不存在**；但 Cloudflare 恰好提供了它们的**原生等价物，而且更强**：

| 原设计（自托管） | Cloudflare 等价物 | 变化性质 |
|---|---|---|
| 房间级 Promise 串行队列（自研） | **Durable Object 单线程强一致**（每房一个 DO） | 自研 → 平台保证（**更强**：跨网络/跨重启/跨实例） |
| `setInterval` 250ms 扫描 | **DO alarm** | 自研调度 → 平台调度（可休眠、可重试、按房独立） |
| `node:sqlite` 单库 | **DO 自带 SQLite**（`ctx.storage.sql`，每房一个库） | 表结构不变，API 换掉 |
| JSONL 日志文件 | **Workers Logs / `wrangler tail` / Logpush** | 文件 → 日志流 |
| 进程内房间缓存 | DO 内存（可被回收）+ SQLite 恢复 | 语义从"重启即暂停"变成"随时可被回收，按需恢复" |
| `ws` 服务端 + 自研协议 | **DO WebSocket Hibernation API** | 连接与房间状态天然同源 |
| `node:crypto` AES-GCM | **WebCrypto AES-GCM**（`crypto.subtle`） | 算法与 AAD 绑定完全不变，只是异步 |
| `MASTER_KEY` 环境变量 | **Worker secret**（`wrangler secret put`） | 更安全：加密存储、不进配置文件 |
| Docker Compose + Caddy | **`wrangler deploy` + Workers Static Assets** | 无服务器、无证书运维 |

**为什么"更强"**：原方案的串行队列只在单进程内成立，我还在文档里写了"若将来水平扩展则失效"。
DO 的串行性是**平台级保证**，且天然把"一个房间"映射成"一个执行单元"——这正好是本项目的并发模型。

---

## 2. 需要修改的章节（逐条）

| 位置 | 原文 | 修订后 | 理由 |
|---|---|---|---|
| 阶段1 §3.2 后端运行时 | Node 20 + Fastify | **Cloudflare Workers（ES Module）+ Durable Objects** | 部署目标变更 |
| 阶段1 §3.3 实时通信 | Socket.IO（进程内 adapter） | **DO WebSocket + Hibernation**；客户端用浏览器原生 WebSocket | 平台原生；休眠期间不计时长 |
| 阶段1 §3.4 数据库 | SQLite（better-sqlite3） | **DO SQLite（`ctx.storage.sql`）**；每房一个库 | 表结构与唯一索引**不变** |
| 阶段1 §3.6 部署形态 | 单台 VPS + Docker Compose + Caddy | **wrangler deploy + Workers Static Assets**；GitHub Actions 做 CI/CD | —— |
| 阶段1 §5 目录结构 | `packages/{core,ai,db,vault,server,web}` | `packages/{core,server,worker,web}`：`core` 不变；`server` 降级为**运行时适配 + 参考实现**；新增 `worker` 为生产运行时 | 端口化后两个运行时共用 core 与编排 |
| 阶段2 §2.2 指令与数据分离 | 无变化 | 无变化 | 判定口径与防越狱完全与运行时无关 |
| 阶段2 §3.1 判定缓存 | 全局缓存（跨房间一致） | **缓存按房间隔离**（同一 DO 内共享） | 一致性由**事实表权威裁决**保证，不依赖缓存；缓存只是成本/延迟优化 |
| 阶段3 §1.5 房间生命周期 | 6h/2h/24h + 60s 扫描 | 阈值不变，**由 alarm 驱动**；不再有"常驻扫描进程" | 无进程概念 |
| 阶段3 §2.7 服务端时间 | `Date.now()` | 不变（Workers 提供） | —— |
| 阶段4 §9.2 加密选型 | node:crypto AES-256-GCM + `MASTER_KEY` env | **WebCrypto AES-256-GCM + Worker secret**；AAD 绑定不变 | 算法不变 |
| 阶段4 §5 运行时失败处理 | 不变 | 不变（`fetch` + AbortController 在 Workers 上同样可用） | —— |
| 阶段5 §1.1 串行化机制 | 房间队列 + 版本号 + 唯一索引 | **DO 串行 + 版本号 + 唯一索引**（三层保留，第一层交给平台） | 见上 |
| 阶段5 §2.2 服务器重启 | 重启后内存态丢失 → 房间暂停 | **DO 被回收后按需恢复**：状态从 SQLite 重建，alarm 续期；**不进入暂停** | 语义变化，见 §4 风险 |
| 阶段5 §3 可观测性 | JSONL 文件 + 每小时聚合脚本 | **Workers Logs + `wrangler tail` + 可选 Logpush**；聚合改用 Workers Analytics Engine 或线下拉取 | 无文件系统 |
| 阶段5 §6 本地测试形态二 | `pnpm m1` 起本地 Node 服务 | **`pnpm cf:dev`（wrangler dev = 本地 workerd）**；Node 版保留为参考实现/回归夹具 | 已实测 workerd 可在本机运行 |
| 阶段5 §6.5 数据持久化 | SQLite 文件 + 备份脚本 | **DO SQLite**（平台负责持久化与复制）；题库改为种子文件（仓库内） | 无文件系统 |

**不需要改的**：阶段 2 全部（题库/分级/防越狱/判定一致性/复盘）、阶段 3 的回合状态机与成员状态两条线、
阶段 4 的额度优先级/锁定/四情形/移交归还/密钥生命周期、`@ht/core` 的每一个文件。

---

## 3. 目标架构（修订后的部署图）

```
                    GitHub（源码 + Actions）
                          │  push to main
                          ▼
        ┌───────────────────────────────────────────────┐
        │  Cloudflare Workers（边缘，无服务器）           │
        │  ┌─────────────────────────────────────────┐  │
        │  │ Worker 入口                              │  │
        │  │  · 静态资源（Static Assets）→ 前端 SPA    │  │
        │  │  · /api/health,/api/config → Library DO  │  │
        │  │  · /api/rooms*,/api/session → Library DO │  │
        │  │  · /ws → 房间 DO（每房一个）             │  │
        │  └───────┬──────────────────────┬──────────┘  │
        │          ▼                      ▼             │
        │  LibraryDurableObject    RoomDurableObject    │
        │  （单例）                （每房间一个）        │
        │  · 房间码索引            · 房间状态（内存+SQL）│
        │  · 会话令牌索引          · 该房间的 SQLite     │
        │  · 题库种子              · WebSocket（休眠）   │
        │  · 站点用量计数          · alarm 驱动 tick     │
        │                          · 密钥密文（本房）    │
        └───────────────────────────────────────────────┘
                          │ fetch（唯一出网点）
                          ▼
                   AI 提供方（房主自备 Key 或站点 Key）
```

关键安全性质**不变**（这是本项目的红线，与运行时无关）：
- Key 明文只在「入站提交」与「出站调用前一刻」存在；`MASTER_KEY` 是 Worker secret，不入仓库、不进配置
- 汤底唯一出口仍是 `GET /api/recap`（settled + 非 aborted + 参与者）；DTO 白名单投影与 `assertNoLeak` 原样保留
- 提交权限仍由服务端（现在是 DO）校验；前端按钮依旧只是 UX

---

## 4. 这次修改带来的新风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| **DO 随时可能被回收** | 原设计"重启 → 房间暂停"的语义要改；内存态不可信 | 已按"状态全量落 DO SQLite + 按需重建运行时"设计；`alarm` 续期；对局不进入暂停 |
| **CPU 时间上限**（Workers 每请求有限额） | 一次请求里做太多事会被杀掉 | 判定调用是 I/O 等待（不耗 CPU）；入库与广播的 CPU 量极小；单次 tick 只做纯计算。**部署前需按当前计划的限额复核**（见 §6 清单） |
| **每房一个 DO 的冷启动** | 房间被回收后首次访问有额外延迟 | 可接受（朋友间对局，秒级延迟无感）；如需进一步优化可提升 tick 间隔 |
| **跨房间判定缓存丢失** | 成本略升、跨房间缓存命中率下降 | 一致性由事实表保证；缓存按房隔离仅影响成本。若成本敏感，可把 `verdict_cache` 移到 Library DO（用一次额外 hop 换全局缓存） |
| **本地开发差异** | 本地 workerd 与线上行为可能有细微差别 | 用 `wrangler dev`（就是本地 workerd）做集成测试；GitHub Actions 上用同一套测试 |
| **两套运行时的漂移** | Node 版与 Worker 版行为不一致 | 端口化（`packages/server/src/ports.ts`）：`@ht/core` + `rooms.ts` + `ai.ts` 被两者**逐字复用**，只有适配器不同；两套适配器跑同一组测试 |
| **免费计划限制** | 可能超出免费额度或功能受限 | 见 §6 清单（需要在部署前逐项确认；DO 必须使用 `new_sqlite_classes` 的 SQLite 后端） |

---

## 5. 迁移步骤（已完成 ✅ / 待办 ⬜）

1. ✅ **端口化**：抽出 `RuntimeDeps` 的结构化端口（`RoomStorePort` / `LoggerPort` / `HostPort` / `DecryptPort`），
   让 `rooms.ts`（房间编排）与 `ai.ts`（AI 代理）不再依赖具体运行时
2. ✅ 移除 `ai.ts` 的 `node:crypto` 依赖（其中 `questionHash` 未被使用）→ 该文件现在可在 workerd 直接运行
3. ✅ 安装并验证 `wrangler`（4.136.3）与 `workerd` 可在本机运行
4. ✅ `wrangler.toml`：`new_sqlite_classes` 迁移、静态资源绑定、DO 绑定、变量与 secret 约定
5. ✅ Worker 侧适配器：入口路由、WebCrypto 保险箱、DO SQLite 仓储、房间 DO（alarm + WS 休眠）、控制台脱敏日志
6. ⬜ Library DO（房间码/会话令牌索引）与路由收口
7. ⬜ 让 `pnpm cf:dev` 跑通端到端：建房 → 加入 → 开局 → 提问 → 判定 → 复盘
8. ⬜ 把 Node 版集成测试**复用**到 workerd 上（同一组用例、两个运行时）
9. ⬜ GitHub Actions：`test` + `typecheck` + `selfcheck` + `wrangler deploy`（main 分支）
10. ⬜ 用真实账号 `wrangler deploy` 并用 `wrangler tail` 验证（需要你提供账号/计划信息）

---

## 6. 部署前必须确认的限额清单（我无法在沙箱里访问 CF 文档站，请一起核对）

我的沙箱把 `developers.cloudflare.com` 解析到非公网地址，取不到官方页面，因此以下条目**需要在你的账号里确认**（`wrangler` 与官方文档均可查）：

1. **Durable Objects 的计划可用性**：新的 DO 命名空间必须使用 **SQLite 存储后端**（`new_sqlite_classes`）；
   KV 后端已被 Cloudflare 停止支持用于新命名空间。SQLite 后端在**免费计划**可用（社区模板的
   [issue #459](https://github.com/cloudflare/templates/issues/459) 与
   [官方 changelog](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/) 都指向这一点）。
2. **DO 的存储上限**（每个对象；官方 Limits 页：<https://developers.cloudflare.com/durable-objects/platform/limits/>）
3. **请求/alarm 的 CPU 时间上限**（<https://developers.cloudflare.com/workers/platform/limits/>）——决定 tick 间隔与单次 tick 的工作量
4. **WebSocket 休眠计费**（<https://developers.cloudflare.com/durable-objects/best-practices/websockets/>）：休眠期间不计时长，仅按消息计费
5. **免费计划每日请求数**与 DO 请求是否单独计量
6. **Worker secret 数量/大小上限**（<https://developers.cloudflare.com/workers/configuration/secrets/>）

我会在实现里做保守假设（tick 1 秒、单次 tick 只做纯计算与少量 SQL），把超限风险降到最低；上面的数字确认后可以再调。

---

## 7. 需要你拍板的两件事

1. **是否保留 Node 版服务端？**
   - **推荐：保留为"参考实现 + 回归夹具"**（`pnpm reference`），生产只跑 Worker。
     好处：两套适配器跑同一组测试 → 用"差分测试"证明规则没有被运行时改动；本机没有 CF 账号时也能开发。
     代价：多一份适配器要维护（但规则与编排是共用的，适配器很薄）。
   - 备选：删掉 Node 版，只留 Worker + `wrangler dev` 本地开发。更干净，但失去"两个运行时互相验证"的能力。
2. **Cloudflare 用的是免费计划还是 Workers Paid？**
   影响：DO 的可用性与限额、WebSocket 休眠计费、是否能用 `wrangler tail` 长期观察。
   如果你现在还不确定，我就按"免费计划可用"实现（SQLite 后端 + 低 CPU 占用），不做任何需要付费计划的功能。

另外确认一下：**GitHub 侧你希望只做 CI 还是也做 CD？** 我的默认方案是 main 分支自动 `wrangler deploy`（需要
在仓库里配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 两个 secret），PR 只跑测试。
