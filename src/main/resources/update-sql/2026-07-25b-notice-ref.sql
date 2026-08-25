-- 通知关联业务 id：COMMENT 类通知（朋友圈评论/回复）记录对应的 moment（动态）id，
-- 便于用户点击通知直接跳转到对应朋友圈内容。ADMIN 等类通知 ref_id 为 NULL。
-- 仅在未重跑全量 schema.sql 的老库上执行；全新库已包含在 schema.sql 中。

ALTER TABLE notice
    ADD COLUMN ref_id BIGINT DEFAULT NULL COMMENT '关联业务 id（如朋友圈评论通知关联的 moment id）' AFTER read_wait_seconds;
