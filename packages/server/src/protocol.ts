/**
 * WebSocket 协议帧定义（服务端 ↔ 客户端）。
 *
 * 约定：
 *  - 服务端推给客户端的一切都必须经过 core/dto.ts 的白名单投影
 *  - 事件帧带 `seq`（房间内单调）与 `stateVersion`；客户端按 seq 排序、按版本拒绝陈旧载荷
 *  - 文案由服务端模板渲染（不来自模型），保证所有客户端看到的一致
 */
import type { CoreRoom, GameConfig, JudgeResult, PublicRoom } from '@ht/core';

/**
 * 凭据里保存的 Base URL。
 *
 * 字段在存储层历史上叫 `baseUrlHost`（只存主机名），但那样会丢掉路径前缀 —— 而 OpenAI 以及
 * 大量兼容服务必须带 `/v1`（`https://api.openai.com/v1/chat/completions`）。
 * 现在新记录存**完整 URL**（提交时已过 SSRF 校验：仅 https、无 query/fragment、非内网），
 * 旧记录只有主机名也能正确还原，无需数据迁移。
 *
 * ⚠️ 刻意放在这个**零依赖**模块里：Worker 端的 rooms.ts 需要按值导入它。
 *    若放在 vault.ts（用到 node:crypto），整个 Node 加密实现会被打进 Worker 包，
 *    部署时会因 `node:crypto` 不可用而失败（见自检 "Worker 可打包性"）。
 */
export function credentialBaseUrl(cred: { baseUrlHost: string }): string {
  const raw = String(cred.baseUrlHost ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export interface TimelineEntry {
  seq: number;
  kind: 'system' | 'question' | 'rejected' | 'vote' | 'transfer' | 'credit' | 'recap';
  at: number;
  text: string;
  memberId?: string;
  answer?: JudgeResult['answer'];
  reasonCode?: string;
  source?: JudgeResult['source'];
  /** 「是/否」时可选的一句补充说明（已过泄露检查，可缺省） */
  explain?: string | null;
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
  | { t: 'start'; id?: string; mode: 'vote' | 'pick'; puzzleId?: string; force?: boolean }
  | { t: 'ready'; id?: string; ready: boolean }
  | { t: 'kick'; id?: string; memberId: string }
  | { t: 'create_ai_puzzle'; id?: string }
  /** 回到选题：上一局结束后把房间放回等待状态（仅房主），房主接着选下一道题 */
  | { t: 'next_round'; id?: string }
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

/**
 * 动作失败码 → 面向玩家的中文文案（**唯一权威表**）。
 *
 * 为什么放在这里：Worker（`packages/worker/src/http.ts`）和 Node 参考服务器
 * （`packages/server/src/server.ts`）都要用它，以前各写一份，结果两边都在漏码 ——
 * 漏掉的码会掉进 default，玩家只看到一句"操作未通过校验"，真正的失败原因被吞掉
 * （真实故障：AI 出题返回 SCHEMA_INVALID，房主只看到"操作未通过校验"）。
 * 新增失败码时**只改这里**。
 */
export function messageOf(code: string): string {
  switch (code) {
    // ---- 回合 / 提交 ----
    case 'NOT_YOUR_TURN': return '还没轮到你发言。';
    case 'TURN_EXPIRED': return '本轮已跳过，内容未提交。';
    case 'TURN_ALREADY_ANSWERED': return '本轮已经提交过了。';
    case 'STALE_TURN': return '回合已经切换，请以最新状态为准。';
    case 'TURN_VOIDED': return '因房主变更，本轮已作废。';
    case 'TEXT_TOO_LONG': return '提问太长了（上限 200 字）。';
    case 'TEXT_EMPTY': return '内容太短，请写清楚一点。';
    case 'RATE_LIMITED': return '操作太频繁了，缓一缓再试。';
    // ---- 房间 / 权限 ----
    case 'MATCH_PAUSED': return '对局已暂停。';
    case 'MATCH_NOT_ACTIVE': return '对局未在进行中。';
    case 'NOT_HOST': return '只有房主可以做这个操作。';
    case 'NOT_ALLOWED': return '当前状态下不能做这个操作（多半是对局已经开始/结束了）。';
    case 'PUZZLE_NOT_FOUND': return '找不到这道题：可能房间里的自定义题（AI 创作）没保存成功，或题目 id 对不上。再生成一次即可。';
    case 'ROOM_NOT_FOUND': return '房间不存在或已被清理。';
    case 'ROOM_CLOSED': return '房间已经结束，不能再加入了。';
    case 'ROOM_FULL': return '房间人数已满。';
    case 'UNAUTHORIZED': return '会话无效或已过期，请重新加入房间。';
    case 'CONFLICT': return '房间状态刚被别的操作更新，请重试一次。';
    case 'UNKNOWN_ACTION': return '未知操作（客户端与服务端版本可能不一致）。';
    // ---- 投票 / 准备 ----
    case 'VOTE_NOT_ELIGIBLE': return '挂机或离线的成员不能表决。';
    case 'VOTE_NOT_OPEN': return '当前没有进行中的投票。';
    case 'NOT_ALL_READY': return '还有玩家没点「我准备好了」；等大家都准备好，或确认后强制开局。';
    // ---- 提示 / 揭秘 ----
    case 'HINTS_DISABLED': return '本局未开启提示（房主可在「对局参数」里打开）。';
    case 'HINT_COOLDOWN': return '提示冷却中。';
    case 'HINT_QUOTA_EXHAUSTED': return '你的提示次数已用尽。';
    case 'HINT_TIER3_EXHAUSTED': return 'T3 关键提示本局已用完。';
    case 'HINT_NO_FACT': return '该梯度已无可用提示。';
    case 'GUESS_NOT_IN_WINDOW': return '还没到可以揭秘的轮次。';
    case 'GUESS_ATTEMPTS_EXHAUSTED': return '你的揭秘次数已用尽。';
    case 'GUESS_TOO_SHORT': return '推理内容太短。';
    case 'GUESS_COOLDOWN': return '猜汤底是**所有人共用一个冷却**：刚有人猜过（不管对错），等冷却结束再猜。';
    // ---- 模型凭据（自备 Key / 平台额度）----
    case 'AI_UNAVAILABLE': return '当前没有可用的模型凭据：服务端没配平台额度，你也没填自备 Key。填一把自己的 Key（先点「测试连接」验证）即可；或让运维配置 AI_KEY。';
    case 'HTTP_401': return '模型鉴权失败：API Key 无效或已被撤销。';
    case 'HTTP_402': return '模型账号余额/额度不足：充值或换一把 Key。';
    case 'HTTP_403': return '模型无权限：这把 Key 不能访问该模型。';
    case 'HTTP_400': return '上游不接受请求参数：多半是模型名不对。';
    case 'HTTP_404': return 'Base URL 或模型名不对：DeepSeek 用 https://api.deepseek.com + deepseek-flash。';
    case 'HTTP_408': case 'HTTP_425': return '上游临时异常（超时/要求重试），再试一次通常就好。';
    case 'HTTP_429': return '被上游限流：等十几秒再试一次。';
    case 'HTTP_5XX': return '模型服务端出错（5xx）：稍后重试，或换一个模型名。';
    case 'CONNECT_TIMEOUT': case 'READ_TIMEOUT': return '调用模型超时：检查网络/代理，或换一个 Base URL。';
    case 'CONN_RESET': return '连接模型时被重置：稍后重试，或换一个 Base URL。';
    case 'SCHEMA_INVALID': return '模型这次没按要求返回 JSON（已自动重试一次）。再点一次生成通常就能出题；连续失败可以把模型换成 deepseek-chat 试试。';
    case 'PROVIDER_REFUSAL': return '上游以内容策略为由拒绝了这次请求：换一个模型或改一下题目方向。';
    case 'LEAK_DETECTED': return '模型输出里含有汤底片段，被安全机制拦下了（不会下发给任何人）。再生成一次即可。';
    case 'INCONSISTENT': return '模型输出前后矛盾，无法用于判定。再生成一次即可。';
    case 'UNANSWERABLE_ABUSE': return '模型把太多问题判成「无法回答」，已被规则拦下。再试一次或换个模型。';
    case 'PUZZLE_INVALID': return 'AI 出的题没通过坏题检测，已作废（逐条原因见下），换一次生成即可。';
    case 'UNKNOWN': return '模型调用出现未分类错误（详情见下）。';
    default: return `操作未通过校验（未分类错误码 ${code}）。`;
  }
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
