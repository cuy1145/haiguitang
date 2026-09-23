/**
 * WebSocket 协议帧定义（服务端 ↔ 客户端）。
 *
 * 约定：
 *  - 服务端推给客户端的一切都必须经过 core/dto.ts 的白名单投影
 *  - 事件帧带 `seq`（房间内单调）与 `stateVersion`；客户端按 seq 排序、按版本拒绝陈旧载荷
 *  - 文案由服务端模板渲染（不来自模型），保证所有客户端看到的一致
 */
import type { CoreRoom, GameConfig, JudgeResult, PublicRoom } from '@ht/core';

export interface TimelineEntry {
  seq: number;
  kind: 'system' | 'question' | 'rejected' | 'vote' | 'transfer' | 'credit' | 'recap';
  at: number;
  text: string;
  memberId?: string;
  answer?: JudgeResult['answer'];
  reasonCode?: string;
  source?: JudgeResult['source'];
  meta?: string;
}

export interface RoomView {
  room: PublicRoom;
  timeline: TimelineEntry[];
  you: {
    memberId: string;
    isHost: boolean;
    canSubmit: boolean;
    canHintT12: number;
    canHintT3: number;
    guessLeft: number;
    hintCooldownLeftMs: number;
    nextGuessInRounds: number;
  };
  candidates?: Array<{ id: string; title: string; surface: string; difficulty: number; rating: string; tags: string[]; sensitiveTags: string[]; estMinutes: number }>;
}

export type ClientFrame =
  | { t: 'hello'; token: string }
  | { t: 'snapshot' }
  | { t: 'heartbeat'; hidden?: boolean }
  | { t: 'activity'; hidden?: boolean }
  | { t: 'submit'; id?: string; turnSeq: number; text: string; clientSubmitId: string }
  | { t: 'hint'; id?: string; tier: 1 | 2 | 3 }
  | { t: 'guess'; id?: string; text: string }
  | { t: 'vote'; id?: string; choice: string }
  | { t: 'config'; id?: string; patch: Partial<GameConfig>; expectedVersion: number }
  | { t: 'start'; id?: string; mode: 'vote' | 'pick'; puzzleId?: string }
  | { t: 'resume_transfer'; id?: string }
  | { t: 'return_host'; id?: string }
  | { t: 'decline_return'; id?: string }
  | { t: 'reenable_key'; id?: string; yes: boolean }
  | { t: 'revoke_key'; id?: string }
  | { t: 'skip_turn'; id?: string }
  | { t: 'end_match'; id?: string; result?: 'aborted' }
  | { t: 'ping'; id?: string };

export type ServerFrame =
  | { t: 'hello'; you: { memberId: string; roomId: string }; serverTime: number; view: RoomView }
  | { t: 'snapshot'; serverTime: number; view: RoomView }
  | { t: 'event'; seq: number; kind: string; payload: Record<string, unknown>; text: string; serverTime: number; stateVersion: number }
  | { t: 'ack'; id: string; ok: true; data?: Record<string, unknown> }
  | { t: 'error'; id: string; ok: false; code: string; message: string };

/** 房间码字符集：剔除 I/L/O/0/1，避免口误与混淆。 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)] ?? 'A';
  }
  return out;
}

/** 服务端模板文案（所有面向玩家的中文都由这里给出，不由模型生成）。 */
export const TEXT = {
  turnStarted: (name: string, sec: number, unavailable: boolean) =>
    unavailable ? `轮到 ${name} 了（当前不可用，直接进入宽限）` : `轮到 ${name} 了（${sec} 秒）`,
  graceStarted: (sec: number) => `倒计时结束，进入 ${sec} 秒宽限期（此时提交仍然有效）`,
  turnSkipped: (name: string, reason: string) => `${name} 已被跳过（${reason === 'timeout' ? '超时未提交' : '当前不可用'}）`,
  submitRejected: (code: string) => {
    switch (code) {
      case 'TURN_EXPIRED': return '本轮已跳过，内容未提交。（草稿仍保留在你的浏览器里）';
      case 'NOT_YOUR_TURN': return '还没轮到你发言。';
      case 'TURN_ALREADY_ANSWERED': return '本轮已经提交过了。';
      case 'STALE_TURN': return '回合已经切换，请以最新状态为准。';
      case 'TURN_VOIDED': return '因房主变更，本轮已作废。';
      case 'MATCH_PAUSED': return '对局已暂停，暂时不能提交。';
      case 'MATCH_NOT_ACTIVE': return '对局未在进行中。';
      case 'TEXT_TOO_LONG': return '提问太长了（上限 200 字）。';
      case 'TEXT_EMPTY': return '内容太短，请写清楚一点。';
      case 'RATE_LIMITED': return '提问太快了，缓一缓。';
      default: return '提交未通过校验。';
    }
  },
  memberStateChanged: (name: string, line: string, to: string) =>
    line === 'conn'
      ? `${name}：${to === 'disconnected' ? '已离线' : '已重连'}`
      : `${name}：${to === 'idle' ? '挂机' : '恢复活跃'}`,
  roomPaused: (reason: string) => reason === 'ai_blocked'
    ? 'AI 服务异常，对局已暂停，等待房主处理。'
    : reason === 'waiting_host_return'
      ? '房主已离线且无人可接管：对局暂停，等待房主回来。'
      : '全员挂机或离线：对局已暂停，任意成员回来后自动恢复。',
  roomResumed: '有人回来了：对局已恢复（当前回合重新给完整时长）。',
  voteOpened: (kind: string, sec: number) => kind === 'puzzle_choice'
    ? `候选题目已公布，开始投票（${sec} 秒）`
    : '房主长时间无响应：发起投票——是否临时启用平台备用额度继续对局？',
  voteSettled: (result: string) => `投票结果：${result}`,
  hostTransfer: (from: string, to: string) =>
    `房主位已由 ${from} 移交给 ${to}。原房主的 API Key 已挂起（任何人都无法读取原文），本局额度来源切换为平台备用额度——原因是"密钥所有权不可转移"，与"调用失败不降级"并不冲突。`,
  hostWaiting: '房主离线且房间内没有其他在线活跃成员：对局暂停等待房主回来（Key 不挂起、额度不变）。',
  transferResume: (name: string) => `${name} 开始了新的一轮（上一轮因房主变更作废，不计入跳过次数）。`,
  aiBlocked: (code: string) => `AI 服务异常（${code}）：对局已暂停，等待房主处理。本轮未消耗，且不会自动切换到平台额度。`,
  aiRecovered: '对局已恢复。',
  creditGranted: (calls: number) => `已临时启用平台备用额度（预算 ${calls} 次调用，本局有效）。`,
  hintGranted: (tier: number, text: string, left: string) => `【提示 · T${tier}】${text}（剩余配额：${left}）`,
  guessHit: (name: string) => `🎉 ${name} 揭秘命中汤底！`,
  guessPartial: (name: string, hits: number, total: number) => `${name} 的推理「接近但未命中」（关键要素 ${hits}/${total}；不告知命中了哪几条，避免变成免费提示）`,
  guessMiss: (name: string) => `${name} 的推理未命中，请再想想。`,
  matchEnded: (result: string, reason: string) =>
    `对局结束：${result === 'solved' ? '解密成功' : result === 'unsolved' ? '未解密' : '已中止'}（${reason}）`,
  recapBlocked: '本局为中止的对局，不予揭晓汤底（避免"开局→立刻结束→读汤底"的套题路径）。',
} as const;

export type { CoreRoom };
