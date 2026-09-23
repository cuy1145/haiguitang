/**
 * 本地模拟主持人（内置规则主持人）。
 *
 * 用途：
 *  1. 未配置 AI（AI_KEY 为空）时的降级主持人 —— 保证"除 AI 调用外其余功能离线可运行"
 *  2. M0 单文件原型的默认主持人
 *  3. 集成测试的确定性桩（不发任何网络请求）
 *
 * 与真实模型的分工完全一致：它只做「问题 → 事实点映射」，答案由 decideFromFacts 裁决。
 */
import type { JudgeResult, PuzzleFact } from './types.ts';
import { analyzeInput, decideFromFacts, preflight } from './verdict.ts';
import { matchFactsByKeys } from './facts.ts';
import { stableHash, normalize, verdictCacheKey, PROMPT_VERSION } from './text.ts';

export interface MockHostOptions {
  /** 题目 id（参与判定缓存键；缺省为 mock，仅用于本地模拟） */
  puzzleId?: string;
  facts: readonly PuzzleFact[];
  /** 事实集版本，参与缓存键 */
  factSetVersion?: number;
  /** 判定缓存（同问题同结论）。缺省则每次重算。 */
  cache?: Map<string, JudgeResult>;
}

/**
 * 判定一次提问。
 * 顺序：缓存 → L0 预检（不调模型）→ 复合提问拆分 → 事实匹配 → 四类结论。
 */
export function mockJudge(question: string, opts: MockHostOptions): JudgeResult {
  const puzzleId = opts.puzzleId ?? 'mock';
  const key = verdictCacheKey(puzzleId, question, PROMPT_VERSION, opts.factSetVersion ?? 1);
  const cached = opts.cache?.get(key);
  if (cached) return { ...cached, source: 'cache' };

  const result = compute();
  opts.cache?.set(key, result);
  return result;

  function compute(): JudgeResult {
    const blocked = preflight(question);
    if (blocked) return blocked;

    const { features } = analyzeInput(question);
    if (features.compound.length >= 2) {
      const answers = features.compound.map((part) => {
        const matched = matchFactsByKeys(part, opts.facts);
        return decideFromFacts(matched);
      });
      const unique = Array.from(new Set(answers));
      if (unique.length > 1) {
        return { answer: 'unanswerable', reasonCode: 'COMPOUND_SPLIT_REQUIRED', matchedFactIds: [], source: 'rule' };
      }
      const matched = matchFactsByKeys(features.compound[0] ?? '', opts.facts);
      return { answer: unique[0] ?? 'irrelevant', reasonCode: 'NONE', matchedFactIds: matched.map((f) => f.id), source: 'model' };
    }

    const matched = matchFactsByKeys(question, opts.facts);
    return {
      answer: decideFromFacts(matched),
      reasonCode: 'NONE',
      matchedFactIds: matched.map((f) => f.id),
      source: 'model',
    };
  }
}

/** 供测试与日志使用的键（与缓存内部一致）。 */
export function mockCacheKey(puzzleId: string, question: string, factSetVersion = 1): string {
  return `${verdictCacheKey(puzzleId, question, PROMPT_VERSION, factSetVersion)}#${stableHash(normalize(question))}`;
}

