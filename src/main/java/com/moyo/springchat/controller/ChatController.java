package com.moyo.springchat.controller;

import com.moyo.springchat.common.AuthUser;
import com.moyo.springchat.dto.MessageSendDto;
import com.moyo.springchat.dto.WsMessage;
import com.moyo.springchat.service.FriendService;
import com.moyo.springchat.service.GroupService;
import com.moyo.springchat.service.MessageService;
import com.moyo.springchat.service.UserService;
import com.moyo.springchat.service.AiAssistantService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

import java.security.Principal;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * WebSocket 消息入口：客户端发送到 /app/chat.send
 */
@Controller
public class ChatController {

    /** 加急消息限流：每个发送者两次加急的最小间隔（毫秒） */
    private static final long URGENT_INTERVAL_MS = 10_000;

    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    @Autowired
    private MessageService messageService;

    @Autowired
    private FriendService friendService;

    @Autowired
    private GroupService groupService;

    @Autowired
    private UserService userService;

    @Autowired
    private AiAssistantService aiAssistantService;

    /** 记录每个用户上一次成功发送加急消息的时间戳 */
    private final ConcurrentMap<Long, Long> lastUrgentTime = new ConcurrentHashMap<>();

    @MessageMapping("chat.send")
    public void handle(@Payload MessageSendDto dto, Principal principal) {
        Long senderId;
        if (principal instanceof AuthUser au) {
            senderId = au.getUserId();
        } else {
            senderId = dto.getSenderId();
        }
        if (senderId == null || dto.getTargetType() == null || dto.getTargetId() == null) {
            return;
        }
        // 账号被冻结：禁止发送任何消息，并向发送者推送「发送失败」通知（不落库、不转发）
        if (userService.isFrozen(senderId)) {
            Map<String, Object> notice = new HashMap<>();
            notice.put("type", "SEND_FAILED");
            notice.put("targetType", dto.getTargetType());
            notice.put("targetId", dto.getTargetId());
            notice.put("reason", "你的账号已被冻结，无法发送消息");
            messagingTemplate.convertAndSend("/topic/user/" + senderId, notice);
            return;
        }
        // 加急消息限流：10 秒内重复发送直接拦截，向发送者推送提示（不落库、不转发）
        if (Boolean.TRUE.equals(dto.getUrgent())) {
            Long last = lastUrgentTime.get(senderId);
            long now = System.currentTimeMillis();
            if (last != null && now - last < URGENT_INTERVAL_MS) {
                Map<String, Object> notice = new HashMap<>();
                notice.put("type", "URGENT_LIMIT");
                notice.put("targetType", dto.getTargetType());
                notice.put("targetId", dto.getTargetId());
                notice.put("reason", "加急消息过于频繁，请间隔 10 秒再发");
                messagingTemplate.convertAndSend("/topic/user/" + senderId, notice);
                return;
            }
        }
        // 单向拉黑：仅当收件方把发送方拉黑时禁止发送单聊消息，并向发送者推送「发送失败」通知
        if ("USER".equals(dto.getTargetType()) && friendService.isBlocked(senderId, dto.getTargetId())) {
            Map<String, Object> notice = new HashMap<>();
            notice.put("type", "SEND_FAILED");
            notice.put("targetType", dto.getTargetType());
            notice.put("targetId", dto.getTargetId());
            notice.put("reason", "对方已把你拉黑，消息无法送达");
            messagingTemplate.convertAndSend("/topic/user/" + senderId, notice);
            return;
        }
        // 群聊已解散（deleted=1）：禁止发送，向发送者推送「发送失败」通知，不落库不转发
        if ("GROUP".equals(dto.getTargetType())) {
            com.moyo.springchat.entity.ChatGroup grp = groupService.getGroup(dto.getTargetId());
            if (grp != null && Integer.valueOf(1).equals(grp.getDeleted())) {
                Map<String, Object> notice = new HashMap<>();
                notice.put("type", "SEND_FAILED");
                notice.put("targetType", "GROUP");
                notice.put("targetId", dto.getTargetId());
                notice.put("reason", "该群聊已被群主解散，无法发送消息");
                messagingTemplate.convertAndSend("/topic/user/" + senderId, notice);
                return;
            }
        }
        // 加急限流校验通过后才记录时间戳（被拉黑拦截的不计）
        if (Boolean.TRUE.equals(dto.getUrgent())) {
            lastUrgentTime.put(senderId, System.currentTimeMillis());
        }

        WsMessage wm = messageService.save(senderId, dto.getType(), dto.getContent(), dto.getTargetType(), dto.getTargetId(), dto.getUrgent());

        if ("USER".equals(dto.getTargetType())) {
            // 发给接收方与发送方本人
            messagingTemplate.convertAndSend("/topic/user/" + dto.getTargetId(), wm);
            messagingTemplate.convertAndSend("/topic/user/" + senderId, wm);
            // 若接收方是 AI 助手：用「对话的目标 AI」异步生成回复并推回给用户（而非默认助手）
            if (aiAssistantService.isAssistant(dto.getTargetId()) && "TEXT".equals(dto.getType())) {
                replyByAssistantAsync(senderId, dto.getTargetId(), dto.getContent());
            }
        } else if ("GROUP".equals(dto.getTargetType())) {
            messagingTemplate.convertAndSend("/topic/group/" + dto.getTargetId(), wm);
        } else if ("SESSION".equals(dto.getTargetType())) {
            // 私人会话：自己发给自己，仅推送给发送方本人
            messagingTemplate.convertAndSend("/topic/user/" + senderId, wm);
        }
    }

    /** 异步让「目标 AI」回复用户：新线程调用 AI，生成后落库并推送给用户本人（不推给助手账户） */
    private void replyByAssistantAsync(Long userId, Long assistantUserId, String userText) {
        if (assistantUserId == null) assistantUserId = aiAssistantService.getAssistantId();
        if (assistantUserId == null) return;
        Long assistantId = assistantUserId;
        // 先给发送方一个「正在输入」提示（提示来自正在对话的这个 AI）
        Map<String, Object> typing = new LinkedHashMap<>();
        typing.put("type", "TYPING");
        typing.put("senderId", assistantId);
        typing.put("targetType", "USER");
        typing.put("targetId", userId);
        messagingTemplate.convertAndSend("/topic/user/" + userId, typing);

        new Thread(() -> {
            try {
                String reply = aiAssistantService.chat(assistantId, userText);
                if (reply != null && !reply.isBlank()) {
                    WsMessage am = messageService.save(assistantId, "TEXT", reply, "USER", userId, false);
                    messagingTemplate.convertAndSend("/topic/user/" + userId, am);
                }
            } catch (Exception ignored) {
                // AI 回复异常不阻断主流程；可补充失败提示
                Map<String, Object> err = new LinkedHashMap<>();
                err.put("type", "ASSISTANT_ERROR");
                err.put("senderId", assistantId);
                err.put("targetType", "USER");
                err.put("targetId", userId);
                err.put("content", "moyo助手暂时无法回复，请稍后再试～");
                messagingTemplate.convertAndSend("/topic/user/" + userId, err);
            }
        }, "moyo-assistant-reply").start();
    }

    /**
     * 实时「窥探」：发送方每次输入框内容变化，把当前内容推给正在查看自己的对方。
     * 仅单聊有效；仅当对方已发出 TYPING_VIEW(viewing=true) 时，对方界面才会显示。
     */
    @MessageMapping("typing.content")
    public void typingContent(@Payload WsMessage wm, Principal principal) {
        Long senderId = principal instanceof AuthUser au ? au.getUserId() : wm.getSenderId();
        if (senderId == null || !"USER".equals(wm.getTargetType()) || wm.getTargetId() == null) return;
        if (!friendService.isFriend(senderId, wm.getTargetId())) return;
        WsMessage out = new WsMessage();
        out.setType("TYPING_CONTENT");
        out.setSenderId(senderId);
        out.setTargetType("USER");
        out.setTargetId(wm.getTargetId());
        out.setContent(wm.getContent());
        messagingTemplate.convertAndSend("/topic/user/" + wm.getTargetId(), out);
    }

    /**
     * 查看开关：对方点击「查看」开始窥探时 viewing=true，关闭面板时 viewing=false。
     * 服务端把该开关转告给被查看者，由被查看者决定是否推送输入框内容。
     */
    @MessageMapping("typing.view")
    public void typingView(@Payload WsMessage wm, Principal principal) {
        Long viewerId = principal instanceof AuthUser au ? au.getUserId() : wm.getSenderId();
        if (viewerId == null || !"USER".equals(wm.getTargetType()) || wm.getTargetId() == null) return;
        if (!friendService.isFriend(viewerId, wm.getTargetId())) return;
        WsMessage out = new WsMessage();
        out.setType("TYPING_VIEW");
        out.setSenderId(viewerId);
        out.setTargetType("USER");
        out.setTargetId(wm.getTargetId());
        out.setTyping(wm.getTyping());
        messagingTemplate.convertAndSend("/topic/user/" + wm.getTargetId(), out);
    }
}
