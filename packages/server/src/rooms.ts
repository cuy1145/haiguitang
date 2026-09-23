/**
 * 房间运行时：串行队列 + 事件缓冲 + 落库 + 判定编排（《阶段5》§1.1）。
 *
 * 关键设计（顺序即正确性）：
 *  1. 房间内的一切状态变更都经 `enqueue()` 串行执行（进程内 Promise 链；单实例部署下足够）
 *  2. **模型调用在队列之外**：先入队占位（turn=JUDGING）→ 出队调用 → 结果回投队列落库与推进
 *  3. 每个动作都"先同步预检、再入队复检"，避免把校验放在队列外造成 TOCTOU
 *  4. 定时器只"投递任务"，绝不直接改状态
 */
import {
  PLATFORM, PROMPT_VERSION, assertNoLeak, canSubmit, emptyRoom, getMember, hintsExhausted,
  isLeaky, judgeGuess, pickHintFact, pickNewHost, reduce, toPublicPuzzle, toPublicRoom,
  transferGate, validateConfigChange,
} from '@ht/core';
import type {
  ActionReject, CoreMember, CoreRoom, DomainEvent, GameConfig, Puzzle, ReduceCtx, SubmitReject,
} from '@ht/core';
import type { CredentialRecord } from './vault.ts';
import { credentialBaseUrl } from './vault.ts';
import type { QuestionRecord } from './store.ts';
import type { HostPort, LoggerPort, RoomStorePort } from './ports.ts';
import { CODE_LENGTH, TEXT, generateCode } from './protocol.ts';
import type { RoomView, TimelineEntry } from './protocol.ts';

export interface SessionLike {
  send(frame: unknown): void;
}

export interface RuntimeDeps {
  store: RoomStorePort;
  logger: LoggerPort;
  host: HostPort;
  /** 站点备用额度是否允许（月度上限 / 运维开关） */
  siteQuotaAllows: () => boolean;
  grantBudgetCalls: number;
  grantMaxPerMatch: number;
  grantCooldownSec: number;
  /** 解密凭据（仅用于出站调用与复测；用完即弃，不回读给任何人） */
  decrypt: (cred: CredentialRecord) => string;
  /** 注入时钟，便于集成测试用假时钟驱动 */
  now: () => number;
  newId: (prefix: string) => string;
  rand: () => number;
}

interface BufferedEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  text: string;
  stateVersion: number;
  at: number;
}

type Result<T = void> = { ok: true; data?: T } | { ok: false; code: ActionReject; detail?: unknown };

/**
 * 结构性事件：广播后补发快照。
 * 纯时间线事件（turn_settled、member_state_changed 等）只走事件流，避免快照刷屏。
 */
const STRUCTURAL_EVENTS = new Set<DomainEvent['type']>([
  'turn_started', 'turn_skipped', 'room_paused', 'room_resumed',
  'host_transfer', 'host_transfer_waiting', 'credit_switch', 'ai_blocked', 'ai_recovered',
  'vote_opened', 'vote_settled', 'match_ended', 'hint_granted', 'guess_result',
]);

export class RoomRuntime {
  room: CoreRoom;
  private readonly deps: RuntimeDeps;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessions = new Map<string, Set<SessionLike>>();
  private buffer: BufferedEvent[] = [];
  private timeline: TimelineEntry[] = [];
  private keyStates = new Map<string, { state: 'none' | 'active' | 'suspended' | 'destroyed'; mask: string | null; formerHost: boolean }>();
  private matchId: string | null = null;
  private candidates: string[] = [];
  private judging = new Set<number>();
  private submittedByTurn = new Map<number, string>();
  private lastPresenceTick = 0;
  private lastSweep = 0;
  private grantCount = 0;
  private grantCooldownUntil = 0;
  private hostSkipUsed = 0;
  private resumeDeadline = 0;

  constructor(room: CoreRoom, deps: RuntimeDeps) {
    this.room = room;
    this.deps = deps;
    for (const [id, v] of deps.store.memberKeyStates(room.id)) {
      this.keyStates.set(id, { state: v.state as 'none' | 'active' | 'suspended' | 'destroyed', mask: v.mask, formerHost: v.formerHost });
    }
    this.matchId = deps.store.currentMatch(room.id)?.id ?? null;
    if (room.transfer.state === 'paused_for_resume') this.resumeDeadline = deps.now() + 20000;
  }

  // ---------------------------------------------------------------- 基础设施
  get now(): number { return this.deps.now(); }

  private ctx(): ReduceCtx {
    return { now: this.now, rand: this.deps.rand, newId: this.deps.newId };
  }

  /** 房间级串行队列：所有状态变更的唯一入口。 */
  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  }

  attachSession(memberId: string, session: SessionLike): () => void {
    let set = this.sessions.get(memberId);
    if (!set) { set = new Set(); this.sessions.set(memberId, set); }
    set.add(session);
    return () => { set?.delete(session); if (set && set.size === 0) this.sessions.delete(memberId); };
  }

  hasSession(memberId: string): boolean {
    return (this.sessions.get(memberId)?.size ?? 0) > 0;
  }

  private sendTo(memberId: string, frame: unknown): void {
    const set = this.sessions.get(memberId);
    if (!set) return;
    for (const s of set) {
      try { s.send(frame); } catch { /* 连接已断，忽略 */ }
    }
  }

  broadcast(frameFor: (memberId: string) => unknown): void {
    for (const memberId of this.sessions.keys()) this.sendTo(memberId, frameFor(memberId));
  }

  /** 把域事件转成对外事件帧：分配 seq、写入缓冲、渲染文案、广播。 */
  private emit(events: DomainEvent[]): void {
    for (const ev of events) {
      const seq = ++this.room.eventSeq;
      const payload = ev as unknown as Record<string, unknown>;
      const text = this.textOf(ev);
      const buffered: BufferedEvent = { seq, kind: ev.type, payload, text, stateVersion: this.room.stateVersion, at: this.now };
      this.buffer.push(buffered);
      if (this.buffer.length > PLATFORM.eventBufferSize) this.buffer.shift();
      if (text) this.timeline.push(this.timelineEntry(buffered, ev));
      this.broadcast((memberId) => ({
        t: 'event', seq, kind: ev.type, payload, text, serverTime: this.now, stateVersion: this.room.stateVersion,
        ...(ev.type === 'rejected' && ev.memberId === memberId ? { you: true } : {}),
      }));
    }
  }

  private timelineEntry(buffered: BufferedEvent, ev: DomainEvent): TimelineEntry {
    const base: TimelineEntry = { seq: buffered.seq, kind: 'system', at: buffered.at, text: buffered.text };
    switch (ev.type) {
      case 'turn_started': return { ...base, memberId: ev.memberId, meta: `turn_seq=${ev.turnSeq}` };
      case 'turn_skipped': return { ...base, memberId: ev.memberId };
      case 'hint_granted': return { ...base, memberId: ev.memberId };
      case 'guess_result': return { ...base, kind: 'question', memberId: ev.memberId, meta: `${ev.hits}/${ev.total}` };
      case 'vote_opened':
      case 'vote_settled': return { ...base, kind: 'vote' };
      case 'host_transfer':
      case 'host_transfer_waiting': return { ...base, kind: 'transfer' };
      case 'credit_switch': return { ...base, kind: 'credit' };
      case 'match_ended': return { ...base, kind: 'recap' };
      case 'rejected': return { ...base, kind: 'rejected', memberId: ev.memberId ?? undefined };
      default: return base;
    }
  }

  /** 域事件 → 服务端模板文案（模型不参与，保证所有客户端一致）。 */
  private textOf(ev: DomainEvent): string {
    const name = (id: string | null | undefined): string => getMember(this.room, id)?.name ?? '某位玩家';
    switch (ev.type) {
      case 'turn_started': return TEXT.turnStarted(name(ev.memberId), Math.round(this.room.config.perTurnSec), ev.phase === 'GRACE');
      case 'grace_started': return TEXT.graceStarted(this.room.config.graceSec);
      case 'turn_skipped': return TEXT.turnSkipped(name(ev.memberId), ev.reason);
      case 'turn_settled': return '';
      case 'member_state_changed': return TEXT.memberStateChanged(name(ev.memberId), ev.line, ev.to);
      case 'room_paused': return TEXT.roomPaused(ev.reason);
      case 'room_resumed': return TEXT.roomResumed;
      case 'vote_opened': return TEXT.voteOpened(ev.voteType, this.room.config.voteDurationSec);
      case 'vote_settled': return TEXT.voteSettled(ev.result);
      case 'credit_switch': return ev.reason === 'MEMBER_VOTE'
        ? TEXT.creditGranted(this.room.credit.grantLeft || this.deps.grantBudgetCalls)
        : `额度来源切换：${ev.from} → ${ev.to}（${ev.reason}）`;
      case 'ai_blocked': return TEXT.aiBlocked(ev.reasonCode);
      case 'ai_recovered': return TEXT.aiRecovered;
      case 'host_transfer': return TEXT.hostTransfer(name(ev.from), name(ev.to));
      case 'host_transfer_waiting': return TEXT.hostWaiting;
      case 'hint_granted': {
        const left = `${this.room.config.hintQuotaPerMember - (getMember(this.room, ev.memberId)?.hintsUsedT12 ?? 0)} / T3 ${Math.max(0, this.room.config.hintTier3Max - this.room.hint.tier3Used)}`;
        const fact = this.currentPuzzle()?.facts.find((f) => f.id === ev.factId);
        return TEXT.hintGranted(ev.tier, fact?.text ?? '', left);
      }
      case 'guess_result': return ev.verdict === 'hit' ? TEXT.guessHit(name(ev.memberId))
        : ev.verdict === 'partial' ? TEXT.guessPartial(name(ev.memberId), ev.hits, ev.total)
          : TEXT.guessMiss(name(ev.memberId));
      case 'match_ended': return TEXT.matchEnded(ev.result, ev.reason);
      case 'rejected': return TEXT.submitRejected(ev.code);
      default: return '';
    }
  }

  /** 落库：房间 + 成员 + 投票 + 对局结束（在队列内调用）。 */
  persist(): void {
    const keyStates = new Map<string, { state: string; mask: string | null; formerHost: boolean }>();
    for (const [id, v] of this.keyStates) keyStates.set(id, { state: v.state, mask: v.mask, formerHost: v.formerHost });
    this.deps.store.saveRoom(this.room, keyStates);
    if (this.room.vote) this.deps.store.saveVote(this.room.id, this.room.vote);
    // 对局结束时同步 matches：aborted 不写 reveal_at（复盘门禁据此拒绝揭晓汤底）
    if (this.room.status === 'settled' && this.room.result) {
      const aborted = this.room.result.result === 'aborted';
      this.deps.store.endMatch(this.room.id, this.room.result.result, this.room.result.reason, Date.now(), aborted ? null : Date.now());
    }
  }

  /** 应用一组域事件：广播 + 落库（结构性变化后再补一份快照，避免客户端 view 陈旧）。 */
  private apply(events: DomainEvent[]): void {
    this.emit(events);
    this.persist();
    if (events.some((e) => STRUCTURAL_EVENTS.has(e.type))) this.broadcastSnapshot();
  }

  /** 全量快照广播：成员状态、回合、投票、额度、复盘等结构性变化后使用。 */
  broadcastSnapshot(): void {
    this.broadcast((memberId) => ({ t: 'snapshot', serverTime: this.now, view: this.view(memberId) }));
  }

  // ---------------------------------------------------------------- 视图
  currentPuzzle(): Puzzle | null {
    return this.room.puzzleId ? this.deps.store.getPuzzle(this.room.puzzleId) : null;
  }

  keyStateOf(memberId: string): { state: 'none' | 'active' | 'suspended' | 'destroyed'; mask: string | null; formerHost: boolean } {
    return this.keyStates.get(memberId) ?? { state: 'none', mask: null, formerHost: false };
  }

  setKeyState(memberId: string, state: 'none' | 'active' | 'suspended' | 'destroyed', mask: string | null, formerHost?: boolean): void {
    const prev = this.keyStateOf(memberId);
    const nextFormer = formerHost ?? prev.formerHost;
    this.keyStates.set(memberId, { state, mask, formerHost: nextFormer });
    this.deps.store.setMemberKeyState(memberId, state, mask, nextFormer);
  }

  /** 加入成员（在队列内完成，并广播快照让所有人看到成员列表变化）。 */
  async addMember(member: CoreMember): Promise<void> {
    await this.enqueue(() => {
      const isFirst = this.room.members.length === 0 || this.room.hostId === null;
      this.room = {
        ...this.room,
        members: [...this.room.members, member],
        hostId: isFirst ? member.id : this.room.hostId,
        turnOrder: member.role === 'spectator' ? this.room.turnOrder : [...this.room.turnOrder, member.id],
        updatedAt: this.now,
        stateVersion: this.room.stateVersion + 1,
      };
      this.persist();
      this.broadcast((mid) => ({ t: 'snapshot', serverTime: this.now, view: this.view(mid) }));
      this.deps.store.audit({ action: member.role === 'spectator' ? 'spectator_joined' : 'member_joined', roomId: this.room.id, subject: member.id });
    });
  }

  /** 离开房间：从成员表移除（主动退出；断线不调用本方法）。 */
  async removeMember(memberId: string): Promise<void> {
    await this.enqueue(() => {
      if (!getMember(this.room, memberId)) return;
      const members = this.room.members.filter((m) => m.id !== memberId);
      const nextHost = this.room.hostId === memberId ? (members.find((m) => m.role !== 'spectator')?.id ?? null) : this.room.hostId;
      this.room = {
        ...this.room,
        members,
        hostId: nextHost,
        turnOrder: this.room.turnOrder.filter((id) => id !== memberId),
        updatedAt: this.now,
        stateVersion: this.room.stateVersion + 1,
      };
      this.persist();
      this.broadcast((mid) => ({ t: 'snapshot', serverTime: this.now, view: this.view(mid) }));
      this.deps.store.audit({ action: 'member_left', roomId: this.room.id, subject: memberId });
    });
  }

  /** 连接建立：标记在线（消息处理器必须先注册，再调用本方法）。 */
  async markOnline(memberId: string): Promise<void> {
    await this.enqueue(() => {
      if (!getMember(this.room, memberId)) return;
      this.room = {
        ...this.room,
        members: this.room.members.map((m) => (m.id === memberId
          ? { ...m, conn: 'connected' as const, activity: 'active' as const, lastHeartbeatAt: this.now, lastActivityAt: this.now }
          : m)),
      };
      this.persist();
    });
  }

  /** 连接关闭：进入断连线（不立即剔除席位，由移交与回收逻辑接手）。 */
  async markOffline(memberId: string): Promise<void> {
    if (this.hasSession(memberId)) return;
    await this.enqueue(() => {
      if (!getMember(this.room, memberId)) return;
      this.room = {
        ...this.room,
        members: this.room.members.map((m) => (m.id === memberId
          ? { ...m, conn: 'disconnected' as const, lastHeartbeatAt: this.now - 60000 - 1 }
          : m)),
      };
      this.persist();
      this.broadcast((mid) => ({ t: 'snapshot', serverTime: this.now, view: this.view(mid) }));
    });
  }

  /** 心跳 / 活动上报（客户端只上报原始信号，状态由服务端推导）。 */
  async reportSignal(memberId: string, kind: 'heartbeat' | 'activity', hidden: boolean): Promise<void> {
    await this.enqueue(() => {
      if (!getMember(this.room, memberId)) return;
      this.room = {
        ...this.room,
        members: this.room.members.map((m) => (m.id === memberId
          ? {
            ...m,
            conn: 'connected' as const,
            hidden,
            lastHeartbeatAt: this.now,
            ...(kind === 'activity' ? { lastActivityAt: this.now, activity: 'active' as const } : {}),
          }
          : m)),
      };
      this.persist();
    });
  }

  /** 恢复候选题目列表。
   *  无状态运行时（Cloudflare D1 方案）每个请求都会重建 RoomRuntime，内存里的 candidates 会丢失，
   *  因此需要从持久化的投票记录（vote.puzzleIds）或题库筛选结果里恢复出来。 */
  setCandidates(puzzleIds: string[]): void {
    this.candidates = [...puzzleIds];
  }

  /** 候选题目 id 列表（只读，便于调试与测试）。 */
  candidateIds(): string[] {
    return [...this.candidates];
  }

  view(viewerId: string): RoomView {
    const puzzle = this.currentPuzzle();
    const candidatePuzzles = this.candidates
      .map((id) => this.deps.store.getPuzzle(id))
      .filter((p): p is Puzzle => Boolean(p));
    const room = toPublicRoom(this.room, viewerId, {
      serverTime: this.now,
      puzzle,
      candidates: candidatePuzzles,
      keyOf: (memberId) => {
        const k = this.keyStateOf(memberId);
        return { hasKey: k.state === 'active' || k.state === 'suspended', keyMask: k.mask, keyState: k.state, formerHost: k.formerHost };
      },
    });
    // 运行时兜底断言：投影里绝不能出现汤底/事实点/密钥形态字符串
    // （汤面属于合法公开文本，因此作为 publicText 传入，避免把汤面本身的用词误判为泄露）
    if (puzzle) assertNoLeak(room, { truth: puzzle.truth.truth, facts: puzzle.facts, publicText: puzzle.surface });
    const me = getMember(this.room, viewerId);
    return {
      room,
      timeline: this.timeline.slice(-200),
      you: {
        memberId: viewerId,
        isHost: this.room.hostId === viewerId,
        canSubmit: Boolean(me) && this.room.turn.memberId === viewerId
          && (this.room.turn.phase === 'ACTIVE' || this.room.turn.phase === 'GRACE')
          && this.room.status === 'playing',
        canHintT12: Math.max(0, this.room.config.hintQuotaPerMember - (me?.hintsUsedT12 ?? 0)),
        canHintT3: Math.max(0, this.room.config.hintTier3Max - this.room.hint.tier3Used),
        guessLeft: Math.max(0, this.room.config.guessMaxPerMember - (me?.guessesUsed ?? 0)),
        hintCooldownLeftMs: Math.max(0, (me?.lastHintAt ?? 0) + this.room.config.hintCooldownSec * 1000 - this.now),
        nextGuessInRounds: this.nextGuessInRounds(this.room.roundNo),
      },
      ...(candidatePuzzles.length > 0
        ? {
          candidates: candidatePuzzles.map((p) => {
            const pub = toPublicPuzzle(p);
            return { id: pub.id, title: pub.title, surface: pub.surface, difficulty: pub.difficulty, rating: pub.rating, tags: pub.tags, sensitiveTags: pub.sensitiveTags, estMinutes: pub.estMinutes };
          }),
        }
        : {}),
    };
  }

  private nextGuessInRounds(roundNo: number): number {
    const every = this.room.config.guessEveryRounds;
    if (roundNo <= 1) return 0;
    const mod = (roundNo - 1) % every;
    return mod === 0 ? 0 : every - mod;
  }

  eventsSince(seq: number): BufferedEvent[] {
    return this.buffer.filter((e) => e.seq > seq);
  }

  // ---------------------------------------------------------------- 开局
  async startMatch(memberId: string, mode: 'vote' | 'pick', puzzleId?: string): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    if (this.room.status !== 'waiting') return { ok: false, code: 'NOT_ALLOWED' };
    const list = this.deps.store.listPuzzles({
      ratingMax: this.room.config.ratingMax,
      difficultyMin: this.room.config.difficultyMin,
      difficultyMax: this.room.config.difficultyMax,
    });
    if (list.length === 0) return { ok: false, code: 'NOT_ALLOWED' };

    if (mode === 'pick') {
      const chosen = puzzleId ? list.find((p) => p.id === puzzleId) : list[Math.floor(this.deps.rand() * list.length)];
      if (!chosen) return { ok: false, code: 'NOT_ALLOWED' };
      return this.enqueue(() => {
        if (this.room.status !== 'waiting') return { ok: false as const, code: 'NOT_ALLOWED' as ActionReject };
        this.lockPuzzle(chosen.id);
        return { ok: true as const };
      });
    }
    return this.enqueue(() => {
      if (this.room.status !== 'waiting') return { ok: false as const, code: 'NOT_ALLOWED' as ActionReject };
      const shuffled = [...list].sort(() => this.deps.rand() - 0.5);
      this.candidates = shuffled.slice(0, Math.min(this.room.config.candidateCount, shuffled.length)).map((p) => p.id);
      const out = reduce(this.room, { type: 'VOTE_OPEN', voteType: 'puzzle_choice', voteId: this.deps.newId('vote'), puzzleIds: this.candidates }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
      return { ok: true as const };
    });
  }

  private lockPuzzle(puzzleId: string): void {
    this.candidates = [];
    const out = reduce(this.room, { type: 'MATCH_BEGIN', puzzleId }, this.ctx());
    this.room = out.room;
    this.matchId = this.deps.store.startMatch(this.room.id, puzzleId, this.room.config, this.room.turnOrder, this.room.credit.mode, Date.now());
    this.apply(out.events);
    const puzzle = this.currentPuzzle();
    if (!puzzle) return;
    this.timeline.push({ seq: ++this.room.eventSeq, kind: 'system', at: this.now, text: `题目已锁定：《${puzzle.title}》（难度 ${puzzle.difficulty} · ${puzzle.rating}${puzzle.tags.length ? ' · ' + puzzle.tags.join('/') : ''}）` });
    this.timeline.push({ seq: ++this.room.eventSeq, kind: 'system', at: this.now, text: `汤面：${puzzle.surface}` });
    this.persist();
    this.broadcast((memberId) => ({ t: 'snapshot', serverTime: this.now, view: this.view(memberId) }));
  }

  // ---------------------------------------------------------------- 提交与判定
  async submit(memberId: string, text: string, clientSubmitId: string, turnSeq: number): Promise<Result> {
    const receivedAt = this.now;
    const precheck = canSubmit(this.room, memberId, turnSeq, receivedAt, text);
    if (precheck) {
      await this.enqueue(() => { this.emit([{ type: 'rejected', code: precheck, memberId }]); });
      return { ok: false, code: precheck };
    }
    // 幂等重放：同一 clientSubmitId 重复提交不产生第二次判定
    if (this.submittedByTurn.get(turnSeq) === clientSubmitId) return { ok: true };

    const accepted = await this.enqueue(() => {
      const again = canSubmit(this.room, memberId, turnSeq, receivedAt, text);
      if (again) {
        this.emit([{ type: 'rejected', code: again, memberId }]);
        return { ok: false as const, code: again };
      }
      this.submittedByTurn.set(turnSeq, clientSubmitId);
      this.judging.add(turnSeq);
      const out = reduce(this.room, { type: 'SUBMIT_ACCEPTED', memberId }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
      return { ok: true as const };
    });
    if (!accepted.ok) return accepted;

    // ---- 以下在房间队列之外执行（模型调用可能长达 20 秒）----
    const puzzle = this.currentPuzzle();
    if (!puzzle) {
      await this.enqueue(() => {
        this.judging.delete(turnSeq);
        const out = reduce(this.room, { type: 'JUDGE_FAILED' }, this.ctx());
        this.room = out.room;
        this.apply(out.events);
      });
      return { ok: true };
    }

    // 房主自备 Key 与平台额度**互不依赖**：服务端没配置任何模型额度时，
    // 房主自己填的 Key 就是唯一的真实模型来源（此前这里被 realModelEnabled 挡住，
    // 导致"服务端没配 Key"时房主填了 Key 也仍走内置模拟主持人）。
    const credential = await this.resolveCredential();
    const outcome = await this.deps.host.judge({
      roomId: this.room.id, matchId: this.matchId, turnSeq, question: text, puzzle, credential,
    });

    await this.enqueue(() => {
      this.judging.delete(turnSeq);
      if (outcome.kind === 'ok') {
        const result = outcome.result;
        const q: QuestionRecord = {
          id: this.deps.newId('q'), roomId: this.room.id, matchId: this.matchId, turnSeq,
          memberId, text, answer: result.answer, reasonCode: result.reasonCode, source: result.source,
          late: this.room.turn.lateSubmit, matchedFactIds: result.matchedFactIds,
          explain: result.explain ?? null, createdAt: Date.now(),
        };
        this.deps.store.insertQuestion(q);
        const before = this.room.revealedFacts.length;
        const reveal = reduce(this.room, { type: 'FACT_REVEALED', factIds: result.matchedFactIds }, this.ctx());
        this.room = reveal.room;
        const unlocked = this.room.revealedFacts.length - before;
        this.timeline.push({
          seq: ++this.room.eventSeq, kind: 'question', at: this.now, memberId, text,
          answer: result.answer, reasonCode: result.reasonCode, source: result.source,
          explain: result.explain ?? null,
          meta: `来源：${result.source === 'cache' ? '判定缓存' : result.source === 'rule' ? '规则拦截' : '模型映射'}${unlocked > 0 ? ` · 解锁 ${unlocked} 个事实点` : ''}`,
        });
        const out = reduce(this.room, { type: 'JUDGE_DONE' }, this.ctx());
        this.room = out.room;
        this.apply(out.events);
        this.deps.store.bumpUsage(outcome.usedSource === 'host_key' ? 'host' : outcome.usedSource === 'site_fallback' ? 'site' : 'mock', Date.now(), outcome.usedSource === 'none' ? 0 : 1);
        return;
      }

      // 不可重试失败 → 中断 + 房主告警；**绝不自动降级到站点额度**（《阶段4》§3）
      this.deps.logger.warn('judge_failed', { room_id: this.room.id, turn_seq: turnSeq, code: outcome.errorClass, attempts: outcome.attempts });
      this.deps.store.bumpUsage('site', Date.now(), 0, 0, 1);
      const blocked = reduce(this.room, { type: 'CREDIT_BLOCK', reasonCode: outcome.errorClass }, this.ctx());
      this.room = blocked.room;
      this.apply(blocked.events);
      this.deps.store.audit({ action: 'ai_blocked', roomId: this.room.id, subject: outcome.errorClass, result: outcome.message });
    });
    return { ok: true };
  }

  /** 取当前应当使用的凭据：所有权 + 状态 + TTL 三重校验（R1）。 */
  private async resolveCredential(): Promise<{ apiKey: string; baseUrl: string; model: string; provider: string } | null> {
    const cred = this.deps.store.roomCredential(this.room.id);
    if (!cred || cred.state !== 'active' || !cred.blob) return null;
    const hostPlayerId = getMember(this.room, this.room.hostId)?.playerId ?? null;
    if (!hostPlayerId || cred.ownerPlayerId !== hostPlayerId) return null;
    if (cred.ttlExpiresAt !== null && this.now >= cred.ttlExpiresAt) return null;
    try {
      const apiKey = await this.deps.decrypt(cred);
      return { apiKey, baseUrl: credentialBaseUrl(cred), model: cred.model, provider: cred.provider };
    } catch (e) {
      this.deps.logger.error('credential_decrypt_failed', { room_id: this.room.id, code: (e as Error).message });
      return null;
    }
  }

  // ---------------------------------------------------------------- 提示 / 揭秘
  async requestHint(memberId: string, tier: 1 | 2 | 3): Promise<Result<{ text: string }>> {
    // 提示是可选玩法：默认关闭（config.hintsEnabled=false），关闭时一律拒绝
    if (!this.room.config.hintsEnabled) return { ok: false, code: 'HINTS_DISABLED' };
    const puzzle = this.currentPuzzle();
    const member = getMember(this.room, memberId);
    if (!puzzle || !member) return { ok: false, code: 'NOT_ALLOWED' };
    if (this.room.status !== 'playing') return { ok: false, code: 'MATCH_NOT_ACTIVE' };
    if (tier === 3) {
      if (this.room.hint.tier3Used >= this.room.config.hintTier3Max) return { ok: false, code: 'HINT_TIER3_EXHAUSTED' };
    } else if (member.hintsUsedT12 >= this.room.config.hintQuotaPerMember) {
      return { ok: false, code: 'HINT_QUOTA_EXHAUSTED' };
    }
    if (this.now - member.lastHintAt < this.room.config.hintCooldownSec * 1000) return { ok: false, code: 'HINT_COOLDOWN' };
    if (hintsExhausted(puzzle.facts, this.room.revealedFacts)) return { ok: false, code: 'HINT_NO_FACT' };

    return this.enqueue(() => {
      const meNow = getMember(this.room, memberId);
      if (!meNow) return { ok: false as const, code: 'NOT_ALLOWED' as ActionReject };
      if (this.now - meNow.lastHintAt < this.room.config.hintCooldownSec * 1000) return { ok: false as const, code: 'HINT_COOLDOWN' as ActionReject };
      const fact = pickHintFact(puzzle.facts, tier, this.room.revealedFacts);
      if (!fact) return { ok: false as const, code: 'HINT_NO_FACT' as ActionReject };
      // 提示文案由服务端模板渲染（模型不写文案），渲染后再过一次泄露检查
      // （排除它自己那条事实点，否则相似度必然为 1.0）
      const leak = isLeaky(fact.text, puzzle.truth.truth, puzzle.facts, { excludeFactId: fact.id, publicText: puzzle.surface });
      if (leak) {
        this.deps.logger.warn('hint_leak_blocked', { room_id: this.room.id, code: leak });
        return { ok: false as const, code: 'HINT_NO_FACT' as ActionReject };
      }
      const out = reduce(this.room, { type: 'HINT', memberId, tier, factId: fact.id }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
      return { ok: true as const, data: { text: fact.text } };
    });
  }

  async submitGuess(memberId: string, text: string): Promise<Result<{ verdict: string }>> {
    const puzzle = this.currentPuzzle();
    const member = getMember(this.room, memberId);
    if (!puzzle || !member) return { ok: false, code: 'NOT_ALLOWED' };
    if (this.room.status !== 'playing') return { ok: false, code: 'MATCH_NOT_ACTIVE' };
    if (this.room.roundNo > 1 && (this.room.roundNo - 1) % this.room.config.guessEveryRounds !== 0) return { ok: false, code: 'GUESS_NOT_IN_WINDOW' };
    if (member.guessesUsed >= this.room.config.guessMaxPerMember) return { ok: false, code: 'GUESS_ATTEMPTS_EXHAUSTED' };
    const trimmed = text.trim();
    if (trimmed.length < PLATFORM.guessMinLen) return { ok: false, code: 'GUESS_TOO_SHORT' };
    if (trimmed.length > PLATFORM.guessMaxLen) return { ok: false, code: 'TEXT_TOO_LONG' };

    const result = judgeGuess(trimmed, puzzle.facts);
    return this.enqueue(() => {
      const out = reduce(this.room, { type: 'GUESS', memberId, verdict: result.verdict, hits: result.hits, total: result.total }, this.ctx());
      this.room = out.room;
      this.room = { ...this.room, members: this.room.members.map((m) => (m.id === memberId ? { ...m, guessesUsed: m.guessesUsed + 1 } : m)) };
      this.apply(out.events);
      return { ok: true as const, data: { verdict: result.verdict } };
    });
  }

  // ---------------------------------------------------------------- 投票
  async castVote(memberId: string, choice: string): Promise<Result> {
    const vote = this.room.vote;
    if (!vote || vote.status !== 'open') return { ok: false, code: 'VOTE_NOT_OPEN' };
    if (!vote.eligibleAtOpen.includes(memberId)) return { ok: false, code: 'VOTE_NOT_ELIGIBLE' };
    const m = getMember(this.room, memberId);
    if (!m || m.conn !== 'connected' || m.activity !== 'active') return { ok: false, code: 'VOTE_NOT_ELIGIBLE' };
    return this.enqueue(() => {
      const out = reduce(this.room, { type: 'VOTE_CAST', memberId, choice }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
      this.settleVoteIfReady();
      return { ok: true as const };
    });
  }

  private settleVoteIfReady(): void {
    const vote = this.room.vote;
    if (!vote || vote.status !== 'open') return;
    const allVoted = vote.eligibleAtOpen.length > 0 && vote.eligibleAtOpen.every((id) => vote.ballots[id] !== undefined);
    if (!allVoted && this.now < vote.deadlineAt) return;
    const settle = reduce(this.room, { type: 'VOTE_SETTLE' }, this.ctx());
    this.room = settle.room;
    const events = [...settle.events];
    if (settle.selectedPuzzleId) {
      this.emit(events);
      this.lockPuzzle(settle.selectedPuzzleId);
      return;
    }
    if (settle.creditGranted) {
      const granted = reduce(this.room, { type: 'CREDIT_GRANT', calls: this.deps.grantBudgetCalls }, this.ctx());
      this.room = granted.room;
      this.grantCount += 1;
      this.grantCooldownUntil = this.now + this.deps.grantCooldownSec * 1000;
      this.deps.store.saveGrant(this.room.id, this.deps.newId('grant'), this.matchId, this.deps.grantBudgetCalls, 'MEMBER_VOTE', Date.now(), Date.now() + 3600_000);
      events.push(...granted.events);
    }
    this.apply(events);
  }

  // ---------------------------------------------------------------- 房主相关
  async resumeTransfer(memberId: string): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    if (this.room.transfer.state !== 'paused_for_resume') return { ok: false, code: 'NOT_ALLOWED' };
    return this.enqueue(() => {
      const out = reduce(this.room, { type: 'HOST_RESUME' }, this.ctx());
      this.room = out.room;
      this.resumeDeadline = 0;
      this.apply(out.events);
      return { ok: true as const };
    });
  }

  async returnHost(memberId: string): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    const former = this.room.members.find((m) => this.keyStateOf(m.id).formerHost);
    if (!former) return { ok: false, code: 'NOT_ALLOWED' };
    return this.enqueue(() => {
      const out = reduce(this.room, { type: 'HOST_RETURN', formerHostId: former.id }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
      return { ok: true as const };
    });
  }

  /** 归还后原房主决定是否重新启用自备 Key（复测通过才切回）。 */
  async reenableKey(memberId: string, yes: boolean): Promise<Result<{ reason: string }>> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    const cred = this.deps.store.roomCredential(this.room.id);
    if (!cred || cred.state !== 'suspended') return { ok: false, code: 'NOT_ALLOWED' };
    const hostPlayerId = getMember(this.room, memberId)?.playerId ?? null;
    if (!hostPlayerId || cred.ownerPlayerId !== hostPlayerId) return { ok: false, code: 'NOT_ALLOWED' };

    if (!yes) {
      this.deps.store.destroyCredential(cred.id, 'OWNER_DECLINED_REENABLE', Date.now());
      this.setKeyState(memberId, 'destroyed', null);
      return this.enqueue(() => {
        const out = reduce(this.room, { type: 'CREDIT_REVOKED_BY_OWNER' }, this.ctx());
        this.room = out.room;
        this.apply(out.events);
        return { ok: true as const, data: { reason: 'OWNER_DECLINED_REENABLE' } };
      });
    }
    // 复测：用库中密文解密后调用，全程不回读原文给任何人
    let apiKey: string;
    try {
      apiKey = await this.deps.decrypt(cred);
    } catch {
      return { ok: false, code: 'NOT_ALLOWED' };
    }
    const test = await this.deps.host.connectionTest({ apiKey, baseUrl: credentialBaseUrl(cred), model: cred.model });
    if (!test.ok) {
      this.deps.store.audit({ action: 'credential_revalidate_failed', roomId: this.room.id, subject: cred.id, result: test.reasonCode });
      return { ok: true, data: { reason: `REVALIDATE_FAILED:${test.reasonCode}` } };
    }
    this.deps.store.insertCredential({ ...cred, state: 'active', ttlExpiresAt: Date.now() + 24 * 3600 * 1000, suspendReason: null });
    this.setKeyState(memberId, 'active', cred.mask);
    return this.enqueue(() => {
      const out = reduce(this.room, { type: 'CREDIT_REVOKE', reason: 'HOST_RECOVERED' }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
      return { ok: true as const, data: { reason: 'HOST_RESTORED' } };
    });
  }

  /**
   * 房主提交/更新了自备 Key 之后调用：若对局正因 AI 中断而暂停（ai_blocked），
   * 就解除暂停并继续——否则房主修好了 Key 也永远卡在"等待房主处理"。
   * 只在确实 BLOCKED 时才产生状态变更（避免刷出无意义的事件）。
   */
  async restoreAfterKeyUpdate(memberId: string): Promise<Result<{ resumed: boolean }>> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    const cred = this.deps.store.roomCredential(this.room.id);
    if (!cred || cred.state !== 'active') return { ok: false, code: 'NOT_ALLOWED' };
    const blocked = this.room.ai.state === 'BLOCKED';
    return this.enqueue(() => {
      if (this.room.ai.state === 'BLOCKED') {
        const out = reduce(this.room, { type: 'CREDIT_RESTORED' }, this.ctx());
        this.room = out.room;
        this.apply(out.events);
      }
      return { ok: true as const, data: { resumed: blocked } };
    });
  }

  async declineReturn(memberId: string): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    const former = this.room.members.find((m) => this.keyStateOf(m.id).formerHost);
    if (!former) return { ok: false, code: 'NOT_ALLOWED' };
    const cred = this.deps.store.roomCredential(this.room.id);
    if (cred) this.deps.store.destroyCredential(cred.id, 'TRANSFER_DECLINED', Date.now());
    this.setKeyState(former.id, 'destroyed', null, false);
    this.deps.logger.info('host_transfer_declined', { room_id: this.room.id });
    return this.enqueue(() => {
      this.broadcast((mid) => ({ t: 'snapshot', serverTime: this.now, view: this.view(mid) }));
      return { ok: true as const };
    });
  }

  async skipTurn(memberId: string): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    if (this.room.status !== 'playing') return { ok: false, code: 'MATCH_NOT_ACTIVE' };
    if (this.hostSkipUsed >= PLATFORM.hostSkipMaxPerMatch) return { ok: false, code: 'NOT_ALLOWED' };
    return this.enqueue(() => {
      if (this.room.turn.phase !== 'ACTIVE' && this.room.turn.phase !== 'GRACE') return { ok: false as const, code: 'NOT_ALLOWED' as ActionReject };
      this.hostSkipUsed += 1;
      this.deps.store.audit({ action: 'host_skip_turn', roomId: this.room.id, actor: memberId, meta: { used: this.hostSkipUsed } });
      const out = reduce(this.room, { type: 'TURN_TICK' }, { ...this.ctx(), now: this.room.turn.graceDeadlineAt });
      this.room = out.room;
      this.apply(out.events);
      return { ok: true as const };
    });
  }

  async endMatch(memberId: string): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    return this.enqueue(() => {
      const out = reduce(this.room, { type: 'MATCH_END', result: 'aborted', reason: '房主结束了对局' }, this.ctx());
      this.room = out.room;
      // aborted 不揭晓汤底：reveal_at 保持 NULL
      this.deps.store.endMatch(this.room.id, 'aborted', '房主结束了对局', Date.now(), null);
      this.apply(out.events);
      return { ok: true as const };
    });
  }

  async updateConfig(memberId: string, patch: Partial<GameConfig>, expectedVersion: number): Promise<Result> {
    if (this.room.hostId !== memberId) return { ok: false, code: 'NOT_HOST' };
    if (expectedVersion !== this.room.configVersion) return { ok: false, code: 'NOT_ALLOWED', detail: { reason: 'CONFIG_CONFLICT', current: this.room.configVersion } };
    const started = this.room.status !== 'waiting';
    const validation = validateConfigChange(this.room.config, patch, started);
    if (!validation.ok) return { ok: false, code: 'NOT_ALLOWED', detail: { reason: 'INVALID_CONFIG', errors: validation.errors } };
    return this.enqueue(() => {
      this.room = {
        ...this.room,
        config: { ...this.room.config, ...patch },
        configVersion: this.room.configVersion + 1,
        stateVersion: this.room.stateVersion + 1,
        updatedAt: this.now,
      };
      this.deps.store.audit({ action: 'config_updated', roomId: this.room.id, actor: memberId, meta: { keys: Object.keys(patch), version: this.room.configVersion } });
      this.persist();
      this.broadcast((mid) => ({ t: 'snapshot', serverTime: this.now, view: this.view(mid) }));
      return { ok: true as const };
    });
  }

  revokeKey(memberId: string): Result {
    const cred = this.deps.store.roomCredential(this.room.id);
    const member = getMember(this.room, memberId);
    if (!member) return { ok: false, code: 'UNAUTHORIZED' };
    if (cred && cred.ownerPlayerId !== member.playerId) return { ok: false, code: 'NOT_ALLOWED' };
    void this.enqueue(() => {
      if (cred) this.deps.store.destroyCredential(cred.id, 'OWNER_REVOKED', Date.now());
      this.setKeyState(memberId, 'destroyed', null);
      const out = reduce(this.room, { type: 'CREDIT_REVOKED_BY_OWNER' }, this.ctx());
      this.room = out.room;
      this.apply(out.events);
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- 定时推进（只投递任务）
  async tickOnce(): Promise<void> {
    await this.enqueue(() => this.tick());
  }

  private tick(): void {
    const now = this.now;
    const events: DomainEvent[] = [];

    if (this.room.status === 'playing') {
      const turnTick = reduce(this.room, { type: 'TURN_TICK' }, this.ctx());
      this.room = turnTick.room;
      events.push(...turnTick.events);
    }

    if (now - this.lastPresenceTick >= 1000) {
      this.lastPresenceTick = now;
      const presence = reduce(this.room, { type: 'PRESENCE_TICK' }, this.ctx());
      this.room = presence.room;
      events.push(...presence.events);
    }

    // 房主断连 → 移交（挂机不触发；阈值与冷却见 core/host.ts）
    // 断连可能来自客户端上报的事件，也可能是上面扫描推导出来的，因此这里统一兜底：
    //   · 房主此刻 disconnected 且未进入 suspect → 进入 suspect
    //   · 房主此刻已恢复 connected 但还停在 suspect → **必须取消 suspect**
    //     （否则一次误判会永久留痕：后面的真实断连会绕过 30 秒宽限直接移交）
    const hostMember = getMember(this.room, this.room.hostId);
    if (hostMember && this.room.transfer.state === 'idle' && hostMember.conn === 'disconnected') {
      const suspect = reduce(this.room, { type: 'HOST_SUSPECT' }, this.ctx());
      this.room = suspect.room;
      events.push(...suspect.events);
    } else if (hostMember && this.room.transfer.state === 'suspect' && hostMember.conn === 'connected') {
      const back = reduce(this.room, { type: 'HOST_RECONNECTED' }, this.ctx());
      this.room = back.room;
      events.push(...back.events);
    }
    const gate = transferGate(this.room, now);
    if (gate.ok) {
      const toId = pickNewHost(this.room, now);
      if (toId) {
        const out = reduce(this.room, { type: 'HOST_TRANSFER', toId }, this.ctx());
        this.room = out.room;
        events.push(...out.events);
        if (out.suspendedKeyOwnerId) {
          const cred = this.deps.store.roomCredential(this.room.id);
          if (cred) this.deps.store.insertCredential({ ...cred, state: 'suspended', suspendReason: 'HOST_TRANSFERRED', ttlExpiresAt: Date.now() + 24 * 3600 * 1000 });
          this.setKeyState(out.suspendedKeyOwnerId, 'suspended', cred?.mask ?? null, true);
        }
        this.resumeDeadline = now + 20000;
        this.deps.store.audit({ action: 'host_transferred', roomId: this.room.id, subject: `${out.suspendedKeyOwnerId}->${toId}` });
      } else {
        const waiting = reduce(this.room, { type: 'HOST_TRANSFER_WAITING' }, this.ctx());
        this.room = waiting.room;
        events.push(...waiting.events);
      }
    }

    if (this.room.vote && this.room.vote.status === 'open' && now >= this.room.vote.deadlineAt) {
      this.settleVoteIfReady();
      return;
    }

    // AI 中断 + 房主无响应 → 自动发起额度降级投票（挂机与断连都算无响应）
    if (this.room.ai.state === 'BLOCKED' && this.room.ai.blockedAt !== null) {
      const waited = now - this.room.ai.blockedAt;
      const voteOpen = Boolean(this.room.vote && this.room.vote.type === 'fallback_credit' && this.room.vote.status === 'open');
      if (waited > PLATFORM.hostUnresponsiveSec * 1000 && !voteOpen
          && this.grantCount < this.deps.grantMaxPerMatch && now >= this.grantCooldownUntil && this.deps.siteQuotaAllows()) {
        const out = reduce(this.room, { type: 'VOTE_OPEN', voteType: 'fallback_credit', voteId: this.deps.newId('vote') }, this.ctx());
        this.room = out.room;
        events.push(...out.events);
      }
    }

    // 移交后 20 秒内新房主未点「继续」→ 自动继续（避免卡死）
    if (this.room.transfer.state === 'paused_for_resume' && this.resumeDeadline > 0 && now >= this.resumeDeadline) {
      const out = reduce(this.room, { type: 'HOST_RESUME' }, this.ctx());
      this.room = out.room;
      events.push(...out.events);
      this.resumeDeadline = 0;
    }

    if (now - this.lastSweep >= 30000) {
      this.lastSweep = now;
      const expired = this.deps.store.expireCredentials(Date.now());
      if (expired > 0) this.deps.logger.info('credentials_expired', { count: expired });
    }

    if (events.length > 0) this.apply(events);
    else this.persist();
  }

  /**
   * 复盘（汤底只在 settled 且非 aborted 时由服务端注入）。
   * **仅房主可看**：汤底揭晓属于主持人视角，其他玩家只知道自己这局的结果。
   */
  recap(viewerId: string): { ok: true; view: Record<string, unknown> } | { ok: false; code: string } {
    const member = getMember(this.room, viewerId);
    if (!member || member.role === 'spectator') return { ok: false, code: 'UNAUTHORIZED' };
    if (this.room.hostId !== viewerId) return { ok: false, code: 'NOT_HOST' };
    const match = this.deps.store.currentMatch(this.room.id);
    const puzzle = this.currentPuzzle();
    if (!match || !puzzle) return { ok: false, code: 'NOT_FOUND' };
    if (this.room.status !== 'settled') return { ok: false, code: 'MATCH_NOT_REVEALED' };
    const aborted = this.room.result?.result === 'aborted';
    const questions = this.deps.store.listQuestions(this.room.id).map((q) => ({
      turnSeq: q.turnSeq,
      memberId: q.memberId,
      memberName: getMember(this.room, q.memberId)?.name ?? '—',
      text: q.text,
      answer: q.answer,
      reasonCode: q.reasonCode,
      source: q.source,
      late: q.late,
    }));
    return {
      ok: true,
      view: {
        roomId: this.room.id,
        puzzle: toPublicPuzzle(puzzle),
        result: this.room.result,
        canRevealTruth: !aborted,
        truth: aborted ? null : puzzle.truth.truth,
        truthNote: aborted ? TEXT.recapBlocked : null,
        questions,
        members: this.room.members.map((m) => ({
          id: m.id, name: m.name, score: m.score, skipStreak: m.skipStreak,
          conn: m.conn, activity: m.activity, guessesUsed: m.guessesUsed,
          hintsUsedT12: m.hintsUsedT12, hintsUsedT3: m.hintsUsedT3,
        })),
        scaleVersion: 'scale-v1',
        promptVersion: PROMPT_VERSION,
      },
    };
  }
}

/** 房间注册表：房间码分配（含冷却）、房间查找、生命周期扫描。 */
export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly codeCooldown = new Map<string, number>();
  private readonly deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  get size(): number { return this.rooms.size; }

  all(): RoomRuntime[] { return [...this.rooms.values()]; }

  get(roomId: string): RoomRuntime | undefined { return this.rooms.get(roomId); }

  byCode(code: string): RoomRuntime | undefined {
    const upper = code.toUpperCase();
    for (const r of this.rooms.values()) if (r.room.code === upper) return r;
    return undefined;
  }

  allocateCode(): string {
    const now = this.deps.now();
    for (let i = 0; i < 50; i++) {
      const code = generateCode(this.deps.rand);
      const cooling = this.codeCooldown.get(code);
      if (cooling && now < cooling) continue;
      if (this.byCode(code)) continue;
      return code;
    }
    return generateCode(this.deps.rand);
  }

  create(config: GameConfig, now: number): RoomRuntime {
    const code = this.allocateCode();
    const id = this.deps.newId('room');
    const runtime = new RoomRuntime(emptyRoom(id, code, config, now), this.deps);
    this.rooms.set(id, runtime);
    runtime.persist();
    this.deps.store.audit({ action: 'room_created', roomId: id, meta: { code } });
    return runtime;
  }

  /** 服务器重启后恢复：进行中的对局一律进入暂停（内存态不可信）。 */
  restore(now: number): number {
    let resumed = 0;
    for (const { room } of this.deps.store.loadRooms()) {
      if (room.status === 'destroyed') continue;
      const restarted: CoreRoom = room.status === 'playing'
        ? { ...room, status: 'suspended', pauseReason: 'server_restart' }
        : room;
      const runtime = new RoomRuntime(restarted, this.deps);
      this.rooms.set(restarted.id, runtime);
      runtime.persist();
      resumed++;
    }
    if (resumed > 0) this.deps.logger.info('rooms_restored', { count: resumed });
    this.deps.store.audit({ action: 'server_started', meta: { resumed } });
    return resumed;
  }

  sweepLifecycle(now: number): void {
    for (const runtime of [...this.rooms.values()]) {
      const room = runtime.room;
      const idleFor = now - room.updatedAt;
      if (room.status === 'waiting' && now - room.createdAt > PLATFORM.roomWaitExpireSec * 1000) {
        this.destroy(runtime, now, 'WAIT_EXPIRED');
      } else if (room.status === 'settled' && idleFor > 24 * 3600 * 1000) {
        this.destroy(runtime, now, 'SETTLED_TIMEOUT');
      } else if (idleFor > PLATFORM.roomDestroySec * 1000) {
        this.destroy(runtime, now, 'IDLE_TIMEOUT');
      }
    }
  }

  destroy(runtime: RoomRuntime, now: number, reason: string): void {
    runtime.room = { ...runtime.room, status: 'destroyed', updatedAt: now };
    const cleared = this.deps.store.destroyRoomCredentials(runtime.room.id, now);
    runtime.persist();
    runtime.broadcast(() => ({ t: 'error', id: 'room', ok: false, code: 'ROOM_CLOSED', message: '房间已结束' }));
    this.codeCooldown.set(runtime.room.code, now + 24 * 3600 * 1000);
    this.rooms.delete(runtime.room.id);
    this.deps.store.audit({ action: 'room_destroyed', roomId: runtime.room.id, result: reason, meta: { clearedCredentials: cleared } });
    this.deps.logger.info('room_destroyed', { room_id: runtime.room.id, code: reason });
  }
}

export { CODE_LENGTH };



