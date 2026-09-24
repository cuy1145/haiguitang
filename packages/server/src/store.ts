/**
 * SQLite 持久化层（node:sqlite 内置模块，零原生依赖）。
 *
 * 设计要点：
 *  - 每个房间的关键状态（含回合、成员、投票、额度、移交）都落库，服务器重启后可恢复
 *  - 唯一索引是并发防线的最后一层（《阶段5》§1.1 L3）：判定缓存、投票一人一票、举报一人一次
 *  - 汤底与事实点单独存表，仓储只暴露"取整题"方法；公开投影由 core/dto.ts 负责
 *  - 逻辑删除 vs 物理删除：密钥销毁是物理清空（密文/指纹/掩码置 NULL）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreMember, CoreRoom, GameConfig, Puzzle, PuzzleFact, PuzzleMeta } from '@ht/core';
import type { CredentialRecord, CredentialState, EncryptedBlob } from './vault.ts';

export const SCHEMA_VERSION = 2;

export interface StoredMemberKeyState {
  hasKey: boolean;
  keyMask: string | null;
  keyState: 'none' | 'active' | 'suspended' | 'destroyed';
  formerHost: boolean;
}

export interface QuestionRecord {
  id: string;
  roomId: string;
  matchId: string | null;
  turnSeq: number;
  memberId: string;
  text: string;
  answer: string;
  reasonCode: string;
  source: string;
  late: boolean;
  matchedFactIds: string[];
  /** 「是 / 否」时可选的一句补充说明（已过泄露检查；没有就是 null） */
  explain?: string | null;
  createdAt: number;
}

export interface VerdictCacheRow {
  puzzleId: string;
  questionHash: string;
  promptVersion: string;
  factSetVersion: number;
  answer: string;
  reasonCode: string;
  matchedFactIds: string[];
  hitCount: number;
  createdAt: number;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly file: string;

  constructor(dataDir: string, filename = 'haiguitang.db') {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, filename);
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  get path(): string { return this.file; }

  close(): void { this.db.close(); }

  /** 启动时完整性自检（《阶段5》§2.3）。 */
  integrityCheck(): { ok: boolean; detail: string } {
    const row = this.db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    const detail = row ? String(Object.values(row)[0]) : 'unknown';
    return { ok: detail === 'ok', detail };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const current = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    if ((current?.v ?? 0) >= SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS puzzles (
        id TEXT PRIMARY KEY,
        meta_json TEXT NOT NULL,
        truth_json TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        review_status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        pause_reason TEXT,
        host_member_id TEXT,
        config_json TEXT NOT NULL,
        config_version INTEGER NOT NULL,
        state_version INTEGER NOT NULL,
        event_seq INTEGER NOT NULL,
        puzzle_id TEXT,
        round_no INTEGER NOT NULL,
        turn_json TEXT NOT NULL,
        revealed_facts_json TEXT NOT NULL,
        hint_json TEXT NOT NULL,
        vote_json TEXT,
        ai_json TEXT NOT NULL,
        credit_json TEXT NOT NULL,
        transfer_json TEXT NOT NULL,
        result_json TEXT,
        turn_order_json TEXT NOT NULL,
        ready_json TEXT NOT NULL DEFAULT '[]',
        turn_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_rooms_status ON rooms(status, updated_at);

      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL,
        join_seq INTEGER NOT NULL,
        conn TEXT NOT NULL,
        activity TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        skip_streak INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        hints_t12 INTEGER NOT NULL DEFAULT 0,
        hints_t3 INTEGER NOT NULL DEFAULT 0,
        guesses_used INTEGER NOT NULL DEFAULT 0,
        last_hint_at INTEGER NOT NULL DEFAULT 0,
        resume_token_hash TEXT,
        former_host INTEGER NOT NULL DEFAULT 0,
        key_state TEXT NOT NULL DEFAULT 'none',
        key_mask TEXT,
        left_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(room_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS ix_members_room ON members(room_id, join_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_members_token ON members(resume_token_hash);

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        match_id TEXT,
        turn_seq INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        text TEXT NOT NULL,
        answer TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        source TEXT NOT NULL,
        late INTEGER NOT NULL DEFAULT 0,
        matched_json TEXT NOT NULL,
        explain TEXT,
        client_submit_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(room_id, turn_seq),
        UNIQUE(room_id, client_submit_id)
      );

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        puzzle_id TEXT NOT NULL,
        config_snapshot TEXT NOT NULL,
        turn_order_snapshot TEXT NOT NULL,
        credit_source TEXT NOT NULL,
        result TEXT,
        reason TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reveal_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS votes (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        ballots_json TEXT NOT NULL,
        eligible_json TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        result TEXT,
        tally_json TEXT,
        tie_seed REAL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_vote_open
        ON votes(room_id, type) WHERE status = 'open';

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        owner_player_id TEXT NOT NULL,
        room_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url_host TEXT NOT NULL,
        state TEXT NOT NULL,
        mask TEXT,
        fingerprint TEXT,
        cipher BLOB,
        iv BLOB,
        tag BLOB,
        key_id TEXT,
        ttl_expires_at INTEGER,
        suspend_reason TEXT,
        destroyed_reason TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ix_credentials_owner ON credentials(owner_player_id, room_id, state);

      CREATE TABLE IF NOT EXISTS verdict_cache (
        puzzle_id TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        fact_set_version INTEGER NOT NULL,
        answer TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        matched_json TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (puzzle_id, question_hash, prompt_version, fact_set_version)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        room_id TEXT,
        actor TEXT,
        action TEXT NOT NULL,
        subject TEXT,
        result TEXT,
        ip_hash TEXT,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_events(ts);

      CREATE TABLE IF NOT EXISTS usage_counters (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        period TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        cost_estimate REAL NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        grants_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(scope, period)
      );
    `);
    // v1 → v2：questions 增加 explain（「是/否」后的可选补充说明）。
    // 建表语句已经带上该列；对已存在的旧库这里补一次，失败（列已存在）忽略。
    try { this.db.exec('ALTER TABLE questions ADD COLUMN explain TEXT'); } catch { /* 已存在 */ }
    this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, Date.now());
  }

  // ---------------------------------------------------------------- 题库
  upsertPuzzle(puzzle: Puzzle, now = Date.now()): void {
    const { truth, facts, ...meta } = puzzle;
    this.db.prepare(`
      INSERT INTO puzzles(id, meta_json, truth_json, facts_json, review_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        meta_json = excluded.meta_json,
        truth_json = excluded.truth_json,
        facts_json = excluded.facts_json,
        review_status = excluded.review_status
    `).run(puzzle.id, JSON.stringify(meta), JSON.stringify(truth), JSON.stringify(facts), puzzle.reviewStatus, now);
  }

  /**
   * 保存一道房间级的自定义题目（房主的 AI 创作）。
   * Node 版有独立的 puzzles 表，直接 upsert 进去即可（与静态题库同源、同接口）。
   * Worker 版没有 puzzles 表（题库是编译进包的常量），它把题目写进 rooms.puzzle_json。
   */
  saveRoomPuzzle(puzzle: Puzzle): void {
    this.upsertPuzzle(puzzle);
  }

  getPuzzle(id: string): Puzzle | null {
    const row = this.db.prepare('SELECT * FROM puzzles WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!row) return null;
    return this.rowToPuzzle(row);
  }

  listPuzzles(filter?: { ratingMax?: 'L1' | 'L2' | 'L3'; difficultyMin?: number; difficultyMax?: number; tags?: string[] }): Puzzle[] {
    const rows = this.db.prepare('SELECT * FROM puzzles WHERE review_status = ?').all('approved') as Record<string, string>[];
    const rank: Record<string, number> = { L1: 1, L2: 2, L3: 3 };
    return rows.map((r) => this.rowToPuzzle(r)).filter((p) => {
      if (!filter) return true;
      if (filter.ratingMax && rank[p.rating]! > rank[filter.ratingMax]!) return false;
      if (filter.difficultyMin !== undefined && p.difficulty < filter.difficultyMin) return false;
      if (filter.difficultyMax !== undefined && p.difficulty > filter.difficultyMax) return false;
      if (filter.tags && filter.tags.length > 0 && !filter.tags.some((t) => p.tags.includes(t))) return false;
      return true;
    });
  }

  private rowToPuzzle(row: Record<string, string>): Puzzle {
    const meta = JSON.parse(row.meta_json ?? '{}') as PuzzleMeta;
    return {
      ...meta,
      reviewStatus: (row.review_status ?? 'approved') as Puzzle['reviewStatus'],
      truth: JSON.parse(row.truth_json ?? '{}'),
      facts: JSON.parse(row.facts_json ?? '[]') as PuzzleFact[],
    };
  }

  // ---------------------------------------------------------------- 房间与成员
  saveRoom(room: CoreRoom, keyStates: Map<string, { state: string; mask: string | null; formerHost: boolean }>): void {
    const tx = this.db.prepare(`
      INSERT INTO rooms(id, code, status, pause_reason, host_member_id, config_json, config_version, state_version,
                        event_seq, puzzle_id, round_no, turn_json, revealed_facts_json, hint_json, vote_json, ai_json,
                        credit_json, transfer_json, result_json, turn_order_json, ready_json, turn_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, pause_reason = excluded.pause_reason, host_member_id = excluded.host_member_id,
        config_json = excluded.config_json, config_version = excluded.config_version,
        state_version = excluded.state_version, event_seq = excluded.event_seq,
        puzzle_id = excluded.puzzle_id, round_no = excluded.round_no, turn_json = excluded.turn_json,
        revealed_facts_json = excluded.revealed_facts_json, hint_json = excluded.hint_json,
        vote_json = excluded.vote_json, ai_json = excluded.ai_json, credit_json = excluded.credit_json,
        transfer_json = excluded.transfer_json, result_json = excluded.result_json,
        turn_order_json = excluded.turn_order_json, ready_json = excluded.ready_json,
        turn_index = excluded.turn_index, updated_at = excluded.updated_at
    `);
    tx.run(
      room.id, room.code, room.status, room.pauseReason, room.hostId,
      JSON.stringify(room.config), room.configVersion, room.stateVersion, room.eventSeq,
      room.puzzleId, room.roundNo, JSON.stringify(room.turn), JSON.stringify(room.revealedFacts),
      JSON.stringify(room.hint), room.vote ? JSON.stringify(room.vote) : null,
      JSON.stringify(room.ai), JSON.stringify(room.credit), JSON.stringify(room.transfer),
      room.result ? JSON.stringify(room.result) : null,
      JSON.stringify(room.turnOrder), JSON.stringify(room.ready ?? []), room.turnIndex, room.createdAt, room.updatedAt,
    );

    const keep = room.members.map((m) => m.id);
    const existing = this.db.prepare('SELECT id FROM members WHERE room_id = ?').all(room.id) as { id: string }[];
    for (const row of existing) {
      if (!keep.includes(row.id)) this.db.prepare('DELETE FROM members WHERE id = ?').run(row.id);
    }
    const upsert = this.db.prepare(`
      INSERT INTO members(id, room_id, player_id, name, is_bot, role, join_seq, conn, activity, hidden,
                          last_activity_at, last_heartbeat_at, skip_streak, score, hints_t12, hints_t3,
                          guesses_used, last_hint_at, former_host, key_state, key_mask, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, is_bot = excluded.is_bot, role = excluded.role, join_seq = excluded.join_seq,
        conn = excluded.conn, activity = excluded.activity, hidden = excluded.hidden,
        last_activity_at = excluded.last_activity_at, last_heartbeat_at = excluded.last_heartbeat_at,
        skip_streak = excluded.skip_streak, score = excluded.score, hints_t12 = excluded.hints_t12,
        hints_t3 = excluded.hints_t3, guesses_used = excluded.guesses_used, last_hint_at = excluded.last_hint_at,
        former_host = excluded.former_host, key_state = excluded.key_state, key_mask = excluded.key_mask
    `);
    for (const m of room.members) {
      const ks = keyStates.get(m.id);
      upsert.run(
        m.id, room.id, m.playerId, m.name, m.isBot ? 1 : 0, m.role, m.joinSeq, m.conn, m.activity, m.hidden ? 1 : 0,
        m.lastActivityAt, m.lastHeartbeatAt, m.skipStreak, m.score, m.hintsUsedT12, m.hintsUsedT3,
        m.guessesUsed, m.lastHintAt, ks?.formerHost ? 1 : 0, ks?.state ?? 'none', ks?.mask ?? null, room.createdAt,
      );
    }
  }

  setResumeTokenHash(memberId: string, hash: string | null): void {
    this.db.prepare('UPDATE members SET resume_token_hash = ? WHERE id = ?').run(hash, memberId);
  }

  /** 吊销某成员的所有会话（房主踢人时调用）：清掉续期令牌，他下一次请求就会被登出。 */
  revokeMemberSessions(memberId: string): void {
    this.db.prepare('UPDATE members SET resume_token_hash = NULL WHERE id = ?').run(memberId);
  }

  findMemberByToken(hash: string): { id: string; roomId: string } | null {
    const row = this.db.prepare('SELECT id, room_id FROM members WHERE resume_token_hash = ?').get(hash) as { id: string; room_id: string } | undefined;
    return row ? { id: row.id, roomId: row.room_id } : null;
  }

  memberKeyStates(roomId: string): Map<string, { state: string; mask: string | null; formerHost: boolean }> {
    const rows = this.db.prepare('SELECT id, key_state, key_mask, former_host FROM members WHERE room_id = ?').all(roomId) as { id: string; key_state: string; key_mask: string | null; former_host: number }[];
    const out = new Map<string, { state: string; mask: string | null; formerHost: boolean }>();
    for (const r of rows) out.set(r.id, { state: r.key_state, mask: r.key_mask, formerHost: r.former_host === 1 });
    return out;
  }

  setMemberKeyState(memberId: string, state: string, mask: string | null, formerHost?: boolean): void {
    if (formerHost === undefined) {
      this.db.prepare('UPDATE members SET key_state = ?, key_mask = ? WHERE id = ?').run(state, mask, memberId);
    } else {
      this.db.prepare('UPDATE members SET key_state = ?, key_mask = ?, former_host = ? WHERE id = ?')
        .run(state, mask, formerHost ? 1 : 0, memberId);
    }
  }

  loadRooms(): Array<{ room: CoreRoom; code: string }> {
    const rows = this.db.prepare('SELECT * FROM rooms WHERE status != ?').all('destroyed') as Record<string, unknown>[];
    return rows.map((row) => {
      const roomId = String(row.id);
      const memberRows = this.db.prepare('SELECT * FROM members WHERE room_id = ? ORDER BY join_seq').all(roomId) as Record<string, unknown>[];
      const members: CoreMember[] = memberRows.map((m) => ({
        id: String(m.id),
        playerId: String(m.player_id),
        name: String(m.name),
        isBot: Number(m.is_bot) === 1,
        role: String(m.role) as CoreMember['role'],
        joinSeq: Number(m.join_seq),
        conn: String(m.conn) as CoreMember['conn'],
        activity: String(m.activity) as CoreMember['activity'],
        hidden: Number(m.hidden) === 1,
        lastActivityAt: Number(m.last_activity_at),
        lastHeartbeatAt: Number(m.last_heartbeat_at),
        skipStreak: Number(m.skip_streak),
        score: Number(m.score),
        hintsUsedT12: Number(m.hints_t12),
        hintsUsedT3: Number(m.hints_t3),
        guessesUsed: Number(m.guesses_used),
        lastHintAt: Number(m.last_hint_at),
      }));
      const room: CoreRoom = {
        id: roomId,
        code: String(row.code),
        status: String(row.status) as CoreRoom['status'],
        pauseReason: (row.pause_reason as string | null) ?? null,
        hostId: (row.host_member_id as string | null) ?? null,
        members,
        turnOrder: JSON.parse(String(row.turn_order_json ?? '[]')),
        turnIndex: Number(row.turn_index ?? 0),
        roundNo: Number(row.round_no ?? 1),
        turn: JSON.parse(String(row.turn_json)),
        config: JSON.parse(String(row.config_json)) as GameConfig,
        configVersion: Number(row.config_version ?? 1),
        stateVersion: Number(row.state_version ?? 0),
        eventSeq: Number(row.event_seq ?? 0),
        puzzleId: (row.puzzle_id as string | null) ?? null,
        revealedFacts: JSON.parse(String(row.revealed_facts_json ?? '[]')),
        ready: JSON.parse(String(row.ready_json ?? '[]')),
        hint: JSON.parse(String(row.hint_json ?? '{"tier3Used":0}')),
        vote: row.vote_json ? JSON.parse(String(row.vote_json)) : null,
        ai: JSON.parse(String(row.ai_json)),
        credit: JSON.parse(String(row.credit_json)),
        transfer: JSON.parse(String(row.transfer_json)),
        result: row.result_json ? JSON.parse(String(row.result_json)) : null,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      };
      return { room, code: room.code };
    });
  }

  // ---------------------------------------------------------------- 提问 / 对局
  insertQuestion(q: QuestionRecord): void {
    // explain 兼容旧库：列不存在时回落为不带该列的插入（Node 参考实现里库是本地文件）
    try {
      this.db.prepare(`
        INSERT INTO questions(id, room_id, match_id, turn_seq, member_id, text, answer, reason_code, source, late, matched_json, explain, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, turn_seq) DO NOTHING
      `).run(q.id, q.roomId, q.matchId, q.turnSeq, q.memberId, q.text, q.answer, q.reasonCode, q.source, q.late ? 1 : 0, JSON.stringify(q.matchedFactIds), q.explain ?? null, q.createdAt);
    } catch {
      this.db.prepare(`
        INSERT INTO questions(id, room_id, match_id, turn_seq, member_id, text, answer, reason_code, source, late, matched_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, turn_seq) DO NOTHING
      `).run(q.id, q.roomId, q.matchId, q.turnSeq, q.memberId, q.text, q.answer, q.reasonCode, q.source, q.late ? 1 : 0, JSON.stringify(q.matchedFactIds), q.createdAt);
    }
  }

  listQuestions(roomId: string): QuestionRecord[] {
    const rows = this.db.prepare('SELECT * FROM questions WHERE room_id = ? ORDER BY turn_seq').all(roomId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      roomId: String(r.room_id),
      matchId: (r.match_id as string | null) ?? null,
      turnSeq: Number(r.turn_seq),
      memberId: String(r.member_id),
      text: String(r.text),
      answer: String(r.answer),
      reasonCode: String(r.reason_code),
      source: String(r.source),
      late: Number(r.late) === 1,
      matchedFactIds: JSON.parse(String(r.matched_json ?? '[]')),
      explain: r.explain === null || r.explain === undefined ? null : String(r.explain),
      createdAt: Number(r.created_at),
    }));
  }

  startMatch(roomId: string, puzzleId: string, config: GameConfig, turnOrder: string[], creditSource: string, now: number): string {
    const id = `match_${roomId}_${now}`;
    this.db.prepare(`
      INSERT INTO matches(id, room_id, puzzle_id, config_snapshot, turn_order_snapshot, credit_source, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, roomId, puzzleId, JSON.stringify(config), JSON.stringify(turnOrder), creditSource, now);
    return id;
  }

  endMatch(roomId: string, result: string, reason: string, now: number, revealAt: number | null): void {
    this.db.prepare(`
      UPDATE matches SET result = ?, reason = ?, ended_at = ?, reveal_at = ?
      WHERE room_id = ? AND ended_at IS NULL
    `).run(result, reason, now, revealAt, roomId);
  }

  currentMatch(roomId: string): { id: string; puzzleId: string; startedAt: number; revealAt: number | null; result: string | null } | null {
    const row = this.db.prepare('SELECT * FROM matches WHERE room_id = ? ORDER BY started_at DESC LIMIT 1').get(roomId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      puzzleId: String(row.puzzle_id),
      startedAt: Number(row.started_at),
      revealAt: row.reveal_at === null || row.reveal_at === undefined ? null : Number(row.reveal_at),
      result: (row.result as string | null) ?? null,
    };
  }

  // ---------------------------------------------------------------- 投票
  saveVote(roomId: string, vote: CoreRoom['vote']): void {
    if (!vote) return;
    this.db.prepare(`
      INSERT INTO votes(id, room_id, type, status, ballots_json, eligible_json, opened_at, deadline_at, result, tally_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, ballots_json = excluded.ballots_json,
        result = excluded.result, tally_json = excluded.tally_json
    `).run(vote.id, roomId, vote.type, vote.status, JSON.stringify(vote.ballots), JSON.stringify(vote.eligibleAtOpen), vote.openedAt, vote.deadlineAt, vote.result ?? null, vote.tally ? JSON.stringify(vote.tally) : null);
  }

  saveGrant(roomId: string, grantId: string, gameId: string | null, calls: number, reason: string, now: number, expiresAt: number): void {
    this.db.prepare(`
      INSERT INTO usage_counters(id, scope, period, calls, cost_estimate, grants_count)
      VALUES (?, ?, ?, 0, 0, 1)
      ON CONFLICT(scope, period) DO UPDATE SET grants_count = grants_count + 1
    `).run(`site:${periodKey(now)}`, 'site', periodKey(now));
    this.audit({ action: 'credit_grant', roomId, subject: grantId, result: reason, meta: { calls, gameId, expiresAt } });
  }

  // ---------------------------------------------------------------- 调用计量 / 判定缓存
  bumpUsage(scope: string, now: number, calls = 1, cost = 0, blocked = 0): void {
    const period = periodKey(now);
    this.db.prepare(`
      INSERT INTO usage_counters(id, scope, period, calls, cost_estimate, blocked_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, period) DO UPDATE SET
        calls = calls + excluded.calls,
        cost_estimate = cost_estimate + excluded.cost_estimate,
        blocked_count = blocked_count + excluded.blocked_count
    `).run(`${scope}:${period}`, scope, period, calls, cost, blocked);
  }

  usage(scope: string, now: number): { calls: number; cost: number; blocked: number; grants: number } {
    const row = this.db.prepare('SELECT * FROM usage_counters WHERE scope = ? AND period = ?').get(scope, periodKey(now)) as Record<string, unknown> | undefined;
    return {
      calls: Number(row?.calls ?? 0),
      cost: Number(row?.cost_estimate ?? 0),
      blocked: Number(row?.blocked_count ?? 0),
      grants: Number(row?.grants_count ?? 0),
    };
  }

  getVerdict(puzzleId: string, questionHash: string, promptVersion: string, factSetVersion: number): VerdictCacheRow | null {
    const row = this.db.prepare(`
      SELECT * FROM verdict_cache WHERE puzzle_id = ? AND question_hash = ? AND prompt_version = ? AND fact_set_version = ?
    `).get(puzzleId, questionHash, promptVersion, factSetVersion) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare(`
      UPDATE verdict_cache SET hit_count = hit_count + 1
      WHERE puzzle_id = ? AND question_hash = ? AND prompt_version = ? AND fact_set_version = ?
    `).run(puzzleId, questionHash, promptVersion, factSetVersion);
    return {
      puzzleId: String(row.puzzle_id),
      questionHash: String(row.question_hash),
      promptVersion: String(row.prompt_version),
      factSetVersion: Number(row.fact_set_version),
      answer: String(row.answer),
      reasonCode: String(row.reason_code),
      matchedFactIds: JSON.parse(String(row.matched_json ?? '[]')),
      hitCount: Number(row.hit_count),
      createdAt: Number(row.created_at),
    };
  }

  putVerdict(row: VerdictCacheRow): void {
    this.db.prepare(`
      INSERT INTO verdict_cache(puzzle_id, question_hash, prompt_version, fact_set_version, answer, reason_code, matched_json, hit_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(puzzle_id, question_hash, prompt_version, fact_set_version) DO NOTHING
    `).run(row.puzzleId, row.questionHash, row.promptVersion, row.factSetVersion, row.answer, row.reasonCode, JSON.stringify(row.matchedFactIds), row.hitCount, row.createdAt);
  }

  // ---------------------------------------------------------------- 密钥凭据
  insertCredential(cred: CredentialRecord): void {
    this.db.prepare(`
      INSERT INTO credentials(id, owner_player_id, room_id, provider, model, base_url_host, state, mask, fingerprint,
                              cipher, iv, tag, key_id, ttl_expires_at, suspend_reason, destroyed_reason, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state, mask = excluded.mask, fingerprint = excluded.fingerprint,
        cipher = excluded.cipher, iv = excluded.iv, tag = excluded.tag, key_id = excluded.key_id,
        ttl_expires_at = excluded.ttl_expires_at, suspend_reason = excluded.suspend_reason,
        destroyed_reason = excluded.destroyed_reason, last_used_at = excluded.last_used_at
    `).run(
      cred.id, cred.ownerPlayerId, cred.roomId, cred.provider, cred.model, cred.baseUrlHost, cred.state,
      cred.mask, cred.fingerprint,
      cred.blob ? cred.blob.cipher : null, cred.blob ? cred.blob.iv : null, cred.blob ? cred.blob.tag : null,
      cred.blob ? cred.blob.keyId : null,
      cred.ttlExpiresAt, cred.suspendReason, cred.destroyedReason, cred.createdAt, cred.lastUsedAt,
    );
  }

  /** 销毁：**物理清空**密钥材料（密文/指纹/掩码），只保留行与原因用于审计。 */
  destroyCredential(id: string, reason: string, now: number): void {
    this.db.prepare(`
      UPDATE credentials SET state = 'destroyed', cipher = NULL, iv = NULL, tag = NULL, key_id = NULL,
                             fingerprint = NULL, mask = NULL, destroyed_reason = ?, ttl_expires_at = NULL
      WHERE id = ?
    `).run(reason, id);
    this.audit({ action: 'credential_destroyed', subject: id, result: reason, meta: { at: now } });
  }

  getCredential(id: string): CredentialRecord | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToCredential(row) : null;
  }

  /** 取房间当前"绑定"的凭据：优先 ACTIVE，其次 SUSPENDED/VALIDATING（用于状态展示与复测）。 */
  roomCredential(roomId: string): CredentialRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM credentials WHERE room_id = ? AND state != 'destroyed' ORDER BY created_at DESC LIMIT 1
    `).get(roomId) as Record<string, unknown> | undefined;
    return row ? this.rowToCredential(row) : null;
  }

  private rowToCredential(row: Record<string, unknown>): CredentialRecord {
    const hasBlob = row.cipher && row.iv && row.tag;
    return {
      id: String(row.id),
      ownerPlayerId: String(row.owner_player_id),
      roomId: (row.room_id as string | null) ?? null,
      provider: String(row.provider),
      model: String(row.model),
      baseUrlHost: String(row.base_url_host),
      state: String(row.state) as CredentialState,
      mask: (row.mask as string | null) ?? null,
      fingerprint: (row.fingerprint as string | null) ?? null,
      blob: hasBlob ? {
        cipher: row.cipher as Buffer,
        iv: row.iv as Buffer,
        tag: row.tag as Buffer,
        keyId: String(row.key_id ?? 'mk1'),
      } : null,
      ttlExpiresAt: row.ttl_expires_at === null || row.ttl_expires_at === undefined ? null : Number(row.ttl_expires_at),
      suspendReason: (row.suspend_reason as string | null) ?? null,
      destroyedReason: (row.destroyed_reason as string | null) ?? null,
      createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    };
  }

  expireCredentials(now: number): number {
    const rows = this.db.prepare(`
      SELECT id FROM credentials WHERE state IN ('active','suspended','validating') AND ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?
    `).all(now) as { id: string }[];
    for (const r of rows) this.destroyCredential(r.id, 'TTL_EXPIRED', now);
    return rows.length;
  }

  // ---------------------------------------------------------------- 审计
  audit(entry: { action: string; roomId?: string | null; actor?: string | null; subject?: string | null; result?: string | null; ipHash?: string | null; meta?: Record<string, unknown> }): void {
    this.db.prepare(`
      INSERT INTO audit_events(id, ts, room_id, actor, action, subject, result, ip_hash, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      Date.now(), entry.roomId ?? null, entry.actor ?? null, entry.action,
      entry.subject ?? null, entry.result ?? null, entry.ipHash ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
    );
  }

  countAudit(action: string, roomId?: string): number {
    const row = roomId
      ? this.db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE action = ? AND room_id = ?').get(action, roomId) as { c: number }
      : this.db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE action = ?').get(action) as { c: number };
    return Number(row?.c ?? 0);
  }

  /** 房间销毁：清理该房间全部凭据 + 未完成的授权（不等 TTL）。 */
  destroyRoomCredentials(roomId: string, now: number): number {
    const rows = this.db.prepare('SELECT id FROM credentials WHERE room_id = ? AND state != ?').all(roomId, 'destroyed') as { id: string }[];
    for (const r of rows) this.destroyCredential(r.id, 'ROOM_DESTROYED', now);
    return rows.length;
  }

  enableWALCheckpoint(): void {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignore */ }
  }
}

export function periodKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type { EncryptedBlob };

