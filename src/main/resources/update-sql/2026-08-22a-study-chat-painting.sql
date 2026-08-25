-- 2026-08-22 新增：AI 对话历史持久化表 + 绘画作品管理表
-- 两张均为新增表，用存储过程做幂等（表已存在则跳过 CREATE TABLE）。
-- 执行后便于 study.js / painting.js 从后端读写，刷新/换设备可靠恢复。

DELIMITER $$

CREATE PROCEDURE p_create_study_chat()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
    CREATE TABLE study_chat (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        user_id     BIGINT       NOT NULL COMMENT '所属用户',
        role        VARCHAR(8)   NOT NULL COMMENT 'user=用户消息 / ai=AI 回复',
        mode        VARCHAR(16)  NOT NULL DEFAULT 'chat' COMMENT '对话模式：chat/plan/quiz/summarize',
        content     MEDIUMTEXT   COMMENT '消息内容（流式过程中实时更新 AI 回复）',
        seq         INT          NOT NULL DEFAULT 0 COMMENT '同一用户会话内的顺序号，从 1 递增，用于回放排序',
        create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_study_chat_user (user_id, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
END$$

CALL p_create_study_chat()$$

DROP PROCEDURE p_create_study_chat$$

CREATE PROCEDURE p_create_painting()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
    CREATE TABLE painting (
        id          BIGINT       NOT NULL AUTO_INCREMENT,
        user_id     BIGINT       NOT NULL COMMENT '所属用户',
        title       VARCHAR(128) NOT NULL COMMENT '作品标题',
        description VARCHAR(512) DEFAULT '' COMMENT '作品描述',
        image_url   VARCHAR(512) NOT NULL COMMENT '图片地址（MinIO 代理 URL 或外部链接）',
        create_time DATETIME     DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_painting_user (user_id, create_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
END$$

CALL p_create_painting()$$

DROP PROCEDURE p_create_painting$$

DELIMITER ;
