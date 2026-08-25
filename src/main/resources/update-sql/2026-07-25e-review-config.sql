-- 朋友圈审核模式开关（全局，仅一行 id=1）
-- AUTO=自动审核(直接发布) / MANUAL=人工审核(新发布/被打回重新发布的内容进入 PENDING 待管理员审核)
CREATE TABLE IF NOT EXISTS review_config (
    id    INT         NOT NULL AUTO_INCREMENT,
    mode  VARCHAR(16) NOT NULL DEFAULT 'AUTO' COMMENT 'AUTO=自动审核(直接发布) / MANUAL=人工审核(待审核)',
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO review_config (id, mode) VALUES (1, 'AUTO')
ON DUPLICATE KEY UPDATE mode = IFNULL(mode, 'AUTO');
