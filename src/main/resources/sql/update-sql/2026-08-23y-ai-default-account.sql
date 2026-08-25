-- 2026-08-23y AI 助手默认标记 + 账号扩长
-- 1) ai_assistant 新增 is_default 列（标识当前默认助手）
-- 2) user.account 由 VARCHAR(10) 扩到 VARCHAR(20)，支持手填/生成 >=10 位账号
-- 3) 将 id=1 的助手设为默认（兼容既有数据）
-- MySQL 5.7 不支持 IF EXISTS / IF NOT EXISTS，用存储过程包裹 CONTINUE HANDLER 做幂等

DELIMITER $$

CREATE PROCEDURE p_20260823y()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;

    -- 1) 新增 is_default 列
    ALTER TABLE ai_assistant
        ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1=默认助手：新用户自动添加，删除后自动切换到下一个';

    -- 2) account 扩长（仅当长度仍为 10 时；已是 20 则 ALTER 幂等不报错，HANDLER 吞掉）
    ALTER TABLE user
        MODIFY COLUMN account VARCHAR(20) NOT NULL;

    -- 3) 默认助手初始化：若尚无任何 is_default=1，则把 id 最小者（通常是 id=1）设为默认
    IF NOT EXISTS (SELECT 1 FROM ai_assistant WHERE is_default = 1) THEN
        UPDATE ai_assistant SET is_default = 1 WHERE id = (SELECT min_id FROM (SELECT MIN(id) AS min_id FROM ai_assistant) t);
    END IF;
END$$

CALL p_20260823y()$$
DROP PROCEDURE p_20260823y$$

DELIMITER ;
