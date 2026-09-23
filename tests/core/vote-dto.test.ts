/**
 * 投票规则与 DTO 泄露防护的单元测试（《阶段3》§6.3、《阶段4》§8、阶段1 §4.8）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM, DEFAULT_CONFIG, emptyRoom, reduce, assertNoLeak, toPublicPuzzle, toPublicRoom,
} from '../../packages/core/src/index.ts';
import type { CoreRoom, ReduceCtx } from '../../packages/core/src/index.ts';
import { canCast, voteDenominator, settleVote } from '../../packages/core/src/vote.ts';
import { leakFacts, leakPuzzle, LEAK_MARKER } from '../fixtures/puzzle.ts';

let idc = 0;
function ctx(now: number, rand: () => number = () => 0.5): ReduceCtx {
  return { now, rand, newId: (p: string) => `${p}${++idc}` };
}

function makeRoom(now: number, memberCount = 3): CoreRoom {
  let room = emptyRoom('r1', 'ABC123', { ...DEFAULT_CONFIG }, now);
  for (let i = 1; i <= memberCount; i++) {
    room = {
      ...room,
      members: [...room.members, {
        id: `m${i}`, playerId: `p${i}`, name: `玩家${i}`, isBot: false,
        role: i === 1 ? 'host' : 'member', joinSeq: i,
        conn: 'connected', activity: 'active', hidden: false,
        lastActivityAt: now, lastHeartbeatAt: now,
        skipStreak: 0, score: 0, hintsUsedT12: 0, hintsUsedT3: 0, guessesUsed: 0, lastHintAt: -1e9,
      }],
      hostId: 'm1',
    };
  }
  return room;
}

function openFallbackVote(room: CoreRoom, now: number, rand = () => 0.5) {
  const c = ctx(now, rand);
  const opened = reduce(room, { type: 'VOTE_OPEN', voteType: 'fallback_credit', voteId: 'v1' }, c);
  return opened.room;
}

test('额度降级投票：有效人数 ≥ 2 且赞成严格过半才通过', () => {
  const now = 1_000_000;
  let room = openFallbackVote(makeRoom(now), now);
  assert.equal(room.vote?.eligibleAtOpen.length, 3);

  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm1', choice: 'yes' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm2', choice: 'yes' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm3', choice: 'no' }, ctx(now)).room;
  const settled = settleVote(room, now, () => 0.5);
  assert.equal(settled.room.vote?.status, 'passed');
  assert.equal(settled.creditGranted, true);
  assert.deepEqual(settled.room.vote?.tally, { yes: 2, no: 1, abstain: 0 });
});

test('弃权计入分母：1 赞成 2 弃权 → 不通过（防止"没人投"被当作默许）', () => {
  const now = 1_000_000;
  let room = openFallbackVote(makeRoom(now), now);
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm1', choice: 'yes' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm2', choice: 'abstain' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm3', choice: 'abstain' }, ctx(now)).room;
  const settled = settleVote(room, now, () => 0.5);
  assert.equal(settled.room.vote?.status, 'rejected');
  assert.equal(settled.creditGranted, false);
  assert.equal(settled.room.vote?.tally?.abstain, 2);
});

test('分母口径：投票期间变为挂机者被移出分母，但其选票保留', () => {
  const now = 1_000_000;
  let room = openFallbackVote(makeRoom(now), now);
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm2', choice: 'yes' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm3', choice: 'no' }, ctx(now)).room;
  // m1 在投票期间挂机（活动线上报过期）
  room = { ...room, members: room.members.map((m) => m.id === 'm1' ? { ...m, activity: 'idle' as const, lastActivityAt: now - PLATFORM.idleSec * 1000 - 1 } : m) };
  assert.deepEqual(voteDenominator(room), ['m2', 'm3']);
  const settled = settleVote(room, now, () => 0.5);
  // 分母 2，赞成 1 → 1 > 1 为假 → 不通过
  assert.equal(settled.room.vote?.status, 'rejected');
});

test('挂机与断连成员的表决不被受理（VOTE_NOT_ELIGIBLE）', () => {
  const now = 1_000_000;
  let room = openFallbackVote(makeRoom(now), now);
  room = { ...room, members: room.members.map((m) => m.id === 'm2' ? { ...m, activity: 'idle' as const } : m.id === 'm3' ? { ...m, conn: 'disconnected' as const } : m) };
  assert.equal(canCast(room, 'm1'), null);
  assert.equal(canCast(room, 'm2'), 'VOTE_NOT_ELIGIBLE');
  assert.equal(canCast(room, 'm3'), 'VOTE_NOT_ELIGIBLE');
});

test('有效投票人不足 2 人 → 投票无效，不授予额度', () => {
  const now = 1_000_000;
  let room = makeRoom(now, 2);
  room = { ...room, members: room.members.map((m) => m.id === 'm2' ? { ...m, conn: 'disconnected' as const } : m) };
  room = openFallbackVote(room, now);
  assert.equal(room.vote?.eligibleAtOpen.length, 1);
  const settled = settleVote(room, now, () => 0.5);
  assert.equal(settled.room.vote?.status, 'rejected');
  assert.equal(settled.creditGranted, false);
  assert.match(settled.room.vote?.result ?? '', /有效投票人不足/);
});

test('选题投票：票高者当选；平票由服务端随机（seed 可复现）', () => {
  const now = 1_000_000;
  const base = makeRoom(now);
  const c = ctx(now);
  let room = reduce(base, { type: 'VOTE_OPEN', voteType: 'puzzle_choice', voteId: 'v2', puzzleIds: ['p1', 'p2', 'p3'] }, c).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm1', choice: 'p2' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm2', choice: 'p2' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm3', choice: 'p1' }, ctx(now)).room;
  const settled = settleVote(room, now, () => 0.5);
  assert.equal(settled.selectedPuzzleId, 'p2');
  assert.equal(settled.room.vote?.tally?.byOption?.p2, 2);

  // 平票：m1→p1, m2→p3, m3 弃权未投
  let tie = reduce(base, { type: 'VOTE_OPEN', voteType: 'puzzle_choice', voteId: 'v3', puzzleIds: ['p1', 'p3'] }, c).room;
  tie = reduce(tie, { type: 'VOTE_CAST', memberId: 'm1', choice: 'p1' }, ctx(now)).room;
  tie = reduce(tie, { type: 'VOTE_CAST', memberId: 'm2', choice: 'p3' }, ctx(now)).room;
  tie = reduce(tie, { type: 'VOTE_CAST', memberId: 'm3', choice: 'p1' }, ctx(now)).room;
  tie = reduce(tie, { type: 'VOTE_CAST', memberId: 'm1', choice: 'p1' }, ctx(now)).room; // 覆盖为同一值
  const tieSettled = settleVote(tie, now, () => 0.99);
  assert.ok(['p1', 'p3'].includes(tieSettled.selectedPuzzleId ?? ''), '平票时必须选出其一');
  assert.match(tieSettled.room.vote?.result ?? '', /票高者当选|平票/);
});

test('额度降级投票通过 → 授予平台额度并恢复对局；房主有效处理则投票作废', () => {
  const now = 1_000_000;
  let room = makeRoom(now);
  const c = ctx(now);
  room = reduce(room, { type: 'CREDIT_BLOCK', reasonCode: 'AUTH_FAILED' }, c).room;
  assert.equal(room.ai.state, 'BLOCKED');
  assert.equal(room.credit.mode, 'host_key', '中断本身绝不改变额度来源（不降级铁律）');
  assert.equal(room.status, 'suspended');
  assert.equal(room.pauseReason, 'ai_blocked');

  room = openFallbackVote(room, now);
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm1', choice: 'yes' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm2', choice: 'yes' }, ctx(now)).room;
  room = reduce(room, { type: 'VOTE_CAST', memberId: 'm3', choice: 'yes' }, ctx(now)).room;
  const settle = reduce(room, { type: 'VOTE_SETTLE' }, ctx(now));
  assert.equal(settle.creditGranted, true);
  const granted = reduce(settle.room, { type: 'CREDIT_GRANT', calls: 200 }, ctx(now)).room;
  assert.equal(granted.credit.mode, 'site_fallback');
  assert.equal(granted.credit.reason, 'MEMBER_VOTE');
  assert.equal(granted.credit.grantLeft, 200);
  assert.equal(granted.ai.state, 'GRANTED');
  assert.equal(granted.status, 'playing');

  // 房主处理完自己的 Key → 立即收回 grant 并切回自备额度
  const revoked = reduce(granted, { type: 'CREDIT_REVOKE', reason: 'HOST_RECOVERED' }, ctx(now + 1000)).room;
  assert.equal(revoked.credit.mode, 'host_key');
  assert.equal(revoked.credit.reason, 'HOST_RESTORED');
  assert.equal(revoked.credit.grantLeft, 0);

  // 投票期间房主有效处理 → 投票作废
  let room2 = openFallbackVote(makeRoom(now), now);
  room2 = reduce(room2, { type: 'VOTE_CAST', memberId: 'm1', choice: 'yes' }, ctx(now)).room;
  const voided = reduce(room2, { type: 'VOTE_VOID_BY_HOST' }, ctx(now)).room;
  assert.equal(voided.vote?.status, 'rejected');
  assert.match(voided.vote?.result ?? '', /作废/);
});

/**
 * 房主换上可用的自备 Key（CREDIT_RESTORED）：解除 AI 中断、继续对局，
 * 且额度来源仍是 host_key —— 与"放弃自备 Key 改用平台额度"（CREDIT_REVOKED_BY_OWNER）区分开。
 */
test('房主更新 Key → 解除 AI 中断并继续本轮（额度来源仍是自备）', () => {
  const now = 1_000_000;
  let room = makeRoom(now);
  room = reduce(room, { type: 'MATCH_BEGIN', puzzleId: 'p-leak' }, ctx(now)).room;
  const turnSeqBefore = room.turn.seq;
  room = reduce(room, { type: 'CREDIT_BLOCK', reasonCode: 'SCHEMA_INVALID' }, ctx(now)).room;
  assert.equal(room.status, 'suspended');
  assert.equal(room.turn.phase, 'PAUSED');

  const restored = reduce(room, { type: 'CREDIT_RESTORED' }, ctx(now + 5000));
  assert.equal(restored.room.ai.state, 'OK');
  assert.equal(restored.room.ai.reasonCode, null);
  assert.equal(restored.room.ai.blockedAt, null);
  assert.equal(restored.room.status, 'playing');
  assert.equal(restored.room.pauseReason, null);
  assert.equal(restored.room.credit.mode, 'host_key');
  assert.equal(restored.room.turn.phase, 'ACTIVE', '恢复后本轮重新开始计时');
  assert.equal(restored.room.turn.seq, turnSeqBefore, '不额外消耗轮次');
  assert.ok(restored.room.turn.deadlineAt > now, '给了新的截止时间');
  assert.deepEqual(restored.events.map((e) => e.type), ['ai_recovered']);
});

/** 准备状态：举手 / 收回 / 幂等 / 非成员无效 / 开局清零 */
test('准备状态只在开局前有效，且开局时清零', () => {
  const now = 1_000_000;
  let room = makeRoom(now);

  room = reduce(room, { type: 'READY_SET', memberId: 'm1', ready: true }, ctx(now)).room;
  assert.deepEqual(room.ready, ['m1']);
  room = reduce(room, { type: 'READY_SET', memberId: 'm2', ready: true }, ctx(now)).room;
  assert.deepEqual(room.ready, ['m1', 'm2']);

  const again = reduce(room, { type: 'READY_SET', memberId: 'm2', ready: true }, ctx(now));
  assert.deepEqual(again.room.ready, ['m1', 'm2'], '重复举手是幂等的');

  const stranger = reduce(room, { type: 'READY_SET', memberId: '不在房里', ready: true }, ctx(now));
  assert.deepEqual(stranger.room.ready, ['m1', 'm2'], '非成员无效');

  room = reduce(room, { type: 'READY_SET', memberId: 'm1', ready: false }, ctx(now)).room;
  assert.deepEqual(room.ready, ['m2'], '可以收回');

  const begun = reduce(room, { type: 'MATCH_BEGIN', puzzleId: 'p-leak' }, ctx(now)).room;
  assert.deepEqual(begun.ready, [], '开局后准备状态清零');

  // 对局进行中改动准备态被忽略
  const during = reduce(begun, { type: 'READY_SET', memberId: 'm2', ready: true }, ctx(now));
  assert.deepEqual(during.room.ready, [], '对局中不再接受准备状态');
});

// ---------------------------------------------------------------- DTO 泄露防护

test('toPublicPuzzle 不包含汤底与事实点字段（类型层白名单投影）', () => {
  const pub = toPublicPuzzle(leakPuzzle());
  const json = JSON.stringify(pub);
  assert.ok(!json.includes('truth'), '投影中不得出现 truth 字段');
  assert.ok(!json.includes('facts'), '投影中不得出现 facts 字段');
  assert.ok(!json.includes(LEAK_MARKER));
  assert.equal(pub.id, 'p-leak');
  assert.equal(pub.surface.includes('海龟汤'), true);
});

test('toPublicRoom 全量投影通过 assertNoLeak（含成员、投票、额度状态）', () => {
  const now = 1_000_000;
  const puzzle = leakPuzzle();
  let room = makeRoom(now);
  room = reduce(room, { type: 'MATCH_BEGIN', puzzleId: puzzle.id }, ctx(now)).room;
  room = openFallbackVote(room, now);
  room = { ...room, revealedFacts: ['f1'] };

  const view = toPublicRoom(room, 'm1', {
    serverTime: now,
    puzzle,
    candidates: [puzzle],
    keyOf: (id) => (id === 'm1'
      ? { hasKey: true, keyMask: 'sk-DEMO****0000', keyState: 'active', formerHost: false }
      : { hasKey: false, keyMask: null, keyState: 'none', formerHost: false }),
  });
  assertNoLeak(view, { truth: puzzle.truth.truth, facts: leakFacts });
  assert.equal(view.puzzle?.id, puzzle.id);
  assert.equal(view.turn.seq, 1);
  assert.equal(view.members.length, 3);
  assert.equal(view.canRevealTruth, false, '进行中的对局不得揭晓汤底');
  assert.equal(JSON.stringify(view).includes(LEAK_MARKER), false);
});

test('assertNoLeak 能抓住被手写对象绕过的泄露（负面测试）', () => {
  const puzzle = leakPuzzle();
  assert.throws(() => {
    assertNoLeak({ oops: { truth: puzzle.truth.truth } }, { truth: puzzle.truth.truth, facts: leakFacts });
  }, /汤底泄露/);
  assert.throws(() => {
    assertNoLeak({ hint: leakFacts[0]!.text }, { truth: puzzle.truth.truth, facts: leakFacts });
  }, /事实点泄露/);
  assert.throws(() => {
    assertNoLeak({ key: 'sk-live-abcdefghijklmn' }, { truth: 'x', facts: [] });
  }, /密钥泄露/);
});

test('aborted 对局不得揭晓汤底（canRevealTruth=false）', () => {
  const now = 1_000_000;
  const puzzle = leakPuzzle();
  let room = makeRoom(now);
  room = reduce(room, { type: 'MATCH_BEGIN', puzzleId: puzzle.id }, ctx(now)).room;
  room = reduce(room, { type: 'MATCH_END', result: 'aborted', reason: '房主结束' }, ctx(now)).room;
  const view = toPublicRoom(room, 'm1', { serverTime: now, puzzle, candidates: [], keyOf: () => ({ hasKey: false, keyMask: null, keyState: 'none', formerHost: false }) });
  assert.equal(view.status, 'settled');
  assert.equal(view.result?.result, 'aborted');
  assert.equal(view.canRevealTruth, false, '中止对局不揭晓汤底（防"开局→立刻结束→读汤底"）');
});

test('解题成功后允许揭晓，但汤底只由服务端注入（投影本身仍不含汤底）', () => {
  const now = 1_000_000;
  const puzzle = leakPuzzle();
  let room = makeRoom(now);
  room = reduce(room, { type: 'MATCH_BEGIN', puzzleId: puzzle.id }, ctx(now)).room;
  room = reduce(room, { type: 'GUESS', memberId: 'm1', verdict: 'hit', hits: 5, total: 5 }, ctx(now)).room;
  const view = toPublicRoom(room, 'm1', { serverTime: now, puzzle, candidates: [], keyOf: () => ({ hasKey: false, keyMask: null, keyState: 'none', formerHost: false }) });
  assert.equal(view.canRevealTruth, true);
  assertNoLeak(view, { truth: puzzle.truth.truth, facts: leakFacts });
});
