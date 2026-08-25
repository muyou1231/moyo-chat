-- 邮箱验证注册 / 多账号支持（MySQL 5.7 兼容，幂等可重复执行）：
-- 1) 一个邮箱最多可注册 3 个账号，因此移除 email 唯一索引（保留 username/account 唯一）
-- 2) 新增 email_verified 标记列（历史账号默认 1=已验证；新注册在邮箱验证码校验通过后写入 1）
-- 注意：MySQL 5.7 不支持 DROP INDEX IF EXISTS，故用存储过程 + CONTINUE HANDLER 容错，
--       索引不存在 / 列已存在 时静默跳过，避免重复执行报错。
DELIMITER $$
DROP PROCEDURE IF EXISTS migrate_email_multi $$
CREATE PROCEDURE migrate_email_multi()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
    ALTER TABLE user DROP INDEX uk_user_email;
    ALTER TABLE user ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 1 COMMENT '邮箱是否已验证：1=已验证 0=未验证（注册需邮箱验证码）' AFTER email;
END $$
DELIMITER ;
CALL migrate_email_multi();
DROP PROCEDURE IF EXISTS migrate_email_multi;
