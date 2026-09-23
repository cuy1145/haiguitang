/**
 * 投票规则（《阶段3》§6.3 选题投票、《阶段4》§8 额度降级投票）。
 *
 * 统一口径：
 *  - 有表决权者 = 发起时在线活跃成员（eligibleAtOpen）
 *  - 分母 = eligibleAtOpen ∩ 结算时仍在线活跃（投票期间变为挂机/断线者被移出分母，但其选票保留并计入"已投"）
 *  - 超时未投 = 弃权，**计入分母**（防止"没人投票"被当作默许通过）
 *  - 额度降级门槛：有效人数 ≥ 2 且赞成票严格过半
 *  - 选题投票：票高者当选；平票由服务端随机（seed 落库，可复现）
 */
import type { ActionReject, CoreRoom, CoreVote, DomainEvent, VoteType } from './types.ts';
import { PLATFORM } from './constants.ts';
import { eligibleMembers, getMember, isPlaying, withRoom } from './room.ts';

export function openVote(
  room: CoreRoom,
  type: VoteType,
  puzzleIds: string[],
  now: number,
  opts: { id: string; durationSec?: number },
): { room: CoreRoom; vote: CoreVote } {
  const eligible = eligibleMembers(room, now).map((m) => m.id);
  const duration = opts.durationSec
    ?? (type === 'puzzle_choice' ? room.config.voteDurationSec : PLATFORM.fallbackVoteDurationSec);
  const vote: CoreVote = {
    id: opts.id,
    type,
    puzzleIds: type === 'puzzle_choice' ? puzzleIds : [],
    ballots: {},
    eligibleAtOpen: eligible,
    openedAt: now,
    deadlineAt: now + duration * 1000,
    status: 'open',
  };
  return { room: withRoom(room, { vote }, now), vote };
}

/** 表决资格：发起时在册 + 当前仍在线活跃。挂机/断线者的表决不被受理。 */
export function canCast(room: CoreRoom, memberId: string): ActionReject | null {
  const vote = room.vote;
  if (!vote || vote.status !== 'open') return 'VOTE_NOT_OPEN';
  if (!vote.eligibleAtOpen.includes(memberId)) return 'VOTE_NOT_ELIGIBLE';
  const m = getMember(room, memberId);
  if (!m || m.conn !== 'connected' || m.activity !== 'active') return 'VOTE_NOT_ELIGIBLE';
  return null;
}

export function castBallot(room: CoreRoom, memberId: string, choice: string, now: number): CoreRoom {
  const vote = room.vote;
  if (!vote) return room;
  const ballots = { ...vote.ballots, [memberId]: choice };
  return withRoom(room, { vote: { ...vote, ballots } }, now);
}

/** 分母：发起时在册 ∩ 结算时仍在线活跃。 */
export function voteDenominator(room: CoreRoom): string[] {
  const vote = room.vote;
  if (!vote) return [];
  const live = new Set(eligibleMembers(room, room.updatedAt).map((m) => m.id));
  return vote.eligibleAtOpen.filter((id) => live.has(id));
}

/** 是否应当结算：全部在册表决人都已投票，或已过截止时间。 */
export function shouldSettle(room: CoreRoom, now: number): boolean {
  const vote = room.vote;
  if (!vote || vote.status !== 'open') return false;
  const allVoted = vote.eligibleAtOpen.length > 0 && vote.eligibleAtOpen.every((id) => vote.ballots[id] !== undefined);
  return allVoted || now >= vote.deadlineAt;
}

export interface VoteSettleResult {
  room: CoreRoom;
  events: DomainEvent[];
  /** 额度降级投票通过时为 true（由服务端据此授予 grant） */
  creditGranted: boolean;
  /** 选题投票选中的题目 id */
  selectedPuzzleId: string | null;
}

export function settleVote(room: CoreRoom, now: number, rand: () => number): VoteSettleResult {
  const vote = room.vote;
  const events: DomainEvent[] = [];
  if (!vote || vote.status !== 'open') return { room, events, creditGranted: false, selectedPuzzleId: null };

  const denom = voteDenominator(room);
  const invalid = denom.length < PLATFORM.voteMinEligible;

  if (vote.type === 'puzzle_choice') {
    const byOption: Record<string, number> = {};
    for (const [, choice] of Object.entries(vote.ballots)) {
      byOption[choice] = (byOption[choice] ?? 0) + 1;
    }
    let best: string | null = null;
    let bestN = -1;
    const ties: string[] = [];
    for (const id of vote.puzzleIds) {
      const n = byOption[id] ?? 0;
      if (n > bestN) { bestN = n; best = id; ties.length = 0; ties.push(id); }
      else if (n === bestN) ties.push(id);
    }
    let result: string;
    if (invalid) {
      best = vote.puzzleIds[0] ?? null;
      result = '有效投票人不足，房主直接指定';
    } else if (ties.length > 1) {
      const seed = rand();
      best = ties[Math.floor(seed * ties.length)] ?? ties[0] ?? null;
      result = '平票，服务端随机选定';
    } else {
      result = '票高者当选';
    }
    const settled: CoreVote = { ...vote, status: 'passed', result, tally: { yes: 0, no: 0, abstain: 0, byOption } };
    events.push({ type: 'vote_settled', voteId: vote.id, status: 'passed', result, tally: settled.tally });
    return { room: withRoom(room, { vote: settled }, now), events, creditGranted: false, selectedPuzzleId: best };
  }

  // 额度降级投票
  let yes = 0; let no = 0;
  for (const [, choice] of Object.entries(vote.ballots)) {
    if (choice === 'yes') yes++;
    else if (choice === 'no') no++;
  }
  const abstain = Math.max(0, denom.length - yes - no);
  const tally = { yes, no, abstain };
  const passed = !invalid && yes > denom.length / 2;
  const status = passed ? 'passed' : 'rejected';
  const result = invalid
    ? `投票无效：有效投票人不足 ${PLATFORM.voteMinEligible} 人`
    : passed
      ? `通过（${yes} 赞成 / ${no} 反对 / ${abstain} 弃权）`
      : `未通过（${yes} 赞成 / ${no} 反对 / ${abstain} 弃权）`;
  const settled: CoreVote = { ...vote, status, result, tally };
  events.push({ type: 'vote_settled', voteId: vote.id, status, result, tally });
  return { room: withRoom(room, { vote: settled }, now), events, creditGranted: passed, selectedPuzzleId: null };
}

/** 有人做了有效处理（例如房主更新了 Key）时，投票立即作废（《阶段4》§8.2）。 */
export function voidVoteByHostAction(room: CoreRoom, now: number): { room: CoreRoom; events: DomainEvent[] } {
  const vote = room.vote;
  if (!vote || vote.status !== 'open') return { room, events: [] };
  const settled: CoreVote = { ...vote, status: 'rejected', result: '房主已完成处理，投票作废' };
  return {
    room: withRoom(room, { vote: settled }, now),
    events: [{ type: 'vote_settled', voteId: vote.id, status: 'rejected', result: settled.result ?? '', tally: vote.tally }],
  };
}

export { isPlaying };
