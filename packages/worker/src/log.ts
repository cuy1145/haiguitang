/**
 * Workers 侧结构化日志（与 Node 版脱敏规则一致，落点是 console → Workers Logs / `wrangler tail`）。
 *
 * 硬约束（与《阶段5》§3.1 相同）：
 *  · 绝不记录 API Key 明文 / 密文 / 指纹 / 掩码
 *  · 绝不记录汤底与事实点原文（用 puzzle_id + turn_seq 关联数据库）
 *  · 绝不记录 resume_token 与完整 IP
 */
import type { LoggerPort } from '../../server/src/ports.ts';

const REDACT_KEYS = [
  'api_key', 'apikey', 'authorization', 'bearer', 'token', 'resume_token', 'master_key',
  'key_ciphertext', 'cipher', 'iv', 'tag', 'key_fingerprint', 'mask', 'mask_display',
  'truth', 'fact_text', 'key_points', 'red_lines',
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (/\bsk-[A-Za-z0-9_-]{8,}\b/.test(value)) return '[redacted-key]';
    if (value.length > 300) return `${value.slice(0, 120)}…(${value.length} chars)`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (REDACT_KEYS.some((needle) => lower.includes(needle))) { out[k] = '[redacted]'; continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** 日志里只出现成员短哈希，不出现昵称与 id。 */
export async function memberRef(memberId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(memberId));
  return `m_${[...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function hashIp(ip: string | undefined, salt = 'ht'): string {
  // CF 侧不落 IP：这里只做不可逆的短哈希（用于限流与滥用排查）
  let h = 0x811c9dc5;
  const input = `${salt}:${ip ?? 'unknown'}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class ConsoleLogger implements LoggerPort {
  constructor(private readonly minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {}

  private write(level: 'debug' | 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
    const order = { debug: 10, info: 20, warn: 30, error: 40 } as const;
    if (order[level] < order[this.minLevel]) return;
    const line = JSON.stringify({ ts: Date.now(), level, event, ...(redact(fields) as Record<string, unknown>) });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.write('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.write('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.write('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.write('error', event, fields); }
}
