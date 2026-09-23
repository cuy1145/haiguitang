/**
 * Cloudflare Workers 入口：路由分发（API / WebSocket / 静态资源）。
 *
 * 与 Node 参考实现（packages/server）的关系：
 *  · 规则与编排**复用同一份 @ht/core**（零依赖纯函数），不存在第二套规则实现
 *  · 本文件只承担"运行时适配"：把 fetch 请求路由到房间 Durable Object，
 *    把 WebSocket 升级交给 DO（这样连接与房间状态天然同源、且支持休眠）
 */
import type { RoomDurableObject } from './room-do.ts';
import type { LibraryDurableObject } from './library-do.ts';
import { json, securityHeaders } from './http.ts';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  LIBRARY: DurableObjectNamespace<LibraryDurableObject>;
  ASSETS: Fetcher;
  /** 加密房主自备 Key 的主密钥（32 字节 base64）；缺失即关闭该功能 */
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ---- WebSocket 升级：交给房间 DO（每房一个 DO，连接与状态同源）----
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token') ?? '';
      if (!token) return json({ error: 'UNAUTHORIZED' }, 401);
      const roomId = await lookupRoomByToken(env, token);
      if (!roomId) return json({ error: 'UNAUTHORIZED' }, 401);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'EXPECTED_WEBSOCKET' }, 426);
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    if (url.pathname.startsWith('/api/')) {
      // 会话/房间码相关的全局索引放在单例 Library DO 里（避免引入第二个数据库）
      if (url.pathname === '/api/health') {
        const library = env.LIBRARY.get(env.LIBRARY.idFromName('library'));
        const health = await library.fetch(new Request('https://library/health', { method: 'GET' }));
        const body = await health.json() as Record<string, unknown>;
        return json({
          ok: true,
          runtime: 'cloudflare-workers',
          vault: Boolean(env.MASTER_KEY),
          realModel: Boolean(env.AI_KEY && env.AI_BASE_URL && env.AI_MODEL),
          ...body,
        }, 200);
      }

      const library = env.LIBRARY.get(env.LIBRARY.idFromName('library'));
      const forwarded = new Request(`https://library${url.pathname}${url.search}`, request);
      return library.fetch(forwarded);
    }

    if (url.pathname.startsWith('/debug/')) {
      if (env.DEV_TOOLS !== '1') return json({ error: 'DEBUG_DISABLED' }, 403);
      const library = env.LIBRARY.get(env.LIBRARY.idFromName('library'));
      return library.fetch(new Request(`https://library${url.pathname}${url.search}`, request));
    }

    // ---- 静态资源（前端）----
    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset, 'static');
  },
} satisfies ExportedHandler<Env>;

/** 通过会话令牌反查房间（令牌只以哈希形式存储）。 */
async function lookupRoomByToken(env: Env, token: string): Promise<string | null> {
  const library = env.LIBRARY.get(env.LIBRARY.idFromName('library'));
  const res = await library.fetch(new Request('https://library/session/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }));
  if (!res.ok) return null;
  const body = await res.json() as { roomId?: string };
  return body.roomId ?? null;
}

function withSecurityHeaders(res: Response, kind: 'static' | 'api'): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders(kind))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export { RoomDurableObject } from './room-do.ts';
export { LibraryDurableObject } from './library-do.ts';
