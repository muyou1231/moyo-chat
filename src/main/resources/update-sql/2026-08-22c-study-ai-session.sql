-- 2026-08-22 新增：学习空间 AI 对话「会话」维度表。
-- 每个 AI 会话（按主题/轮次拆分）一行，study_chat 通过 session_id 关联到本表。
-- 用 CREATE TABLE IF NOT EXISTS 做幂等（MySQL 5.7 不支持 DROP/CREATE INDEX IF EXISTS，
-- 存储过程在 stdin 管道下易报 DELIMITER 语法错，故直接 IF NOT EXISTS 建表即可）。

CREATE TABLE IF NOT EXISTS study_ai_session (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    user_id     BIGINT       NOT NULL COMMENT '所属用户',
    title       VARCHAR(128) NOT NULL COMMENT '会话标题（可重命名）',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_study_ai_session_user (user_id, create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- study_chat 增加 session_id 列，关联 study_ai_session（幂等 ALTER，5.7 不支持 IF NOT EXISTS，用存储过程跳过重复加列）。
DELIMITER $$
CREATE PROCEDURE p_alter_study_chat_session()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
    ALTER TABLE study_chat ADD COLUMN session_id BIGINT NOT NULL DEFAULT 0 COMMENT '所属 AI 会话；0 表示改造前的旧数据（全局单对话）';
    ALTER TABLE study_chat ADD KEY idx_study_chat_session (user_id, session_id, seq);
END$$
CALL p_alter_study_chat_session()$$
DROP PROCEDURE p_alter_study_chat_session$$
DELIMITER ;

