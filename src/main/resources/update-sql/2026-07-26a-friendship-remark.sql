-- 2026-07-26 好友备注功能：friendship 表新增 remark 列
-- MySQL 5.7 不支持 ADD COLUMN IF NOT EXISTS，用存储过程包裹做幂等（列已存在则跳过）

DELIMITER $$

CREATE PROCEDURE p_add_friendship_remark()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
    ALTER TABLE friendship
        ADD COLUMN remark VARCHAR(64) DEFAULT NULL COMMENT '好友备注（仅本人视角）' AFTER status;
END$$

CALL p_add_friendship_remark()$$

DROP PROCEDURE p_add_friendship_remark$$

DELIMITER ;
