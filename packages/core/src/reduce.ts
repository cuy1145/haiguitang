/**
 * 事件归约器：把"发生了什么"翻译成"状态怎么变"。
 *
 * 服务端在一个**房间级串行队列**里调用本函数（《阶段5》§1.1）：
 *   enqueue(roomId, () => { const out = reduce(room, event, ctx); persist(out.room); broadcast(out.events); })
 * 判定调用本身在队列之外执行，结果回投队列（避免 20 秒的模型调用冻结整个房间）。
 */
import type { CoreRoom, DomainEvent, ReduceCtx, ReduceResult } from './types.ts';
import { PLATFORM } from './constants.ts';
import { getMember, withRoom } from './room.ts';
import * as presence from './presence.ts';
import * as turn from './turn.ts';
import * as votes from './vote.ts';
import * as host from './host.ts';

export type CoreEvent =
  | { type: 'MATCH_BEGIN'; puzzleId: string }
  /** 准备状态：玩家自己举手/收回（只在开局前有意义） */
  | { type: 'READY_SET'; memberId: string; ready: boolean }
  | { type: 'TURN_TICK' }
  | { type: 'SUBMIT_ACCEPTED'; memberId: string }
  | { type: 'JUDGE_DONE' }
  | { type: 'JUDGE_FAILED' }
  | { type: 'GUESS'; memberId: string; verdict: 'hit' | 'partial' | 'miss'; hits: number; total: number; cooldownUntil?: number }
  | { type: 'HINT'; memberId: string; tier: 1 | 2 | 3; factId: string }
  | { type: 'FACT_REVEALED'; factIds: string[] }
  | { type: 'MEMBER_CONN'; memberId: string; conn: 'connected' | 'disconnected' }
  | { type: 'MEMBER_ACTIVITY'; memberId: string; hidden: boolean }
  | { type: 'PRESENCE_TICK' }
  | { type: 'HOST_SUSPECT' }
  | { type: 'HOST_TRANSFER'; toId: string }
  | { type: 'HOST_TRANSFER_WAITING' }
  | { type: 'HOST_RESUME' }
  | { type: 'HOST_RECONNECTED' }
  | { type: 'HOST_RETURN'; formerHostId: string }
  | { type: 'VOTE_OPEN'; voteType: 'puzzle_choice' | 'fallback_credit'; voteId: string; puzzleIds?: string[] }
  | { type: 'VOTE_CAST'; memberId: string; choice: string }
  | { type: 'VOTE_SETTLE' }
  | { type: 'VOTE_VOID_BY_HOST' }
  | { type: 'CREDIT_BLOCK'; reasonCode: string }
  | { type: 'CREDIT_GRANT'; calls: number }
  | { type: 'CREDIT_REVOKE'; reason: 'HOST_RECOVERED' | 'MATCH_ENDED' }
  | { type: 'CREDIT_REVOKED_BY_OWNER' }
  | { type: 'AI_RECOVERED' }
  /** 房主换上/更新了可用的自备 Key：解除 AI 中断、恢复对局，额度来源仍是自备 */
  | { type: 'CREDIT_RESTORED' }
  | { type: 'MATCH_END'; result: 'solved' | 'unsolved' | 'aborted'; reason: string }
  /** 回到选题：settled → waiting（房主开始下一局前先把房间放回大厅状态） */
  | { type: 'ROOM_REOPEN' }
  | { type: 'ROOM_SUSPEND'; reason: string }
  | { type: 'ROOM_RESUME' };

export interface ReduceOutcome extends ReduceResult {
  /** 额度降级投票通过时为 true（服务端据此创建 credit_grant 记录） */
  creditGranted?: boolean;
  /** 选题投票选中的题目 id */
  selectedPuzzleId?: string | null;
  /** 移交发生时需要挂起的原房主（服务端据此处理密钥保险箱） */
  suspendedKeyOwnerId?: string | null;
}

function emit(events: DomainEvent[], ...more: DomainEvent[]): DomainEvent[] {
  return [...events, ...more];
}

export function reduce(room: CoreRoom, event: CoreEvent, ctx: ReduceCtx): ReduceOutcome {
  switch (event.type) {
    case 'MATCH_BEGIN': {
      const out = turn.beginMatch(room, event.puzzleId, ctx);
      // 新一局开始：清空准备状态，避免"上一局的举手"直接生效；
      // 局号 +1（讨论区靠它区分「第 N 局开始」，见 §12.8）
      return { room: { ...out.room, ready: [], matchNo: room.matchNo + 1 }, events: out.events };
    }

    case 'READY_SET': {
      // 只有"等待开局"才谈得上准备：对局中/已结束收下只会误导别人
      // （以前只挡 playing，于是 settled 之后点"我准备好了"照样写库、界面还写"可以开局"，
      //   而房间已经不可能再开局了 —— 见 M1）
      if (room.status !== 'waiting') return { room, events: [] };
      if (!room.members.some((m) => m.id === event.memberId)) return { room, events: [] };
      if (room.ready.includes(event.memberId) === event.ready) return { room, events: [] };
      const ready = event.ready
        ? [...room.ready, event.memberId]
        : room.ready.filter((id) => id !== event.memberId);
      return { room: withRoom(room, { ready }, ctx.now), events: [] };
    }

    case 'TURN_TICK': {
      const out = turn.tickTurn(room, ctx.now, ctx);
      return { room: out.room, events: out.events };
    }

    case 'SUBMIT_ACCEPTED': {
      const next = turn.applySubmit(room, event.memberId, ctx.now);
      return { room: next, events: [] };
    }

    case 'JUDGE_DONE': {
      // 结算本轮并推进到下一位（推进只在这里发生，保证"一次提问只推进一次"）
      const settled = turn.applyJudgeDone(room, ctx.now);
      const advanced = turn.advanceTurn(settled.room, ctx);
      return { room: advanced.room, events: [...settled.events, ...advanced.events] };
    }

    case 'JUDGE_FAILED': {
      // 判定失败：回退 ACTIVE，不消耗回合、不推进（也不会产生第二条判定）
      return { room: turn.applyJudgeFailed(room, ctx.now), events: [] };
    }

    case 'GUESS': {
      let next = room;
      // 共用冷却：**任何人**猜一次都把全房间的冷却推后（房主可配 guessCooldownSec，0=不限）
      if (typeof event.cooldownUntil === 'number' && event.cooldownUntil > 0) {
        next = withRoom(next, { guessCooldownUntil: event.cooldownUntil }, ctx.now);
      }
      if (event.verdict === 'hit') {
        next = withRoom(next, {
          members: next.members.map((m) => (m.id === event.memberId ? { ...m, score: m.score + 70 } : m)),
        }, ctx.now);
      } else if (event.verdict === 'partial') {
        next = withRoom(next, {
          members: next.members.map((m) => (m.id === event.memberId ? { ...m, score: m.score + 10 } : m)),
        }, ctx.now);
      } else {
        next = withRoom(next, {
          members: next.members.map((m) => (m.id === event.memberId ? { ...m, score: m.score - 2 } : m)),
        }, ctx.now);
      }
      const events: DomainEvent[] = [
        { type: 'guess_result', memberId: event.memberId, verdict: event.verdict, hits: event.hits, total: event.total },
      ];
      if (event.verdict === 'hit') {
        const out = turn.endMatch(next, 'solved', '有人还原了真相', ctx);
        return { room: out.room, events: emit(events, ...out.events) };
      }
      return { room: next, events };
    }

    case 'HINT': {
      const member = getMember(room, event.memberId);
      if (!member) return { room, events: [] };
      const members = room.members.map((m) => {
        if (m.id !== event.memberId) return m;
        return event.tier === 3
          ? { ...m, hintsUsedT3: m.hintsUsedT3 + 1, lastHintAt: ctx.now, score: m.score - 8 }
          : { ...m, hintsUsedT12: m.hintsUsedT12 + 1, lastHintAt: ctx.now, score: m.score - (event.tier === 1 ? 1 : 3) };
      });
      const next = withRoom(room, {
        members,
        hint: { tier3Used: room.hint.tier3Used + (event.tier === 3 ? 1 : 0) },
        revealedFacts: room.revealedFacts.includes(event.factId) ? room.revealedFacts : [...room.revealedFacts, event.factId],
      }, ctx.now);
      return { room: next, events: [{ type: 'hint_granted', memberId: event.memberId, tier: event.tier, factId: event.factId }] };
    }

    case 'FACT_REVEALED': {
      const merged = [...room.revealedFacts];
      for (const id of event.factIds) if (!merged.includes(id)) merged.push(id);
      return { room: withRoom(room, { revealedFacts: merged }, ctx.now), events: [] };
    }

    case 'MEMBER_CONN': {
      const out = presence.setConn(room, event.memberId, event.conn, ctx.now);
      let next = out.room;
      const events = [...out.events];
      // 断连即失去"已准备"资格：否则"举手 → 离线 → 回来"会不声不响地恢复成已准备，
      // 房主据此开局，而这个人其实一直不在（L1）。回来后重新举手即可。
      if (event.conn === 'disconnected' && next.ready.includes(event.memberId)) {
        next = withRoom(next, { ready: next.ready.filter((id) => id !== event.memberId) }, ctx.now);
      }
      const hostMember = getMember(next, next.hostId);
      if (event.memberId === next.hostId && hostMember) {
        if (hostMember.conn === 'disconnected') {
          next = host.markSuspect(next, ctx.now);
        } else if (next.transfer.state === 'suspect') {
          next = host.cancelSuspect(next, ctx.now);
        }
      }
      return { room: next, events };
    }

    case 'MEMBER_ACTIVITY': {
      const next = presence.reportActivity(room, event.memberId, ctx.now, event.hidden);
      return { room: next, events: [] };
    }

    case 'PRESENCE_TICK': {
      const out = presence.presenceTick(room, ctx.now);
      return { room: out.room, events: out.events };
    }

    case 'HOST_SUSPECT':
      return { room: host.markSuspect(room, ctx.now), events: [] };

    case 'HOST_TRANSFER': {
      const out = host.transferHost(room, event.toId, ctx);
      return { room: out.room, events: out.events, suspendedKeyOwnerId: out.suspendedKeyOwnerId };
    }

    case 'HOST_TRANSFER_WAITING': {
      const out = host.transferWaiting(room, ctx.now);
      return { room: out.room, events: out.events };
    }

    case 'HOST_RESUME': {
      const out = host.resumeAfterTransfer(room, ctx);
      return { room: out.room, events: out.events };
    }

    case 'HOST_RECONNECTED':
      return { room: host.cancelSuspect(room, ctx.now), events: [] };

    case 'HOST_RETURN': {
      const out = host.returnHost(room, event.formerHostId, ctx.now);
      return { room: out.room, events: out.events };
    }

    case 'VOTE_OPEN': {
      const out = votes.openVote(room, event.voteType, event.puzzleIds ?? [], ctx.now, { id: event.voteId });
      return {
        room: out.room,
        events: [{ type: 'vote_opened', voteId: out.vote.id, voteType: out.vote.type, deadlineAt: out.vote.deadlineAt, eligible: out.vote.eligibleAtOpen }],
      };
    }

    case 'VOTE_CAST':
      return { room: votes.castBallot(room, event.memberId, event.choice, ctx.now), events: [] };

    case 'VOTE_SETTLE': {
      const out = votes.settleVote(room, ctx.now, ctx.rand);
      return { room: out.room, events: out.events, creditGranted: out.creditGranted, selectedPuzzleId: out.selectedPuzzleId };
    }

    case 'VOTE_VOID_BY_HOST': {
      const out = votes.voidVoteByHostAction(room, ctx.now);
      return { room: out.room, events: out.events };
    }

    case 'CREDIT_BLOCK': {
      const next = withRoom(room, {
        ai: { state: 'BLOCKED', reasonCode: event.reasonCode, blockedAt: ctx.now },
        status: 'suspended',
        pauseReason: 'ai_blocked',
        turn: room.turn.phase === 'ACTIVE' || room.turn.phase === 'GRACE' || room.turn.phase === 'JUDGING'
          ? { ...room.turn, phase: 'PAUSED' }
          : room.turn,
      }, ctx.now);
      return { room: next, events: [{ type: 'ai_blocked', reasonCode: event.reasonCode }] };
    }

    case 'CREDIT_GRANT': {
      const wasSite = room.credit.mode === 'site_fallback';
      const next = withRoom(room, {
        ai: { state: 'GRANTED', reasonCode: null, blockedAt: null },
        credit: { mode: 'site_fallback', reason: 'MEMBER_VOTE', grantLeft: event.calls, grantId: room.credit.grantId },
        status: 'playing',
        pauseReason: null,
        turn: room.turn.phase === 'PAUSED'
          ? { ...room.turn, phase: 'ACTIVE', startedAt: ctx.now, deadlineAt: ctx.now + room.config.perTurnSec * 1000, graceDeadlineAt: ctx.now + room.config.perTurnSec * 1000 + room.config.graceSec * 1000 }
          : room.turn,
      }, ctx.now);
      const events: DomainEvent[] = [{ type: 'ai_recovered' }];
      if (!wasSite) events.push({ type: 'credit_switch', from: room.credit.mode, to: 'site_fallback', reason: 'MEMBER_VOTE', auto: true });
      return { room: next, events };
    }

    case 'CREDIT_REVOKE': {
      const next = withRoom(room, {
        ai: { state: 'OK', reasonCode: null, blockedAt: null },
        credit: { mode: 'host_key', reason: 'HOST_RESTORED', grantLeft: 0, grantId: null },
      }, ctx.now);
      return {
        room: next,
        events: [{ type: 'credit_switch', from: 'site_fallback', to: 'host_key', reason: 'HOST_RESTORED', auto: false }],
      };
    }

    case 'CREDIT_REVOKED_BY_OWNER': {
      const next = withRoom(room, {
        ai: { state: 'OK', reasonCode: null, blockedAt: null },
        credit: { mode: 'site_fallback', reason: 'OWNER_REVOKED', grantLeft: 0, grantId: null },
        ...(room.status === 'suspended' && room.pauseReason === 'ai_blocked' ? { status: 'playing' as const, pauseReason: null } : {}),
        turn: room.turn.phase === 'PAUSED'
          ? { ...room.turn, phase: 'ACTIVE', startedAt: ctx.now, deadlineAt: ctx.now + room.config.perTurnSec * 1000, graceDeadlineAt: ctx.now + room.config.perTurnSec * 1000 + room.config.graceSec * 1000 }
          : room.turn,
      }, ctx.now);
      return {
        room: next,
        events: [{ type: 'credit_switch', from: room.credit.mode, to: 'site_fallback', reason: 'OWNER_REVOKED', auto: false }],
      };
    }

    case 'AI_RECOVERED': {
      const next = withRoom(room, { ai: { state: 'OK', reasonCode: null, blockedAt: null } }, ctx.now);
      return { room: next, events: [{ type: 'ai_recovered' }] };
    }

    /**
     * 房主更新了自备 Key（复测通过）→ 解除 ai_blocked 暂停并接着玩。
     * 与 CREDIT_REVOKED_BY_OWNER 的区别：额度来源保持 host_key（不是因为放弃自备 Key 而切到平台额度）。
     */
    case 'CREDIT_RESTORED': {
      const next = withRoom(room, {
        ai: { state: 'OK', reasonCode: null, blockedAt: null },
        credit: { mode: 'host_key', reason: 'HOST_RESTORED', grantLeft: 0, grantId: null },
        ...(room.status === 'suspended' && room.pauseReason === 'ai_blocked'
          ? { status: 'playing' as const, pauseReason: null }
          : {}),
        turn: room.turn.phase === 'PAUSED'
          ? {
            ...room.turn, phase: 'ACTIVE', startedAt: ctx.now,
            deadlineAt: ctx.now + room.config.perTurnSec * 1000,
            graceDeadlineAt: ctx.now + room.config.perTurnSec * 1000 + room.config.graceSec * 1000,
          }
          : room.turn,
      }, ctx.now);
      return { room: next, events: [{ type: 'ai_recovered' }] };
    }

    case 'MATCH_END': {
      const out = turn.endMatch(room, event.result, event.reason, ctx);
      return { room: out.room, events: out.events };
    }

    /**
     * 回到选题（上一局已结束 → 重新等待房主选下一道题）。
     * 只允许从 settled 回到 waiting；其它状态一律忽略（幂等、不误伤进行中的对局）。
     */
    case 'ROOM_REOPEN': {
      if (room.status !== 'settled') return { room, events: [] };
      return {
        room: withRoom(room, {
          status: 'waiting',
          pauseReason: null,
          puzzleId: null,
          roundNo: 0,
          revealedFacts: [],
          ready: [],
          guessCooldownUntil: 0,
          result: null,
          vote: null,
          turn: { seq: 0, memberId: null, phase: 'IDLE', startedAt: 0, deadlineAt: 0, graceDeadlineAt: 0, outcome: null, lateSubmit: false },
        }, ctx.now),
        events: [{ type: 'room_reopened' }],
      };
    }

    case 'ROOM_SUSPEND': {
      if (room.status !== 'playing') return { room, events: [] };
      return {
        room: withRoom(room, { status: 'suspended', pauseReason: event.reason }, ctx.now),
        events: [{ type: 'room_paused', reason: event.reason }],
      };
    }

    case 'ROOM_RESUME': {
      if (room.status !== 'suspended') return { room, events: [] };
      return {
        room: withRoom(room, { status: 'playing', pauseReason: null }, ctx.now),
        events: [{ type: 'room_resumed' }],
      };
    }

    default: {
      // 穷尽性检查：新增事件类型时必须在此处补分支
      const never: never = event;
      void never;
      return { room, events: [] };
    }
  }
}

/** 判定失败后的兜底：直接用规则事实表裁决（不消耗额度、不产生第二次判定）。 */
export function fallbackAfterJudgeFailure(): { hintCode: string } {
  return { hintCode: 'RULE_FALLBACK' };
}

export { PLATFORM, turn, presence, votes, host };
