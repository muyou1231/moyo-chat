package com.moyo.springchat.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;

/** 消息改写历史：保留每次编辑前的内容（含最初原文 version=0），仅发送者本人可查看 */
@TableName("message_edit_history")
public class MessageEditHistory {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long messageId;

    private String content;

    private Integer version = 0;

    private LocalDateTime editedTime = LocalDateTime.now();

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

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

    public Integer getVersion() {
        return version;
    }

    public void setVersion(Integer version) {
        this.version = version;
    }

    public LocalDateTime getEditedTime() {
        return editedTime;
    }

    public void setEditedTime(LocalDateTime editedTime) {
        this.editedTime = editedTime;
    }
}
