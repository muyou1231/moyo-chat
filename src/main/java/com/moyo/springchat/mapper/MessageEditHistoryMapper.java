package com.moyo.springchat.mapper;

import com.moyo.springchat.entity.MessageEditHistory;
import org.apache.ibatis.annotations.*;

import java.util.List;

@Mapper
public interface MessageEditHistoryMapper {

    @Insert("INSERT INTO message_edit_history(message_id, content, version) " +
            "VALUES(#{messageId}, #{content}, #{version})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(MessageEditHistory history);

    /** 某条消息的全部历史版本，按 version 升序（version=0 为最初原文） */
    @Select("SELECT * FROM message_edit_history WHERE message_id = #{messageId} ORDER BY version ASC")
    List<MessageEditHistory> findByMessageId(@Param("messageId") Long messageId);

    @Select("SELECT COUNT(*) FROM message_edit_history WHERE message_id = #{messageId}")
    int countByMessageId(@Param("messageId") Long messageId);
}
