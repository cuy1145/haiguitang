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
import { json, securityHeaders } from './http.ts';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MASTER_KEY?: string;
  AI_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_PROVIDER?: string;
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
      return json({
        presets: ['quick', 'standard', 'casual'],
        vaultEnabled: Boolean(env.MASTER_KEY),
        realModelEnabled: Boolean(env.AI_KEY && env.AI_BASE_URL && env.AI_MODEL),
        storage: 'd1',
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/debug/')) {
      return json({
        error: 'MIGRATION_IN_PROGRESS',
        message: '房间 API 正在从 Durable Objects 迁移到 D1 方案，见 packages/worker/README.md 的待办清单',
        available: ['/api/health', '/api/config'],
      }, 501);
    }

    // 静态资源（前端）
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(securityHeaders('static'))) headers.set(k, v);
    void ctx;
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
