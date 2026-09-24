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

/**
 * 「体裁跑偏」与「内容不适」关键词：不是违禁，但会让题目变成另一种东西，或观感很差。
 * 分组是为了给出**可读的原因**（也方便日后按房间分级开关）。
 *
 * 实测依据：拿 HuggingFace 上 2 万道 AI 生成的题库跑一遍，这几类是主要污染源。
 */
const CONTENT_RULES: Array<{ label: string; reason: string; words: string[] }> = [
  {
    label: '超自然',
    reason: '谜底靠超自然/灵异 —— 玩家无法用"是/否"推出来',
    words: ['恶魔', '鬼魂', '恶灵', '诅咒', '附体', '僵尸', '吸血鬼', '巫术', '灵魂被', '超能力', '外星人', '穿越到', '转世', '投胎', '通灵', '驱魔'],
  },
  {
    label: '性暴力/虐待',
    reason: '涉及性暴力、虐待或囚禁 —— 朋友局里非常不合适',
    words: ['强奸', '性侵', '猥亵', '恋童', '幼女', '轮奸', '囚禁', '绑架', '拐卖', '虐待', '家暴', '虐杀', '折磨致死', '剥皮', '割喉', '碎尸', '肢解', '分尸'],
  },
  {
    label: '猎奇血腥',
    reason: '猎奇血腥描写 —— 不适合朋友局',
    words: ['眼球', '挖出', '掏空', '内脏', '肠子', '脑浆', '血浆', '啃食', '尸体被', '割下'],
  },
  {
    label: '科幻/灾难',
    reason: '谜底是科幻或超自然灾难 —— 破坏了"封闭世界"（真相只能用汤面里出现过的东西解释）',
    words: ['激光分解', '外星生物', '平行宇宙', '时空穿越', '机器人统治', '人工智能觉醒', '丧尸', '基因变异', '克隆人', '核爆', '世界末日'],
  },
];

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
  for (const rule of CONTENT_RULES) {
    const hit = rule.words.find((w) => allText.includes(w));
    if (hit) fail('$', `${rule.reason}（"${hit}"）`);
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

/**
 * 清洗从模型/网上来的题目文本。
 *
 * 实测（HuggingFace 数据集）里最常见的三种脏数据：
 *   · Markdown 残留：`**汤面**：…`、`## 汤底`
 *   · 标签前缀：`汤面：`、`: `、`答案：`
 *   · 模型客套话：`当然可以！下面是一个有趣的海龟汤示例：`、`希望你喜欢`
 * 这些不清掉，汤面读起来就很怪，而且会污染事实点抽取。
 */
export function cleanPuzzleText(text: unknown): string {
  let t = String(text ?? '').replace(/\r/g, '');
  t = t.replace(/\*\*|__|`/g, '');                                  // markdown 强调记号
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');                       // 行首标题记号
  // 模型客套话（通常在最前面，且以冒号结尾）
  t = t.replace(/^\s*(当然可以|好的|没问题|可以)[！!，,。. ]*[^\n]{0,60}?(示例|题目|海龟汤|如下)[^\n]*[:：]\s*/i, '');
  // 标签前缀：`汤面：xxx`、`汤面\nxxx`、纯冒号开头（跑两遍以处理"客套话 + 标签"叠在一起的情况）
  for (let i = 0; i < 2; i++) {
    t = t.replace(/^\s*(汤面|汤底|题目|谜面|谜底|答案|真相|story|riddle|solution)\s*[:：]?[ \t]*\n?[ \t]*/i, '');
    t = t.replace(/^\s*[:：]\s*/, '');
  }
  t = t.replace(/(希望你喜欢|希望对你有帮助|以上是)[^\n]*$/i, '');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/**
 * **文本级**质检（不依赖事实点表）——用于导入前的"先看质量再花钱"：
 * 长度、违禁词、超自然、猎奇。真正的结构检查要等事实点表生成后由
 * checkAndNormalizePuzzle() 完成。
 */
export function screenPuzzleText(input: { surface: unknown; truth: unknown }): { ok: boolean; issues: PuzzleCheckIssue[]; surface: string; truth: string } {
  const surface = cleanPuzzleText(input.surface);
  const truth = cleanPuzzleText(input.truth);
  const issues: PuzzleCheckIssue[] = [];
  if (len(surface) < LIMITS.surface[0]) issues.push({ path: 'surface', reason: `清洗后汤面只剩 ${len(surface)} 字（太短）` });
  if (len(surface) > LIMITS.surface[1]) issues.push({ path: 'surface', reason: `清洗后汤面 ${len(surface)} 字，超过 ${LIMITS.surface[1]} 字` });
  if (len(truth) < LIMITS.truth[0]) issues.push({ path: 'truth', reason: `清洗后汤底只剩 ${len(truth)} 字（太短）` });
  if (len(truth) > LIMITS.truth[1]) issues.push({ path: 'truth', reason: `清洗后汤底 ${len(truth)} 字，超过 ${LIMITS.truth[1]} 字` });
  const all = `${surface}\n${truth}`;
  for (const w of BANNED) if (all.includes(w)) issues.push({ path: '$', reason: `命中违禁关键词` });
  for (const rule of CONTENT_RULES) {
    if (rule.words.some((w) => all.includes(w))) issues.push({ path: '$', reason: rule.reason });
  }
  return { ok: issues.length === 0, issues, surface, truth };
}

/** 内容风险分组名（供体检报告归类统计；与 CONTENT_RULES 一一对应） */
export const CONTENT_RULE_LABELS = CONTENT_RULES.map((r) => r.label);

export type { AnswerEnum };
