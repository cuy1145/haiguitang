/**
 * DTO 白名单投影 —— 汤底与密钥的**唯一出口约束**（《阶段1》§4.8、《阶段2》§2.2）。
 *
 * 规则：
 *  - 任何发往客户端的数据必须经过本文件；
 *  - Projection 类型里**不存在** truth / facts / credential 字段，因此"忘记删字段"在类型层就不可能；
 *  - 服务端在发送前再用 assertNoLeak() 做一次运行时兜底断言（防手写对象绕过投影）。
 *
 * 汤底的唯一出口是复盘接口（且必须满足 settled + 已揭晓 + 参与者三个条件），
 * 由服务端在 recap 处显式注入，不经过本文件的 toPublic* 系列。
 */
import type {
  CoreMember, CoreRoom, CoreVote, GameConfig, Puzzle, PuzzleMeta,
} from './types.ts';
import { PLATFORM } from './constants.ts';

export interface PublicPuzzle extends PuzzleMeta {
  attribution: { author: string; url: string } | null;
}

export interface PublicMember {
  id: string;
  name: string;
  role: CoreMember['role'];
  isBot: boolean;
  joinSeq: number;
  conn: CoreMember['conn'];
  activity: CoreMember['activity'];
  stateLabel: '在线' | '挂机' | '离线';
  skipStreak: number;
  score: number;
  hasKey: boolean;
  keyMask: string | null;
  keyState: 'none' | 'active' | 'suspended' | 'destroyed';
  formerHost: boolean;
  isHost: boolean;
}

export interface PublicTurn {
  seq: number;
  memberId: string | null;
  phase: CoreRoom['turn']['phase'];
  deadlineAt: number;
  graceDeadlineAt: number;
  outcome: CoreRoom['turn']['outcome'];
  lateSubmit: boolean;
}

export interface PublicVote {
  id: string;
  type: CoreVote['type'];
  status: CoreVote['status'];
  deadlineAt: number;
  votedCount: number;
  eligibleCount: number;
  /** 选题投票：候选（全部为脱敏投影） */
  candidates?: PublicPuzzle[];
  /** 票数分布只在结算后公布（防从众） */
  tally?: CoreVote['tally'];
  result?: string;
  myBallot: string | null;
}

export interface PublicRoom {
  id: string;
  code: string;
  status: CoreRoom['status'];
  pauseReason: string | null;
  hostId: string | null;
  config: GameConfig;
  configVersion: number;
  stateVersion: number;
  eventSeq: number;
  serverTime: number;
  roundNo: number;
  turn: PublicTurn;
  members: PublicMember[];
  puzzle: PublicPuzzle | null;
  vote: PublicVote | null;
  ai: CoreRoom['ai'];
  credit: { mode: CoreRoom['credit']['mode']; reason: CoreRoom['credit']['reason']; grantLeft: number };
  transfer: { state: CoreRoom['transfer']['state']; fromId: string | null; toId: string | null };
  result: CoreRoom['result'];
  canRevealTruth: boolean;
  revealedFacts: string[];
}

export function toPublicPuzzle(p: Puzzle): PublicPuzzle {
  return {
    id: p.id,
    title: p.title,
    surface: p.surface,
    difficulty: p.difficulty,
    rating: p.rating,
    tags: [...p.tags],
    sensitiveTags: [...p.sensitiveTags],
    estMinutes: p.estMinutes,
    sourceType: p.sourceType,
    attributionRequired: p.attributionRequired,
    ...(p.sourceAuthor ? { sourceAuthor: p.sourceAuthor } : {}),
    ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
    attribution: p.attributionRequired
      ? { author: p.sourceAuthor ?? '佚名', url: p.sourceUrl ?? '' }
      : null,
  };
}

export interface MemberKeyState {
  hasKey: boolean;
  keyMask: string | null;
  keyState: PublicMember['keyState'];
  formerHost: boolean;
}

export function toPublicMember(m: CoreMember, key: MemberKeyState, hostId: string | null): PublicMember {
  const stateLabel = m.conn === 'disconnected' ? '离线' : m.activity === 'idle' ? '挂机' : '在线';
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    isBot: m.isBot,
    joinSeq: m.joinSeq,
    conn: m.conn,
    activity: m.activity,
    stateLabel,
    skipStreak: m.skipStreak,
    score: m.score,
    hasKey: key.hasKey,
    keyMask: key.keyMask,
    keyState: key.keyState,
    formerHost: key.formerHost,
    isHost: m.id === hostId,
  };
}

export function toPublicVote(
  vote: CoreVote | null,
  viewerId: string,
  candidates: PublicPuzzle[],
): PublicVote | null {
  if (!vote) return null;
  const settled = vote.status !== 'open';
  return {
    id: vote.id,
    type: vote.type,
    status: vote.status,
    deadlineAt: vote.deadlineAt,
    votedCount: Object.keys(vote.ballots).length,
    eligibleCount: vote.eligibleAtOpen.length,
    ...(vote.type === 'puzzle_choice' ? { candidates } : {}),
    ...(settled && vote.tally ? { tally: vote.tally } : {}),
    ...(vote.result ? { result: vote.result } : {}),
    myBallot: vote.ballots[viewerId] ?? null,
  };
}

export interface RoomViewDeps {
  serverTime: number;
  puzzle: Puzzle | null;
  /** 候选题（只在选题投票期间提供，仍为脱敏投影） */
  candidates: Puzzle[];
  keyOf: (memberId: string) => MemberKeyState;
}

export function toPublicRoom(room: CoreRoom, viewerId: string, deps: RoomViewDeps): PublicRoom {
  const canReveal = room.status === 'settled'
    && room.result !== null
    && room.result.result !== 'aborted';
  return {
    id: room.id,
    code: room.code,
    status: room.status,
    pauseReason: room.pauseReason,
    hostId: room.hostId,
    config: { ...room.config },
    configVersion: room.configVersion,
    stateVersion: room.stateVersion,
    eventSeq: room.eventSeq,
    serverTime: deps.serverTime,
    roundNo: room.roundNo,
    turn: {
      seq: room.turn.seq,
      memberId: room.turn.memberId,
      phase: room.turn.phase,
      deadlineAt: room.turn.deadlineAt,
      graceDeadlineAt: room.turn.graceDeadlineAt,
      outcome: room.turn.outcome,
      lateSubmit: room.turn.lateSubmit,
    },
    members: room.members.map((m) => toPublicMember(m, deps.keyOf(m.id), room.hostId)),
    puzzle: deps.puzzle ? toPublicPuzzle(deps.puzzle) : null,
    vote: toPublicVote(room.vote, viewerId, deps.candidates.map(toPublicPuzzle)),
    ai: { ...room.ai },
    credit: { mode: room.credit.mode, reason: room.credit.reason, grantLeft: room.credit.grantLeft },
    transfer: { state: room.transfer.state, fromId: room.transfer.fromId, toId: room.transfer.toId },
    result: room.result ? { ...room.result } : null,
    canRevealTruth: canReveal,
    revealedFacts: [...room.revealedFacts],
  };
}

/** 🔴 运行时兜底断言：payload 中不得出现汤底片段、事实点原文、密钥形态字符串。 */
export interface LeakAssertCtx {
  /** 🔴 汤底原文 */
  truth: string;
  facts: readonly { id: string; text: string }[];
  /**
   * 已经合法公开的文本（汤面）。汤面本身可能和某条事实点用词相同
   * （例如汤面就写了"制冷设备当时并没有启动"），这不算泄露；
   * 但只要 payload 里出现了**汤面之外的**事实点原文，就是缺陷。
   */
  publicText?: string;
  /** 已知的密钥明文（如有），用于断言"绝不出现" */
  secrets?: readonly string[];
}

export function assertNoLeak(payload: unknown, ctx: LeakAssertCtx): void {
  const json = JSON.stringify(payload ?? null);
  const publicText = ctx.publicText ?? '';
  const ng = (s: string, n: number): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
    return out;
  };
  const publicGrams = ng(publicText, 8);
  const truthGrams = ng(ctx.truth, 8);
  for (let i = 0; i + 8 <= json.length; i++) {
    const g = json.slice(i, i + 8);
    // 汤面里本来就出现的片段不算泄露
    if (truthGrams.has(g) && !publicGrams.has(g)) {
      throw new Error(`汤底泄露：payload 中出现与汤底共享的片段「${g}」`);
    }
  }
  for (const f of ctx.facts) {
    if (f.text.length < 6) continue;
    if (publicText.includes(f.text)) continue; // 该事实已由汤面合法公开
    if (json.includes(f.text)) {
      throw new Error(`事实点泄露：payload 中出现事实点 ${f.id} 的原文`);
    }
  }
  for (const s of ctx.secrets ?? []) {
    if (s.length >= 8 && json.includes(s)) {
      throw new Error('密钥泄露：payload 中出现密钥明文');
    }
  }
  if (/\bsk-[A-Za-z0-9_-]{8,}\b/.test(json)) {
    throw new Error('密钥泄露：payload 中出现疑似 API Key 形态的字符串');
  }
}

export { PLATFORM };
