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

/** 面向玩家的固定错误文案（不来自模型；与 Node 版 messageOf 保持一致）。 */
export function messageOf(code: string): string {
  switch (code) {
    case 'NOT_YOUR_TURN': return '还没轮到你发言。';
    case 'TURN_EXPIRED': return '本轮已跳过，内容未提交。';
    case 'TURN_ALREADY_ANSWERED': return '本轮已经提交过了。';
    case 'STALE_TURN': return '回合已经切换，请以最新状态为准。';
    case 'TURN_VOIDED': return '因房主变更，本轮已作废。';
    case 'MATCH_PAUSED': return '对局已暂停。';
    case 'MATCH_NOT_ACTIVE': return '对局未在进行中。';
    case 'NOT_HOST': return '只有房主可以做这个操作。';
    case 'VOTE_NOT_ELIGIBLE': return '挂机或离线的成员不能表决。';
    case 'VOTE_NOT_OPEN': return '当前没有进行中的投票。';
    case 'HINTS_DISABLED': return '本局未开启提示（房主可在「对局参数」里打开）。';
    case 'AI_UNAVAILABLE': return '当前没有可用的模型凭据：服务端没配平台额度，你也没填自备 Key。填一把自己的 Key（先点「测试连接」验证）即可；或让运维配置 AI_KEY。';
    case 'PUZZLE_INVALID': return 'AI 出的题没通过坏题检测，已作废（逐条原因见下），换一次生成即可。';
    case 'NOT_ALL_READY': return '还有玩家没点「我准备好了」；等大家都准备好，或确认后强制开局。';
    case 'HINT_COOLDOWN': return '提示冷却中。';
    case 'HINT_QUOTA_EXHAUSTED': return '你的提示次数已用尽。';
    case 'HINT_TIER3_EXHAUSTED': return 'T3 关键提示本局已用完。';
    case 'HINT_NO_FACT': return '该梯度已无可用提示。';
    case 'GUESS_NOT_IN_WINDOW': return '还没到可以揭秘的轮次。';
    case 'GUESS_ATTEMPTS_EXHAUSTED': return '你的揭秘次数已用尽。';
    case 'GUESS_TOO_SHORT': return '推理内容太短。';
    default: return '操作未通过校验。';
  }
}

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
