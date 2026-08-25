package com.moyo.springchat.common;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 轻量级内存令牌存储（演示用，重启即失效）。
 * 生产环境应替换为 JWT / Redis 等持久化方案。
 */
@Component
public class TokenStore {

    private final Map<String, Long> tokenToUser = new ConcurrentHashMap<>();

    public String createToken(Long userId) {
        String token = UUID.randomUUID().toString().replace("-", "");
        tokenToUser.put(token, userId);
        return token;
    }

    public Long getUserId(String token) {
        if (token == null) {
            return null;
        }
        return tokenToUser.get(token.trim());
    }

    public void remove(String token) {
        if (token != null) {
            tokenToUser.remove(token.trim());
        }
    }

    /** 强制下线：移除某用户持有的全部令牌（踢掉其所有登录会话） */
    public void removeByUser(Long userId) {
        if (userId == null) return;
        tokenToUser.entrySet().removeIf(e -> userId.equals(e.getValue()));
    }

    /** 当前在线的所有用户 id（去重），用于向全员实时推送通知 */
    public java.util.Set<Long> onlineUserIds() {
        return new java.util.LinkedHashSet<>(tokenToUser.values());
    }
}
