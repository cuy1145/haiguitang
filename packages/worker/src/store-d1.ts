/**
 * D1 仓储（方案 A：无 Durable Objects）。
 *
 * 为什么能"零改动复用" RoomRuntime：
 *   Node 版仓储是同步接口（`saveRoom()` 立刻返回），而 D1 是异步的。
 *   于是把一次请求拆成三段，中间夹一个**请求级内存仓储**：
 *
 *    ① 预读（async，一次性）  ：房间 + 成员 + 当前对局 + 凭据 + 用量 + 判定缓存
 *    ② 纯计算（sync，复用原逻辑）：catch-up 补算 → 处理动作 → 生成事件
 *    ③ 写回（async，单事务批次）：房间行用 CAS 抢占版本，其余派生写入全部以新版本为条件
 *
 *   ③ 的写法保证原子性：
 *
 *     UPDATE rooms SET <全部内容>, state_version = state_version + 1 WHERE id=? AND state_version=?
 *     INSERT OR REPLACE INTO members(...) SELECT ... WHERE EXISTS(SELECT 1 FROM rooms WHERE id=? AND state_version=?)
 *     ...
 *
 *   第一批语句若影响 0 行说明有人抢先 → 重新预读并重放本次动作（最多 3 次）。
 *   这样"串行队列"由 D1 的写入串行 + CAS 重试等价替代，第 10 节的五条不变量继续成立。
 */
import type { CoreMember, CoreRoom, GameConfig, Puzzle, PuzzleFact, PuzzleMeta } from '@ht/core';
import { PROMPT_VERSION, PLATFORM, ngrams } from '@ht/core';
import type { RoomStorePort, VerdictCachePort } from '../../server/src/ports.ts';
import type { CredentialRecord, CredentialState } from '../../server/src/vault.ts';
import type { QuestionRecord, ChatRecord, VerdictCacheRow } from '../../server/src/store.ts';
import { seedPuzzles } from '../../server/src/data/seed-puzzles.ts';

interface Row { [k: string]: unknown }

export interface RoomSnapshot {
  room: CoreRoom;
  keyStates: Map<string, { state: string; mask: string | null; formerHost: boolean }>;
  credential: CredentialRecord | null;
  match: { id: string; puzzleId: string; startedAt: number; revealAt: number | null; result: string | null } | null;
  usage: { siteCalls: number; hostCalls: number };
  verdicts: Map<string, VerdictCacheRow>;
  questions: QuestionRecord[];
  /** 房主用 AI 现写的那道题（存在 rooms.puzzle_json 里）；getPuzzle 会优先返回它 */
  customPuzzle: Puzzle | null;
}

interface PendingStatement { sql: string; bindings: unknown[] }

/**
 * 派生写入里"房间当前版本号"的占位符，flush 时替换成真实版本号。
 *
 * ⚠️ 这里**不能**像以前那样用"值等于 0"当占位符：绑定里合法的 0 会被一起替换掉。
 * 真实故障：`questions.late`（0=非临界提交）被写成房间版本号，于是
 * `publicQuestionLog` 里 `late === true` 永远不成立 ——「上一轮为临界提交」提示直接消失，
 * 而且"非临界"反而变成了一个像版本号的怪值。
 */
const VERSION_PLACEHOLDER = '__ht_state_version__';

/** 题库是代码内常量（对应《阶段1》§1.5"题库可用文件维护"），因此读题库不需要查库。 */
const PUZZLES: Puzzle[] = seedPuzzles();
const PUZZLE_BY_ID = new Map(PUZZLES.map((p) => [p.id, p]));

export function verdictKeyOf(puzzleId: string, questionHash: string, promptVersion: string, factSetVersion: number): string {
  return `${puzzleId}|${questionHash}|${promptVersion}|${factSetVersion}`;
}

// ---------------------------------------------------------------- ① 预读
export async function loadSnapshot(db: D1Database, roomId: string, opts: { withQuestions?: boolean } = {}): Promise<RoomSnapshot | null> {
  const roomRow = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first<Row>();
  if (!roomRow) return null;
  const room = rowToRoom(roomRow);

  const memberRows = (await db.prepare('SELECT * FROM members WHERE room_id = ? ORDER BY join_seq').bind(roomId).all<Row>()).results ?? [];
  room.members = memberRows.map(rowToMember);
  const keyStates = new Map<string, { state: string; mask: string | null; formerHost: boolean }>();
  for (const r of memberRows) {
    keyStates.set(String(r.id), { state: String(r.key_state ?? 'none'), mask: (r.key_mask as string | null) ?? null, formerHost: Number(r.former_host) === 1 });
  }

  const credRow = await db.prepare("SELECT * FROM credentials WHERE room_id = ? AND state != 'destroyed' ORDER BY created_at DESC LIMIT 1").bind(roomId).first<Row>();
  const matchRow = await db.prepare('SELECT * FROM matches WHERE room_id = ? ORDER BY started_at DESC LIMIT 1').bind(roomId).first<Row>();

  const period = periodKey(Date.now());
  const usageRows = (await db.prepare('SELECT scope, calls FROM usage_counters WHERE period = ? AND scope IN (?, ?)').bind(period, 'site', 'host').all<Row>()).results ?? [];
  const usage = { siteCalls: 0, hostCalls: 0 };
  for (const r of usageRows) {
    if (r.scope === 'site') usage.siteCalls = Number(r.calls ?? 0);
    if (r.scope === 'host') usage.hostCalls = Number(r.calls ?? 0);
  }

  const verdicts = new Map<string, VerdictCacheRow>();
  if (room.puzzleId) {
    const rows = (await db.prepare('SELECT * FROM verdict_cache WHERE puzzle_id = ? LIMIT 2000').bind(room.puzzleId).all<Row>()).results ?? [];
    for (const r of rows) {
      const row: VerdictCacheRow = {
        puzzleId: String(r.puzzle_id), questionHash: String(r.question_hash), promptVersion: String(r.prompt_version),
        factSetVersion: Number(r.fact_set_version), answer: String(r.answer), reasonCode: String(r.reason_code),
        matchedFactIds: JSON.parse(String(r.matched_json ?? '[]')), hitCount: Number(r.hit_count), createdAt: Number(r.created_at),
      };
      verdicts.set(verdictKeyOf(row.puzzleId, row.questionHash, row.promptVersion, row.factSetVersion), row);
    }
  }

  const questions: QuestionRecord[] = [];
  if (opts.withQuestions) {
    const rows = (await db.prepare('SELECT * FROM questions WHERE room_id = ? ORDER BY turn_seq').bind(roomId).all<Row>()).results ?? [];
    for (const r of rows) {
      questions.push({
        id: String(r.id), roomId: String(r.room_id), matchId: (r.match_id as string | null) ?? null,
        turnSeq: Number(r.turn_seq), memberId: String(r.member_id), text: String(r.text), answer: String(r.answer),
        reasonCode: String(r.reason_code), source: String(r.source), late: Number(r.late) === 1,
        matchedFactIds: JSON.parse(String(r.matched_json ?? '[]')),
        explain: r.explain === null || r.explain === undefined ? null : String(r.explain),
        answerModel: r.answer_model === null || r.answer_model === undefined ? null : String(r.answer_model),
        createdAt: Number(r.created_at),
      });
    }
  }

  return {
    room,
    keyStates,
    credential: credRow ? rowToCredential(credRow) : null,
    match: matchRow ? {
      id: String(matchRow.id), puzzleId: String(matchRow.puzzle_id), startedAt: Number(matchRow.started_at),
      revealAt: matchRow.reveal_at === null || matchRow.reveal_at === undefined ? null : Number(matchRow.reveal_at),
      result: (matchRow.result as string | null) ?? null,
    } : null,
    usage,
    verdicts,
    questions,
    customPuzzle: parseCustomPuzzle(roomRow.puzzle_json),
  };
}

/** rooms.puzzle_json → Puzzle（解析失败一律当作"没有自定义题目"，绝不影响开局） */
function parseCustomPuzzle(raw: unknown): Puzzle | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Puzzle;
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && Array.isArray(parsed.facts)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- ② 请求级仓储（同步读 + 缓冲写）
export class D1RoomStore implements RoomStorePort, VerdictCachePort {
  private readonly pending: PendingStatement[] = [];
  /** 写回时用于 CAS 的期望版本；由 prepareFlush 设置 */
  private expectedVersion: number;
  private readonly roomId: string;
  private readonly savedKeyStates = new Map<string, { state: string; mask: string | null; formerHost: boolean }>();
  private readonly knownQuestions: QuestionRecord[];
  private readonly creds: CredentialRecord[];
  private readonly db: D1Database;
  readonly snapshot: RoomSnapshot;
  /** 本房间的 AI 创作题目（存在 rooms.puzzle_json） */
  private customPuzzle: Puzzle | null;
  private readonly matches: RoomSnapshot['match'];
  /** 本次请求客户端的 IP 哈希（拿不到合法 IP 或没配置密钥时为 null）。原始 IP 绝不落库。 */
  private readonly clientIpHash: string | null;

  /**
   * 注意：刻意**不用** TypeScript 的"参数属性"（`constructor(private readonly db: ...)`）——
   * Node 的 type-stripping 不支持它，会导致这个文件无法被 `node --test` 直接导入
   * （Worker 侧因此一直没有测试）。手动赋值保持"零构建即可测试"。
   */
  constructor(db: D1Database, snapshot: RoomSnapshot, clientIpHash: string | null = null) {
    this.db = db;
    this.snapshot = snapshot;
    this.roomId = snapshot.room.id;
    this.expectedVersion = snapshot.room.stateVersion;
    this.knownQuestions = [...snapshot.questions];
    this.creds = snapshot.credential ? [snapshot.credential] : [];
    this.matches = snapshot.match;
    this.customPuzzle = snapshot.customPuzzle;
    this.clientIpHash = clientIpHash;
  }

  // ---- 读：全部走预读快照（题库走代码常量，房间自带的 AI 题目优先）
  getPuzzle(id: string): Puzzle | null {
    if (this.customPuzzle && this.customPuzzle.id === id) return this.customPuzzle;
    return PUZZLE_BY_ID.get(id) ?? null;
  }

  /** 房主用 AI 现写的题：只写本房间的 rooms.puzzle_json，不污染全局题库 */
  saveRoomPuzzle(puzzle: Puzzle): void {
    this.customPuzzle = puzzle;
  }

  listPuzzles(filter?: { ratingMax?: 'L1' | 'L2' | 'L3'; difficultyMin?: number; difficultyMax?: number; tags?: string[] }): Puzzle[] {
    const rank: Record<string, number> = { L1: 1, L2: 2, L3: 3 };
    return PUZZLES.filter((p) => {
      if (!filter) return true;
      if (filter.ratingMax && (rank[p.rating] ?? 3) > (rank[filter.ratingMax] ?? 3)) return false;
      if (filter.difficultyMin !== undefined && p.difficulty < filter.difficultyMin) return false;
      if (filter.difficultyMax !== undefined && p.difficulty > filter.difficultyMax) return false;
      if (filter.tags && filter.tags.length > 0 && !filter.tags.some((t) => p.tags.includes(t))) return false;
      return true;
    });
  }

  listQuestions(roomId: string): QuestionRecord[] { void roomId; return [...this.knownQuestions]; }

  memberKeyStates(roomId: string): Map<string, { state: string; mask: string | null; formerHost: boolean }> {
    void roomId;
    return new Map(this.snapshot.keyStates);
  }

  roomCredential(roomId: string): CredentialRecord | null {
    void roomId;
    return this.creds.find((c) => c.state !== 'destroyed') ?? null;
  }

  getCredential(id: string): CredentialRecord | null { return this.creds.find((c) => c.id === id) ?? null; }

  currentMatch(roomId: string): RoomSnapshot['match'] { void roomId; return this.matches; }

  usage(scope: string, now: number): { calls: number; cost: number; blocked: number; grants: number } {
    void now;
    const calls = scope === 'site' ? this.snapshot.usage.siteCalls : this.snapshot.usage.hostCalls;
    return { calls, cost: 0, blocked: 0, grants: 0 };
  }

  getVerdict(puzzleId: string, questionHash: string, promptVersion: string, factSetVersion: number): VerdictCacheRow | null {
    return this.snapshot.verdicts.get(verdictKeyOf(puzzleId, questionHash, promptVersion, factSetVersion)) ?? null;
  }

  loadRooms(): Array<{ room: CoreRoom; code: string }> { return [{ room: this.snapshot.room, code: this.snapshot.room.code }]; }

  // ---- 写：全部缓冲，等待 ③ 一次性提交
  putVerdict(row: VerdictCacheRow): void {
    this.snapshot.verdicts.set(verdictKeyOf(row.puzzleId, row.questionHash, row.promptVersion, row.factSetVersion), row);
    this.pending.push({
      sql: `INSERT INTO verdict_cache(puzzle_id, question_hash, prompt_version, fact_set_version, answer, reason_code, matched_json, hit_count, created_at)
            VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(puzzle_id, question_hash, prompt_version, fact_set_version) DO UPDATE SET hit_count = hit_count + 1`,
      bindings: [row.puzzleId, row.questionHash, row.promptVersion, row.factSetVersion, row.answer, row.reasonCode, JSON.stringify(row.matchedFactIds), row.hitCount, row.createdAt],
    });
  }

  /**
   * 全员讨论区：追加一条消息（与房间写入同事务）。
   * `chat_seq` 由 SQL 里的 MAX+1 原子计算，并用 (room_id, member_id, client_message_id) 唯一约束保证幂等
   * —— 网络重试不会写出重复消息。守卫仍挂在房间 state_version 上：房间被清理就不写了。
   */
  appendChat(msg: ChatRecord): void {
    this.pending.push({
      sql: `INSERT OR IGNORE INTO room_chat(id, room_id, chat_seq, member_id, text, client_message_id, match_no, created_at)
            SELECT ?, ?, (SELECT COALESCE(MAX(chat_seq), 0) + 1 FROM room_chat WHERE room_id = ?), ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [msg.id, msg.roomId, msg.roomId, msg.memberId, msg.text, msg.clientMessageId, msg.matchNo, msg.createdAt, this.roomId, VERSION_PLACEHOLDER],
    });
  }

  insertQuestion(q: QuestionRecord): void {    if (this.knownQuestions.some((x) => x.turnSeq === q.turnSeq)) return;
    this.knownQuestions.push(q);
    this.pending.push({
      sql: `INSERT OR IGNORE INTO questions(id, room_id, match_id, turn_seq, member_id, text, answer, reason_code, source, late, matched_json, explain, answer_model, client_submit_id, created_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [q.id, q.roomId, q.matchId, q.turnSeq, q.memberId, q.text, q.answer, q.reasonCode, q.source, q.late ? 1 : 0, JSON.stringify(q.matchedFactIds), q.explain ?? null, q.answerModel ?? null, null, q.createdAt, this.roomId, VERSION_PLACEHOLDER],
    });
  }

  saveVote(roomId: string, vote: CoreRoom['vote']): void {
    if (!vote) return;
    this.pending.push({
      sql: `INSERT OR REPLACE INTO votes(id, room_id, type, status, ballots_json, eligible_json, opened_at, deadline_at, result, tally_json)
            SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [vote.id, roomId, vote.type, vote.status, JSON.stringify(vote.ballots), JSON.stringify(vote.eligibleAtOpen), vote.openedAt, vote.deadlineAt, vote.result ?? null, vote.tally ? JSON.stringify(vote.tally) : null, this.roomId, VERSION_PLACEHOLDER],
    });
  }

  saveRoom(room: CoreRoom, keyStates: Map<string, { state: string; mask: string | null; formerHost: boolean }>): void {
    // 记录待写内容；真正的 SQL（含 CAS 与派生写入）由 buildFlushStatements() 生成
    this.pendingRoom = room;
    for (const [id, v] of keyStates) this.savedKeyStates.set(id, v);
  }

  setMemberKeyState(memberId: string, state: string, mask: string | null, formerHost?: boolean): void {
    const prev = this.savedKeyStates.get(memberId) ?? this.snapshot.keyStates.get(memberId) ?? { state: 'none', mask: null, formerHost: false };
    this.savedKeyStates.set(memberId, { state, mask, formerHost: formerHost ?? prev.formerHost });
  }

  /**
   * 吊销某成员的所有会话（房主踢人时调用）。
   * 与房间写入同事务：房间 CAS 成功才会真正删掉会话，避免"踢了人却没删掉会话"。
   */
  revokeMemberSessions(memberId: string): void {
    this.pending.push({
      sql: 'DELETE FROM sessions WHERE member_id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)',
      bindings: [memberId, this.roomId, VERSION_PLACEHOLDER],
    });
  }

  startMatch(roomId: string, puzzleId: string, config: GameConfig, turnOrder: string[], creditSource: string, now: number): string {
    const id = `match_${roomId}_${now}`;
    this.pending.push({
      sql: `INSERT OR IGNORE INTO matches(id, room_id, puzzle_id, config_snapshot, turn_order_snapshot, credit_source, started_at)
            SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [id, roomId, puzzleId, JSON.stringify(config), JSON.stringify(turnOrder), creditSource, now, this.roomId, VERSION_PLACEHOLDER],
    });
    this.matchesRuntime = { id, puzzleId, startedAt: now, revealAt: null, result: null };
    return id;
  }

  endMatch(roomId: string, result: string, reason: string, now: number, revealAt: number | null): void {
    this.pending.push({
      sql: `UPDATE matches SET result = ?, reason = ?, ended_at = ?, reveal_at = ? WHERE room_id = ? AND ended_at IS NULL
            AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [result, reason, now, revealAt, roomId, this.roomId, VERSION_PLACEHOLDER],
    });
  }

  insertCredential(cred: CredentialRecord): void {
    const idx = this.creds.findIndex((c) => c.id === cred.id);
    if (idx >= 0) this.creds[idx] = cred; else this.creds.push(cred);
    this.pending.push({
      sql: `INSERT OR REPLACE INTO credentials(id, owner_player_id, room_id, provider, model, base_url_host, state, mask, fingerprint, cipher, iv, tag, key_id, ttl_expires_at, suspend_reason, destroyed_reason, created_at, last_used_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [cred.id, cred.ownerPlayerId, cred.roomId, cred.provider, cred.model, cred.baseUrlHost, cred.state, cred.mask, cred.fingerprint,
        cred.blob ? toBytes(cred.blob.cipher) : null, cred.blob ? toBytes(cred.blob.iv) : null, cred.blob ? toBytes(cred.blob.tag) : null,
        cred.blob ? cred.blob.keyId : null, cred.ttlExpiresAt, cred.suspendReason, cred.destroyedReason, cred.createdAt, cred.lastUsedAt,
        this.roomId, VERSION_PLACEHOLDER],
    });
  }

  /** 销毁：物理清空密钥材料（密文/指纹/掩码），只保留行与原因用于审计。 */
  destroyCredential(id: string, reason: string, now: number): void {
    const idx = this.creds.findIndex((c) => c.id === id);
    if (idx >= 0) this.creds[idx] = { ...this.creds[idx]!, state: 'destroyed', mask: null, fingerprint: null, blob: null, ttlExpiresAt: null, destroyedReason: reason };
    this.pending.push({
      sql: `UPDATE credentials SET state='destroyed', cipher=NULL, iv=NULL, tag=NULL, key_id=NULL, fingerprint=NULL, mask=NULL, destroyed_reason=?, ttl_expires_at=NULL
            WHERE id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [reason, id, this.roomId, 0],
    });
    this.audit({ action: 'credential_destroyed', subject: id, result: reason, meta: { at: now } });
  }

  expireCredentials(now: number): number {
    const expired = this.creds.filter((c) => c.state !== 'destroyed' && c.ttlExpiresAt !== null && c.ttlExpiresAt <= now);
    for (const c of expired) this.destroyCredential(c.id, 'TTL_EXPIRED', now);
    return expired.length;
  }

  destroyRoomCredentials(roomId: string, now: number): number {
    void roomId;
    const alive = this.creds.filter((c) => c.state !== 'destroyed');
    for (const c of alive) this.destroyCredential(c.id, 'ROOM_DESTROYED', now);
    return alive.length;
  }

  saveGrant(roomId: string, grantId: string, gameId: string | null, calls: number, reason: string, now: number, expiresAt: number): void {
    this.pending.push({
      sql: `INSERT OR REPLACE INTO credit_grants(id, room_id, match_id, calls, reason, granted_at, expires_at)
            SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [grantId, roomId, gameId, calls, reason, now, expiresAt, this.roomId, VERSION_PLACEHOLDER],
    });
    this.bumpUsage('site', now, 0, 0, 0, 1);
  }

  bumpUsage(scope: string, now: number, calls = 1, cost = 0, blocked = 0, grants = 0): void {
    const period = periodKey(now);
    this.pending.push({
      sql: `INSERT INTO usage_counters(id, scope, period, calls, cost_estimate, blocked_count, grants_count)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(scope, period) DO UPDATE SET calls = calls + excluded.calls, cost_estimate = cost_estimate + excluded.cost_estimate,
              blocked_count = blocked_count + excluded.blocked_count, grants_count = grants_count + excluded.grants_count`,
      bindings: [`${scope}:${period}`, scope, period, calls, cost, blocked, grants],
    });
  }

  audit(entry: { action: string; roomId?: string | null; actor?: string | null; subject?: string | null; result?: string | null; ipHash?: string | null; meta?: Record<string, unknown> }): void {
    this.pending.push({
      sql: `INSERT INTO audit_events(id, ts, room_id, actor, action, subject, result, ip_hash, meta_json)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      bindings: [`aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, Date.now(), entry.roomId ?? this.roomId,
        entry.actor ?? null, entry.action, entry.subject ?? null, entry.result ?? null,
        // 没显式给就用本次请求的 IP 哈希（Worker 每个请求新建 store，天然是请求级的）
        entry.ipHash ?? this.clientIpHash ?? null,
        entry.meta ? JSON.stringify(entry.meta) : null],
    });
  }

  // ---- 事件流（原来走 WebSocket 广播，现在落表供客户端增量拉取）
  private events: Array<{ seq: number; kind: string; payload: unknown; text: string; stateVersion: number }> = [];

  recordEvent(seq: number, kind: string, payload: unknown, text: string, stateVersion: number, at: number): void {
    this.events.push({ seq, kind, payload, text, stateVersion });
    this.pending.push({
      sql: `INSERT OR REPLACE INTO room_events(room_id, seq, kind, payload_json, text, state_version, created_at)
            SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
      bindings: [this.roomId, seq, kind, JSON.stringify(payload ?? {}), text, stateVersion, at, this.roomId, VERSION_PLACEHOLDER],
    });
  }

  // ---- ③ 生成写回语句（房间 CAS + 全部派生写入）
  /** 房间已被物理清理（最后一人离开）：此时不得再写回或重试 */
  purged = false;
  private pendingRoom: CoreRoom | null = null;
  private matchesRuntime: RoomSnapshot['match'] | null = null;

  get roomAfter(): CoreRoom | null { return this.pendingRoom ?? this.snapshot.room; }
  get expectedStateVersion(): number { return this.expectedVersion; }
  get emittedEvents(): Array<{ seq: number; kind: string; payload: unknown; text: string; stateVersion: number }> { return this.events; }
  get bufferedCount(): number { return this.pending.length; }

  /**
   * 生成一个事务批次：第 1 条是房间行的 CAS 更新（内容 + 版本自增），
   * 其余派生写入都以「新版本」为存在性条件，从而与 CAS 结果绑定。
   */
  buildFlushStatements(keyStatesOverride?: Map<string, { state: string; mask: string | null; formerHost: boolean }>): { statements: PendingStatement[]; newVersion: number } {
    const room = this.pendingRoom ?? this.snapshot.room;
    const newVersion = room.stateVersion;
    const keyStates = keyStatesOverride ?? this.savedKeyStates;
    const statements: PendingStatement[] = [{
      sql: `UPDATE rooms SET code=?, status=?, pause_reason=?, host_member_id=?, config_json=?, config_version=?, state_version=?,
              event_seq=?, puzzle_id=?, round_no=?, match_no=?, solo=?, turn_json=?, revealed_facts_json=?, hint_json=?, vote_json=?, ai_json=?,
              credit_json=?, transfer_json=?, result_json=?, turn_order_json=?, ready_json=?, puzzle_json=?, guess_cooldown_until=?, turn_index=?, updated_at=?
            WHERE id = ? AND state_version = ?`,
      bindings: [room.code, room.status, room.pauseReason, room.hostId, JSON.stringify(room.config), room.configVersion,
        newVersion, room.eventSeq, room.puzzleId, room.roundNo, room.matchNo ?? 0, room.solo === true ? 1 : 0,
        JSON.stringify(room.turn), JSON.stringify(room.revealedFacts),
        JSON.stringify(room.hint), room.vote ? JSON.stringify(room.vote) : null, JSON.stringify(room.ai),
        JSON.stringify(room.credit), JSON.stringify(room.transfer), room.result ? JSON.stringify(room.result) : null,
        JSON.stringify(room.turnOrder), JSON.stringify(room.ready ?? []),
        this.customPuzzle ? JSON.stringify(this.customPuzzle) : null,
        room.guessCooldownUntil ?? 0, room.turnIndex, room.updatedAt, room.id, this.expectedVersion],
    }];

    // 成员表：先删多余行，再逐行 OR REPLACE（都以新版本为条件）
    const keep = room.members.map((m) => m.id);
    for (const id of [...this.snapshot.keyStates.keys()]) {
      if (!keep.includes(id)) {
        statements.push({ sql: 'DELETE FROM members WHERE id = ? AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)', bindings: [id, this.roomId, newVersion] });
      }
    }
    for (const m of room.members) {
      const ks = keyStates.get(m.id);
      statements.push({
        sql: `INSERT OR REPLACE INTO members(id, room_id, player_id, name, is_bot, role, join_seq, conn, activity, hidden,
                last_activity_at, last_heartbeat_at, skip_streak, score, hints_t12, hints_t3, guesses_used, last_hint_at,
                former_host, key_state, key_mask, pending_seat, seat_requested, created_at)
              SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND state_version = ?)`,
        bindings: [m.id, this.roomId, m.playerId, m.name, m.isBot ? 1 : 0, m.role, m.joinSeq, m.conn, m.activity, m.hidden ? 1 : 0,
          m.lastActivityAt, m.lastHeartbeatAt, m.skipStreak, m.score, m.hintsUsedT12, m.hintsUsedT3, m.guessesUsed, m.lastHintAt,
          ks?.formerHost ? 1 : 0, ks?.state ?? 'none', ks?.mask ?? null,
          m.pendingSeat === true ? 1 : 0, m.seatRequested === true ? 1 : 0,
          room.createdAt, this.roomId, newVersion],
      });
    }

    // 缓冲的派生写入：只替换**显式哨兵**，不再按"值是 0"猜测（合法 0 曾被误伤）
    for (const s of this.pending) {
      const bindings = s.bindings.map((b) => (b === VERSION_PLACEHOLDER ? newVersion : b));
      statements.push({ sql: s.sql, bindings });
    }
    return { statements, newVersion };
  }
}

/** ③ 执行写回：返回是否抢占成功（false 表示有并发写入，调用方需重放） */
export async function flushRoomStore(db: D1Database, store: D1RoomStore): Promise<{ ok: boolean; newVersion: number }> {
  const { statements, newVersion } = store.buildFlushStatements();
  const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.bindings as never[]))));
  const first = results[0] as { meta?: { changes?: number } } | undefined;
  const changes = first?.meta?.changes ?? 0;
  return { ok: changes === 1, newVersion };
}

// ---------------------------------------------------------------- 事件增量拉取
export async function fetchEventsSince(db: D1Database, roomId: string, sinceSeq: number, limit = 200): Promise<Array<{ seq: number; kind: string; payload: unknown; text: string; at: number }>> {
  const rows = (await db.prepare('SELECT seq, kind, payload_json, text, created_at FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(roomId, sinceSeq, limit).all<Row>()).results ?? [];
  return rows.map((r) => ({ seq: Number(r.seq), kind: String(r.kind), payload: JSON.parse(String(r.payload_json ?? '{}')), text: String(r.text ?? ''), at: Number(r.created_at) }));
}

/** 会话：令牌只存哈希 */
export async function lookupSession(db: D1Database, tokenHash: string): Promise<{ roomId: string; memberId: string } | null> {
  const row = await db.prepare('SELECT room_id, member_id FROM sessions WHERE token_hash = ?').bind(tokenHash).first<Row>();
  return row ? { roomId: String(row.room_id), memberId: String(row.member_id) } : null;
}

export async function saveSession(db: D1Database, tokenHash: string, roomId: string, memberId: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO sessions(token_hash, room_id, member_id, created_at) VALUES (?,?,?,?)')
    .bind(tokenHash, roomId, memberId, Date.now()).run();
}

export async function findRoomByCode(db: D1Database, code: string): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM rooms WHERE code = ?').bind(code.toUpperCase()).first<Row>();
  return row ? String(row.id) : null;
}

export async function roomCodeTaken(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM rooms WHERE code = ?').bind(code).first<Row>();
  return Boolean(row);
}

/**
 * 物理清理一个房间：房间行 + 全部关联数据（含密钥密文）。
 * 触发时机：最后一名成员主动离开（"单人退出即视为过期房间，直接清理"）、以及 Cron 清理扫描。
 * 密钥密文一并删除 —— 与"房间销毁即销毁密钥"的红线一致。
 */
export async function purgeRoom(db: D1Database, roomId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM room_events WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM questions WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM room_chat WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM votes WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM matches WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM credit_grants WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM credentials WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM members WHERE room_id = ?').bind(roomId),
    db.prepare('DELETE FROM rooms WHERE id = ?').bind(roomId),
  ]);
}

/**
 * 找出应当清理的房间（Cron 使用）：
 *  · 已经没有任何成员（含"单人退出"之后残留的空房间）
 *  · 未开局且创建超过 `roomWaitExpireSec`（6 小时）：光挂着不开始的房间不留
 *  · **没人了**：既没有状态变化、也没有任何成员心跳，都超过 `roomDestroySec`（6 小时）
 *    —— 判据与 Node 参考实现的 `isRoomAbandoned()` 一致，只是这里用 SQL 表达：
 *    `last_heartbeat_at` 是"这一端还开着页面"的信号（20 秒一次），
 *    关掉网页后心跳停止，`updated_at` 也停在最后一次状态变化上，到点就回收。
 */
export async function listPurgeableRooms(db: D1Database, now: number): Promise<Array<{ id: string; reason: string }>> {
  const ttl = PLATFORM.roomDestroySec * 1000;
  const stale = now - ttl;
  const rows = await db.prepare(`
    SELECT r.id, r.status, r.created_at, r.updated_at,
           (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id) AS member_count,
           (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id AND m.last_heartbeat_at > ?) AS live_members
      FROM rooms r
     WHERE (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id) = 0
        OR (r.status = 'waiting' AND r.created_at < ?)
        OR (r.updated_at < ? AND (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id AND m.last_heartbeat_at > ?) = 0)
     LIMIT 200
  `).bind(stale, now - PLATFORM.roomWaitExpireSec * 1000, stale, stale).all<Row>();
  return (rows.results ?? []).map((r) => ({
    id: String(r.id),
    reason: Number(r.member_count) === 0 ? 'NO_MEMBERS'
      : String(r.status) === 'waiting' ? 'WAIT_EXPIRED' : 'ABANDONED',
  }));
}

// ---------------------------------------------------------------- 行 → 对象
function rowToRoom(row: Row): CoreRoom {
  return {
    id: String(row.id), code: String(row.code), status: String(row.status) as CoreRoom['status'],
    pauseReason: (row.pause_reason as string | null) ?? null, hostId: (row.host_member_id as string | null) ?? null,
    members: [], turnOrder: JSON.parse(String(row.turn_order_json ?? '[]')), ready: JSON.parse(String(row.ready_json ?? '[]')), turnIndex: Number(row.turn_index ?? 0),
    guessCooldownUntil: Number(row.guess_cooldown_until ?? 0),
    roundNo: Number(row.round_no ?? 1), matchNo: Number(row.match_no ?? 0), solo: Number(row.solo ?? 0) === 1,
    turn: JSON.parse(String(row.turn_json)),
    config: JSON.parse(String(row.config_json)) as GameConfig, configVersion: Number(row.config_version ?? 1),
    stateVersion: Number(row.state_version ?? 0), eventSeq: Number(row.event_seq ?? 0),
    puzzleId: (row.puzzle_id as string | null) ?? null, revealedFacts: JSON.parse(String(row.revealed_facts_json ?? '[]')),
    hint: JSON.parse(String(row.hint_json ?? '{"tier3Used":0}')), vote: row.vote_json ? JSON.parse(String(row.vote_json)) : null,
    ai: JSON.parse(String(row.ai_json)), credit: JSON.parse(String(row.credit_json)), transfer: JSON.parse(String(row.transfer_json)),
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/**
 * 拉取讨论消息（`sinceSeq` 之后，最多 limit 条）。读路径直接用 DB，不进快照：
 * 讨论消息不属于房间状态，没必要每轮都载入。
 */
export async function fetchChat(db: D1Database, roomId: string, sinceSeq = 0, limit = 200): Promise<ChatRecord[]> {
  const res = await db.prepare(
    'SELECT id, room_id, chat_seq, member_id, text, client_message_id, match_no, created_at FROM room_chat WHERE room_id = ? AND chat_seq > ? ORDER BY chat_seq LIMIT ?',
  ).bind(roomId, sinceSeq, limit).all<Row>();
  return (res.results ?? []).map((r) => ({
    id: String(r.id), roomId: String(r.room_id), chatSeq: Number(r.chat_seq),
    memberId: String(r.member_id), text: String(r.text),
    clientMessageId: String(r.client_message_id), matchNo: Number(r.match_no ?? 0), createdAt: Number(r.created_at),
  }));
}

/** 限流用：某成员最近 N 条消息的时间戳（新→旧）。 */
export async function recentChatTimes(db: D1Database, roomId: string, memberId: string, limit = 30): Promise<number[]> {
  const res = await db.prepare(
    'SELECT created_at FROM room_chat WHERE room_id = ? AND member_id = ? ORDER BY chat_seq DESC LIMIT ?',
  ).bind(roomId, memberId, limit).all<Row>();
  return (res.results ?? []).map((r) => Number(r.created_at));
}

function rowToMember(m: Row): CoreMember {
  return {
    id: String(m.id), playerId: String(m.player_id), name: String(m.name), isBot: Number(m.is_bot) === 1,
    role: String(m.role) as CoreMember['role'], joinSeq: Number(m.join_seq), conn: String(m.conn) as CoreMember['conn'],
    activity: String(m.activity) as CoreMember['activity'], hidden: Number(m.hidden) === 1,
    lastActivityAt: Number(m.last_activity_at), lastHeartbeatAt: Number(m.last_heartbeat_at),
    skipStreak: Number(m.skip_streak), score: Number(m.score), hintsUsedT12: Number(m.hints_t12),
    hintsUsedT3: Number(m.hints_t3), guessesUsed: Number(m.guesses_used), lastHintAt: Number(m.last_hint_at),
    ...(Number(m.pending_seat) === 1 ? { pendingSeat: true, seatRequested: Number(m.seat_requested) === 1 } : {}),
  };
}

function rowToCredential(row: Row): CredentialRecord {
  const cipher = row.cipher ? toBytes(row.cipher) : null;
  const iv = row.iv ? toBytes(row.iv) : null;
  const tag = row.tag ? toBytes(row.tag) : null;
  return {
    id: String(row.id), ownerPlayerId: String(row.owner_player_id), roomId: (row.room_id as string | null) ?? null,
    provider: String(row.provider), model: String(row.model), baseUrlHost: String(row.base_url_host),
    state: String(row.state) as CredentialState, mask: (row.mask as string | null) ?? null,
    fingerprint: (row.fingerprint as string | null) ?? null,
    blob: cipher && iv && tag ? { cipher: cipher as never, iv: iv as never, tag: tag as never, keyId: String(row.key_id ?? 'mk1') } : null,
    ttlExpiresAt: row.ttl_expires_at === null || row.ttl_expires_at === undefined ? null : Number(row.ttl_expires_at),
    suspendReason: (row.suspend_reason as string | null) ?? null, destroyedReason: (row.destroyed_reason as string | null) ?? null,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
  };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  return new Uint8Array(0);
}

export function periodKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 提示/文案的泄露检查需要 n-gram 工具（此处保留引用，避免被 tree-shaking 掉类型依赖）。 */
export const __core = { ngrams, PROMPT_VERSION };
export type { PuzzleFact, PuzzleMeta };
