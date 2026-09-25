/**
 * Cloudflare Workers 入口（方案 A：D1 + 惰性推进 + 轮询，无 Durable Objects）。
 *
 * 当前状态：**基础层已就绪，房间 API 正在落地**。
 *   ✅ 静态资源、安全响应头、健康检查（会真实查询 D1，用于验证绑定与迁移）
 *   ✅ D1 仓储（store-d1.ts：预读 + 缓冲写 + CAS 单事务批次）、WebCrypto 保险箱、脱敏日志
 *   ⬜ 房间 API（建房/加入/状态/事件/动作/复盘/凭据）——见 packages/worker/README.md 的待办
 *
 * 未完成端点统一返回 501 + 明确的 `MIGRATION_IN_PROGRESS`，避免"看起来能玩但行为不对"。
 */
// 房主自备 Key 的默认提供方常量与 API 一起放在 room-api.ts（单一来源）
import { json, securityHeaders } from './http.ts';
import { handleApi, siteAiConfig, DEFAULT_HOST_BASE_URL, DEFAULT_HOST_MODEL } from './room-api.ts';
import { listPurgeableRooms, purgeRoom } from './store-d1.ts';
import { ConsoleLogger } from './log.ts';
import { PLATFORM } from '@ht/core';

const logger = new ConsoleLogger('info');

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MASTER_KEY?: string;
  AI_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_PROVIDER?: string;
  DEFAULT_HOST_BASE_URL?: string;
  DEFAULT_HOST_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  DEV_TOOLS?: string;
  SITE_MONTHLY_CALL_CAP?: string;
  SITE_GRANT_BUDGET_CALLS?: string;
  SITE_GRANT_MAX_PER_MATCH?: string;
  SITE_GRANT_COOLDOWN_SEC?: string;
  POLL_WAIT_MS?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 健康检查：真实打一次 D1，用来验证绑定与迁移是否生效
    if (url.pathname === '/api/health') {
      let db: { ok: boolean; rooms?: number; detail?: string };
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM rooms').first<{ c: number }>();
        db = { ok: true, rooms: Number(row?.c ?? 0) };
      } catch (err) {
        db = { ok: false, detail: (err as Error).message };
      }
      return json({
        ok: db.ok,
        runtime: 'cloudflare-workers',
        storage: 'd1',
        persistence: 'd1',
        vault: Boolean(env.MASTER_KEY),
        realModel: Boolean(env.AI_KEY && env.AI_BASE_URL && env.AI_MODEL),
        migration: 'room-api-in-progress',
        db,
      }, db.ok ? 200 : 503);
    }

    if (url.pathname === '/api/config') {
      const site = siteAiConfig(env);
      return json({
        presets: ['quick', 'standard', 'casual'],
        vaultEnabled: Boolean(env.MASTER_KEY),
        // 只配 AI_KEY 就算启用（地址/模型缺省时自动用 DeepSeek）
        realModelEnabled: site.enabled,
        storage: 'd1',
        // 房主自备 Key 的默认提供方（只下发非敏感字段，用于预填表单）
        defaultProvider: env.AI_PROVIDER ?? 'openai-compatible',
        defaultBaseUrl: env.DEFAULT_HOST_BASE_URL ?? DEFAULT_HOST_BASE_URL,
        defaultModel: env.DEFAULT_HOST_MODEL ?? DEFAULT_HOST_MODEL,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    if (url.pathname.startsWith('/debug/')) {
      return json({
        error: 'MIGRATION_IN_PROGRESS',
        message: '调试接口待移植（见 packages/worker/README.md）',
      }, 501);
    }

    // 方案 A 改用轮询，不再提供 WebSocket。
    // 这里显式返回 410，避免落到静态资源兜底（那会让前端误以为是网络问题而无限重连）。
    if (url.pathname === '/ws') {
      return json({
        error: 'WEBSOCKET_REMOVED',
        message: '本部署使用 D1 + 轮询方案（无 Durable Objects），WebSocket 不再提供；前端正在改为轮询',
        pollEndpoints: ['/api/rooms/:id/state', '/api/rooms/:id/events?since=seq'],
      }, 410);
    }

    // 静态资源（前端）
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(securityHeaders('static'))) headers.set(k, v);
    void ctx;
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },

  /**
   * Cron 清理（wrangler.toml: `crons = ["17 * * * *"]`）。
   * 只做"没人访问、也就没人会来管"的收尾 —— 对局计时由请求内的惰性推进负责，不依赖 Cron。
   *  · 空房间（含单人退出后残留的）→ 立即清理
   *  · 未开局超 `PLATFORM.roomWaitExpireSec`（6 小时）
   *  · **没人了**：没状态变化、也没人心跳超过 `PLATFORM.roomDestroySec`（6 小时）
   *    —— 晚上关掉网页没点"离开房间"的房间，第二天早上就会被这里收掉
   *  · 过期密钥密文物理清空
   *
   * 每次销毁都补一条 `room_destroyed` 审计（这条路径没有玩家动作，不记的话
   * 事后完全看不出房间是什么时候没的、为什么没的）。
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    try {
      const purgeable = await listPurgeableRooms(env.DB, now);
      for (const room of purgeable) {
        await purgeRoom(env.DB, room.id);
        await env.DB.prepare(
          `INSERT INTO audit_events(id, ts, room_id, actor, action, subject, result, ip_hash, meta_json)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).bind(
          `aud_${now}_${Math.random().toString(36).slice(2, 8)}`, now, room.id, 'system',
          'room_destroyed', room.reason, 'cron', null,
          JSON.stringify({ ttl_h: PLATFORM.roomDestroySec / 3600, wait_ttl_h: PLATFORM.roomWaitExpireSec / 3600 }),
        ).run();
        logger.info('room_purged', { room_id: room.id, code: room.reason });
      }
      const destroyed = await env.DB.prepare(
        `UPDATE credentials SET state='destroyed', cipher=NULL, iv=NULL, tag=NULL, key_id=NULL,
           fingerprint=NULL, mask=NULL, destroyed_reason='TTL_EXPIRED', ttl_expires_at=NULL
         WHERE state IN ('active','suspended','validating') AND ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?`,
      ).bind(now).run();
      logger.info('cron_done', {
        purged_rooms: purgeable.length,
        expired_credentials: destroyed.meta?.changes ?? 0,
      });
    } catch (err) {
      logger.error('cron_failed', { code: (err as Error).message });
    }
  },
} satisfies ExportedHandler<Env>;

