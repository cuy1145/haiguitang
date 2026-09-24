/**
 * 题目校验（坏题检测）的单元测试。
 * 这道门槛同时管住「AI 创作」与「题库导入」，所以检查项要逐条钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAndNormalizePuzzle, summarizePuzzleIssues } from '../../packages/core/src/puzzle-check.ts';

/** 一道各项都合格的样板题 */
function goodPuzzle(): Record<string, unknown> {
  return {
    title: '灯塔',
    surface: '一个男人推开门，看到眼前的景象后立刻跳楼自杀了。为什么？',
    truth: '他是灯塔管理员。那天他睡过头没有点亮灯塔，导致一艘船触礁沉没，他无法承受这个后果。',
    difficulty: 3,
    rating: 'L2',
    tags: ['本格', '反转'],
    sensitiveTags: ['死亡'],
    estMinutes: 20,
    facts: [
      { id: 'f1', text: '男人是灯塔管理员', isTrue: true, tier: 1, required: true, keys: ['灯塔', '管理员'] },
      { id: 'f2', text: '他睡过头忘了点灯', isTrue: true, tier: 2, required: true, keys: ['睡过头', '忘了点灯'] },
      { id: 'f3', text: '有船因此触礁沉没', isTrue: true, tier: 2, required: true, keys: ['船难', '触礁', '沉船'] },
      { id: 'f4', text: '他被人谋杀了', isTrue: false, tier: 1, required: false, keys: ['谋杀', '凶手'] },
    ],
  };
}

test('P1: 合格的题 → 通过，并规范化 id / 默认值', () => {
  const r = checkAndNormalizePuzzle(goodPuzzle(), { idPrefix: 'ai' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.puzzle.id, /^ai-/);
  assert.deepEqual(r.puzzle.facts.map((f) => f.id), ['f1', 'f2', 'f3', 'f4'], '事实点 id 必须重排成 f1..fn');
  assert.equal(r.puzzle.sourceType, 'ai');
  assert.equal(r.puzzle.facts.filter((f) => f.required).length, 3);
});

test('P2: 汤面直接写出关键事实点 → 判为坏题（等于把答案印在题面上）', () => {
  const p = goodPuzzle();
  p.surface = '男人是灯塔管理员。一天他推开门，看到眼前的景象后立刻跳楼自杀了。为什么？';
  const r = checkAndNormalizePuzzle(p);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.issues.some((i) => i.path === 'surface' && i.reason.includes('关键事实点')), summarizePuzzleIssues(r.issues));
});

test('P3: 事实点太少 / 必需点不足 / 必需点为假 → 拒绝', () => {
  const few = goodPuzzle();
  few.facts = (few.facts as unknown[]).slice(0, 2);
  assert.equal(checkAndNormalizePuzzle(few).ok, false, '少于 3 条事实点应拒绝');

  const noRequired = goodPuzzle();
  noRequired.facts = (noRequired.facts as Array<Record<string, unknown>>).map((f) => ({ ...f, required: false }));
  assert.equal(checkAndNormalizePuzzle(noRequired).ok, false, '没有必需事实点应拒绝');

  const requiredFalse = goodPuzzle();
  requiredFalse.facts = (requiredFalse.facts as Array<Record<string, unknown>>).map((f) => (f.id === 'f4' ? { ...f, required: true } : f));
  assert.equal(checkAndNormalizePuzzle(requiredFalse).ok, false, '必需点必须是成立的');
});

test('P4: 否定型事实点过多 / tier 越界 / keys 缺失 → 拒绝并给出可读原因', () => {
  const manyFalse = goodPuzzle();
  manyFalse.facts = [
    { id: 'f1', text: '男人是灯塔管理员', isTrue: true, tier: 1, required: true, keys: ['灯塔'] },
    { id: 'f2', text: '他睡过头忘了点灯', isTrue: true, tier: 2, required: true, keys: ['睡过头'] },
    { id: 'f3', text: '他被人谋杀了', isTrue: false, tier: 1, keys: ['谋杀'] },
    { id: 'f4', text: '他欠了赌债', isTrue: false, tier: 1, keys: ['赌债'] },
    { id: 'f5', text: '他妻子出轨了', isTrue: false, tier: 1, keys: ['出轨'] },
  ];
  const r = checkAndNormalizePuzzle(manyFalse);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.issues.some((i) => i.reason.includes('否定型')), summarizePuzzleIssues(!r.ok ? r.issues : []));

  const badTier = goodPuzzle();
  badTier.facts = (badTier.facts as Array<Record<string, unknown>>).map((f) => (f.id === 'f1' ? { ...f, tier: 9 } : f));
  assert.equal(checkAndNormalizePuzzle(badTier).ok, false);

  const noKeys = goodPuzzle();
  noKeys.facts = (noKeys.facts as Array<Record<string, unknown>>).map((f) => (f.id === 'f1' ? { ...f, keys: [] } : f));
  assert.equal(checkAndNormalizePuzzle(noKeys).ok, false);
});

test('P5: 违禁关键词 / 分级越界 / 汤面过长 → 拒绝', () => {
  const banned = goodPuzzle();
  banned.surface = '一个男人在广场上看到了习近平，随后跳楼自杀了。为什么？';
  assert.equal(checkAndNormalizePuzzle(banned).ok, false, '违禁词应拒绝');

  const rating = checkAndNormalizePuzzle(goodPuzzle(), { ratingMax: 'L1' });
  assert.equal(rating.ok, false, 'L2 的题在 L1 上限下应拒绝');

  const longSurface = goodPuzzle();
  longSurface.surface = '开头' + '很长的场景描述'.repeat(40);
  assert.equal(checkAndNormalizePuzzle(longSurface).ok, false, '汤面超过 200 字应拒绝');
});

test('P6: 接受 {puzzle, answer} 形态（网上收集来的题只有这两栏）', () => {
  const r = checkAndNormalizePuzzle({
    puzzle: '一个女人在餐厅点了一份海龟汤，喝了一口就哭了。为什么？',
    answer: '她想起多年前遇难时，丈夫把仅有的一碗汤让给她，说那是海龟汤；她现在才明白那是什么。',
    facts: [
      { text: '她多年前在海上遇难', isTrue: true, tier: 1, required: true, keys: ['遇难', '海难'] },
      { text: '丈夫把自己的食物让给了她', isTrue: true, tier: 2, required: true, keys: ['丈夫', '让给她'] },
      { text: '她当时被告知那是海龟汤', isTrue: true, tier: 2, required: true, keys: ['海龟汤'] },
    ],
  }, { idPrefix: 'imp' });
  assert.equal(r.ok, true, !r.ok ? summarizePuzzleIssues(r.issues) : '');
  if (r.ok) assert.equal(r.puzzle.sourceType, 'ai');
});

test('P7: 非对象 / 空输入 → 明确失败（不抛异常）', () => {
  for (const bad of [null, undefined, '文本', 42, [], {}]) {
    const r = checkAndNormalizePuzzle(bad);
    assert.equal(r.ok, false);
  }
});
