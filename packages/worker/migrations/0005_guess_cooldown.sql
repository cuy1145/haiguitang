-- 0005：猜汤底改为「随时可猜 + 全房间共用冷却」。
-- 这一列存共用冷却的截止时间（毫秒时间戳，0 = 当前谁都可以猜）。
-- 用 DEFAULT 0 保证老房间读出来就是"可以猜"，不需要数据回填。
ALTER TABLE rooms ADD COLUMN guess_cooldown_until INTEGER NOT NULL DEFAULT 0;
