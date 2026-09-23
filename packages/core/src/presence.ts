/**
 * 成员状态判定：**两条完全独立的判定线**（《阶段3》§3.2）。
 *
 *  判定线 A（成员状态，分钟级）：activity（active/idle）与 conn（connected/disconnected）
 *      依据：阈值内是否有活动上报 / 是否有心跳。客户端不能声明自己的状态，只能上报原始信号。
 *  判定线 B（回合结果，秒级）：由 turn.ts 负责。
 *
 *  硬约束：A 的变更不修改 turn；B 的结果不修改 A。
 *  唯一例外：**全员**进入 idle/disconnected 时房间级暂停（由本文件处理）。
 */
import type { CoreRoom, DomainEvent } from './types.ts';
import { PLATFORM } from './constants.ts';
import { anyActive, allDisconnected, patchMember, withRoom } from './room.ts';

export interface PresenceTickResult {
  room: CoreRoom;
  events: DomainEvent[];
}

/** 单次扫描：活动线 + 断连线，互不影响；随后处理房间级暂停/恢复。 */
export function presenceTick(room: CoreRoom, now: number): PresenceTickResult {
  let next = room;
  const events: DomainEvent[] = [];

  for (const m of room.members) {
    // ---- 判定线 A-1：挂机（只看活动信号）----
    const limit = (m.hidden ? PLATFORM.hiddenIdleSec : PLATFORM.idleSec) * 1000;
    const wantActivity = now - m.lastActivityAt >= limit ? 'idle' : 'active';
    if (m.activity !== wantActivity) {
      next = patchMember(next, m.id, { activity: wantActivity }, now);
      events.push({ type: 'member_state_changed', memberId: m.id, line: 'activity', from: m.activity, to: wantActivity });
    }
    // ---- 判定线 A-2：断连（只看心跳）----
    const wantConn = now - m.lastHeartbeatAt >= PLATFORM.disconnectSec * 1000 ? 'disconnected' : 'connected';
    if (m.conn !== wantConn) {
      next = patchMember(next, m.id, { conn: wantConn }, now);
      events.push({ type: 'member_state_changed', memberId: m.id, line: 'conn', from: m.conn, to: wantConn });
    }
  }

  // ---- 房间级：全员挂起 / 全员断连 → 暂停；有人活跃 → 恢复 ----
  if (next.status === 'playing' && !anyActive(next)) {
    const reason = allDisconnected(next) ? 'all_disconnected' : 'all_idle';
    next = withRoom(next, { status: 'suspended', pauseReason: reason }, now);
    events.push({ type: 'room_paused', reason });
  } else if (next.status === 'suspended' && next.pauseReason !== 'ai_blocked' && next.pauseReason !== 'waiting_host_return'
             && next.pauseReason !== 'transfer_cooldown' && anyActive(next)) {
    next = withRoom(next, { status: 'playing', pauseReason: null }, now);
    events.push({ type: 'room_resumed' });
  }

  return { room: next, events };
}

/** 成员上报活动（任意交互）：刷新活动与心跳时间戳。 */
export function reportActivity(room: CoreRoom, memberId: string, now: number, hidden = false): CoreRoom {
  const m = room.members.find((x) => x.id === memberId);
  if (!m) return room;
  return patchMember(room, memberId, { lastActivityAt: now, lastHeartbeatAt: now, activity: 'active', hidden }, now);
}

/** 心跳（只刷新连接线，不影响活动线）。 */
export function reportHeartbeat(room: CoreRoom, memberId: string, now: number, hidden = false): CoreRoom {
  const m = room.members.find((x) => x.id === memberId);
  if (!m) return room;
  const patch: Record<string, unknown> = { lastHeartbeatAt: now, hidden };
  if (m.conn === 'disconnected') patch.conn = 'connected';
  return patchMember(room, memberId, patch, now);
}

/** 连接状态变化（断线/重连）。 */
export function setConn(room: CoreRoom, memberId: string, conn: 'connected' | 'disconnected', now: number): PresenceTickResult {
  const m = room.members.find((x) => x.id === memberId);
  if (!m) return { room, events: [] };
  const events: DomainEvent[] = [];
  // 断线时不刷新心跳时间戳，而是把它置为"已过期"：
  // 这样"是否连接"始终可以由时间推导（否则下一次扫描会立刻把状态改回 connected）。
  const patch: Record<string, unknown> = conn === 'connected'
    ? { conn, lastHeartbeatAt: now, lastActivityAt: now, activity: 'active' }
    : { conn, lastHeartbeatAt: now - PLATFORM.disconnectSec * 1000 - 1 };
  const next = patchMember(room, memberId, patch, now);
  events.push({ type: 'member_state_changed', memberId, line: 'conn', from: m.conn, to: conn });
  return { room: next, events };
}
