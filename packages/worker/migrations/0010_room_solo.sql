-- 单人房标记（主界面的「单人模式」）。
--
-- 1 = 单人房：一个回合永远是自己、**不计时**（deadlineAt/graceDeadlineAt = 0 表示不限时），
-- 讨论区 / 准备举手 / 投票 / 踢人 / 房主移交 一律由服务端拒绝，别人也无法加入。
-- 0 = 普通多人房（默认，历史房间全部是 0）。
ALTER TABLE rooms ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
