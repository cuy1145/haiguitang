/**
 * 房间状态的不可变更新原语。
 *
 * 所有状态变更都必须经过这里：`stateVersion` 在每次变更时 +1，
 * 用于（1）落库 CAS（2）客户端拒绝陈旧载荷（3）广播收敛。
 */
import type { CoreMember, CoreRoom } from './types.ts';

export function withRoom(room: CoreRoom, patch: Partial<CoreRoom>, now: number): CoreRoom {
  return { ...room, ...patch, stateVersion: room.stateVersion + 1, updatedAt: now };
}

export function patchMember(
  room: CoreRoom,
  memberId: string,
  patch: Partial<CoreMember>,
  now: number,
): CoreRoom {
  const members = room.members.map((m) => (m.id === memberId ? { ...m, ...patch } : m));
  return withRoom(room, { members }, now);
}

export function getMember(room: CoreRoom, memberId: string | null | undefined): CoreMember | undefined {
  if (!memberId) return undefined;
  return room.members.find((m) => m.id === memberId);
}

export function hostOf(room: CoreRoom): CoreMember | undefined {
  return getMember(room, room.hostId);
}

/** 成员按加入顺序（房主移交用的序列，与回合顺序是两个不同的序列）。 */
export function membersByJoin(room: CoreRoom): CoreMember[] {
  return [...room.members].sort((a, b) => a.joinSeq - b.joinSeq);
}

/** 有表决权 / 计入分母的成员：在线且活跃（旁观者不算）。 */
export function eligibleMembers(room: CoreRoom, now: number): CoreMember[] {
  void now;
  return room.members.filter((m) => m.role !== 'spectator' && m.conn === 'connected' && m.activity === 'active');
}

export function anyActive(room: CoreRoom): boolean {
  return room.members.some((m) => m.conn === 'connected' && m.activity === 'active');
}

export function allDisconnected(room: CoreRoom): boolean {
  return room.members.length > 0 && room.members.every((m) => m.conn === 'disconnected');
}

export function isPlaying(room: CoreRoom): boolean {
  return room.status === 'playing';
}

/** 最近一次成员心跳的时刻（没有任何成员发过心跳时为 0）。 */
export function lastHeartbeatAt(room: Pick<CoreRoom, 'members'>): number {
  return room.members.reduce((mx, m) => Math.max(mx, Number(m.lastHeartbeatAt || 0)), 0);
}

/**
 * 房间是不是"没人了"（可以销毁）：**既没有状态变化、也没有任何成员的心跳**，都超过 ttl。
 *
 * 为什么要带心跳这一条（只看 updatedAt 是不够的）：
 *  · `updatedAt` 只在**状态变化**时刷新（回合推进、提问、投票…），心跳本身不改房间状态；
 *  · 于是"开放页面但没人操作"的房间会和"浏览器已经关了"的房间长得一模一样，
 *    只按 updatedAt 回收就会把还有人看着的房间一起收走。
 * 心跳（20 秒一次）是"这一端还开着页面"的唯一可靠信号：
 *  有页面开着 → 一直有心跳 → 房间留着；网页关了 → 心跳停了 → 到点回收。
 * 这也正是"晚上玩完直接关网页、第二天早上不该还被拉回那个房间"要的行为。
 */
export function isRoomAbandoned(
  room: Pick<CoreRoom, 'updatedAt' | 'members'>,
  now: number,
  ttlMs: number,
): boolean {
  if (now - room.updatedAt <= ttlMs) return false;
  return now - lastHeartbeatAt(room) > ttlMs;
}

/** 参与者（非旁观）数量。 */
export function playerCount(room: CoreRoom): number {
  return room.members.filter((m) => m.role !== 'spectator').length;
}

/** 构造一个空白的房间状态（测试与建房共用）。 */
export function emptyRoom(id: string, code: string, config: CoreRoom['config'], now: number): CoreRoom {
  return {
    id, code,
    status: 'waiting',
    pauseReason: null,
    hostId: null,
    members: [],
    turnOrder: [],
    turnIndex: 0,
    roundNo: 1,
    matchNo: 0,
    turn: {
      seq: 0, memberId: null, phase: 'IDLE',
      startedAt: 0, deadlineAt: 0, graceDeadlineAt: 0, outcome: null, lateSubmit: false,
    },
    config,
    configVersion: 1,
    stateVersion: 0,
    eventSeq: 0,
    puzzleId: null,
    revealedFacts: [],
    ready: [],
    hint: { tier3Used: 0 },
    vote: null,
    ai: { state: 'OK', reasonCode: null, blockedAt: null },
    credit: { mode: 'host_key', reason: 'LOCKED_ACTIVE', grantLeft: 0, grantId: null },
    transfer: { state: 'idle', suspectAt: 0, fromId: null, toId: null, count: 0, cooldownUntil: 0 },
    guessCooldownUntil: 0,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}
