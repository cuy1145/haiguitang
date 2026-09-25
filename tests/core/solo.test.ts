/**
 * 单人模式（`room.solo`）的回合规则单测。
 *
 * 单人房与多人房**共用同一套回合状态机**，差别只有三条：
 *  ① 不计时（deadlineAt / graceDeadlineAt = 0 表示不限时）；
 *  ② 不看在线/挂机状态 —— 一个人"挂机"只是在想题，不该把回合跳掉；
 *  ③ tickTurn 不推进阶段（没有宽限期、没有超时跳过）。
 * 这里把三条都按住，同时回归一句"多人房不受影响"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLATFORM, PRESETS } from '../../packages/core/src/index.ts';
import { emptyRoom } from '../../packages/core/src/room.ts';
import { beginMatch, canSubmit, startTurn, tickTurn } from '../../packages/core/src/turn.ts';
import type { CoreMember, CoreRoom, ReduceCtx } from '../../packages/core/src/types.ts';

const NOW = 1_700_000_000_000;
const ctx: ReduceCtx = { now: NOW, rand: () => 0.5, newId: (p: string) => `${p}_x` };

function member(id: string, patch: Partial<CoreMember> = {}): CoreMember {
  return {
    id, playerId: `p_${id}`, name: id, isBot: false, role: 'member', joinSeq: 1,
    conn: 'connected', activity: 'active', hidden: false,
    lastActivityAt: NOW, lastHeartbeatAt: NOW,
    skipStreak: 0, score: 0, hintsUsedT12: 0, hintsUsedT3: 0, guessesUsed: 0, lastHintAt: -1e9,
    ...patch,
  };
}

function roomWith(solo: boolean, patch: Partial<CoreMember> = {}): CoreRoom {
  const base = emptyRoom('r1', 'ABC123', { ...PRESETS.standard }, NOW, solo);
  // turnOrder 要真的有这个人：startTurn 会先把"已经不在房间里的 id"过滤掉，
  // 空轮转顺序会被判成"没有可参与轮转的成员"直接结束对局（真实开局由 beginMatch 生成顺序）。
  return { ...base, hostId: 'm1', turnOrder: ['m1'], members: [member('m1', patch)] };
}

test('单人房：开局后**不计时**（deadlineAt/graceDeadlineAt = 0 表示不限时）', () => {
  const out = beginMatch(roomWith(true), 'p1', ctx);
  assert.equal(out.room.status, 'playing');
  assert.equal(out.room.turn.phase, 'ACTIVE');
  assert.equal(out.room.turn.deadlineAt, 0);
  assert.equal(out.room.turn.graceDeadlineAt, 0);
  assert.equal(out.room.turn.memberId, 'm1');
  const started = out.events.find((e) => e.type === 'turn_started');
  assert.ok(started && started.type === 'turn_started' && started.deadlineAt === 0, '事件里的截止时间也是 0（前端据此显示"不限时"）');
});

test('单人房：**挂机/离线也不跳过**（回合仍是你自己的、ACTIVE）', () => {
  for (const patch of [{ activity: 'idle' as const }, { conn: 'disconnected' as const }]) {
    const out = startTurn({ ...roomWith(true, patch), status: 'playing' }, ctx);
    assert.equal(out.room.turn.phase, 'ACTIVE', `${JSON.stringify(patch)} 时仍应是 ACTIVE`);
    assert.equal(out.room.turn.deadlineAt, 0);
  }
  // 对照：多人房里挂机（开着 idleSkip）会直接进宽限期
  const multi = startTurn({ ...roomWith(false, { activity: 'idle' }), status: 'playing' }, ctx);
  assert.equal(multi.room.turn.phase, 'GRACE');
  assert.ok(multi.room.turn.deadlineAt > 0);
});

test('单人房：什么时候提交都受理（放一小时也不会 TURN_EXPIRED）', () => {
  const playing = { ...roomWith(true), status: 'playing' as const };
  const out = beginMatch(playing, 'p1', ctx);
  assert.equal(canSubmit(out.room, 'm1', out.room.turn.seq, NOW + 3600_000, '他是不是在海上遇难了？'), null);
  // 对照：多人房同样放一小时必然过期
  const multi = beginMatch({ ...roomWith(false), status: 'waiting' }, 'p1', ctx);
  assert.equal(canSubmit(multi.room, 'm1', multi.room.turn.seq, NOW + 3600_000, '他是不是在海上遇难了？'), 'TURN_EXPIRED');
});

test('单人房：tickTurn 不推进阶段（不会出现宽限期 / 超时跳过）', () => {
  const out = beginMatch(roomWith(true), 'p1', ctx);
  for (const ms of [PLATFORM.disconnectSec * 1000, 3600_000, 24 * 3600_000]) {
    const ticked = tickTurn(out.room, NOW + ms, { ...ctx, now: NOW + ms });
    assert.equal(ticked.events.length, 0, `+${ms}ms 不该产生任何事件`);
    assert.equal(ticked.room.turn.phase, 'ACTIVE');
    assert.equal(ticked.room.turn.outcome, null);
    assert.equal(ticked.room.status, 'playing');
  }
});

test('单人房：判定失败后重新给的是"不限时"，不会突然冒出倒计时', async () => {
  const { applyJudgeFailed } = await import('../../packages/core/src/turn.ts');
  const out = beginMatch(roomWith(true), 'p1', ctx);
  const failed = applyJudgeFailed(out.room, NOW + 60_000);
  assert.equal(failed.turn.phase, 'ACTIVE');
  assert.equal(failed.turn.deadlineAt, 0);
  assert.equal(failed.turn.graceDeadlineAt, 0);
});
