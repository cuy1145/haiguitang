/**
 * Workers 侧 HTTP 小工具：JSON 响应、请求体解析、安全响应头。
 * 与 Node 版（packages/server/src/log.ts + server.ts 内的 helper）行为一致：
 * 入参一律显式校验、错误一律带结构化错误码。
 */
import { normalizeClientIp } from '../../core/src/text.ts';

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...securityHeaders('api'), ...extraHeaders },
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 64 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 安全响应头：最小 CSP（前端零依赖、无外部资源），禁嵌入、禁 MIME 嗅探。 */
export function securityHeaders(kind: 'api' | 'static'): Record<string, string> {
  const base: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  };
  if (kind === 'static') {
    base['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return base;
}

/** 昵称清洗（与 Node 版一致：去控制字符与尖括号、限长、空则兜底）。 */
export function sanitizeNickname(value: unknown): string {
  const raw = typeof value === 'string' ? value : '玩家';
  const clean = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return clean.length >= 1 ? clean : '玩家';
}

/**
 * 面向玩家的固定错误文案：**唯一权威表在 server/protocol.ts**（Worker 与 Node 服务器共用）。
 * 这里只做转发，避免两边各写一份、各自漏码（漏码的后果：玩家只看到"操作未通过校验"，
 * 真正的失败原因被吞掉 —— AI 出题返回 SCHEMA_INVALID 时就是这样）。
 */
export { messageOf } from '../../server/src/protocol.ts';

/** 生成房间码：剔除 I/L/O/0/1 的 6 位字符集。 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)] ?? 'A';
  return out;
}

/** 令牌哈希（WebCrypto，异步）。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 客户端 IP → **加盐哈希**（HMAC-SHA256，取前 16 位十六进制）。
 *
 * ⚠️ 为什么必须是 HMAC 而不是 `sha256(salt + ip)`：IPv4 只有 2³² 个取值，
 *    拿公开盐 + 哈希几秒就能反查出全部 IP。HMAC 的密钥来自部署密钥（MASTER_KEY），
 *    没有密钥就算不出映射关系；而且域分隔前缀 `ht-ip-v1:` 保证与其它用途的哈希互不通用。
 *
 * IP 来源：**只认 Cloudflare 注入的 `CF-Connecting-IP`**（边缘会覆盖客户端伪造的同名头）。
 * 不读 `X-Forwarded-For`（那是客户端可伪造的）。拿不到合法 IP 时返回 null，不写假值。
 * 原始 IP 绝不落库、绝不进日志。
 */
export async function hashClientIp(ip: string | null | undefined, secret: string | null | undefined): Promise<string | null> {
  const addr = normalizeClientIp(ip);
  if (!addr || !secret) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`ht-ip-v1:${addr}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** 从请求头取出客户端 IP 并哈希；密钥优先 MASTER_KEY，其次 IP_HASH_SALT。 */
export async function clientIpHashOf(request: Request, env: { MASTER_KEY?: string; IP_HASH_SALT?: string }): Promise<string | null> {
  const secret = env.IP_HASH_SALT || env.MASTER_KEY || null;
  return hashClientIp(request.headers.get('CF-Connecting-IP'), secret);
}

/** 随机令牌（32 字节，base64url）。 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
