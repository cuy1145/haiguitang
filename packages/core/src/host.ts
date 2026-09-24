/**
 * 房主移交规则（《阶段4》§6）。
 *
 * 触发条件（严格）：**仅当房主明确断连**且超过宽限。房主仅挂机（仍连接）**不触发移交**。
 * 顺序：成员按加入时间升序的环形序列，自原房主之后顺位查找"在线且活跃"者。
 * 无候选：房间暂停等待房主回来（**Key 不挂起、额度不变**）。
 *
 * 移交时：当前回合作废、额度来源切换（原因 = 所有权不可转移，而非调用失败）。
 */
import type { CoreRoom, DomainEvent, ReduceCtx } from './types.ts';
import { PLATFORM } from './constants.ts';
import { getMember, membersByJoin, withRoom } from './room.ts';
import { startTurn } from './turn.ts';

export function markSuspect(room: CoreRoom, now: number): CoreRoom {
  if (room.transfer.state !== 'idle' || !room.hostId) return room;
  return withRoom(room, {
    transfer: { ...room.transfer, state: 'suspect', suspectAt: now, fromId: room.hostId },
  }, now);
}

/** 是否满足移交条件（断连 + 宽限 + 冷却 + 次数上限）。 */
export type TransferGate =
  | { ok: true }
  | { ok: false; reason: 'host_connected' | 'grace_not_elapsed' | 'cooldown' | 'max_reached' | 'not_suspect' };

export function transferGate(room: CoreRoom, now: number): TransferGate {
  if (room.transfer.state !== 'suspect') return { ok: false, reason: 'not_suspect' };
  const host = getMember(room, room.hostId);
  if (!host) return { ok: false, reason: 'not_suspect' };
  if (host.conn !== 'disconnected') return { ok: false, reason: 'host_connected' };
  if (now - room.transfer.suspectAt < PLATFORM.hostTransferGraceSec * 1000) return { ok: false, reason: 'grace_not_elapsed' };
  if (now < room.transfer.cooldownUntil) return { ok: false, reason: 'cooldown' };
  if (room.transfer.count >= PLATFORM.maxTransfersPerMatch) return { ok: false, reason: 'max_reached' };
  return { ok: true };
}

/** 顺位选新房主：加入顺序环形，跳过挂机/断连者与"心跳已过期"的成员。 */
export function pickNewHost(room: CoreRoom, now: number): string | null {
  // 旁观者与**待入席**者都不能接盘：刚进房还在排队的人对局局一无所知，
  // 把房主位交给他是最糟的选择（他们本来就都是 spectator 角色，这里显式写出意图）。
  const ring = membersByJoin(room).filter((m) => m.role !== 'spectator' && !m.pendingSeat);
  if (ring.length === 0) return null;
  const startIdx = Math.max(0, ring.findIndex((m) => m.id === room.hostId));
  for (let step = 1; step <= ring.length; step++) {
    const cand = ring[(startIdx + step) % ring.length];
    if (!cand || cand.id === room.hostId) continue;
    if (cand.conn !== 'connected' || cand.activity !== 'active') continue;
    // 心跳已过期说明他实际上已经掉线（存在性由服务端时间推导，客户端无法声明）
    if (now - cand.lastHeartbeatAt > PLATFORM.disconnectSec * 1000) continue;
    return cand.id;
  }
  return null;
}

export interface HostTransferResult {
  room: CoreRoom;
  events: DomainEvent[];
  /** 服务端据此挂起原房主 Key（核心域不接触密钥） */
  suspendedKeyOwnerId: string | null;
}

export function transferHost(room: CoreRoom, toId: string, ctx: ReduceCtx): HostTransferResult {
  const fromId = room.hostId;
  if (!fromId) return { room, events: [], suspendedKeyOwnerId: null };
  const voided = room.turn.phase === 'ACTIVE' || room.turn.phase === 'GRACE' || room.turn.phase === 'JUDGING';
  const members = room.members.map((m) => {
    if (m.id === fromId) return { ...m, role: 'member' as const };
    if (m.id === toId) return { ...m, role: 'host' as const };
    return m;
  });
  const next = withRoom(room, {
    hostId: toId,
    members,
    credit: { mode: 'site_fallback', reason: 'HOST_TRANSFERRED', grantLeft: room.credit.grantLeft, grantId: room.credit.grantId },
    transfer: {
      state: 'paused_for_resume',
      suspectAt: room.transfer.suspectAt,
      fromId,
      toId,
      count: room.transfer.count + 1,
      cooldownUntil: ctx.now + PLATFORM.transferCooldownSec * 1000,
    },
    turn: voided
      ? { ...room.turn, phase: 'PAUSED', outcome: 'voided_transfer' }
      : room.turn,
  }, ctx.now);
  const events: DomainEvent[] = [
    { type: 'host_transfer', from: fromId, to: toId, voidedTurnSeq: voided ? room.turn.seq : null },
    { type: 'credit_switch', from: 'host_key', to: 'site_fallback', reason: 'HOST_TRANSFERRED', auto: true },
  ];
  return { room: next, events, suspendedKeyOwnerId: fromId };
}

/** 无候选：暂停等待房主回来（Key 不挂起、额度不变）。 */
export function transferWaiting(room: CoreRoom, now: number): { room: CoreRoom; events: DomainEvent[] } {
  const next = withRoom(room, {
    status: 'suspended',
    pauseReason: 'waiting_host_return',
    transfer: { ...room.transfer, state: 'waiting_host', toId: null },
  }, now);
  return { room: next, events: [{ type: 'host_transfer_waiting' }] };
}

/** 新房主点击「继续对局」：从被作废回合的下一位开始，给完整时长。 */
export function resumeAfterTransfer(room: CoreRoom, ctx: ReduceCtx): { room: CoreRoom; events: DomainEvent[] } {
  if (room.transfer.state !== 'paused_for_resume') return { room, events: [] };
  const next = withRoom(room, {
    transfer: { ...room.transfer, state: 'idle', fromId: null, toId: null },
    status: 'playing',
    pauseReason: null,
    turnIndex: (room.turnIndex + 1) % Math.max(1, room.turnOrder.length),
  }, ctx.now);
  const started = startTurn(next, ctx);
  return { room: started.room, events: started.events };
}

/** 房主在移交宽限内重连 → 取消移交（身份与额度都不变）。 */
export function cancelSuspect(room: CoreRoom, now: number): CoreRoom {
  if (room.transfer.state !== 'suspect') return room;
  return withRoom(room, {
    transfer: { ...room.transfer, state: 'idle', suspectAt: 0, fromId: null },
  }, now);
}

/** 归还房主位：身份回到原房主；额度来源等待其决定是否重新启用自备 Key。 */
export function returnHost(room: CoreRoom, formerHostId: string, now: number): { room: CoreRoom; events: DomainEvent[] } {
  const current = getMember(room, room.hostId);
  const former = getMember(room, formerHostId);
  if (!former) return { room, events: [] };
  const members = room.members.map((m) => {
    if (m.id === formerHostId) return { ...m, role: 'host' as const };
    if (current && m.id === current.id) return { ...m, role: 'member' as const };
    return m;
  });
  const next = withRoom(room, {
    hostId: formerHostId,
    members,
    credit: { mode: 'site_fallback', reason: 'HOST_RETURNED', grantLeft: room.credit.grantLeft, grantId: room.credit.grantId },
  }, now);
  return {
    room: next,
    events: [{ type: 'credit_switch', from: room.credit.mode, to: 'site_fallback', reason: 'HOST_RETURNED', auto: false }],
  };
}
