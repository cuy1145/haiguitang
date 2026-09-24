/**
 * 平台级常量与对局预设。
 *
 * 单一来源原则（《阶段5》§7）：M0 原型、服务端、测试脚本都从这里取阈值，
 * 任何一处硬编码副本都会造成"两版行为漂移"。
 *
 * 注意：本文件里的 PLATFORM 阈值属于**平台级**，房主不可调
 *      （否则房主可以把挂机阈值调到 1 秒来跳过别人、剥夺其投票权）。
 */
import type { GameConfig } from './types.ts';

export const PLATFORM = {
  /**
   * 挂机判定：前台无活动。
   * 10 分钟：玩家"在想问题/看记录"时不该被判成挂机（客户端只在真实交互时上报活动，
   * 所以阈值必须给得足够宽），真走了的人由房主「跳过本轮」处理。
   */
  idleSec: 600,
  /** 挂机判定：后台标签页（切出去查资料/接电话很常见，给到 30 分钟） */
  hiddenIdleSec: 1800,
  /**
   * 断连判定：连接层心跳缺失。
   * ⚠️ 手机锁屏、后台标签页的定时器会被系统节流，60 秒太容易误判成"离线"——
   * 曾出现"切出去一分钟回来发现自己掉线了"。给到 3 分钟，仍然远快于挂机判定。
   */
  disconnectSec: 180,
  heartbeatSec: 20,
  /** 房主响应性：无响应多久后触发自动投票降级 */
  hostUnresponsiveSec: 180,
  /** 房主断连后进入移交的宽限 */
  hostTransferGraceSec: 30,
  /** 刚重连/刚加入的成员在该时间内不作为房主候选 */
  hostCandidateMinAgeSec: 60,
  /** 两次移交之间的冷却 */
  transferCooldownSec: 300,
  /** 每局最多自动移交次数 */
  maxTransfersPerMatch: 3,
  /** 房主手动跳过每局次数上限 */
  hostSkipMaxPerMatch: 3,
  /** 断连席位回收 */
  seatReclaimSec: 1800,
  /** 投票：最少有效人数、时长（选题投票另用 config.voteDurationSec） */
  voteMinEligible: 2,
  fallbackVoteDurationSec: 60,
  /** 提问文本长度上限（与《阶段2》§2.2 的输入上限一致） */
  questionMaxLen: 200,
  questionMinLen: 2,
  /** 推理文本长度上限 */
  guessMaxLen: 500,
  guessMinLen: 4,
  /**
   * 「待入席」排队上限：对局进行中进房的人先排队（不占轮转、不占玩家位），
   * 超过这个数就只能纯旁观，避免有人拿排队占位。
   */
  midJoinPendingMax: 3,
  /** 全员讨论区：单条消息长度上限 */
  chatMaxLen: 500,
  /** 讨论限流：10 秒内最多 5 条、60 秒内最多 30 条（独立于提问与心跳） */
  chatPer10s: 5,
  chatPer60s: 30,
  /** 判定单次超时（毫秒） */
  judgeTimeoutMs: 20000,
  /** 事件环形缓冲条数（超出后客户端需全量快照） */
  eventBufferSize: 500,
  /** 队列任务超时（超过即记 audit 并继续，避免死锁） */
  queueTaskTimeoutMs: 3000,
  /** 房间生命周期 */
  roomWaitExpireSec: 6 * 3600,
  roomIdleSec: 2 * 3600,
  roomDestroySec: 24 * 3600,
  roomSuspendedDowngradeSec: 30 * 60,
} as const;

/** 对局预设（《阶段3》§5.2）。预设只是初始值，套用后仍可逐项修改。 */
export const PRESETS: Record<'quick' | 'standard' | 'casual', GameConfig> = {
  quick: {
    perTurnSec: 30, graceSec: 3, timeoutSkip: true,
    guessEveryRounds: 2, guessMaxPerMember: 0, guessCooldownSec: 90,
    midJoinPolicy: 'seated_next_round', maxPendingSeats: 3,
    hintsEnabled: false,
    hintQuotaPerMember: 3, hintTier3Max: 1, hintCooldownSec: 60,
    maxRounds: 15, turnOrderMode: 'join', idleSkip: true,
    ratingMax: 'L3', difficultyMin: 1, difficultyMax: 5,
    candidateCount: 2, voteDurationSec: 60, allowSpectator: true,
    preset: 'quick',
  },
  standard: {
    perTurnSec: 60, graceSec: 5, timeoutSkip: true,
    guessEveryRounds: 3, guessMaxPerMember: 0, guessCooldownSec: 180,
    midJoinPolicy: 'seated_next_round', maxPendingSeats: 3,
    hintsEnabled: false,
    hintQuotaPerMember: 3, hintTier3Max: 1, hintCooldownSec: 120,
    maxRounds: 20, turnOrderMode: 'join', idleSkip: true,
    ratingMax: 'L3', difficultyMin: 1, difficultyMax: 5,
    candidateCount: 2, voteDurationSec: 120, allowSpectator: true,
    preset: 'standard',
  },
  casual: {
    perTurnSec: 120, graceSec: 10, timeoutSkip: true,
    guessEveryRounds: 5, guessMaxPerMember: 0, guessCooldownSec: 300,
    midJoinPolicy: 'seated_next_round', maxPendingSeats: 3,
    hintsEnabled: false,
    hintQuotaPerMember: 5, hintTier3Max: 2, hintCooldownSec: 240,
    maxRounds: 30, turnOrderMode: 'join', idleSkip: false,
    ratingMax: 'L3', difficultyMin: 1, difficultyMax: 5,
    candidateCount: 2, voteDurationSec: 180, allowSpectator: true,
    preset: 'casual',
  },
};

/** 参数的字段规格（服务端校验、前端表单、文档三处共用同一份）。 */
export interface ConfigFieldSpec {
  key: keyof GameConfig;
  label: string;
  type: 'int' | 'bool' | 'enum';
  min?: number;
  max?: number;
  values?: readonly (string | number)[];
  /** 开局后是否允许修改 */
  afterStart: 'free' | 'increase-only' | 'locked';
  /** 生效时机 */
  effective: 'next-turn' | 'next-round' | 'next-match' | 'immediate';
}

export const CONFIG_SCHEMA: readonly ConfigFieldSpec[] = [
  { key: 'perTurnSec', label: '每人提问时长（秒）', type: 'int', min: 15, max: 600, afterStart: 'free', effective: 'next-turn' },
  { key: 'graceSec', label: '超时宽限期（秒）', type: 'int', min: 0, max: 30, afterStart: 'free', effective: 'next-turn' },
  { key: 'timeoutSkip', label: '超时自动跳过', type: 'bool', afterStart: 'free', effective: 'next-turn' },
  { key: 'guessEveryRounds', label: '揭秘间隔（每 N 轮）', type: 'int', min: 1, max: 10, afterStart: 'free', effective: 'next-round' },
  // 共用冷却才是猜汤底的节奏控制器；每人上限默认 0=不限（房主想要防刷可自己调大）
  { key: 'guessCooldownSec', label: '猜汤底共用冷却（秒，0=不限）', type: 'int', min: 0, max: 1800, afterStart: 'free', effective: 'immediate' },
  { key: 'guessMaxPerMember', label: '每人猜汤底次数上限（0=不限）', type: 'int', min: 0, max: 20, afterStart: 'increase-only', effective: 'immediate' },
  { key: 'midJoinPolicy', label: '对局中进房的人怎么处理', type: 'enum', values: ['seated_next_round', 'spectator_only', 'reject'], afterStart: 'free', effective: 'immediate' },
  { key: 'maxPendingSeats', label: '待入席排队上限', type: 'int', min: 0, max: 10, afterStart: 'free', effective: 'immediate' },
  { key: 'hintsEnabled', label: '启用提示（默认关闭）', type: 'bool', afterStart: 'free', effective: 'immediate' },
  { key: 'hintQuotaPerMember', label: '每人提示次数（T1+T2）', type: 'int', min: 0, max: 10, afterStart: 'increase-only', effective: 'immediate' },
  { key: 'hintTier3Max', label: 'T3 关键提示（每局共享）', type: 'int', min: 0, max: 3, afterStart: 'increase-only', effective: 'immediate' },
  { key: 'hintCooldownSec', label: '提示冷却（秒）', type: 'int', min: 0, max: 600, afterStart: 'free', effective: 'immediate' },
  { key: 'maxRounds', label: '总回合上限（轮）', type: 'int', min: 1, max: 60, afterStart: 'increase-only', effective: 'next-round' },
  { key: 'turnOrderMode', label: '回合顺序', type: 'enum', values: ['join', 'random'], afterStart: 'free', effective: 'next-match' },
  { key: 'idleSkip', label: '跳过挂机成员的回合', type: 'bool', afterStart: 'free', effective: 'next-turn' },
  { key: 'ratingMax', label: '内容分级上限', type: 'enum', values: ['L1', 'L2', 'L3'], afterStart: 'free', effective: 'next-match' },
  { key: 'difficultyMin', label: '难度下限', type: 'int', min: 1, max: 5, afterStart: 'free', effective: 'next-match' },
  { key: 'difficultyMax', label: '难度上限', type: 'int', min: 1, max: 5, afterStart: 'free', effective: 'next-match' },
  { key: 'candidateCount', label: '候选题数量', type: 'int', min: 1, max: 5, afterStart: 'locked', effective: 'next-match' },
  { key: 'voteDurationSec', label: '选题投票时长（秒）', type: 'int', min: 30, max: 600, afterStart: 'locked', effective: 'next-match' },
  { key: 'allowSpectator', label: '允许旁观', type: 'bool', afterStart: 'free', effective: 'immediate' },
];

export const DEFAULT_CONFIG: GameConfig = { ...PRESETS.standard };

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 2;
export const MAX_SPECTATORS = 10;
