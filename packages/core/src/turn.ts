/**
 * 回合状态机（《阶段3》§2）—— 全部为纯函数。
 *
 *  ACTIVE --SUBMIT--> JUDGING --JUDGE_OK--> SETTLED
 *    │  │                 │
 *    │  └─ now>=deadline ─┴─ JUDGE_FAIL ─> 回退 ACTIVE（重新给完整时长，不消耗回合）
 *    ▼
 *  GRACE --SUBMIT--> JUDGING（late_submit=true）
 *    └─ now>=graceDeadline --> SKIPPED(timeout)
 *  轮到即不可用（断连/挂机且开启跳过）--> 直接进入 GRACE
 *
 * 幂等与竞态（《阶段5》§1.2 C-01/C-02/C-10）：
 *  - 提交必须携带 turnSeq；不匹配 → STALE_TURN，不回滚回合
 *  - 是否迟到一律以**服务端接收时刻**判定（调用方传入 now）
 *  - 相位与归属的检查在同一临界区内完成（服务端房间队列）
 */
import type {
  CoreRoom, DomainEvent, ReduceCtx, SkipReason, SubmitReject, TurnOutcome,
} from './types.ts';
import { PLATFORM } from './constants.ts';
import { checkQuestionText } from './text.ts';
import { getMember, isPlaying, playerCount, withRoom } from './room.ts';

/** 一位成员的名称（用于日志/广播文案的服务端模板）。 */
export type NameResolver = (memberId: string) => string;

export interface TurnTransition {
  room: CoreRoom;
  events: DomainEvent[];
}

/** 生成轮转顺序（与房主身份完全解耦）。 */
export function buildTurnOrder(room: CoreRoom, rand: () => number): string[] {
  const ids = room.members.filter((m) => m.role !== 'spectator').map((m) => m.id);
  if (room.config.turnOrderMode === 'random') {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const a = ids[i]; const b = ids[j];
      if (a !== undefined && b !== undefined) { ids[i] = b; ids[j] = a; }
    }
    return ids;
  }
  return ids.sort((a, b) => (getMember(room, a)?.joinSeq ?? 0) - (getMember(room, b)?.joinSeq ?? 0));
}

/** 开局：锁定题目、生成顺序、启动第一回合。 */
export function beginMatch(room: CoreRoom, puzzleId: string, ctx: ReduceCtx): TurnTransition {
  const order = buildTurnOrder(room, ctx.rand);
  let next = withRoom(room, {
    status: 'playing',
    pauseReason: null,
    puzzleId,
    turnOrder: order,
    turnIndex: 0,
    roundNo: 1,
    result: null,
    revealedFacts: [],
    hint: { tier3Used: 0 },
    vote: null,
    transfer: { ...room.transfer, state: 'idle', fromId: null, toId: null },
  }, ctx.now);
  const started = startTurn(next, ctx);
  return started;
}

/** 启动当前 turnIndex 指向的成员的回合并广播。 */
export function startTurn(room: CoreRoom, ctx: ReduceCtx): TurnTransition {
  const events: DomainEvent[] = [];
  const order = room.turnOrder.filter((id) => !!getMember(room, id));
  if (order.length === 0) {
    return endMatch(withRoom(room, { turnOrder: order }, ctx.now), 'aborted', '没有可参与轮转的成员', ctx);
  }
  const index = ((room.turnIndex % order.length) + order.length) % order.length;
  const memberId = order[index] ?? "";
  const member = getMember(room, memberId);
  if (!member) return endMatch(room, 'aborted', '回合归属成员不存在', ctx);

  const unavailable = member.conn === 'disconnected' || (member.activity === 'idle' && room.config.idleSkip);
  const phase = unavailable ? 'GRACE' : 'ACTIVE';
  const deadlineAt = unavailable ? ctx.now : ctx.now + room.config.perTurnSec * 1000;
  const graceDeadlineAt = deadlineAt + room.config.graceSec * 1000;

  const next = withRoom(room, {
    turnOrder: order,
    turnIndex: index,
    turn: {
      seq: room.turn.seq + 1,
      memberId,
      phase,
      startedAt: ctx.now,
      deadlineAt,
      graceDeadlineAt,
      outcome: null,
      lateSubmit: false,
    },
  }, ctx.now);

  events.push({ type: 'turn_started', turnSeq: next.turn.seq, memberId, phase, deadlineAt: graceDeadlineAt });
  return { room: next, events };
}

/** 提交校验：返回 null 表示受理。 */
export function canSubmit(
  room: CoreRoom,
  memberId: string,
  turnSeq: number,
  receivedAt: number,
  rawText: string,
): SubmitReject | null {
  if (room.status === 'settled' || room.status === 'destroyed') return 'MATCH_NOT_ACTIVE';
  if (room.status === 'suspended') return 'MATCH_PAUSED';
  if (!isPlaying(room)) return 'MATCH_NOT_ACTIVE';
  if (room.turn.memberId !== memberId) return 'NOT_YOUR_TURN';
  if (turnSeq !== room.turn.seq) return 'STALE_TURN';
  if (room.turn.phase === 'JUDGING' || room.turn.phase === 'SETTLED') return 'TURN_ALREADY_ANSWERED';
  if (room.turn.phase === 'SKIPPED') return room.turn.outcome === 'voided_transfer' ? 'TURN_VOIDED' : 'TURN_EXPIRED';
  if (room.turn.phase !== 'ACTIVE' && room.turn.phase !== 'GRACE') return 'MATCH_PAUSED';
  if (receivedAt > room.turn.graceDeadlineAt) return 'TURN_EXPIRED';
  return checkQuestionText(rawText);
}

/** 受理提交：进入 JUDGING（判定在房间队列之外执行）。 */
export function applySubmit(room: CoreRoom, memberId: string, now: number): CoreRoom {
  const late = room.turn.phase === 'GRACE';
  return withRoom(room, {
    turn: { ...room.turn, phase: 'JUDGING', lateSubmit: late },
  }, now);
}

/** 判定成功：回合结算。 */
export function applyJudgeDone(room: CoreRoom, now: number): TurnTransition {
  const memberId = room.turn.memberId ?? '';
  const next = withRoom(room, {
    turn: { ...room.turn, phase: 'SETTLED', outcome: 'answered' },
  }, now);
  return { room: next, events: [{ type: 'turn_settled', turnSeq: next.turn.seq, memberId, outcome: 'answered' }] };
}

/** 判定失败：回退到 ACTIVE 并重新给完整时长（不消耗回合，turnSeq 不变 → 不会产生第二次判定）。 */
export function applyJudgeFailed(room: CoreRoom, now: number): CoreRoom {
  const deadlineAt = now + room.config.perTurnSec * 1000;
  return withRoom(room, {
    turn: {
      ...room.turn,
      phase: 'ACTIVE',
      startedAt: now,
      deadlineAt,
      graceDeadlineAt: deadlineAt + room.config.graceSec * 1000,
      lateSubmit: false,
    },
  }, now);
}

/** 定时推进：ACTIVE→GRACE→SKIPPED。返回是否发生了状态转移。 */
export function tickTurn(room: CoreRoom, now: number, ctx: ReduceCtx): TurnTransition {
  const events: DomainEvent[] = [];
  if (!isPlaying(room)) return { room, events };
  const t = room.turn;
  // 先判宽限期是否已过：服务器暂停/重启后一次 tick 可能直接跨过两个阶段，
  // 若先处理 ACTIVE→GRACE 就会把过期回合多留一个 tick。
  if ((t.phase === 'ACTIVE' || t.phase === 'GRACE') && now >= t.graceDeadlineAt) {
    if (room.config.timeoutSkip) {
      return skipTurn(room, 'timeout', ctx);
    }
    // 关闭自动跳过：保持 GRACE 等待房主手动跳过（否则房间会卡死）
    if (t.phase === 'ACTIVE') {
      const graced = withRoom(room, { turn: { ...t, phase: 'GRACE' } }, now);
      events.push({ type: 'grace_started', turnSeq: t.seq, graceDeadlineAt: t.graceDeadlineAt });
      return { room: graced, events };
    }
    return { room, events };
  }
  if (t.phase === 'ACTIVE' && now >= t.deadlineAt) {
    const next = withRoom(room, { turn: { ...t, phase: 'GRACE' } }, now);
    events.push({ type: 'grace_started', turnSeq: t.seq, graceDeadlineAt: t.graceDeadlineAt });
    return { room: next, events };
  }
  return { room, events };
}

/**
 * 跳过当前回合（不补回，顺序不变）。
 *
 * ⚠️ 必须用**真实的 ctx.now** 调用：下一回合的截止时间是从 now 起算的，
 *    如果拿一个"未来的时间"当 now（以前房主手动跳过是拿 graceDeadlineAt 伪造一次 tick），
 *    剩余时间就会被叠进下一回合（还剩 30 秒时跳过，下一回合会变成 2 分 30 秒）。
 */
export function skipTurn(room: CoreRoom, reason: SkipReason, ctx: ReduceCtx): TurnTransition {
  const memberId = room.turn.memberId ?? '';
  const member = getMember(room, memberId);
  const outcome: TurnOutcome = reason === 'timeout'
    ? 'skipped_timeout'
    : reason === 'manual' ? 'skipped_manual' : 'skipped_unavailable';
  let next = withRoom(room, {
    turn: { ...room.turn, phase: 'SKIPPED', outcome },
  }, ctx.now);
  if (member && reason === 'timeout') {
    next = withRoom(next, {
      members: next.members.map((m) => (m.id === memberId ? { ...m, skipStreak: m.skipStreak + 1 } : m)),
    }, ctx.now);
  }
  const events: DomainEvent[] = [
    { type: 'turn_skipped', turnSeq: room.turn.seq, memberId, reason },
    { type: 'turn_settled', turnSeq: room.turn.seq, memberId, outcome },
  ];
  const advanced = advanceTurn(next, ctx);
  return { room: advanced.room, events: [...events, ...advanced.events] };
}

/** 推进到下一位；跨轮时检查上限。 */
export function advanceTurn(room: CoreRoom, ctx: ReduceCtx): TurnTransition {
  const len = room.turnOrder.length || 1;
  const nextIndex = (room.turnIndex + 1) % len;
  const wrapped = nextIndex === 0;
  const nextRound = wrapped ? room.roundNo + 1 : room.roundNo;
  if (wrapped && nextRound > room.config.maxRounds) {
    return endMatch(withRoom(room, { turnIndex: nextIndex, roundNo: room.config.maxRounds }, ctx.now),
      'unsolved', '达到总回合上限', ctx);
  }
  let base = room;
  if (wrapped) {
    // 跨轮这一刻，把「待入席且已申请上桌」的人**转正**：追加到轮转队尾。
    // 语义：新成员从这一轮开始才参与轮转（不会挤掉老成员本轮的提问机会），
    // 也避免了"刚进房就抢走一次提问"的不公平。
    const granted = seatGranted(room);
    if (granted.length > 0) {
      base = withRoom(room, {
        members: room.members.map((m) => (granted.includes(m.id) ? { ...m, role: 'member' as const, pendingSeat: false, seatRequested: false } : m)),
        turnOrder: [...room.turnOrder, ...granted],
      }, ctx.now);
    }
  }
  const next = withRoom(base, { turnIndex: nextIndex, roundNo: nextRound }, ctx.now);
  return startTurn(next, ctx);
}

/** 本刻应当转正的待入席成员（已申请上桌、仍在房间里、且没掉线）。 */
export function seatGranted(room: CoreRoom): string[] {
  return room.members
    .filter((m) => m.pendingSeat === true && m.seatRequested === true && m.conn === 'connected')
    .map((m) => m.id);
}

/** 结算整局。aborted 不揭晓汤底（由服务端在 recap 门禁处再校验一次）。 */
export function endMatch(
  room: CoreRoom,
  result: 'solved' | 'unsolved' | 'aborted',
  reason: string,
  ctx: ReduceCtx,
): TurnTransition {
  if (room.status === 'settled') return { room, events: [] };
  const next = withRoom(room, {
    status: 'settled',
    pauseReason: null,
    result: { result, reason },
    turn: { ...room.turn, phase: 'SETTLED', outcome: room.turn.outcome ?? null },
    vote: room.vote && room.vote.status === 'open' ? { ...room.vote, status: 'rejected', result: '对局结束，投票作废' } : room.vote,
  }, ctx.now);
  return { room: next, events: [{ type: 'match_ended', result, reason }] };
}

/** 回合归属校验的辅助：仅用于断言"一个人在一轮内只出现一次"。 */
export function orderInvariantHolds(room: CoreRoom): boolean {
  const participants = room.members.filter((m) => m.role !== 'spectator').map((m) => m.id);
  const seen = new Set(room.turnOrder);
  if (seen.size !== room.turnOrder.length) return false;
  if (room.turnOrder.length !== playerCount(room)) return false;
  return participants.every((id) => seen.has(id));
}

export { PLATFORM };

