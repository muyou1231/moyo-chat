-- 2026-07-24e 群解散标记 + 朋友圈评论
-- 群表增加 deleted 标记（1=已解散，保留历史，成员可见但不可发消息）
ALTER TABLE chat_group ADD COLUMN deleted TINYINT(1) DEFAULT 0 COMMENT '1=已解散（保留历史，成员可见但不可发消息）';

-- 朋友圈评论表（文字 + 图片）
CREATE TABLE moment_comment (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    moment_id   BIGINT       NOT NULL,
    user_id     BIGINT       NOT NULL,
    content     TEXT,
    images      TEXT         COMMENT 'JSON 数组，存走 8080 代理的图片 URL，无图时为空数组',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_comment_moment (moment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
