/**
 * 文本规范化与哈希。
 *
 * 用途（两处必须共用同一实现，否则会出现"同问题不同缓存键"的一致性缺陷）：
 *  1. 判定缓存的键（《阶段2》§3.1）
 *  2. 防越狱的输入预检（L0）
 */
import type { GameConfig } from './types.ts';
import { CONFIG_SCHEMA, PLATFORM } from './constants.ts';

const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\ufeff\u180e]/g;

/** NFKC 归一 + 去零宽/不可见字符 + 折叠空白 + 去首尾空白。 */
export function normalize(input: string): string {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 规范化后的小写形式，用于关键词与意图匹配。 */
export function normalizeLower(input: string): string {
  return normalize(input).toLowerCase();
}

/**
 * 讨论消息（全员讨论区）的正文化：**刻意不做 NFKC**。
 *
 * 判定链路用 `normalize()` 是为了缓存键稳定，NFKC 会把全角标点（，！？：；（））折成半角，
 * 中文里那是错的排版；讨论消息是给人看的正文，不该被改写。
 * 这里只做设计稿 §12.8 要求的事：去零宽 / 控制字符、折叠多余空白、去首尾空白。
 * 换行保留（最多连续两个），因为讨论区允许多行输入。
 */
export function sanitizeChatText(input: string): string {
  return String(input ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

/**
 * 客户端 IP 归一化（只用于**加盐哈希**，原始 IP 绝不落库/落日志）。
 *
 * 处理真实世界里会遇到的几种写法：
 *   · `::ffff:203.0.113.7`  → `203.0.113.7`（IPv4-mapped IPv6，Node 的 remoteAddress 长这样）
 *   · `203.0.113.7:51234`   → `203.0.113.7`（带端口）
 *   · `[2001:db8::1]:443`   → `2001:db8::1`（IPv6 方括号写法）
 *   · 空 / `unknown` / 非 IP 字符串 → null（**不要**把它哈希成一个固定的"unknown"桶，
 *     那会让所有缺 IP 的请求看起来像同一个人）
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'unknown' || s === 'null' || s === 'undefined') return null;
  // [v6]:port
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1]!;
  // v4:port（只在"恰好一个冒号且右侧是数字"时按端口处理，避免破坏 IPv6）
  else if ((s.match(/:/g) ?? []).length === 1 && /:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (s.startsWith('::ffff:')) s = s.slice(7);
  // 只接受 IPv4 / IPv6 字面量；其它一律丢弃（域名、垃圾串都不该进哈希）
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((p) => Number(p) <= 255);
  const isV6 = /^[0-9a-f:]+$/.test(s) && s.includes(':');
  if (!isV4 && !isV6) return null;
  return s;
}

/** 稳定哈希（判定缓存键用；不要求密码学强度，但要求跨进程一致）。 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 判定缓存键：题目 + 问题哈希 + 提示词版本 + 事实集版本（任一升级即失效）。 */
export function verdictCacheKey(puzzleId: string, question: string, promptVersion: string, factSetVersion: number): string {
  return `${puzzleId}|${stableHash(normalize(question))}|${promptVersion}|${factSetVersion}`;
}

/** n-gram 集合（泄露检查用：与汤底求交集必须为空）。 */
export function ngrams(text: string, n: number): Set<string> {
  const s = normalize(text);
  const out = new Set<string>();
  if (s.length < n) {
    if (s.length > 0) out.add(s);
    return out;
  }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/** 两个集合是否共享任一 n-gram（返回首个命中的片段，便于报错）。 */
export function sharedNgram(a: string, b: string, n = 8): string | null {
  const A = ngrams(a, n);
  if (A.size === 0) return null;
  for (const g of ngrams(b, n)) if (A.has(g)) return g;
  return null;
}

/** 归一化编辑相似度（0~1），用于"输出是否抄了事实点原文"的判断。 */
export function similarity(a: string, b: string): number {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (A.size === 0 || B.size === 0) return normalize(a) === normalize(b) ? 1 : 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size);
}
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** 清理并校验提问文本；返回 null 表示通过，否则返回拒绝码。 */
export function checkQuestionText(raw: string): 'TEXT_EMPTY' | 'TEXT_TOO_LONG' | null {
  const clean = normalize(raw);
  if (clean.length < PLATFORM.questionMinLen) return 'TEXT_EMPTY';
  if (clean.length > PLATFORM.questionMaxLen) return 'TEXT_TOO_LONG';
  return null;
}

/** 清理并校验推理文本。 */
export function checkGuessText(raw: string): 'GUESS_TOO_SHORT' | 'TEXT_TOO_LONG' | null {
  const clean = normalize(raw);
  if (clean.length < PLATFORM.guessMinLen) return 'GUESS_TOO_SHORT';
  if (clean.length > PLATFORM.guessMaxLen) return 'TEXT_TOO_LONG';
  return null;
}

/**
 * 判定缓存版本号（提示词改动时递增）。
 * v2：explain 从"可选"改成"必填"（每次判定都要给一句结合提问语境、不给额外提示的说明）。
 *     不递增的话，旧缓存里的判定会把没有说明的历史答案原样喂回来，玩家看到的还是干巴巴的"是/否"。
 * v3：新增 **partial（部分接近）**：一句话里同时问到多件事时，要求模型把问到的事实点都填进
 *     `matched_fact_ids`，命中里真假混杂就由事实表裁决成 partial。
 *     不递增的话，同一个问题会命中 v2 时期"只映射一条"的旧结论，永远看不到"部分接近"。
 */
export const PROMPT_VERSION = 'judge-v3';

// ---------------------------------------------------------------- 配置校验
export interface ConfigValidation {
  ok: boolean;
  errors: Array<{ path: string; value: unknown; reason: string; allowed?: string }>;
}

/**
 * 参数校验（《阶段3》§5.3）：**整批拒绝，不静默取默认值**。
 * 跨字段规则同样在此处集中实现。
 */
export function validateConfig(candidate: Partial<GameConfig>): ConfigValidation {
  const errors: ConfigValidation['errors'] = [];
  for (const spec of CONFIG_SCHEMA) {
    const value = (candidate as unknown as Record<string, unknown>)[spec.key];
    if (value === undefined) continue;
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') {
        errors.push({ path: spec.key, value, reason: 'NOT_BOOLEAN', allowed: 'true | false' });
      }
      continue;
    }
    if (spec.type === 'enum') {
      if (!spec.values || !spec.values.includes(value as string | number)) {
        errors.push({ path: spec.key, value, reason: 'NOT_IN_ENUM', allowed: (spec.values ?? []).join(' | ') });
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      errors.push({ path: spec.key, value, reason: 'NOT_INTEGER', allowed: `[${spec.min}, ${spec.max}]` });
      continue;
    }
    if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
      errors.push({ path: spec.key, value, reason: 'OUT_OF_RANGE', allowed: `[${spec.min}, ${spec.max}]` });
    }
  }
  const g = candidate as Partial<GameConfig>;
  if (g.graceSec !== undefined && g.perTurnSec !== undefined && g.graceSec > g.perTurnSec) {
    errors.push({ path: 'graceSec', value: g.graceSec, reason: 'GREATER_THAN_PER_TURN', allowed: `<= perTurnSec(${g.perTurnSec})` });
  }
  if (g.hintTier3Max !== undefined && g.hintQuotaPerMember !== undefined && g.hintTier3Max > g.hintQuotaPerMember) {
    errors.push({ path: 'hintTier3Max', value: g.hintTier3Max, reason: 'GREATER_THAN_HINT_QUOTA', allowed: `<= hintQuotaPerMember(${g.hintQuotaPerMember})` });
  }
  if (g.difficultyMin !== undefined && g.difficultyMax !== undefined && g.difficultyMin > g.difficultyMax) {
    errors.push({ path: 'difficultyMin', value: g.difficultyMin, reason: 'MIN_GREATER_THAN_MAX', allowed: `<= difficultyMax(${g.difficultyMax})` });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 开局后修改参数时的额外校验：只允许增大、或禁止修改
 * （防止"追溯性剥夺"：把上限调小会立刻结束对局、把配额调小会没收已承诺的资源）。
 */
export function validateConfigChange(
  current: GameConfig,
  patch: Partial<GameConfig>,
  started: boolean,
): ConfigValidation {
  const base = validateConfig({ ...current, ...patch });
  const errors = [...base.errors];
  if (started) {
    for (const spec of CONFIG_SCHEMA) {
      const next = (patch as unknown as Record<string, unknown>)[spec.key];
      if (next === undefined) continue;
      const prev = (current as unknown as Record<string, unknown>)[spec.key];
      if (spec.afterStart === 'locked' && next !== prev) {
        errors.push({ path: spec.key, value: next, reason: 'LOCKED_AFTER_START', allowed: `固定为 ${String(prev)}` });
      }
      if (spec.afterStart === 'increase-only' && typeof next === 'number' && typeof prev === 'number' && next < prev) {
        errors.push({ path: spec.key, value: next, reason: 'DECREASE_NOT_ALLOWED', allowed: `>= ${prev}` });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

