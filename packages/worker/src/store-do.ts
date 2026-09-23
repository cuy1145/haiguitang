/**
 * Durable Object SQLite 仓储适配器：实现 `RoomStorePort`（房间编排所需的全部能力）。
 *
 * 与 Node 版 `packages/server/src/store.ts` 的差异：
 *  · node:sqlite 的 `prepare().run()/get()/all()`  →  DO 的 `sql.exec()`
 *  · 不再有 PRAGMA（DO 自带事务与一致性），也没有 fs（日志走 console）
 *  · 表结构与唯一索引**保持完全一致** —— 这是"两份实现不漂移"的关键
 *  · 判定缓存按房间隔离（同一个 DO 内共享）；跨房间一致性由事实表权威裁决保证，不依赖缓存
 */
import type { CoreMember, CoreRoom, GameConfig, Puzzle, PuzzleFact, PuzzleMeta } from '@ht/core';
import { PROMPT_VERSION } from '@ht/core';
import type { RoomStorePort } from '../../server/src/ports.ts';
import type { CredentialRecord, CredentialState } from '../../server/src/vault.ts';
import type { QuestionRecord, VerdictCacheRow } from '../../server/src/store.ts';
import { seedPuzzles } from '../../server/src/data/seed-puzzles.ts';

interface Row { [k: string]: unknown }

export class DoStore implements RoomStorePort {
  constructor(private readonly sql: SqlStorage, readonly roomId: string) {
    this.migrate();
    this.seed();
  }

  // ---------------------------------------------------------------- 基础设施
  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS puzzles (
        id TEXT PRIMARY KEY, meta_json TEXT NOT NULL, truth_json TEXT NOT NULL, facts_json TEXT NOT NULL,
        review_status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, status TEXT NOT NULL, pause_reason TEXT,
        host_member_id TEXT, config_json TEXT NOT NULL, config_version INTEGER NOT NULL,
        state_version INTEGER NOT NULL, event_seq INTEGER NOT NULL, puzzle_id TEXT, round_no INTEGER NOT NULL,
        turn_json TEXT NOT NULL, revealed_facts_json TEXT NOT NULL, hint_json TEXT NOT NULL, vote_json TEXT,
        ai_json TEXT NOT NULL, credit_json TEXT NOT NULL, transfer_json TEXT NOT NULL, result_json TEXT,
        turn_order_json TEXT NOT NULL, turn_index INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, player_id TEXT NOT NULL, name TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL, join_seq INTEGER NOT NULL, conn TEXT NOT NULL,
        activity TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL, skip_streak INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0,
        hints_t12 INTEGER NOT NULL DEFAULT 0, hints_t3 INTEGER NOT NULL DEFAULT 0, guesses_used INTEGER NOT NULL DEFAULT 0,
        last_hint_at INTEGER NOT NULL DEFAULT 0, former_host INTEGER NOT NULL DEFAULT 0,
        key_state TEXT NOT NULL DEFAULT 'none', key_mask TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_members_room ON members(room_id, join_seq);
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, match_id TEXT, turn_seq INTEGER NOT NULL, member_id TEXT NOT NULL,
        text TEXT NOT NULL, answer TEXT NOT NULL, reason_code TEXT NOT NULL, source TEXT NOT NULL,
        late INTEGER NOT NULL DEFAULT 0, matched_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(room_id, turn_seq)
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, puzzle_id TEXT NOT NULL, config_snapshot TEXT NOT NULL,
        turn_order_snapshot TEXT NOT NULL, credit_source TEXT NOT NULL, result TEXT, reason TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER, reveal_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS votes (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
        ballots_json TEXT NOT NULL, eligible_json TEXT NOT NULL, opened_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL, result TEXT, tally_json TEXT
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, owner_player_id TEXT NOT NULL, room_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
        base_url_host TEXT NOT NULL, state TEXT NOT NULL, mask TEXT, fingerprint TEXT, cipher BLOB, iv BLOB, tag BLOB,
        key_id TEXT, ttl_expires_at INTEGER, suspend_reason TEXT, destroyed_reason TEXT,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ix_credentials_owner ON credentials(owner_player_id, room_id, state);
      CREATE TABLE IF NOT EXISTS verdict_cache (
        puzzle_id TEXT NOT NULL, question_hash TEXT NOT NULL, prompt_version TEXT NOT NULL,
        fact_set_version INTEGER NOT NULL, answer TEXT NOT NULL, reason_code TEXT NOT NULL,
        matched_json TEXT NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY (puzzle_id, question_hash, prompt_version, fact_set_version)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, room_id TEXT, actor TEXT, action TEXT NOT NULL,
        subject TEXT, result TEXT, ip_hash TEXT, meta_json TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_counters (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, period TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
        cost_estimate REAL NOT NULL DEFAULT 0, blocked_count INTEGER NOT NULL DEFAULT 0,
        grants_count INTEGER NOT NULL DEFAULT 0, UNIQUE(scope, period)
      );
      CREATE TABLE IF NOT EXISTS credit_grants (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, match_id TEXT, calls INTEGER NOT NULL,
        reason TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
  }

  private seed(): void {
    for (const puzzle of seedPuzzles()) this.upsertPuzzle(puzzle);
  }

  private all<T extends Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  private one<T extends Row>(query: string, ...bindings: unknown[]): T | undefined {
    return this.all<T>(query, ...bindings)[0];
  }

  upsertPuzzle(puzzle: Puzzle, now = Date.now()): void {
    const { truth, facts, ...meta } = puzzle;
    this.sql.exec(
      `INSERT INTO puzzles(id, meta_json, truth_json, facts_json, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET meta_json = excluded.meta_json, truth_json = excluded.truth_json,
         facts_json = excluded.facts_json, review_status = excluded.review_status`,
      puzzle.id, JSON.stringify(meta), JSON.stringify(truth), JSON.stringify(facts), puzzle.reviewStatus, now,
    );
  }

  getPuzzle(id: string): Puzzle | null {
    const row = this.one('SELECT * FROM puzzles WHERE id = ?', id);
    return row ? rowToPuzzle(row) : null;
  }

  listPuzzles(filter?: { ratingMax?: 'L1' | 'L2' | 'L3'; difficultyMin?: number; difficultyMax?: number; tags?: string[] }): Puzzle[] {
    const rows = this.all("SELECT * FROM puzzles WHERE review_status = 'approved'");
    const rank: Record<string, number> = { L1: 1, L2: 2, L3: 3 };
    return rows.map(rowToPuzzle).filter((p) => {
      if (!filter) return true;
      if (filter.ratingMax && (rank[p.rating] ?? 3) > (rank[filter.ratingMax] ?? 3)) return false;
      if (filter.difficultyMin !== undefined && p.difficulty < filter.difficultyMin) return false;
      if (filter.difficultyMax !== undefined && p.difficulty > filter.difficultyMax) return false;
      if (filter.tags && filter.tags.length > 0 && !filter.tags.some((t) => p.tags.includes(t))) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------- 房间与成员
  saveRoom(room: CoreRoom, keyStates: Map<string, { state: string; mask: string | null; formerHost: boolean }>): void {
    this.sql.exec(
      `INSERT INTO rooms(id, code, status, pause_reason, host_member_id, config_json, config_version, state_version,
         event_seq, puzzle_id, round_no, turn_json, revealed_facts_json, hint_json, vote_json, ai_json, credit_json,
         transfer_json, result_json, turn_order_json, turn_index, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, pause_reason = excluded.pause_reason,
         host_member_id = excluded.host_member_id, config_json = excluded.config_json,
         config_version = excluded.config_version, state_version = excluded.state_version, event_seq = excluded.event_seq,
         puzzle_id = excluded.puzzle_id, round_no = excluded.round_no, turn_json = excluded.turn_json,
         revealed_facts_json = excluded.revealed_facts_json, hint_json = excluded.hint_json, vote_json = excluded.vote_json,
         ai_json = excluded.ai_json, credit_json = excluded.credit_json, transfer_json = excluded.transfer_json,
         result_json = excluded.result_json, turn_order_json = excluded.turn_order_json,
         turn_index = excluded.turn_index, updated_at = excluded.updated_at`,
      room.id, room.code, room.status, room.pauseReason, room.hostId,
      JSON.stringify(room.config), room.configVersion, room.stateVersion, room.eventSeq,
      room.puzzleId, room.roundNo, JSON.stringify(room.turn), JSON.stringify(room.revealedFacts),
      JSON.stringify(room.hint), room.vote ? JSON.stringify(room.vote) : null,
      JSON.stringify(room.ai), JSON.stringify(room.credit), JSON.stringify(room.transfer),
      room.result ? JSON.stringify(room.result) : null, JSON.stringify(room.turnOrder), room.turnIndex,
      room.createdAt, room.updatedAt,
    );
    const keep = new Set(room.members.map((m) => m.id));
    for (const row of this.all<{ id: string }>('SELECT id FROM members WHERE room_id = ?', room.id)) {
      if (!keep.has(row.id)) this.sql.exec('DELETE FROM members WHERE id = ?', row.id);
    }
    for (const m of room.members) {
      const ks = keyStates.get(m.id);
      this.sql.exec(
        `INSERT INTO members(id, room_id, player_id, name, is_bot, role, join_seq, conn, activity, hidden,
           last_activity_at, last_heartbeat_at, skip_streak, score, hints_t12, hints_t3, guesses_used, last_hint_at,
           former_host, key_state, key_mask, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, is_bot = excluded.is_bot, role = excluded.role,
           join_seq = excluded.join_seq, conn = excluded.conn, activity = excluded.activity, hidden = excluded.hidden,
           last_activity_at = excluded.last_activity_at, last_heartbeat_at = excluded.last_heartbeat_at,
           skip_streak = excluded.skip_streak, score = excluded.score, hints_t12 = excluded.hints_t12,
           hints_t3 = excluded.hints_t3, guesses_used = excluded.guesses_used, last_hint_at = excluded.last_hint_at,
           former_host = excluded.former_host, key_state = excluded.key_state, key_mask = excluded.key_mask`,
        m.id, room.id, m.playerId, m.name, m.isBot ? 1 : 0, m.role, m.joinSeq, m.conn, m.activity, m.hidden ? 1 : 0,
        m.lastActivityAt, m.lastHeartbeatAt, m.skipStreak, m.score, m.hintsUsedT12, m.hintsUsedT3,
        m.guessesUsed, m.lastHintAt, ks?.formerHost ? 1 : 0, ks?.state ?? 'none', ks?.mask ?? null, room.createdAt,
      );
    }
  }

  loadRooms(): Array<{ room: CoreRoom; code: string }> {
    const room = this.loadRoom(this.roomId);
    return room ? [{ room, code: room.code }] : [];
  }

  loadRoom(roomId: string): CoreRoom | null {
    const row = this.one('SELECT * FROM rooms WHERE id = ?', roomId);
    if (!row) return null;
    const members = this.all('SELECT * FROM members WHERE room_id = ? ORDER BY join_seq', roomId).map((m): CoreMember => ({
      id: String(m.id), playerId: String(m.player_id), name: String(m.name), isBot: Number(m.is_bot) === 1,
      role: String(m.role) as CoreMember['role'], joinSeq: Number(m.join_seq),
      conn: String(m.conn) as CoreMember['conn'], activity: String(m.activity) as CoreMember['activity'],
      hidden: Number(m.hidden) === 1, lastActivityAt: Number(m.last_activity_at),
      lastHeartbeatAt: Number(m.last_heartbeat_at), skipStreak: Number(m.skip_streak), score: Number(m.score),
      hintsUsedT12: Number(m.hints_t12), hintsUsedT3: Number(m.hints_t3),
      guessesUsed: Number(m.guesses_used), lastHintAt: Number(m.last_hint_at),
    }));
    return {
      id: String(row.id), code: String(row.code), status: String(row.status) as CoreRoom['status'],
      pauseReason: (row.pause_reason as string | null) ?? null, hostId: (row.host_member_id as string | null) ?? null,
      members, turnOrder: JSON.parse(String(row.turn_order_json ?? '[]')), turnIndex: Number(row.turn_index ?? 0),
      roundNo: Number(row.round_no ?? 1), turn: JSON.parse(String(row.turn_json)),
      config: JSON.parse(String(row.config_json)) as GameConfig, configVersion: Number(row.config_version ?? 1),
      stateVersion: Number(row.state_version ?? 0), eventSeq: Number(row.event_seq ?? 0),
      puzzleId: (row.puzzle_id as string | null) ?? null,
      revealedFacts: JSON.parse(String(row.revealed_facts_json ?? '[]')),
      hint: JSON.parse(String(row.hint_json ?? '{"tier3Used":0}')),
      vote: row.vote_json ? JSON.parse(String(row.vote_json)) : null,
      ai: JSON.parse(String(row.ai_json)), credit: JSON.parse(String(row.credit_json)),
      transfer: JSON.parse(String(row.transfer_json)),
      result: row.result_json ? JSON.parse(String(row.result_json)) : null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  memberKeyStates(roomId: string): Map<string, { state: string; mask: string | null; formerHost: boolean }> {
    const rows = this.all<{ id: string; key_state: string; key_mask: string | null; former_host: number }>(
      'SELECT id, key_state, key_mask, former_host FROM members WHERE room_id = ?', roomId,
    );
    const out = new Map<string, { state: string; mask: string | null; formerHost: boolean }>();
    for (const r of rows) out.set(r.id, { state: r.key_state, mask: r.key_mask, formerHost: r.former_host === 1 });
    return out;
  }

  setMemberKeyState(memberId: string, state: string, mask: string | null, formerHost?: boolean): void {
    if (formerHost === undefined) this.sql.exec('UPDATE members SET key_state = ?, key_mask = ? WHERE id = ?', state, mask, memberId);
    else this.sql.exec('UPDATE members SET key_state = ?, key_mask = ?, former_host = ? WHERE id = ?', state, mask, formerHost ? 1 : 0, memberId);
  }

  // ---------------------------------------------------------------- 提问 / 对局
  insertQuestion(q: QuestionRecord): void {
    this.sql.exec(
      `INSERT INTO questions(id, room_id, match_id, turn_seq, member_id, text, answer, reason_code, source, late, matched_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id, turn_seq) DO NOTHING`,
      q.id, q.roomId, q.matchId, q.turnSeq, q.memberId, q.text, q.answer, q.reasonCode, q.source,
      q.late ? 1 : 0, JSON.stringify(q.matchedFactIds), q.createdAt,
    );
  }

  listQuestions(roomId: string): QuestionRecord[] {
    return this.all('SELECT * FROM questions WHERE room_id = ? ORDER BY turn_seq', roomId).map((r) => ({
      id: String(r.id), roomId: String(r.room_id), matchId: (r.match_id as string | null) ?? null,
      turnSeq: Number(r.turn_seq), memberId: String(r.member_id), text: String(r.text),
      answer: String(r.answer), reasonCode: String(r.reason_code), source: String(r.source),
      late: Number(r.late) === 1, matchedFactIds: JSON.parse(String(r.matched_json ?? '[]')),
      createdAt: Number(r.created_at),
    }));
  }

  startMatch(roomId: string, puzzleId: string, config: GameConfig, turnOrder: string[], creditSource: string, now: number): string {
    const id = `match_${roomId}_${now}`;
    this.sql.exec(
      `INSERT INTO matches(id, room_id, puzzle_id, config_snapshot, turn_order_snapshot, credit_source, started_at)
       VALUES (?,?,?,?,?,?,?)`,
      id, roomId, puzzleId, JSON.stringify(config), JSON.stringify(turnOrder), creditSource, now,
    );
    return id;
  }

  endMatch(roomId: string, result: string, reason: string, now: number, revealAt: number | null): void {
    this.sql.exec(
      'UPDATE matches SET result = ?, reason = ?, ended_at = ?, reveal_at = ? WHERE room_id = ? AND ended_at IS NULL',
      result, reason, now, revealAt, roomId,
    );
  }

  currentMatch(roomId: string): { id: string; puzzleId: string; startedAt: number; revealAt: number | null; result: string | null } | null {
    const row = this.one('SELECT * FROM matches WHERE room_id = ? ORDER BY started_at DESC LIMIT 1', roomId);
    if (!row) return null;
    return {
      id: String(row.id), puzzleId: String(row.puzzle_id), startedAt: Number(row.started_at),
      revealAt: row.reveal_at === null || row.reveal_at === undefined ? null : Number(row.reveal_at),
      result: (row.result as string | null) ?? null,
    };
  }

  // ---------------------------------------------------------------- 投票 / 额度
  saveVote(roomId: string, vote: CoreRoom['vote']): void {
    if (!vote) return;
    this.sql.exec(
      `INSERT INTO votes(id, room_id, type, status, ballots_json, eligible_json, opened_at, deadline_at, result, tally_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, ballots_json = excluded.ballots_json,
         result = excluded.result, tally_json = excluded.tally_json`,
      vote.id, roomId, vote.type, vote.status, JSON.stringify(vote.ballots), JSON.stringify(vote.eligibleAtOpen),
      vote.openedAt, vote.deadlineAt, vote.result ?? null, vote.tally ? JSON.stringify(vote.tally) : null,
    );
  }

  saveGrant(roomId: string, grantId: string, gameId: string | null, calls: number, reason: string, now: number, expiresAt: number): void {
    this.sql.exec(
      'INSERT INTO credit_grants(id, room_id, match_id, calls, reason, granted_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      grantId, roomId, gameId, calls, reason, now, expiresAt,
    );
    this.bumpUsage('site', now, 0, 0, 0, 1);
  }

  bumpUsage(scope: string, now: number, calls = 1, cost = 0, blocked = 0, grants = 0): void {
    const period = periodKey(now);
    this.sql.exec(
      `INSERT INTO usage_counters(id, scope, period, calls, cost_estimate, blocked_count, grants_count)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(scope, period) DO UPDATE SET calls = calls + excluded.calls,
         cost_estimate = cost_estimate + excluded.cost_estimate,
         blocked_count = blocked_count + excluded.blocked_count,
         grants_count = grants_count + excluded.grants_count`,
      `${scope}:${period}`, scope, period, calls, cost, blocked, grants,
    );
  }

  usage(scope: string, now: number): { calls: number; cost: number; blocked: number; grants: number } {
    const row = this.one('SELECT * FROM usage_counters WHERE scope = ? AND period = ?', scope, periodKey(now));
    return {
      calls: Number(row?.calls ?? 0), cost: Number(row?.cost_estimate ?? 0),
      blocked: Number(row?.blocked_count ?? 0), grants: Number(row?.grants_count ?? 0),
    };
  }

  // ---------------------------------------------------------------- 判定缓存
  getVerdict(puzzleId: string, questionHash: string, promptVersion: string, factSetVersion: number): VerdictCacheRow | null {
    const row = this.one(
      'SELECT * FROM verdict_cache WHERE puzzle_id = ? AND question_hash = ? AND prompt_version = ? AND fact_set_version = ?',
      puzzleId, questionHash, promptVersion, factSetVersion,
    );
    if (!row) return null;
    this.sql.exec(
      'UPDATE verdict_cache SET hit_count = hit_count + 1 WHERE puzzle_id = ? AND question_hash = ? AND prompt_version = ? AND fact_set_version = ?',
      puzzleId, questionHash, promptVersion, factSetVersion,
    );
    return {
      puzzleId: String(row.puzzle_id), questionHash: String(row.question_hash), promptVersion: String(row.prompt_version),
      factSetVersion: Number(row.fact_set_version), answer: String(row.answer), reasonCode: String(row.reason_code),
      matchedFactIds: JSON.parse(String(row.matched_json ?? '[]')), hitCount: Number(row.hit_count), createdAt: Number(row.created_at),
    };
  }

  putVerdict(row: VerdictCacheRow): void {
    this.sql.exec(
      `INSERT INTO verdict_cache(puzzle_id, question_hash, prompt_version, fact_set_version, answer, reason_code, matched_json, hit_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(puzzle_id, question_hash, prompt_version, fact_set_version) DO NOTHING`,
      row.puzzleId, row.questionHash, row.promptVersion, row.factSetVersion, row.answer, row.reasonCode,
      JSON.stringify(row.matchedFactIds), row.hitCount, row.createdAt,
    );
  }

  // ---------------------------------------------------------------- 密钥凭据
  insertCredential(cred: CredentialRecord): void {
    this.sql.exec(
      `INSERT INTO credentials(id, owner_player_id, room_id, provider, model, base_url_host, state, mask, fingerprint,
         cipher, iv, tag, key_id, ttl_expires_at, suspend_reason, destroyed_reason, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, mask = excluded.mask, fingerprint = excluded.fingerprint,
         cipher = excluded.cipher, iv = excluded.iv, tag = excluded.tag, key_id = excluded.key_id,
         ttl_expires_at = excluded.ttl_expires_at, suspend_reason = excluded.suspend_reason,
         destroyed_reason = excluded.destroyed_reason, last_used_at = excluded.last_used_at`,
      cred.id, cred.ownerPlayerId, cred.roomId, cred.provider, cred.model, cred.baseUrlHost, cred.state,
      cred.mask, cred.fingerprint,
      cred.blob ? toBytes(cred.blob.cipher) : null, cred.blob ? toBytes(cred.blob.iv) : null,
      cred.blob ? toBytes(cred.blob.tag) : null, cred.blob ? cred.blob.keyId : null,
      cred.ttlExpiresAt, cred.suspendReason, cred.destroyedReason, cred.createdAt, cred.lastUsedAt,
    );
  }

  /** 销毁：物理清空密钥材料（密文/指纹/掩码），只保留行与原因用于审计。 */
  destroyCredential(id: string, reason: string, now: number): void {
    this.sql.exec(
      `UPDATE credentials SET state = 'destroyed', cipher = NULL, iv = NULL, tag = NULL, key_id = NULL,
         fingerprint = NULL, mask = NULL, destroyed_reason = ?, ttl_expires_at = NULL WHERE id = ?`,
      reason, id,
    );
    this.audit({ action: 'credential_destroyed', subject: id, result: reason, meta: { at: now } });
  }

  getCredential(id: string): CredentialRecord | null {
    const row = this.one('SELECT * FROM credentials WHERE id = ?', id);
    return row ? rowToCredential(row) : null;
  }

  roomCredential(roomId: string): CredentialRecord | null {
    const row = this.one("SELECT * FROM credentials WHERE room_id = ? AND state != 'destroyed' ORDER BY created_at DESC LIMIT 1", roomId);
    return row ? rowToCredential(row) : null;
  }

  expireCredentials(now: number): number {
    const rows = this.all<{ id: string }>(
      "SELECT id FROM credentials WHERE state IN ('active','suspended','validating') AND ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?",
      now,
    );
    for (const r of rows) this.destroyCredential(r.id, 'TTL_EXPIRED', now);
    return rows.length;
  }

  destroyRoomCredentials(roomId: string, now: number): number {
    const rows = this.all<{ id: string }>("SELECT id FROM credentials WHERE room_id = ? AND state != 'destroyed'", roomId);
    for (const r of rows) this.destroyCredential(r.id, 'ROOM_DESTROYED', now);
    return rows.length;
  }

  // ---------------------------------------------------------------- 审计
  audit(entry: { action: string; roomId?: string | null; actor?: string | null; subject?: string | null; result?: string | null; ipHash?: string | null; meta?: Record<string, unknown> }): void {
    this.sql.exec(
      `INSERT INTO audit_events(id, ts, room_id, actor, action, subject, result, ip_hash, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, Date.now(),
      entry.roomId ?? this.roomId, entry.actor ?? null, entry.action, entry.subject ?? null,
      entry.result ?? null, entry.ipHash ?? null, entry.meta ? JSON.stringify(entry.meta) : null,
    );
  }
}

// ---------------------------------------------------------------- helpers
export function periodKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function rowToPuzzle(row: Row): Puzzle {
  const meta = JSON.parse(String(row.meta_json ?? '{}')) as PuzzleMeta;
  return {
    ...meta,
    reviewStatus: String(row.review_status ?? 'approved') as Puzzle['reviewStatus'],
    truth: JSON.parse(String(row.truth_json ?? '{}')),
    facts: JSON.parse(String(row.facts_json ?? '[]')) as PuzzleFact[],
  };
}

function rowToCredential(row: Row): CredentialRecord {
  const cipher = row.cipher ? fromBytes(row.cipher) : null;
  const iv = row.iv ? fromBytes(row.iv) : null;
  const tag = row.tag ? fromBytes(row.tag) : null;
  return {
    id: String(row.id), ownerPlayerId: String(row.owner_player_id), roomId: (row.room_id as string | null) ?? null,
    provider: String(row.provider), model: String(row.model), baseUrlHost: String(row.base_url_host),
    state: String(row.state) as CredentialState, mask: (row.mask as string | null) ?? null,
    fingerprint: (row.fingerprint as string | null) ?? null,
    blob: cipher && iv && tag ? { cipher, iv, tag, keyId: String(row.key_id ?? 'mk1') } : null,
    ttlExpiresAt: row.ttl_expires_at === null || row.ttl_expires_at === undefined ? null : Number(row.ttl_expires_at),
    suspendReason: (row.suspend_reason as string | null) ?? null,
    destroyedReason: (row.destroyed_reason as string | null) ?? null,
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

function fromBytes(value: unknown): Uint8Array {
  return toBytes(value);
}

export { PROMPT_VERSION };
