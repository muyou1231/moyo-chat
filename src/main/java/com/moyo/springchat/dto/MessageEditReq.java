package com.moyo.springchat.dto;

/** ④ 消息改写请求体 */
public class MessageEditReq {

    private Long messageId;
    private String content;

    public Long getMessageId() {
        return messageId;
    }

    public void setMessageId(Long messageId) {
        this.messageId = messageId;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }
}
