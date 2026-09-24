-- 0007：全员讨论区（房间内自由聊天，不参与判定）。
-- chat_seq 在房间内单调递增，客户端用它做增量拉取游标；
-- (room_id, member_id, client_message_id) 唯一约束保证网络重试不会写出重复消息。
-- 幂等键**按发送者划分**：不同的人各自生成 id，不该互相顶掉对方的消息
-- （同一房间内两个人碰巧用了同一个 id 时，按房间唯一会让后发的人消息被静默吞掉）。
CREATE TABLE IF NOT EXISTS room_chat (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  chat_seq INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  text TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(room_id, member_id, client_message_id),
  UNIQUE(room_id, chat_seq)
);
CREATE INDEX IF NOT EXISTS idx_room_chat ON room_chat(room_id, chat_seq);
CREATE INDEX IF NOT EXISTS idx_room_chat_member ON room_chat(room_id, member_id, chat_seq);
