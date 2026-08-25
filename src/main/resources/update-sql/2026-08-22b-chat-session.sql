-- 2026-08-22b 新增：用户自建会话（聊天的会话管理：显式创建/删除空会话条目）
-- 会话不属于好友也不属于群，是用户自己的「私人会话/笔记会话」，仅自己可见。
-- MySQL 5.7 支持 CREATE TABLE IF NOT EXISTS，直接幂等建表。

CREATE TABLE IF NOT EXISTS chat_session (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    user_id     BIGINT       NOT NULL COMMENT '所属用户',
    title       VARCHAR(128) NOT NULL COMMENT '会话标题（用户自定义）',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_chat_session_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
