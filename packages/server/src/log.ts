/**
 * 结构化日志（JSON Lines）+ 统一脱敏器（《阶段5》§3.1）。
 *
 * 硬约束：
 *  - 绝不记录 API Key 明文、密文、指纹、掩码（掩码只出现在"凭证本人"的接口响应里）
 *  - 绝不记录汤底与事实点原文（用 puzzle_id + turn_seq 关联数据库，而不是把文本写进日志）
 *  - 绝不记录 resume_token、完整 IP（只留 ip_hash）
 */
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { normalizeClientIp } from '@ht/core';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 需要整体屏蔽的字段名（大小写不敏感，含子串匹配）。 */
const REDACT_KEYS = [
  'api_key', 'apikey', 'authorization', 'bearer', 'token', 'resume_token', 'master_key',
  'key_ciphertext', 'cipher', 'iv', 'tag', 'key_fingerprint', 'mask', 'mask_display',
  'truth', 'fact_text', 'key_points', 'red_lines',
];

export interface LogRecord {
  ts: number;
  level: LogLevel;
  event: string;
  room_id?: string;
  match_id?: string;
  turn_seq?: number;
  member_ref?: string;
  code?: string;
  latency_ms?: number;
  [key: string]: unknown;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // 兜底：把疑似密钥形态与超长文本替换掉
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
      if (REDACT_KEYS.some((needle) => lower.includes(needle))) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * 客户端 IP → **加盐哈希**（只留 16 个十六进制字符，即 64 位）。
 *
 * ⚠️ 必须用 HMAC（密钥 + 域分隔），不能用 `sha256(salt + ip)` 这种"公开盐"：
 *    IPv4 只有 2³² 个取值，拿到哈希 + 公开盐，几秒就能把整张表反查出来 —— 那样存哈希等于存明文 IP。
 *    HMAC 的密钥来自部署密钥（Worker 用 MASTER_KEY），没有密钥就推不出对应关系。
 * 归一化交给 core 的 normalizeClientIp()；拿不到合法 IP 时返回 null（不造"unknown"假桶）。
 */
export function hashIp(ip: string | null | undefined, secret: string): string | null {
  const addr = normalizeClientIp(ip);
  // 没有密钥就**不记**：空密钥的 HMAC 等于公开算法，IPv4 空间太小，反查毫无门槛
  if (!addr || !String(secret ?? '').trim()) return null;
  return createHmac('sha256', `${secret}`).update(`ht-ip-v1:${addr}`).digest('hex').slice(0, 16);
}

/** 成员引用：日志里只出现短哈希，不出现昵称与 id（降低隐私面）。 */
export function memberRef(memberId: string): string {
  return `m_${createHash('sha256').update(memberId).digest('hex').slice(0, 8)}`;
}

export class Logger {
  private readonly minLevel: number;
  private readonly file: string | null;

  constructor(level: LogLevel = 'info', logDir?: string) {
    this.minLevel = LEVEL_ORDER[level];
    if (logDir) {
      try {
        mkdirSync(logDir, { recursive: true });
        this.file = join(logDir, 'server.log.jsonl');
      } catch {
        this.file = null;
      }
    } else {
      this.file = null;
    }
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const record: LogRecord = { ts: Date.now(), level, event, ...(redact(fields) as Record<string, unknown>) };
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
    if (this.file) {
      try { appendFileSync(this.file, `${line}\n`); } catch { /* 日志写失败不影响主流程 */ }
    }
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.write('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.write('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.write('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.write('error', event, fields); }
}
