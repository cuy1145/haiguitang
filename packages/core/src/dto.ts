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
  /** 开局前是否已举手「我准备好了」 */
  ready: boolean;
  /**
   * 「待入席」= 对局进行中进房、还在排队的人。他不占轮转、不占玩家位，
   * 界面上应单独分组显示（"待入席（下一轮上桌）"），不能与正式成员混在一起。
   */
  pendingSeat: boolean;
  /** 待入席成员是否已点「申请下一轮上桌」 */
  seatRequested: boolean;
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
  /** 本房间已经开始的局数（0 = 还没开过局）：讨论区分隔线用它（§12.8） */
  matchNo: number;
  turn: PublicTurn;
  members: PublicMember[];
  puzzle: PublicPuzzle | null;
  vote: PublicVote | null;
  ai: CoreRoom['ai'];
  credit: { mode: CoreRoom['credit']['mode']; reason: CoreRoom['credit']['reason']; grantLeft: number };
  transfer: { state: CoreRoom['transfer']['state']; fromId: string | null; toId: string | null };
  result: CoreRoom['result'];
  canRevealTruth: boolean;
  /**
   * **汤底公示**：只在对局被猜出（result.result === 'solved'）时才有值，人人可见。
   *
   * 这是"汤底永不下发"这条红线的**唯一例外**，并且是刻意设计的：谜底已经被玩家自己解开了，
   * 这时候藏着它只会让非房主玩家一脸茫然（以前只有房主能点复盘看汤底）。
   * 中止（aborted）与未解出（unsolved）一律为 null —— 防止"开局→立刻结束→读汤底"。
   */
  truth: string | null;
  /** 汤底公示时附带的说明（例如"本局由 阿伟 猜出"） */
  truthNote: string | null;
  /** 猜汤底共用冷却截止时间（0 = 现在可以猜）；前端据此显示倒计时 */
  guessCooldownUntil: number;
  /** 本局是否还能猜汤底（冷却已过 且 未超个人上限） */
  canGuess: boolean;
  revealedFacts: string[];
  /**
   * 本题事实点总数 / 其中"必需"条数 —— **只有计数，没有内容**。
   * 用于给玩家显示「线索 3/8 · 探索度 42%」这类进度反馈（事实点原文永不下发）。
   */
  factTotal: number;
  requiredFactTotal: number;
  /**
   * 准备状态汇总：`readyCount / readyEligible`。
   * 有资格的成员 = 非旁观且当前在线的成员（离线/旁观不阻塞开局）。
   */
  readyCount: number;
  readyEligible: number;
  /** 待入席人数（对局进行中进房排队的人，不占轮转与玩家位） */
  pendingSeatCount: number;
}

/**
 * 全员讨论区的一条消息（房间内自由聊天，不参与判定）。
 * 服务端只做长度/控制字符清洗与成员名补全，绝不会把汤底、事实点或密钥拼进来。
 */
export interface PublicChatMessage {
  id: string;
  /** 房间内单调递增；客户端用它做增量拉取游标 */
  chatSeq: number;
  memberId: string;
  memberName: string;
  text: string;
  /** 发送者的客户端消息 ID：前端据此去重（网络重试/乐观显示） */
  clientMessageId: string;
  /**
   * 发这条消息时房间已经开始的局数（0 = 还没开过局）。
   * 前端据此在局与局之间插一条「第 N 局开始」分隔线（设计稿 §12.8）。
   */
  matchNo: number;
  createdAt: number;
}

export function toPublicChat(
  m: { id: string; chatSeq: number; memberId: string; text: string; clientMessageId: string; matchNo?: number; createdAt: number },
  memberNameOf: (memberId: string) => string,
): PublicChatMessage {
  return {
    id: m.id,
    chatSeq: m.chatSeq,
    memberId: m.memberId,
    memberName: memberNameOf(m.memberId),
    text: m.text,
    clientMessageId: m.clientMessageId,
    matchNo: m.matchNo ?? 0,
    createdAt: m.createdAt,
  };
}

export function toPublicPuzzle(p: Puzzle): PublicPuzzle {  return {
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

export function toPublicMember(
  m: CoreMember,
  key: MemberKeyState,
  hostId: string | null,
  ready = false,
): PublicMember {
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
    ready,
    pendingSeat: m.pendingSeat === true,
    seatRequested: m.seatRequested === true,
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
  // 汤底公示：**只**在"被人猜出来"时出现，人人可见（中止/未解出都不给）
  const solved = room.status === 'settled' && room.result?.result === 'solved';
  const truth = solved && deps.puzzle ? deps.puzzle.truth.truth : null;
  const me = room.members.find((m) => m.id === viewerId);
  const onCooldown = room.guessCooldownUntil > deps.serverTime;
  const overQuota = room.config.guessMaxPerMember > 0 && (me?.guessesUsed ?? 0) >= room.config.guessMaxPerMember;
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
    matchNo: room.matchNo,
    turn: {
      seq: room.turn.seq,
      memberId: room.turn.memberId,
      phase: room.turn.phase,
      deadlineAt: room.turn.deadlineAt,
      graceDeadlineAt: room.turn.graceDeadlineAt,
      outcome: room.turn.outcome,
      lateSubmit: room.turn.lateSubmit,
    },
    members: room.members.map((m) => toPublicMember(m, deps.keyOf(m.id), room.hostId, room.ready.includes(m.id))),
    puzzle: deps.puzzle ? toPublicPuzzle(deps.puzzle) : null,
    vote: toPublicVote(room.vote, viewerId, deps.candidates.map(toPublicPuzzle)),
    ai: { ...room.ai },
    credit: { mode: room.credit.mode, reason: room.credit.reason, grantLeft: room.credit.grantLeft },
    transfer: { state: room.transfer.state, fromId: room.transfer.fromId, toId: room.transfer.toId },
    result: room.result ? { ...room.result } : null,
    canRevealTruth: canReveal,
    truth,
    truthNote: truth ? '本局已被玩家猜出：汤底对所有人公开' : null,
    guessCooldownUntil: room.guessCooldownUntil,
    canGuess: room.status === 'playing' && !onCooldown && !overQuota,
    revealedFacts: [...room.revealedFacts],
    // 计数（非内容）：探索度用"必需事实点"做分母，普通事实点做分子上限
    factTotal: deps.puzzle ? deps.puzzle.facts.length : 0,
    requiredFactTotal: deps.puzzle ? deps.puzzle.facts.filter((f) => f.required).length : 0,
    // 有资格者 = 非旁观、在线、且**不是房主**的成员（口径必须与 rooms.ts 的 readyEligible 一致）：
    // 离线和旁观不该把大家卡在开场前；房主本来就不需要给自己举手（M4）
    readyEligible: room.members.filter((m) => m.role !== 'spectator' && m.conn === 'connected' && m.id !== room.hostId).length,
    readyCount: room.members.filter((m) => m.role !== 'spectator' && m.conn === 'connected' && m.id !== room.hostId && room.ready.includes(m.id)).length,
    /** 待入席人数（对局进行中进房排队的人）；界面据此显示"待入席（下一轮上桌）"分组 */
    pendingSeatCount: room.members.filter((m) => m.pendingSeat === true).length,
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
  /**
   * 允许汤底出现：**只有**"对局已被猜出、走汤底公示"这一条路径可以传 true。
   * 其余任何投影都必须保持 false，否则这里会直接抛错（红线仍然是红线，只是多了一个显式出口）。
   */
  allowTruth?: boolean;
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
    if (!ctx.allowTruth && truthGrams.has(g) && !publicGrams.has(g)) {
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
