-- 0006：中途进房「待入席」排队状态。
-- pending_seat：对局进行中进房的人先排队（不占轮转、不占玩家位）
-- seat_requested：他点了「申请下一轮上桌」，等到轮次 wrap 时转正进 turnOrder
-- 两列默认 0，老房间读出来就是"不是待入席"，无需数据回填。
ALTER TABLE members ADD COLUMN pending_seat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN seat_requested INTEGER NOT NULL DEFAULT 0;
