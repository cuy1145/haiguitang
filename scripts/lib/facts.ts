/**
 * 规则版事实点抽取（**不调用模型**，零成本）。
 *
 * 背景：题库导入本来靠模型把「汤面 + 汤底」拆成事实点表（`--facts=ai`）。
 * 但 Turtle-Bench 这类评测集自带**玩家猜测 + 对错标签**，于是可以白拿两类事实：
 *   · 汤底按句拆 → 成立的事实点（isTrue=true）
 *   · label=F 的猜测 → **玩家真的猜过、但本题不成立**的方向（isTrue=false）
 *     —— 这正好是"否"需要的事实点，靠规则是造不出来的，而数据集直接给了。
 *
 * 质量说明：规则版事实点**比模型版粗**（句子粒度、关键词靠 n-gram），
 * 但足以让判定引擎正常工作（模型仍可按事实点做映射；内置模拟汤主靠 keys 匹配）。
 * 想要更细的事实点，随时可以带 AI_KEY 重跑 `--facts=ai`。
 */
import type { PuzzleFact } from '../../packages/core/src/types.ts';

const STOP = new Set(['的', '了', '在', '是', '他', '她', '我', '你', '和', '就', '也', '都', '而', '但', '被', '把', '给', '着', '过', '很', '不', '没有', '一个', '什么', '因为', '所以', '于是', '然后', '这个', '那个', '自己', '已经', '还是', '就是']);

const splitClauses = (text: string): string[] => {
  const clean = text.replace(/[""'（）()【】\[\]]/g, '').trim();
  const byPunct = clean.split(/[。！？；\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  if (byPunct.length >= 3) return byPunct;
  // 句子太少（短汤底常见）→ 连逗号/顿号一起拆，尽量凑出可判定的原子句
  const finer = clean.split(/[。！？；\n，、]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  return finer.length > byPunct.length ? finer : byPunct;
};

/** 从一段话里抽 2–4 字的候选关键词（滑窗 + 去停用词 + 去重） */
function keywordsOf(text: string, limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const len of [4, 3, 2]) {
    for (let i = 0; i + len <= text.length && out.length < limit; i += 1) {
      const g = text.slice(i, i + len);
      if (seen.has(g)) continue;
      if ([...g].some((ch) => STOP.has(ch))) continue;
      if (!/^[\u4e00-\u9fa5]{2,4}$/.test(g)) continue;   // 只留纯中文
      seen.add(g);
      out.push(g);
    }
    if (out.length >= limit) break;
  }
  // 兜底：全句都是停用词/非中文时，至少给一个可匹配的片段（校验要求 keys 非空）
  if (out.length === 0) {
    const fallback = text.replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 4);
    if (fallback.length >= 2) out.push(fallback);
    else if (text.trim().length >= 2) out.push(text.trim().slice(0, 4));
  }
  return out.slice(0, limit);
}

export interface GuessRow { text: string; label: string }
export interface RuleFactsInput { surface: string; truth: string; guesses?: GuessRow[] }

/**
 * 生成事实点表。
 *
 * 优先级（Turtle-Bench 这类评测集数据最全，所以先吃它）：
 *   ① label=T 的玩家猜测 → **成立的事实点**（本身就是一个原子命题，phrasing 还是玩家真实说法）
 *   ② label=F 的玩家猜测 → **否定型事实**（"玩家猜过、但本题不成立"，靠规则造不出来）
 *   ③ 不够 2 条成立事实时，用汤底拆句补齐（退化路径，质量较粗）
 * 返回结构直接交给 `checkAndNormalizePuzzle()` 校验与规范化。
 */
export function deriveFacts(input: RuleFactsInput): PuzzleFact[] {
  const facts: PuzzleFact[] = [];
  const seen = new Set<string>();
  const add = (text: string, isTrue: boolean, required = false): void => {
    const t = text.replace(/[""'（）()【】\[\]]/g, '').trim().slice(0, 40);
    if (t.length < 4) return;
    const key = t.replace(/\s+/g, '');
    if (seen.has(key)) return;
    if (facts.some((f) => f.isTrue === isTrue && (f.text.includes(t) || t.includes(f.text)))) return;
    seen.add(key);
    const trueCount = facts.filter((f) => f.isTrue).length;
    // 分级：第 1 条 → tier1，第 2~3 条 → tier2，其余 → tier3。
    // **必须保证 tier1 / tier2 各至少有一条成立事实**，否则"提示 T1/T2"会没东西可给（线上就踩过）。
    const tier: 1 | 2 | 3 = !isTrue ? 1 : trueCount === 0 ? 1 : trueCount <= 2 ? 2 : 3;
    facts.push({
      id: `f${facts.length + 1}`,
      text: t,
      isTrue,
      tier,
      required,
      keys: keywordsOf(t, 6),
    });
  };

  const guesses = input.guesses ?? [];
  const trueGuesses = guesses.filter((g) => /^t(rue)?$/i.test(String(g.label ?? '').trim())).map((g) => g.text);
  const falseGuesses = guesses.filter((g) => /^f(alse)?$/i.test(String(g.label ?? '').trim())).map((g) => g.text);

  // ① 成立的事实点：先吃 T 猜测（最多 5 条，头两条设为必需）
  for (const g of trueGuesses.slice(0, 5)) add(g, true, facts.filter((f) => f.isTrue).length < 2);
  // ② 补足：T 猜测常常只有一两条，用汤底拆句补到 3 条以上（校验要求至少 3 条事实点）
  if (facts.filter((f) => f.isTrue).length < 3) {
    const clauses = splitClauses(input.truth);
    const ordered = [clauses[0], ...clauses.slice().sort((a, b) => b.length - a.length)];
    for (const c of ordered) {
      if (facts.filter((f) => f.isTrue).length >= 3) break;
      add(c ?? '', true, facts.filter((f) => f.isTrue).length < 2);
    }
  }
  // ③ 否定型事实：F 猜测最多 2 条
  for (const g of falseGuesses.slice(0, 2)) add(g, false);

  return facts;
}
