/**
 * 题目结构校验与规范化 —— **AI 创作**与**题库导入**共用同一道门槛。
 *
 * 为什么必须共用：
 *   · 题库直接决定判定质量：事实点表写歪了，模型再准也只能给出歪答案；
 *   · 汤面里如果直接写了关键事实点，这道题一开局就是废题（等于把答案印在题面上）；
 *   · 无论是模型生成的还是从网上爬的，都可能有这些毛病，所以检查项完全一致。
 *
 * 检查项（坏题检测，对应《阶段1》§4 的 Q1–Q8 思路）：结构、长度、事实点自洽、
 * 汤面泄露关键事实、分级/难度越界、违禁内容关键词。
 * 返回**规范化后的 Puzzle**（补 id / 排序 / 裁剪），调用方直接用即可。
 */
import type { AnswerEnum, Puzzle, PuzzleFact } from './types.ts';
import { isLeaky } from './verdict.ts';

export interface PuzzleCheckIssue { path: string; reason: string }

/** 违禁/高风险内容关键词（题库入库前的粗筛，不能替代人工审阅） */
const BANNED = ['习近平', '共产党', '六四', '台独', '法轮功', '儿童色情', '强奸', '幼女', '自杀教程', '制毒', '炸弹制作'];

const LIMITS = {
  title: [2, 24] as const,
  surface: [10, 200] as const,
  truth: [10, 400] as const,
  factText: [2, 40] as const,
  facts: [3, 10] as const,
  requiredFacts: [2, 10] as const,
  keys: [1, 6] as const,
  tags: [0, 5] as const,
  sensitiveTags: [0, 3] as const,
};

export interface PuzzleCheckOk { ok: true; puzzle: Puzzle; warnings: string[] }
export interface PuzzleCheckFail { ok: false; issues: PuzzleCheckIssue[] }

function len(text: unknown): number {
  return typeof text === 'string' ? text.trim().length : -1;
}

/**
 * 校验并规范化一道题。`idPrefix` 用来避免与题库里已有题 id 冲突（生成题用 `gen-`，导入题用 `imp-`）。
 */
export function checkAndNormalizePuzzle(
  raw: unknown,
  opts: { idPrefix?: string; ratingMax?: 'L1' | 'L2' | 'L3'; difficultyMin?: number; difficultyMax?: number } = {},
): PuzzleCheckOk | PuzzleCheckFail {
  const issues: PuzzleCheckIssue[] = [];
  const fail = (path: string, reason: string): void => { issues.push({ path, reason }); };
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '$', reason: '不是 JSON 对象' }] };
  }
  const o = raw as Record<string, unknown>;

  // ---- 标题 / 汤面 / 汤底
  // 标题缺失时用汤面开头补一个（网上收集来的题库常常只有汤面+汤底两栏）
  const surfaceRaw = typeof o.surface === 'string' ? o.surface.trim() : (typeof o.puzzle === 'string' ? o.puzzle.trim() : '');
  const titleRaw = typeof o.title === 'string' ? o.title.trim() : '';
  const title = titleRaw || surfaceRaw.slice(0, 12);
  const surface = surfaceRaw;
  const truthText = typeof o.truth === 'string' ? o.truth.trim() : (typeof o.answer === 'string' ? o.answer.trim() : '');
  if (len(title) < LIMITS.title[0] || len(title) > LIMITS.title[1]) fail('title', `标题长度需在 ${LIMITS.title[0]}–${LIMITS.title[1]} 字之间`);
  if (len(surface) < LIMITS.surface[0] || len(surface) > LIMITS.surface[1]) fail('surface', `汤面长度需在 ${LIMITS.surface[0]}–${LIMITS.surface[1]} 字之间`);
  if (len(truthText) < LIMITS.truth[0] || len(truthText) > LIMITS.truth[1]) fail('truth', `汤底长度需在 ${LIMITS.truth[0]}–${LIMITS.truth[1]} 字之间`);
  if (titleRaw && surface && title === surface.slice(0, title.length)) fail('title', '标题与汤面开头重复');
  if (surface && truthText && surface === truthText) fail('truth', '汤底与汤面完全相同');

  // ---- 事实点表
  const factsRaw = Array.isArray(o.facts) ? o.facts : [];
  if (factsRaw.length < LIMITS.facts[0] || factsRaw.length > LIMITS.facts[1]) {
    fail('facts', `事实点数量需在 ${LIMITS.facts[0]}–${LIMITS.facts[1]} 条之间`);
  }
  const facts: PuzzleFact[] = [];
  const seenText = new Set<string>();
  factsRaw.forEach((f, i) => {
    const path = `facts[${i}]`;
    if (!f || typeof f !== 'object') { fail(path, '不是对象'); return; }
    const fo = f as Record<string, unknown>;
    const text = typeof fo.text === 'string' ? fo.text.trim() : '';
    if (len(text) < LIMITS.factText[0] || len(text) > LIMITS.factText[1]) { fail(`${path}.text`, `事实点长度需在 ${LIMITS.factText[0]}–${LIMITS.factText[1]} 字之间`); return; }
    if (seenText.has(text)) { fail(`${path}.text`, '事实点重复'); return; }
    seenText.add(text);
    const isTrue = fo.isTrue === true || fo.is_true === true;
    const tier = Number(fo.tier ?? 1);
    if (![1, 2, 3].includes(tier)) { fail(`${path}.tier`, 'tier 只能是 1 / 2 / 3'); return; }
    const keysRaw = Array.isArray(fo.keys) ? fo.keys.filter((k) => typeof k === 'string' && k.trim()) as string[] : [];
    if (keysRaw.length < LIMITS.keys[0] || keysRaw.length > LIMITS.keys[1]) { fail(`${path}.keys`, `关键词需 ${LIMITS.keys[0]}–${LIMITS.keys[1]} 个`); return; }
    facts.push({
      id: `f${facts.length + 1}`,
      text,
      isTrue,
      tier: tier as 1 | 2 | 3,
      required: fo.required === true || (fo.required === undefined && isTrue && tier <= 2),
      keys: keysRaw.map((k) => k.trim()).slice(0, LIMITS.keys[1]),
    });
  });

  const trues = facts.filter((f) => f.isTrue);
  const falses = facts.filter((f) => !f.isTrue);
  const required = facts.filter((f) => f.required);
  if (trues.length === 0) fail('facts', '至少要有一条"成立"的事实点');
  if (falses.length === 0) warnings.push('没有否定型事实点（"否"的结论会缺少依据）');
  if (falses.length > 2) fail('facts', '否定型事实点最多 2 条');
  if (required.length < LIMITS.requiredFacts[0]) fail('facts', `必需事实点至少 ${LIMITS.requiredFacts[0]} 条`);
  if (required.some((f) => !f.isTrue)) fail('facts', '必需事实点必须都是成立的');

  // ---- 汤面不得泄露关键事实点（不然题目本身就是答案）
  if (surface) {
    for (const f of required) {
      if (surface.includes(f.text)) fail('surface', `汤面里直接写出了关键事实点：${f.text}`);
      const shared = (f.keys ?? []).find((k) => k.length >= 2 && surface.includes(k));
      if (shared) warnings.push(`汤面里出现了事实点关键词「${shared}」（可能降低难度）`);
    }
    const leak = isLeaky(surface, truthText, facts, { publicText: surface });
    if (leak && leak.startsWith('与汤底共享片段')) {
      // 汤面与汤底共享 8-gram 在这里是正常的（汤面本来就是汤底的一部分线索），只提示
      warnings.push('汤面与汤底有较长重合片段');
    }
  }

  // ---- 元信息
  const difficulty = Number(o.difficulty ?? 3);
  const dMin = opts.difficultyMin ?? 1;
  const dMax = opts.difficultyMax ?? 5;
  if (!Number.isInteger(difficulty) || difficulty < dMin || difficulty > dMax) {
    fail('difficulty', `难度需在 ${dMin}–${dMax} 之间（当前 ${String(o.difficulty)}）`);
  }
  const ratingRaw = String(o.rating ?? 'L2').toUpperCase();
  const ratingOrder = ['L1', 'L2', 'L3'];
  const ratingMax = opts.ratingMax ?? 'L3';
  if (!ratingOrder.includes(ratingRaw)) fail('rating', 'rating 只能是 L1 / L2 / L3');
  else if (ratingOrder.indexOf(ratingRaw) > ratingOrder.indexOf(ratingMax)) fail('rating', `本题分级 ${ratingRaw} 超过房间上限 ${ratingMax}`);
  const estMinutes = Number(o.estMinutes ?? 20);
  if (!Number.isFinite(estMinutes) || estMinutes < 5 || estMinutes > 60) warnings.push('预计时长异常，已按 20 分钟计');
  const tags = (Array.isArray(o.tags) ? o.tags : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => String(t).trim());
  const sensitiveTags = (Array.isArray(o.sensitiveTags) ? o.sensitiveTags : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => String(t).trim());
  if (tags.length > LIMITS.tags[1]) warnings.push('标签过多，已截断');
  if (sensitiveTags.length > LIMITS.sensitiveTags[1]) warnings.push('敏感标签过多，已截断');

  // ---- 违禁内容粗筛（汤面 + 汤底 + 事实点一起查）
  const allText = [title, surface, truthText, ...facts.map((f) => f.text)].join('\n');
  for (const word of BANNED) {
    if (allText.includes(word)) fail('$', `命中违禁/高风险关键词：${word}`);
  }

  if (issues.length > 0) return { ok: false, issues };

  const prefix = opts.idPrefix ?? 'gen';
  const id = `${prefix}-${Math.abs(hash(title + surface)).toString(36)}`;
  return {
    ok: true,
    warnings,
    puzzle: {
      id,
      title,
      surface,
      difficulty: Math.min(dMax, Math.max(dMin, difficulty)),
      rating: ratingRaw as Puzzle['rating'],
      tags: tags.slice(0, LIMITS.tags[1]),
      sensitiveTags: sensitiveTags.slice(0, LIMITS.sensitiveTags[1]),
      estMinutes: Number.isFinite(estMinutes) && estMinutes >= 5 && estMinutes <= 60 ? Math.round(estMinutes) : 20,
      sourceType: 'ai',
      attributionRequired: false,
      reviewStatus: 'approved',
      truth: {
        truth: truthText,
        keyPoints: required.map((f) => f.text).join(' / ').slice(0, 120),
        redLines: ['不得点出未在事实点表中的具体信息'],
      },
      facts,
    },
  };
}

/** 稳定的短哈希（用于生成题目 id；不用于安全用途） */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** 供 UI 展示的一句话结论（把 issues 收成一行） */
export function summarizePuzzleIssues(issues: PuzzleCheckIssue[]): string {
  return issues.slice(0, 4).map((i) => `${i.path}: ${i.reason}`).join('；');
}

export type { AnswerEnum };
