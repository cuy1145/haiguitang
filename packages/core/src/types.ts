/**
 * 核心域类型定义。
 *
 * 设计约束（对应《阶段1》§5 与《阶段5》§7）：
 *  - 本目录**零依赖、零 IO、无 window/process/fs/fetch**；时间、随机、id 一律由调用方注入。
 *  - 敏感字段（汤底、事实点原文、API Key）在类型上就与「可下发」类型分离：
 *    任何要发给客户端的东西都必须经过 dto.ts 的白名单投影，Projection 类型里不存在敏感字段。
 */

// ---------------------------------------------------------------- 基础枚举
export type AnswerEnum = 'yes' | 'no' | 'irrelevant' | 'unanswerable';

/** 判定原因码白名单（《阶段2》§3.2）。unanswerable 必须携带其中之一，且与输入特征一致。 */
export type ReasonCode =
  | 'NONE'
  | 'OUT_OF_SCOPE'
  | 'META_QUESTION'
  | 'LIST_REQUEST'
  | 'SUBJECTIVE'
  | 'COMPOUND_SPLIT_REQUIRED'
  | 'INSTRUCTION_INJECTION'
  | 'ENCODING_EVASION'
  | 'SPOILER_REQUEST';

export const ANSWER_ENUM: readonly AnswerEnum[] = ['yes', 'no', 'irrelevant', 'unanswerable'];
export const REASON_CODES: readonly ReasonCode[] = [
  'NONE', 'OUT_OF_SCOPE', 'META_QUESTION', 'LIST_REQUEST', 'SUBJECTIVE',
  'COMPOUND_SPLIT_REQUIRED', 'INSTRUCTION_INJECTION', 'ENCODING_EVASION', 'SPOILER_REQUEST',
];

/** 判定来源：缓存 / 规则拦截（未调用模型）/ 模型映射。 */
export type VerdictSource = 'cache' | 'rule' | 'model';

export type TurnPhase = 'IDLE' | 'ACTIVE' | 'GRACE' | 'JUDGING' | 'SETTLED' | 'SKIPPED' | 'PAUSED';
export type TurnOutcome =
  | 'answered'
  | 'skipped_timeout'
  | 'skipped_unavailable'
  | 'voided_transfer'
  | 'voided_restart'
  | null;
export type SkipReason = 'timeout' | 'disconnected' | 'idle' | 'left' | 'kicked' | 'voided_transfer';

export type ConnState = 'connected' | 'disconnected';
export type ActivityState = 'active' | 'idle';
export type MemberRole = 'host' | 'member' | 'spectator';

export type VoteType = 'puzzle_choice' | 'fallback_credit';
export type VoteStatus = 'open' | 'passed' | 'rejected';

export type CreditMode = 'host_key' | 'site_fallback' | 'none';

/** 额度来源原因码：只有这四种情形允许使用站点备用额度（《阶段4》§4）。 */
export type CreditReason =
  | 'LOCKED_ACTIVE'
  | 'HOST_RESTORED'
  | 'NEVER_CONFIGURED'
  | 'OWNER_REVOKED'
  | 'HOST_TRANSFERRED'
  | 'MEMBER_VOTE'
  | 'HOST_RETURNED'
  | 'SITE_QUOTA_EXHAUSTED'
  | 'GRANT_EXHAUSTED'
  | 'MATCH_ENDED';

export type AiState = 'OK' | 'DEGRADED' | 'BLOCKED' | 'GRANTED';
export type RoomStatus = 'waiting' | 'playing' | 'suspended' | 'settled' | 'destroyed';
export type MatchResult = 'solved' | 'unsolved' | 'aborted';

export type SubmitReject =
  | 'NOT_YOUR_TURN'
  | 'TURN_EXPIRED'
  | 'TURN_ALREADY_ANSWERED'
  | 'STALE_TURN'
  | 'TURN_VOIDED'
  | 'MATCH_NOT_ACTIVE'
  | 'MATCH_PAUSED'
  | 'TEXT_TOO_LONG'
  | 'TEXT_EMPTY'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED';

export type ActionReject =
  | SubmitReject
  | 'HINTS_DISABLED'
  | 'HINT_COOLDOWN'
  | 'HINT_QUOTA_EXHAUSTED'
  | 'HINT_TIER3_EXHAUSTED'
  | 'HINT_NO_FACT'
  | 'GUESS_NOT_IN_WINDOW'
  | 'GUESS_ATTEMPTS_EXHAUSTED'
  | 'GUESS_TOO_SHORT'
  | 'VOTE_NOT_ELIGIBLE'
  | 'VOTE_NOT_OPEN'
  | 'NOT_HOST'
  | 'NOT_ALLOWED';

// ---------------------------------------------------------------- 题库
/** 原子事实点（🔴 永不 下发）。isTrue 是判定结论的唯一权威来源。 */
export interface PuzzleFact {
  id: string;
  text: string;
  isTrue: boolean;
  /** 提示梯度：1 方向性 / 2 范围收窄 / 3 关键要素 */
  tier: 1 | 2 | 3;
  /** 揭秘命中所需的必要条件 */
  required: boolean;
  /** 是否允许被问答直接确认（结构性防御用；M1 默认全部允许，保留字段） */
  directQueryable?: boolean;
  /** 关键词表：仅本地模拟主持人使用，真实模型走语义映射 */
  keys?: string[];
}

export interface PuzzleTruth {
  truth: string;
  keyPoints?: string;
  redLines?: string[];
}

export interface PuzzleMeta {
  id: string;
  title: string;
  surface: string;
  difficulty: number;
  rating: 'L1' | 'L2' | 'L3';
  tags: string[];
  sensitiveTags: string[];
  estMinutes: number;
  sourceType: 'ai' | 'manual' | 'crawl';
  attributionRequired: boolean;
  sourceAuthor?: string;
  sourceUrl?: string;
}

export interface Puzzle extends PuzzleMeta {
  /** 🔴 汤底：只在复盘门禁通过后由服务端注入，不经过任何 DTO */
  truth: PuzzleTruth;
  facts: PuzzleFact[];
  reviewStatus: 'draft' | 'pending' | 'approved' | 'rejected' | 'delisted';
}

// ---------------------------------------------------------------- 对局参数
export interface GameConfig {
  perTurnSec: number;
  graceSec: number;
  timeoutSkip: boolean;
  guessEveryRounds: number;
  guessMaxPerMember: number;
  /** 提示系统总开关：默认关闭（房主可在对局参数里打开）。关闭时 requestHint 一律被拒。 */
  hintsEnabled: boolean;
  hintQuotaPerMember: number;
  hintTier3Max: number;
  hintCooldownSec: number;
  maxRounds: number;
  turnOrderMode: 'join' | 'random';
  idleSkip: boolean;
  ratingMax: 'L1' | 'L2' | 'L3';
  difficultyMin: number;
  difficultyMax: number;
  candidateCount: number;
  voteDurationSec: number;
  allowSpectator: boolean;
  preset?: string;
}

// ---------------------------------------------------------------- 房间状态
export interface CoreMember {
  id: string;
  playerId: string;
  name: string;
  isBot: boolean;
  role: MemberRole;
  joinSeq: number;
  conn: ConnState;
  activity: ActivityState;
  /** 页面是否可见（后台挂机阈值用） */
  hidden: boolean;
  lastActivityAt: number;
  lastHeartbeatAt: number;
  skipStreak: number;
  score: number;
  hintsUsedT12: number;
  hintsUsedT3: number;
  guessesUsed: number;
  lastHintAt: number;
}

export interface CoreTurn {
  /** 单调递增，本局内唯一（幂等键） */
  seq: number;
  memberId: string | null;
  phase: TurnPhase;
  startedAt: number;
  deadlineAt: number;
  graceDeadlineAt: number;
  outcome: TurnOutcome;
  lateSubmit: boolean;
}

export interface CoreVote {
  id: string;
  type: VoteType;
  /** 选题投票的候选题 id（只用于内部映射；下发给客户端的是脱敏投影） */
  puzzleIds: string[];
  ballots: Record<string, string>;
  eligibleAtOpen: string[];
  openedAt: number;
  deadlineAt: number;
  status: VoteStatus;
  result?: string;
  tally?: { yes: number; no: number; abstain: number; byOption?: Record<string, number> };
  tieBreakSeed?: number;
}

export interface CoreRoom {
  id: string;
  code: string;
  status: RoomStatus;
  pauseReason: string | null;
  hostId: string | null;
  members: CoreMember[];
  turnOrder: string[];
  turnIndex: number;
  roundNo: number;
  turn: CoreTurn;
  config: GameConfig;
  configVersion: number;
  stateVersion: number;
  eventSeq: number;
  puzzleId: string | null;
  /** 已被问答或提示释放的事实点 id */
  revealedFacts: string[];
  hint: { tier3Used: number };
  vote: CoreVote | null;
  ai: { state: AiState; reasonCode: string | null; blockedAt: number | null };
  credit: { mode: CreditMode; reason: CreditReason; grantLeft: number; grantId: string | null };
  transfer: {
    state: 'idle' | 'suspect' | 'paused_for_resume' | 'waiting_host';
    suspectAt: number;
    fromId: string | null;
    toId: string | null;
    count: number;
    cooldownUntil: number;
  };
  result: { result: MatchResult; reason: string } | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- 判定结果
export interface JudgeResult {
  answer: AnswerEnum;
  reasonCode: ReasonCode;
  matchedFactIds: string[];
  source: VerdictSource;
  /**
   * 「是 / 否」时**可选**的一句补充说明（≤ 30 字，由模型按需给出）。
   *
   * 定位：帮玩家理解这个"是/否"的**范围**，而不是给新信息。
   * 红线：不得引入汤底里没有的具体信息（人名、原因、结局），不得复述/改述汤底与事实点原文。
   * 只要过不了泄露检查，就整条丢掉、只留裸的"是/否"（宁缺勿滥，绝不冒险提示）。
   */
  explain?: string | null;
}

export interface GuessResult {
  verdict: 'hit' | 'partial' | 'miss';
  hits: number;
  total: number;
  contradictions: number;
}

// ---------------------------------------------------------------- 域事件
export type DomainEvent =
  | { type: 'turn_started'; turnSeq: number; memberId: string; phase: TurnPhase; deadlineAt: number }
  | { type: 'grace_started'; turnSeq: number; graceDeadlineAt: number }
  | { type: 'turn_skipped'; turnSeq: number; memberId: string; reason: SkipReason }
  | { type: 'turn_settled'; turnSeq: number; memberId: string; outcome: TurnOutcome }
  | { type: 'member_state_changed'; memberId: string; line: 'activity' | 'conn'; from: string; to: string }
  | { type: 'room_paused'; reason: string }
  | { type: 'room_resumed' }
  | { type: 'vote_opened'; voteId: string; voteType: VoteType; deadlineAt: number; eligible: string[] }
  | { type: 'vote_settled'; voteId: string; status: VoteStatus; result: string; tally: CoreVote['tally'] }
  | { type: 'credit_switch'; from: CreditMode; to: CreditMode; reason: CreditReason; auto: boolean }
  | { type: 'ai_blocked'; reasonCode: string }
  | { type: 'ai_recovered' }
  | { type: 'host_transfer'; from: string; to: string; voidedTurnSeq: number | null }
  | { type: 'host_transfer_waiting' }
  | { type: 'hint_granted'; memberId: string; tier: 1 | 2 | 3; factId: string }
  | { type: 'guess_result'; memberId: string; verdict: GuessResult['verdict']; hits: number; total: number }
  | { type: 'match_ended'; result: MatchResult; reason: string }
  | { type: 'rejected'; code: ActionReject; memberId: string | null; detail?: string };

/** reduce 的输出：新状态 + 需要广播/落库的域事件（事件本身不含敏感数据）。 */
export interface ReduceResult {
  room: CoreRoom;
  events: DomainEvent[];
}

/** 注入依赖：核心域不自己取时间与随机数（可测试、可回放）。 */
export interface ReduceCtx {
  now: number;
  rand: () => number;
  newId: (prefix: string) => string;
}
