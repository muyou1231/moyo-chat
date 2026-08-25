package com.moyo.springchat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class SpringChatApplicationTests {
    @Value("${spring.mail.password}")
    private String appName;

    @Test
    void contextLoads() {
        System.out.println(System.getenv("QQ_MAIL_PASSWORD"));    }

}
