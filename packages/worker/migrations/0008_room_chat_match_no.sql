-- 0008：局号（讨论区跨局分隔线用，设计稿 §12.8）。
-- 两处都要加：
--   1) rooms.match_no     —— 房间当前已经开始的局数（0 = 还没开过局）
--   2) room_chat.match_no —— 发每条讨论消息时的局号，前端据此画「第 N 局开始」
-- 老数据一律落到 0（它们确实都是"开局前/局号未知"的消息），不影响任何判定。
ALTER TABLE rooms ADD COLUMN match_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_chat ADD COLUMN match_no INTEGER NOT NULL DEFAULT 0;
