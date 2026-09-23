/**
 * 测试用题库 fixture。
 * 汤底里带 marker `__TRUTH_MARKER__`，便于用"8-gram 共享"断言泄露。
 */
import type { Puzzle, PuzzleFact } from '../../packages/core/src/types.ts';

export const LEAK_MARKER = '__TRUTH_MARKER__';

export const leakFacts: PuzzleFact[] = [
  { id: 'f1', text: '男人曾在海上遇难漂流', isTrue: true, tier: 1, required: true, keys: ['海难', '遇难', '漂流', '出海', '出过海', '海上', '船'] },
  { id: 'f2', text: '他靠同伴提供的食物活了下来', isTrue: true, tier: 2, required: true, keys: ['同伴', '活下来', '活命', '食物'] },
  { id: 'f3', text: '今天喝的汤味道与记忆不同', isTrue: true, tier: 3, required: true, keys: ['味道', '不一样', '不同', '真正的海龟汤'] },
  { id: 'f4', text: '当年他喝下的是同伴的肉', isTrue: true, tier: 3, required: true, keys: ['人肉', '同伴的肉', '吃人'] },
  { id: 'f5', text: '他因为无法承受真相而自杀', isTrue: true, tier: 3, required: true, keys: ['内疚', '承受', '自杀的原因', '为什么自杀'] },
  { id: 'f6', text: '汤里被下了毒', isTrue: false, tier: 1, required: false, keys: ['下毒', '下了毒', '有毒', '中毒', '毒'] },
  { id: 'f7', text: '他认识餐厅的老板', isTrue: false, tier: 1, required: false, keys: ['老板', '老板娘', '熟人'] },
  { id: 'f8', text: '餐厅里发生过暴力事件', isTrue: false, tier: 1, required: false, keys: ['打斗', '凶杀', '打架'] },
];

export function leakPuzzle(): Puzzle {
  return {
    id: 'p-leak',
    title: '测试用海龟汤',
    surface: '一个男人走进餐厅点了一份海龟汤，喝了一口就离开，回家后自杀了。',
    difficulty: 4,
    rating: 'L2',
    tags: ['测试'],
    sensitiveTags: ['死亡'],
    estMinutes: 20,
    sourceType: 'manual',
    attributionRequired: false,
    reviewStatus: 'approved',
    truth: {
      truth: '多年前他在海上遇难漂流，同伴给他端来一碗称为海龟汤的东西，其实是同伴自己的肉。今天他喝到真正的海龟汤，味道完全不同，于是明白真相，无法承受而自杀。' + LEAK_MARKER,
      keyPoints: '人肉 / 真相 / 自杀',
      redLines: ['不得点出同伴的姓名'],
    },
    facts: leakFacts,
  };
}

/** 一个"从未被提及的要素"（用于封闭世界假设断言：应判 irrelevant，而不是「否」）。 */
export const UNMENTIONED = '是不是发生在冬天？';
