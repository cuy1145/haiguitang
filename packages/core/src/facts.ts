/**
 * 原子事实集的操作：匹配、提示挑选、揭秘判定。
 *
 * 事实集是判定与提示的**共同权威**（《阶段2》§3.1）：模型只做「问题 → 事实点」映射，
 * 答案与提示文案都由这里的规则算出，因此"同一问题永远同一答案"是架构属性。
 */
import type { GuessResult, PuzzleFact } from './types.ts';
import { normalize, normalizeLower } from './text.ts';

/** 关键词匹配（仅本地模拟主持人使用；真实模型走语义映射后再由服务端校验事实点 id）。 */
export function matchFactsByKeys(question: string, facts: readonly PuzzleFact[]): PuzzleFact[] {
  const lower = normalizeLower(question);
  const matched: PuzzleFact[] = [];
  for (const f of facts) {
    const keys = f.keys ?? [];
    if (keys.length === 0) continue;
    if (keys.some((k) => lower.includes(normalizeLower(k)))) matched.push(f);
  }
  return matched;
}

/** 挑选提示事实点：指定梯度、尚未释放、优先 required 且 id 稳定排序。 */
export function pickHintFact(
  facts: readonly PuzzleFact[],
  tier: 1 | 2 | 3,
  revealed: readonly string[],
): PuzzleFact | null {
  const pool = facts
    .filter((f) => f.tier === tier && f.isTrue && !revealed.includes(f.id))
    .sort((a, b) => Number(b.required) - Number(a.required) || (a.id < b.id ? -1 : 1));
  return pool[0] ?? null;
}

/** 提示预算检查：全部 required 事实点都被释放后，提示必须用尽（最后一块拼图留给玩家）。 */
export function hintsExhausted(facts: readonly PuzzleFact[], revealed: readonly string[]): boolean {
  const required = facts.filter((f) => f.required);
  return required.length > 0 && required.every((f) => revealed.includes(f.id));
}

/**
 * 揭秘判定（《阶段2》§3.4）：阈值与 required 集合都是数据，不由模型给结论。
 * hit      = 关键要素全中 + 表达了因果链 + 无关键矛盾
 * partial  = 命中率 ≥ 0.6 且无 required 级矛盾（只反馈数量，不告知命中哪几条）
 */
export function judgeGuess(text: string, facts: readonly PuzzleFact[]): GuessResult {
  const clean = normalize(text);
  const lower = normalizeLower(text);
  const required = facts.filter((f) => f.required);
  const hitRequired = required.filter((f) => (f.keys ?? []).some((k) => lower.includes(normalizeLower(k))));
  const contradictions = facts.filter((f) => f.isTrue === false && (f.keys ?? []).some((k) => lower.includes(normalizeLower(k))));
  const ratio = required.length === 0 ? 0 : hitRequired.length / required.length;
  const causal = /(所以|因此|于是|因为|导致|结果|为了|原来|才)/.test(clean) || clean.length > 40;
  const keyContradiction = contradictions.some((f) => f.required);

  let verdict: GuessResult['verdict'] = 'miss';
  if (ratio >= 1 && causal && contradictions.length === 0) verdict = 'hit';
  else if (ratio >= 0.6 && !keyContradiction) verdict = 'partial';

  return { verdict, hits: hitRequired.length, total: required.length, contradictions: contradictions.length };
}

/** 判定尺度版本号：写入 guess_record，便于事后归因"这次判定是不是因为改了尺度"。 */
export const SCALE_VERSION = 'scale-v1';
