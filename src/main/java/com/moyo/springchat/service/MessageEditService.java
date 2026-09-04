package com.moyo.springchat.service;

import com.moyo.springchat.entity.Message;
import com.moyo.springchat.entity.MessageEditHistory;
import com.moyo.springchat.mapper.MessageEditHistoryMapper;
import com.moyo.springchat.mapper.MessageMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ④ 消息改写。
 *
 * <p>核心规则（对应设计方案）：
 * <ul>
 *   <li>只能改自己发的 TEXT 消息，已撤回的不可改。</li>
 *   <li>对方<b>未读</b>：静默替换内容，接收方只看到新内容，不显示任何标记。</li>
 *   <li>对方<b>已读</b>：内容更新 + 打上"已编辑"角标（edited=1），接收方气泡显示角标。</li>
 *   <li>每次编辑前的原文都写入 message_edit_history（version=0 为最初原文），仅发送者本人可查。</li>
 *   <li>可消耗积分隐藏"已编辑"角标（见 {@link #HIDE_MARK_COST}）。</li>
 * </ul>
 */
@Service
public class MessageEditService {

    /** 隐藏"已编辑"角标所需积分 */
    public static final int HIDE_MARK_COST = 30;

    /** 编辑后正文最大长度，与发送消息保持一致的限制口径 */
    private static final int MAX_CONTENT_LENGTH = 2000;

    @Autowired
    private MessageMapper messageMapper;
    @Autowired
    private MessageEditHistoryMapper editHistoryMapper;
    @Autowired
    private PointsService pointsService;
    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    /**
     * 编辑消息。
     *
     * @return 更新后的消息实体
     * @throws IllegalArgumentException 校验失败时抛出，消息即错误提示
     */
    public Message edit(Long uid, Long messageId, String newContent) {
        Message m = messageMapper.selectById(messageId);
        if (m == null) throw new IllegalArgumentException("消息不存在");
        if (!uid.equals(m.getSenderId())) throw new IllegalArgumentException("只能编辑自己发送的消息");
        if (Boolean.TRUE.equals(m.getRecalled())) throw new IllegalArgumentException("已撤回的消息不能编辑");
        if (Boolean.TRUE.equals(m.getDeleted())) throw new IllegalArgumentException("消息已删除");
        if (!"TEXT".equals(m.getType())) throw new IllegalArgumentException("当前仅支持编辑文本消息");
        if (newContent == null || newContent.trim().isEmpty()) throw new IllegalArgumentException("内容不能为空");
        if (newContent.length() > MAX_CONTENT_LENGTH) {
            throw new IllegalArgumentException("内容过长（最多 " + MAX_CONTENT_LENGTH + " 字）");
        }
        String trimmed = newContent.trim();
        if (trimmed.equals(m.getContent())) return m; // 内容无变化，不做任何处理

        // 1) 先把"编辑前的原文"存档，再更新正文
        int nextVersion = editHistoryMapper.countByMessageId(messageId);
        MessageEditHistory history = new MessageEditHistory();
        history.setMessageId(messageId);
        history.setContent(m.getContent());
        history.setVersion(nextVersion);
        editHistoryMapper.insert(history);

        // 2) 对方已读时才打"已编辑"角标；未读则静默替换
        boolean alreadyRead = Boolean.TRUE.equals(m.getRead());
        m.setContent(trimmed);
        if (alreadyRead) {
            m.setEdited(true);
            m.setEditedTime(LocalDateTime.now());
            m.setEditHidden(false); // 再次编辑后角标重新出现，如需隐藏要重新消耗积分
        }
        messageMapper.updateById(m);

        // 3) 推送 MESSAGE_UPDATED，让对方（及自己的其他端）就地替换气泡
        pushUpdated(m);
        return m;
    }

    /** 我的编辑历史（仅发送者本人可看，含最初原文） */
    public List<MessageEditHistory> history(Long uid, Long messageId) {
        Message m = messageMapper.selectById(messageId);
        if (m == null) throw new IllegalArgumentException("消息不存在");
        if (!uid.equals(m.getSenderId())) throw new IllegalArgumentException("只能查看自己发送的消息的编辑历史");
        return editHistoryMapper.findByMessageId(messageId);
    }

    /** 消耗积分隐藏"已编辑"角标 */
    public void hideEditMark(Long uid, Long messageId) {
        Message m = messageMapper.selectById(messageId);
        if (m == null) throw new IllegalArgumentException("消息不存在");
        if (!uid.equals(m.getSenderId())) throw new IllegalArgumentException("只能隐藏自己发送的消息的标记");
        if (!Boolean.TRUE.equals(m.getEdited())) throw new IllegalArgumentException("该消息没有「已编辑」标记");
        if (Boolean.TRUE.equals(m.getEditHidden())) return; // 已隐藏，幂等
        if (!pointsService.spend(uid, HIDE_MARK_COST, "HIDE_EDIT_MARK", messageId)) {
            throw new IllegalArgumentException("积分不足，隐藏标记需要 " + HIDE_MARK_COST + " 积分");
        }
        m.setEditHidden(true);
        messageMapper.updateById(m);
        pushUpdated(m);
    }

    /** 向接收方推送消息内容更新事件（单聊推个人通道，群聊推群通道，同时回推发送方以同步多端） */
    private void pushUpdated(Message m) {
        Map<String, Object> evt = new HashMap<>();
        evt.put("type", "MESSAGE_UPDATED");
        evt.put("id", m.getId());
        evt.put("senderId", m.getSenderId());
        evt.put("targetType", m.getTargetType());
        evt.put("targetId", m.getTargetId());
        evt.put("content", m.getContent());
        evt.put("edited", Boolean.TRUE.equals(m.getEdited()) && !Boolean.TRUE.equals(m.getEditHidden()));
        evt.put("editedTime", m.getEditedTime() == null ? null : m.getEditedTime().toString());
        if ("USER".equals(m.getTargetType())) {
            messagingTemplate.convertAndSend("/topic/user/" + m.getTargetId(), evt);
        } else if ("GROUP".equals(m.getTargetType())) {
            messagingTemplate.convertAndSend("/topic/group/" + m.getTargetId(), evt);
        }
        // 回推发送方本人，保证多端（手机+电脑）看到一致结果
        messagingTemplate.convertAndSend("/topic/user/" + m.getSenderId(), evt);
    }
}
