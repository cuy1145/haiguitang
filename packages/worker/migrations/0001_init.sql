-- ============================================================================
-- D1 初始迁移（方案 A：无 Durable Objects）
--
-- D1 就是 SQLite，因此这里的结构与 Node 版 packages/server/src/store.ts 保持一致：
-- 唯一的差别是多了一张 room_events（原来 WebSocket 广播的内容改存这里，客户端按 seq 增量拉取）
-- 和一张 sessions（原来放在 Library DO）。
--
-- 应用方式：
--   本地预览：npx wrangler d1 migrations apply haiguitang --local
--   线上：    npx wrangler d1 migrations apply haiguitang --remote
-- ============================================================================

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  pause_reason TEXT,
  host_member_id TEXT,
  config_json TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  state_version INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  puzzle_id TEXT,
  round_no INTEGER NOT NULL DEFAULT 1,
  turn_json TEXT NOT NULL,
  revealed_facts_json TEXT NOT NULL DEFAULT '[]',
  hint_json TEXT NOT NULL DEFAULT '{"tier3Used":0}',
  vote_json TEXT,
  ai_json TEXT NOT NULL,
  credit_json TEXT NOT NULL,
  transfer_json TEXT NOT NULL,
  result_json TEXT,
  turn_order_json TEXT NOT NULL DEFAULT '[]',
  turn_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rooms_updated ON rooms(updated_at);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  join_seq INTEGER NOT NULL,
  conn TEXT NOT NULL DEFAULT 'connected',
  activity TEXT NOT NULL DEFAULT 'active',
  hidden INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  skip_streak INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  hints_t12 INTEGER NOT NULL DEFAULT 0,
  hints_t3 INTEGER NOT NULL DEFAULT 0,
  guesses_used INTEGER NOT NULL DEFAULT 0,
  last_hint_at INTEGER NOT NULL DEFAULT 0,
  former_host INTEGER NOT NULL DEFAULT 0,
  key_state TEXT NOT NULL DEFAULT 'none',
  key_mask TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(room_id, player_id)
);
CREATE INDEX IF NOT EXISTS ix_members_room ON members(room_id, join_seq);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  match_id TEXT,
  turn_seq INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  text TEXT NOT NULL,
  answer TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  source TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  matched_json TEXT NOT NULL DEFAULT '[]',
  client_submit_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(room_id, turn_seq),
  UNIQUE(room_id, client_submit_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS ix_matches_room ON matches(room_id, started_at);

CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  ballots_json TEXT NOT NULL,
  eligible_json TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  result TEXT,
  tally_json TEXT
);

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
  matched_json TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS credit_grants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  match_id TEXT,
  calls INTEGER NOT NULL,
  reason TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 会话令牌：只存哈希（与 Node 版同一原则：原文只在签发响应里出现一次）
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_room ON sessions(room_id);

-- 房间事件流：原来通过 WebSocket 广播的内容改存这里，客户端按 seq 增量拉取
CREATE TABLE IF NOT EXISTS room_events (
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  text TEXT,
  state_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq)
);

-- 房间码索引（原来放在 Library DO）
CREATE TABLE IF NOT EXISTS room_codes (
  code TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
