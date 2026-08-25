-- 朋友圈点赞功能：点赞表（用户对动态点赞）
-- 唯一键 (moment_id, user_id) 防止同一用户对同一条动态重复点赞
CREATE TABLE IF NOT EXISTS moment_like (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    moment_id   BIGINT       NOT NULL COMMENT '被点赞的动态 id',
    user_id     BIGINT       NOT NULL COMMENT '点赞用户 id',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_moment_like (moment_id, user_id),
    KEY idx_moment_like_moment (moment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
