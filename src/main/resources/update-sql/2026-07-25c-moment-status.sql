-- 朋友圈动态打回（整改）支持：新增状态与打回原因字段
-- 仅追加列，不影响已有数据；默认 NORMAL（正常）。
ALTER TABLE moment
    ADD COLUMN status        VARCHAR(16) NOT NULL DEFAULT 'NORMAL' COMMENT '动态状态：NORMAL=正常 / REJECTED=已打回整改' AFTER visibility,
    ADD COLUMN reject_reason VARCHAR(255) DEFAULT NULL COMMENT '打回原因（status=REJECTED 时由管理员填写）' AFTER status;

CREATE INDEX idx_moment_status ON moment (status);
