# 类微信聊天工具 — 功能设计提示词（规格说明）

> 用途：本文档既是给 AI 的实现「提示词」，也是给你确认的功能清单。
> 确认后我将基于当前 Spring Boot 项目（`com.moyo.springchat`）逐步实现。

---

## 一、目标

做一个**类似微信的网页聊天工具**，包含用户体系、好友体系、单聊、群聊，支持**文本消息**和**图片消息**，实时收发。后端用 Spring Boot，前端用原生 HTML/CSS/JS 放在 `src/main/resources/static` 下，开箱即跑（默认 H2 内存库，无需额外装数据库）。

---

## 二、技术选型（建议，可调整）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端框架 | Spring Boot 3.0.2 / Java 17 | 沿用现有项目 |
| 实时通信 | Spring WebSocket + STOMP | 单聊/群聊消息实时推送 |
| 持久化 | Spring Data JPA + **H2**（内存） | 零配置即可跑；如需 MySQL 可切换 |
| 安全 | 轻量 Token（登录后返回 token，请求头携带） | 不引入 Spring Security 以降低复杂度 |
| 图片消息 | Base64 / 或存服务器 `uploads/` 目录 + URL | 默认 Base64 内嵌，简单直观 |
| 前端 | 原生 HTML + CSS + JS（SockJS + STOMP.js via CDN） | 无构建步骤，放 `resources/static` |
| 前端 UI | 微信风格双栏布局（左侧会话/好友列表，右侧聊天窗） | 纯 CSS |

---

## 三、功能清单（核心）

### 1. 用户
- **创建用户 / 注册**：用户名、密码、昵称、头像（可选）
- **登录**：用户名 + 密码，返回 token；前端保存
- **当前用户信息**：昵称、头像展示

### 2. 好友
- **搜索用户**：按用户名/昵称模糊搜索
- **发送好友申请**：向目标用户发起申请
- **同意 / 拒绝申请**：被申请方处理
- **好友列表**：展示我的好友
- **删除好友**：双向解除关系，聊天记录保留

### 3. 单聊（好友聊天）
- 进入与某好友的会话窗口
- 发送**文本消息**
- 发送**图片消息**（选图 → 上传/内嵌 → 展示缩略图，点击放大）
- 实时接收对方消息（WebSocket 推送）
- 历史消息加载（进入会话拉取历史）

### 4. 群聊
- **创建群**：填写群名、选好友成员
- **群成员管理**：邀请成员、移除成员、退群
- **群消息**：文本 + 图片，群内所有人实时接收
- **群列表 / 群会话窗口**

### 5. 消息
- 类型：`TEXT`（文本）、`IMAGE`（图片）
- 字段：发送者、接收方（用户或群）、内容、时间戳、已读（可选）
- 会话列表展示**最后一条消息 + 未读数**（增强体验，可选）

---

## 四、数据模型（实体）

```text
User        用户: id, username, password, nickname, avatar
Friendship  好友关系: id, userId, friendId, status(PENDING/ACCEPTED)
FriendRequest 好友申请: 复用 Friendship(PENDING) 或单独表
Group       群: id, name, ownerId, avatar
GroupMember 群成员: id, groupId, userId, role
Message     消息: id, senderId, type(TEXT/IMAGE), content,
                 targetType(USER/GROUP), targetId, createTime, read
```

---

## 五、REST API（草案）

```text
POST /api/user/register          注册
POST /api/user/login             登录 -> token
GET  /api/user/me               当前用户
GET  /api/user/search?kw=       搜索用户

POST /api/friend/apply?to=       发起好友申请
POST /api/friend/accept?id=      同意
POST /api/friend/reject?id=      拒绝
GET  /api/friend/list            好友列表
GET  /api/friend/requests        我的待处理申请
DELETE /api/friend?id=           删除好友

POST /api/group/create           建群(name, memberIds)
POST /api/group/invite           邀请成员
POST /api/group/remove           移除成员
POST /api/group/quit             退群
GET  /api/group/list             我的群列表
GET  /api/group/members?id=      群成员

GET  /api/message/history?targetType=&targetId=&page=  历史消息
POST /api/message/image/upload   图片上传(返回URL/Base64)  [可选]
```

### WebSocket（STOMP）
```text
连接: /ws              (SockJS)
发送: /app/chat.send   发送消息
订阅: /topic/user/{userId}        私聊推送
订阅: /topic/group/{groupId}      群聊推送
```

---

## 六、前端结构（`src/main/resources/static`）

```text
static/
  index.html          登录/注册页 + 主聊天页（SPA 单页切换）
  css/style.css       微信风格样式
  js/api.js           REST 请求封装 + token 管理
  js/ws.js            WebSocket/STOMP 连接与消息路由
  js/chat.js          聊天主逻辑（会话、渲染消息）
  js/friend.js        好友/申请/搜索逻辑
  js/group.js         群聊逻辑
  assets/             默认头像等
```

---

## 七、实现顺序（分阶段）

1. **骨架**：pom 增加 websocket / jpa / h2 依赖；实体 + Repository
2. **用户**：注册、登录、token 拦截器
3. **好友**：申请/同意/列表/删除
4. **消息 + WebSocket**：文本消息实时收发 + 历史
5. **图片消息**：上传/内嵌 + 渲染
6. **群聊**：建群、成员、群消息
7. **前端页面**：登录页 + 微信风格聊天 UI 完整串联
8. **联调**：启动跑通多用户聊天

---

## 八、需要你确认 / 可调整的点

- 数据库：默认 **H2 内存库**（免安装，重启清空）。要不要用 **MySQL**（已引入驱动）？
- 图片：默认 **Base64 内嵌**（简单）。要不要改成**文件上传到服务器目录**？
- 安全：默认**轻量 token**（无 Spring Security）。是否够用？
- 范围：先实现上表「核心功能」即可，未读/已读、消息撤回等**增强项**是否本次就要？

> 你回一句「按默认实现」或指出要改的点，我就开始写代码。
