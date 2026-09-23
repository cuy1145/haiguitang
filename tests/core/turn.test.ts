/**
 * 回合状态机与成员状态两条独立判定线的单元测试（《阶段3》§2/§3、《阶段5》§4.1）。
 * 关键断言：
 *  - 宽限期内提交有效、晚到一律丢弃、不产生第二次判定
 *  - 回合跳过与挂机状态互不写入
 *  - 挂机不触发移交，断连才触发
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM, DEFAULT_CONFIG, emptyRoom, reduce, orderInvariantHolds, getMember,
} from '../../packages/core/src/index.ts';
import type { CoreRoom, ReduceCtx } from '../../packages/core/src/index.ts';
import { buildTurnOrder, canSubmit } from '../../packages/core/src/turn.ts';
import { pickNewHost, transferGate } from '../../packages/core/src/host.ts';

let idc = 0;
function ctx(now: number, rand = () => 0.5): ReduceCtx {
  return { now, rand, newId: (p: string) => `${p}${++idc}` };
}

function makeRoom(now = 1_000_000, opts: { members?: number } = {}): CoreRoom {
  let room = emptyRoom('r1', 'ABC123', { ...DEFAULT_CONFIG }, now);
  const n = opts.members ?? 3;
  for (let i = 1; i <= n; i++) {
    room = {
      ...room,
      members: [...room.members, {
        id: `m${i}`, playerId: `p${i}`, name: `玩家${i}`, isBot: false,
        role: i === 1 ? 'host' : 'member', joinSeq: i,
        conn: 'connected', activity: 'active', hidden: false,
        lastActivityAt: now, lastHeartbeatAt: now,
        skipStreak: 0, score: 0, hintsUsedT12: 0, hintsUsedT3: 0, guessesUsed: 0, lastHintAt: -1e9,
      }],
    };
    if (i === 1) room = { ...room, hostId: 'm1' };
  }
  return room;
}

function beginMatch(room: CoreRoom, ctx0: ReduceCtx): CoreRoom {
  return reduce(room, { type: 'MATCH_BEGIN', puzzleId: 'p-leak' }, ctx0).room;
}

test('开局：生成轮转顺序、启动第一回合（ACTIVE + 完整时长 + 宽限）', () => {
  const now = 1_000_000;
  const room = beginMatch(makeRoom(now), ctx(now));
  assert.equal(room.status, 'playing');
  assert.deepEqual(room.turnOrder, ['m1', 'm2', 'm3']);
  assert.equal(room.turnIndex, 0);
  assert.equal(room.turn.seq, 1);
  assert.equal(room.turn.memberId, 'm1');
  assert.equal(room.turn.phase, 'ACTIVE');
  assert.equal(room.turn.deadlineAt, now + DEFAULT_CONFIG.perTurnSec * 1000);
  assert.equal(room.turn.graceDeadlineAt, now + DEFAULT_CONFIG.perTurnSec * 1000 + DEFAULT_CONFIG.graceSec * 1000);
  assert.ok(orderInvariantHolds(room));
});

test('提交校验：非本回合 / 陈旧 turnSeq / 重复提交 全部被拒（服务端权威）', () => {
  const now = 1_000_000;
  const room = beginMatch(makeRoom(now), ctx(now));
  assert.equal(canSubmit(room, 'm2', 1, now, '他以前出过海吗？'), 'NOT_YOUR_TURN');
  assert.equal(canSubmit(room, 'm1', 2, now, '他以前出过海吗？'), 'STALE_TURN');
  assert.equal(canSubmit(room, 'm1', 1, now, '他以前出过海吗？'), null);

  const judging = reduce(room, { type: 'SUBMIT_ACCEPTED', memberId: 'm1' }, ctx(now)).room;
  assert.equal(judging.turn.phase, 'JUDGING');
  assert.equal(canSubmit(judging, 'm1', 1, now, '再问一次'), 'TURN_ALREADY_ANSWERED');
});

test('C-10 晚到输入一律丢弃：以服务端接收时刻判定，且不做顺延', () => {
  const now = 1_000_000;
  const room = beginMatch(makeRoom(now), ctx(now));
  const lateAt = room.turn.graceDeadlineAt + 1;
  assert.equal(canSubmit(room, 'm1', 1, lateAt, '他以前出过海吗？'), 'TURN_EXPIRED');
  // 宽限期内仍然有效（临界提交）
  assert.equal(canSubmit(room, 'm1', 1, room.turn.graceDeadlineAt, '他以前出过海吗？'), null);
});

test('超时：ACTIVE→GRACE→SKIPPED，跳过的是本轮而不是补回，顺序不变', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  const t = room.turn;

  const grace = reduce(room, { type: 'TURN_TICK' }, ctx(t.deadlineAt)).room;
  assert.equal(grace.turn.phase, 'GRACE');
  assert.equal(grace.turn.memberId, 'm1', '进入宽限期时回合归属不变');

  const skipped = reduce(grace, { type: 'TURN_TICK' }, ctx(t.graceDeadlineAt));
  assert.equal(skipped.room.turn.memberId, 'm2', '宽限期满后轮到下一位');
  assert.equal(skipped.room.turn.seq, 2);
  assert.ok(skipped.events.some((e) => e.type === 'turn_skipped' && e.reason === 'timeout'));
  assert.deepEqual(skipped.room.turnOrder, ['m1', 'm2', 'm3'], '顺序不因跳过而改变');
  assert.equal(getMember(skipped.room, 'm1')?.skipStreak, 1);
});

test('判定失败：回退 ACTIVE 且 turnSeq 不变（不会产生第二次判定）', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  const seq = room.turn.seq;
  room = reduce(room, { type: 'SUBMIT_ACCEPTED', memberId: 'm1' }, ctx(now)).room;
  const failed = reduce(room, { type: 'JUDGE_FAILED' }, ctx(now + 5000)).room;
  assert.equal(failed.turn.phase, 'ACTIVE');
  assert.equal(failed.turn.seq, seq);
  assert.equal(failed.turn.deadlineAt, now + 5000 + DEFAULT_CONFIG.perTurnSec * 1000, '重新给完整时长');
  assert.equal(canSubmit(failed, 'm1', seq, now + 6000, '他以前出过海吗？'), null, '仍可重新提交');
});

test('轮到挂机/断连成员：直接进入宽限（不空等整轮）', () => {
  const now = 1_000_000;
  let room = makeRoom(now);
  // m2 挂机、m3 断连
  room = { ...room, members: room.members.map((m) => m.id === 'm2' ? { ...m, activity: 'idle' } : m.id === 'm3' ? { ...m, conn: 'disconnected' } : m) };
  room = beginMatch(room, ctx(now));
  assert.equal(room.turn.memberId, 'm1');
  assert.equal(room.turn.phase, 'ACTIVE');

  const toM2 = reduce(room, { type: 'TURN_TICK' }, ctx(room.turn.graceDeadlineAt));
  assert.equal(toM2.room.turn.memberId, 'm2');
  assert.equal(toM2.room.turn.phase, 'GRACE', '挂机成员直接进宽限');
  assert.equal(toM2.room.turn.deadlineAt, toM2.room.turn.startedAt, '没有整轮倒计时');

  const toM3 = reduce(toM2.room, { type: 'TURN_TICK' }, ctx(toM2.room.turn.graceDeadlineAt));
  assert.equal(toM3.room.turn.memberId, 'm3');
  assert.equal(toM3.room.turn.phase, 'GRACE', '断连成员直接进宽限');
});

test('成员在自己回合内断连：回合不立即跳过，宽限期内提交仍有效（防瞬时抖动）', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  room = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'disconnected' }, ctx(now + 1000)).room;
  assert.equal(room.turn.memberId, 'm1');
  assert.equal(room.turn.phase, 'ACTIVE', '回合保持 ACTIVE，不因断连立即跳过');
  assert.equal(canSubmit(room, 'm1', room.turn.seq, now + 2000, '他以前出过海吗？'), null, '重连后仍可提交');
});

test('两条判定线互不写入：回合超时不改变挂机状态；挂机状态不改变回合计时', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  const deadlineBefore = room.turn.deadlineAt;
  // 让 m2 变成挂机（活动线）
  room = { ...room, members: room.members.map((m) => m.id === 'm2' ? { ...m, lastActivityAt: now - PLATFORM.idleSec * 1000 - 1 } : m) };
  const ticked = reduce(room, { type: 'PRESENCE_TICK' }, ctx(now)).room;
  assert.equal(getMember(ticked, 'm2')?.activity, 'idle');
  assert.equal(ticked.turn.deadlineAt, deadlineBefore, '挂机扫描不得改动当前回合计时');
  assert.equal(ticked.turn.memberId, 'm1');

  // 回合超时跳过 m1，不得改变 m1 的活动状态
  const activityBefore = getMember(ticked, 'm1')?.activity;
  const skipped = reduce(ticked, { type: 'TURN_TICK' }, ctx(ticked.turn.graceDeadlineAt)).room;
  assert.equal(getMember(skipped, 'm1')?.skipStreak, 1);
  assert.equal(getMember(skipped, 'm1')?.activity, activityBefore, '回合结果不得写入挂机状态');
});

test('断连线与活动线独立：心跳超时只改 conn，不改 activity', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  room = { ...room, members: room.members.map((m) => m.id === 'm2' ? { ...m, lastHeartbeatAt: now - PLATFORM.disconnectSec * 1000 - 1, lastActivityAt: now } : m) };
  const out = reduce(room, { type: 'PRESENCE_TICK' }, ctx(now));
  assert.equal(getMember(out.room, 'm2')?.conn, 'disconnected');
  assert.equal(getMember(out.room, 'm2')?.activity, 'active', '断连不得改变挂机状态');
});

test('全员挂机 → 房间暂停；有人回来 → 恢复', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  const stale = now - PLATFORM.idleSec * 1000 - 1;
  room = { ...room, members: room.members.map((m) => ({ ...m, lastActivityAt: stale })) };
  const paused = reduce(room, { type: 'PRESENCE_TICK' }, ctx(now));
  assert.equal(paused.room.status, 'suspended');
  assert.equal(paused.room.pauseReason, 'all_idle');
  assert.ok(paused.events.some((e) => e.type === 'room_paused'));

  const resumed = reduce(paused.room, { type: 'MEMBER_ACTIVITY', memberId: 'm2', hidden: false }, ctx(now + 1000));
  const after = reduce(resumed.room, { type: 'PRESENCE_TICK' }, ctx(now + 1001));
  assert.equal(after.room.status, 'playing');
  assert.equal(after.room.pauseReason, null);
});

// ---------------------------------------------------------------- 房主移交
test('挂机不触发移交，断连才触发（移交条件与顺位）', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));

  // 挂机：markSuspect 不应发生
  let idleHost = { ...room, members: room.members.map((m) => m.id === 'm1' ? { ...m, activity: 'idle' as const, lastActivityAt: now - PLATFORM.idleSec * 1000 - 1 } : m) };
  idleHost = reduce(idleHost, { type: 'PRESENCE_TICK' }, ctx(now)).room;
  assert.equal(idleHost.transfer.state, 'idle', '房主挂机不得进入移交');
  assert.equal(idleHost.credit.mode, 'host_key');
  assert.equal(getMember(idleHost, 'm1')?.role, 'host');

  // 断连：进入 suspect，宽限后才可移交
  let disconnected = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'disconnected' }, ctx(now)).room;
  assert.equal(disconnected.transfer.state, 'suspect');
  assert.equal(transferGate(disconnected, now + 1000).ok, false, '宽限未过不得移交');
  assert.equal(transferGate(disconnected, now + PLATFORM.hostTransferGraceSec * 1000).ok, true);

  const toId = pickNewHost(disconnected, now + PLATFORM.hostTransferGraceSec * 1000);
  assert.equal(toId, 'm2', '按加入顺序顺位取下一位');

  const transferred = reduce(disconnected, { type: 'HOST_TRANSFER', toId: toId! }, ctx(now + PLATFORM.hostTransferGraceSec * 1000));
  assert.equal(transferred.room.hostId, 'm2');
  assert.equal(getMember(transferred.room, 'm1')?.role, 'member');
  assert.equal(transferred.room.credit.mode, 'site_fallback');
  assert.equal(transferred.room.credit.reason, 'HOST_TRANSFERRED');
  assert.equal(transferred.room.turn.phase, 'PAUSED', '当前回合作废');
  assert.equal(transferred.room.turn.outcome, 'voided_transfer');
  assert.equal(transferred.suspendedKeyOwnerId, 'm1', '服务端据此挂起原房主 Key');
  assert.ok(transferred.events.some((e) => e.type === 'credit_switch' && e.reason === 'HOST_TRANSFERRED'));
  assert.deepEqual(transferred.room.turnOrder, ['m1', 'm2', 'm3'], '移交不打乱回合顺序');
});

test('顺位跳过挂机/断连者；无候选时暂停等待房主（额度与 Key 不变）', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  room = { ...room, members: room.members.map((m) => m.id === 'm2' ? { ...m, activity: 'idle' as const } : m) };
  room = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'disconnected' }, ctx(now)).room;
  assert.equal(pickNewHost(room, now + 31_000), 'm3', '跳过挂机的 m2');

  // 全员离线（含 m3）→ 无候选
  let allOff = { ...room, members: room.members.map((m) => (m.id === 'm1' ? m : { ...m, conn: 'disconnected' as const })) };
  assert.equal(pickNewHost(allOff, now + 31_000), null);
  const waiting = reduce(allOff, { type: 'HOST_TRANSFER_WAITING' }, ctx(now + 31_000));
  assert.equal(waiting.room.status, 'suspended');
  assert.equal(waiting.room.pauseReason, 'waiting_host_return');
  assert.equal(waiting.room.credit.mode, 'host_key', '无候选时额度来源不变（Key 也不挂起）');
  assert.equal(waiting.room.credit.reason, 'LOCKED_ACTIVE');
});

test('移交宽限内重连 → 移交取消，身份与额度都不变', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  room = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'disconnected' }, ctx(now)).room;
  assert.equal(room.transfer.state, 'suspect');
  const back = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'connected' }, ctx(now + 5000)).room;
  assert.equal(back.transfer.state, 'idle');
  assert.equal(back.hostId, 'm1');
  assert.equal(back.credit.mode, 'host_key');
});

test('房主在自己回合内断连：移交优先并作废该回合，新房主继续后从下一位开始', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  assert.equal(room.turn.memberId, 'm1');
  room = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'disconnected' }, ctx(now)).room;
  room = reduce(room, { type: 'HOST_TRANSFER', toId: 'm2' }, ctx(now + 31_000)).room;
  assert.equal(room.turn.outcome, 'voided_transfer');
  const resumed = reduce(room, { type: 'HOST_RESUME' }, ctx(now + 32_000));
  assert.equal(resumed.room.turn.memberId, 'm2', '作废回合的下一位（新房主）开始');
  assert.equal(resumed.room.turn.phase, 'ACTIVE');
});

test('回合上限：只在轮次边界结算，不打断进行中的回合', () => {
  const now = 1_000_000;
  let room = makeRoom(now);
  room = { ...room, config: { ...room.config, maxRounds: 1 } };
  room = beginMatch(room, ctx(now));
  // 第 1 轮内三位成员依次进行，不应结束
  let t = now;
  for (let i = 0; i < 3; i++) {
    const seqRoom = reduce(room, { type: 'SUBMIT_ACCEPTED', memberId: room.turn.memberId! }, ctx(t)).room;
    room = reduce(seqRoom, { type: 'JUDGE_DONE' }, ctx(t)).room;
    if (room.turnIndex === 0 && room.status === 'settled') break;
  }
  assert.equal(room.status, 'settled');
  assert.equal(room.result?.result, 'unsolved');
  assert.equal(room.result?.reason, '达到总回合上限');
});

test('轮转顺序：随机模式用同一 seed 得到同一顺序（可复现）', () => {
  const now = 1_000_000;
  const r = makeRoom(now);
  const withRandom = { ...r, config: { ...r.config, turnOrderMode: 'random' as const } };
  const a = buildTurnOrder(withRandom, () => 0.3);
  const b = buildTurnOrder(withRandom, () => 0.3);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
});

test('移交后继续参与：被作废的回合不计入 skipStreak', () => {
  const now = 1_000_000;
  let room = beginMatch(makeRoom(now), ctx(now));
  room = reduce(room, { type: 'MEMBER_CONN', memberId: 'm1', conn: 'disconnected' }, ctx(now)).room;
  room = reduce(room, { type: 'HOST_TRANSFER', toId: 'm2' }, ctx(now + 31_000)).room;
  assert.equal(getMember(room, 'm1')?.skipStreak, 0);
});

// 引用一下内部工具，避免"未使用"的误解（也是文档化的导出）
test('成员查询工具可用', () => {
  const room = makeRoom();
  assert.equal(getMember(room, 'm1')?.name, '玩家1');
  assert.equal(getMember(room, 'nope'), undefined);
});
