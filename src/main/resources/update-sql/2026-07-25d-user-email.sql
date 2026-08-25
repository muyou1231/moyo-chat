-- 用户邮箱字段：用于「邮箱验证码登录」准备（绑定后可凭邮箱+验证码登录）
-- 可为空；用户通过个人资料页绑定邮箱后生效。
ALTER TABLE user
    ADD COLUMN email VARCHAR(128) DEFAULT NULL COMMENT '绑定邮箱，用于邮箱验证码登录' AFTER hobbies;

CREATE UNIQUE INDEX uk_user_email ON user (email);
