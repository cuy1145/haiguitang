/**
 * 房间生命周期判据（纯函数）单测。
 *
 * 关注点只有一个：**区分"房间没人了"和"只是没人操作"**。
 *  · updatedAt 只在状态变化时刷新（提问、回合推进、投票…）；
 *  · 心跳（20 秒一次）代表"这一端还开着页面"。
 * 只看前者会把"开着页面在思考/挂着"的房间一起收走，所以 isRoomAbandoned 要求两者都过期。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRoomAbandoned, lastHeartbeatAt, PLATFORM } from '../../packages/core/src/index.ts';

const TTL = PLATFORM.roomDestroySec * 1000;
const NOW = 1_700_000_000_000;

/** 只需要 updatedAt 与 members[].lastHeartbeatAt，其余字段与判据无关 */
function roomAt(updatedAt: number, heartbeats: number[]): Parameters<typeof isRoomAbandoned>[0] {
  return { updatedAt, members: heartbeats.map((h, i) => ({ id: `m${i}`, lastHeartbeatAt: h })) } as never;
}

test('生命周期：状态变化 + 心跳**都**过期才算没人了', () => {
  // ① 刚刚有过状态变化 → 绝对不动
  assert.equal(isRoomAbandoned(roomAt(NOW - 1000, [NOW - 1000]), NOW, TTL), false);
  // ② 状态变化很久以前，但**还有人开着页面**（心跳是新的）→ 不能收（这是本次改动最关键的一条）
  assert.equal(isRoomAbandoned(roomAt(NOW - TTL - 1, [NOW - 5_000]), NOW, TTL), false);
  // ③ 状态变化很久 + 心跳也很久（网页关了）→ 到点回收
  assert.equal(isRoomAbandoned(roomAt(NOW - TTL - 1, [NOW - TTL - 1]), NOW, TTL), true);
  // ④ 从没发过心跳（异常残留）→ 按 updatedAt 判
  assert.equal(isRoomAbandoned(roomAt(NOW - TTL - 1, [0]), NOW, TTL), true);
  assert.equal(isRoomAbandoned(roomAt(NOW - 60_000, [0]), NOW, TTL), false);
  // ⑤ 只要**有一个**成员心跳是新的，房间就留着（一个人还看着就该留）
  assert.equal(isRoomAbandoned(roomAt(NOW - TTL - 1, [NOW - TTL - 1, NOW - 1_000]), NOW, TTL), false);
  // ⑥ 边界：正好等于 ttl 不算过期（<=）
  assert.equal(isRoomAbandoned(roomAt(NOW - TTL, [NOW - TTL]), NOW, TTL), false);
});

test('生命周期：TLL 取 6 小时（够跨一夜的散场，又不至于留到第二天）', () => {
  assert.equal(PLATFORM.roomDestroySec, 6 * 3600);
  assert.equal(PLATFORM.roomWaitExpireSec, 6 * 3600);
});

test('生命周期：lastHeartbeatAt 取所有成员里最新的一次', () => {
  assert.equal(lastHeartbeatAt({ members: [{ lastHeartbeatAt: 10 }, { lastHeartbeatAt: 99 }, { lastHeartbeatAt: 5 }] } as never), 99);
  assert.equal(lastHeartbeatAt({ members: [] } as never), 0);
});
