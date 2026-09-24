/**
 * Workers 侧 HTTP 小工具：JSON 响应、请求体解析、安全响应头。
 * 与 Node 版（packages/server/src/log.ts + server.ts 内的 helper）行为一致：
 * 入参一律显式校验、错误一律带结构化错误码。
 */

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

/** 随机令牌（32 字节，base64url）。 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
