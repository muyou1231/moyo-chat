/* 全局状态与通用工具 */
window.App = {
    token: null,
    user: null,
    conversations: [],   // {type, id, name, avatar, lastMessage, unread}
    current: null,       // {type, id, name}
    searchResults: [],
    activeTab: 'chat',
    typing: {},          // 对方 userId -> 是否正在输入（单聊）,
    urgentMode: false,   // 加急发送开关
    mutedUrgentPeers: [],// 已屏蔽加急弹窗的发送方 userId 列表
    peersViewingMe: {},  // peerId -> true：对方正在「查看」我的输入框（仅此后才推送内容）
    typingContent: {},   // partnerId -> string：对方实时输入框内容（用于窥探面板）
    liveViewId: null,    // 当前打开的窥探面板对应的对方 userId（同时只窥探一个）
    urgentCooldownUntil: 0, // 加急冷却到期时间戳(ms)，0 表示无冷却
    online: {},            // userId -> bool：好友实时在线状态（WS PRESENCE 更新）
    switchFromAccount: null, // 切换账号前记录的当前账号，用于「不能切换到当前账号」校验
    friendRemarkMap: {},    // friendId -> remark：好友备注（仅本人视角），用于"看到好友相关内容优先显示备注"
    friendsById: {}         // friendId -> 好友完整对象（含 remark/blocked），用于"查看好友详细信息"面板
};

/** 好友备注优先展示：若 userId 在好友备注表中，返回备注名；否则返回 fallback。
 *  好友相关内容（会话列表 / 聊天头部 / 朋友圈作者与评论者 / 群消息发送者等）统一走此助手。 */
App.friendName = function (userId, fallback) {
    if (userId != null && App.friendRemarkMap[userId]) return App.friendRemarkMap[userId];
    return fallback;
};

/** 从好友列表重建备注映射（好友列表含 remark 字段）。在登录与通讯录渲染时调用。
 *  同时维护 App.friendsById（好友完整对象），供"查看好友详细信息"面板直接读取 remark/blocked。 */
App.loadFriendRemarks = function (friends) {
    App.friendRemarkMap = {};
    App.friendsById = {};
    (friends || []).forEach(function (f) {
        if (f && f.id != null) {
            App.friendsById[f.id] = f;
            if (f.remark) App.friendRemarkMap[f.id] = f.remark;
        }
    });
};

/* ---------- 工具函数 ---------- */
/** AI 助手实时状态缓存：key=助手 userId，value=状态字符串(ONLINE/OFFLINE/MAINTENANCE/BUSY)。
 *  由 WS 的 ASSISTANT_STATUS 推送实时更新，使状态点即时刷新，无需重拉接口。 */
App.aiStatus = {};

App.escapeHtml = function (s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
};

App.shortTime = function (s) {
    if (!s) return '';
    return s.slice(11, 16); // HH:mm
};

App.msgTime = function (s) {
    if (!s) return '';
    return s.slice(5, 16); // MM-DD HH:mm
};

/** AI 助手头像加载失败时的兜底：替换为内置 AI 图标，避免裂图 */
App.avatarImgError = function (img) {
    const div = document.createElement('div');
    div.className = 'avatar ai-default-avatar';
    div.textContent = '🤖';
    if (img && img.parentNode) img.parentNode.replaceChild(div, img);
};

App.avatarHtml = function (obj) {
    const name = obj.nickname || obj.name || '?';
    const av = obj.avatar;
    // AI 助手：优先用自定义头像；为空或加载失败时回退到内置 AI 图标，避免裂图/色块
    if (obj.isAssistant) {
        if (av) {
            return '<img class="avatar" src="' + App.escapeHtml(av) + '" alt="" onerror="App.avatarImgError(this)">';
        }
        return '<div class="avatar ai-default-avatar">🤖</div>';
    }
    if (av) return '<img class="avatar" src="' + App.escapeHtml(av) + '" alt="">';
    const colors = ['#07c160', '#10aeff', '#f76260', '#ffc300', '#6467f0', '#ff9c00'];
    const color = colors[((obj.id || 0) % colors.length + colors.length) % colors.length];
    const ch = App.escapeHtml(name.charAt(0) || '?');
    return '<div class="avatar" style="background:' + color + ';color:#fff;display:flex;' +
        'align-items:center;justify-content:center;font-size:16px;">' + ch + '</div>';
};

/** 头像 + 在线状态点：普通用户取实时/字段 online；AI 助手按自身 aiStatus 着色 */
App.avatarWithStatus = function (obj) {
    let cls = 'online-dot', title = '离线';
    if (obj.isAssistant) {
        // AI 助手：优先用实时缓存的 aiStatus（WS 推送即时更新），回退对象自带 aiStatus，再回退默认 ONLINE
        const st = (App.aiStatus[obj.id] || obj.aiStatus || 'ONLINE').toUpperCase();
        if (st === 'ONLINE') { title = '在线'; }
        else if (st === 'OFFLINE') { cls = 'online-dot offline'; title = '离线'; }
        else if (st === 'MAINTENANCE') { cls = 'online-dot maintenance'; title = '维修中'; }
        else if (st === 'BUSY') { cls = 'online-dot busy'; title = '忙碌'; }
        else { title = st; }
    } else {
        const live = App.online[obj.id];
        const on = (live !== undefined) ? live : (!!obj.online);
        if (obj.id && on) { title = '在线'; }
        else { cls = 'online-dot offline'; title = '离线'; }
    }
    const dot = '<span class="' + cls + '" title="' + title + '"></span>';
    return '<span class="avatar-wrap">' + App.avatarHtml(obj) + dot + '</span>';
};

/** 头像包裹成可点击元素：USER 打开资料，GROUP 打开群成员；在线状态用绿点标识 */
App.entityClickable = function (obj, type, id) {
    const fn = (type === 'GROUP')
        ? 'Group.openMemberModal(' + id + ')'
        : 'App.showFriendDetail(' + id + ')';
    const avatar = (type === 'GROUP') ? App.avatarHtml(obj) : App.avatarWithStatus(obj);
    return '<div class="avatar-clickable" onclick="' + fn + ';event.stopPropagation()">' + avatar + '</div>';
};

/* ===== 资料相关：显示资料 / 编辑资料 / 隐私设置 三者相互独立 ===== */

// 可见范围常量（与后端 UserService.PRIVACY_FIELDS / DEFAULT_PRIVACY 保持一致）
App.PRIVACY_FIELDS = ['signature', 'location', 'hobbies', 'gender', 'age', 'birthday', 'religion', 'education', 'createDays'];
App.DEFAULT_PRIVACY = { signature: 'PUBLIC', location: 'PUBLIC', hobbies: 'PUBLIC', gender: 'PUBLIC', age: 'PUBLIC', birthday: 'FRIENDS', religion: 'PRIVATE', education: 'FRIENDS', createDays: 'PUBLIC' };
App.VIS_OPTS = [['PUBLIC', '公开'], ['FRIENDS', '好友'], ['PRIVATE', '仅自己']];

App._sel = function (opts, val) {
    return opts.map(function (o) {
        return '<option value="' + App.escapeHtml(o[0]) + '"' + (o[0] === (val || '') ? ' selected' : '') + '>' +
            App.escapeHtml(o[1]) + '</option>';
    }).join('');
};
App._genderOpts = [['', '（不填）'], ['保密', '保密'], ['男', '男'], ['女', '女']];
App._religionOpts = [['', '（不填）'], ['无', '无'], ['佛教', '佛教'], ['基督教', '基督教'],
    ['伊斯兰教', '伊斯兰教'], ['道教', '道教'], ['其他', '其他']];
App._eduOpts = [['', '（不填）'], ['初中', '初中'], ['高中', '高中'], ['大专', '大专'],
    ['本科', '本科'], ['硕士', '硕士'], ['博士', '博士'], ['其他', '其他']];

/** 只读资料卡片的「详细资料」行（所在地/爱好/性别/年龄/生日/宗教/学历/注册天数 + 私密提示）。
 *  好友详情面板与本人/他人资料卡共用，避免重复渲染。不含头像/昵称/账号/签名（由调用方单独渲染）。 */
App.profileRowsHtml = function (u) {
    const f = u.fields || {};
    const rows = [];
    function addRow(label, val) {
        if (val !== undefined && val !== null && val !== '') {
            rows.push('<div class="pf-row view"><span class="pf-label">' + label + '</span><span class="pf-val">' + App.escapeHtml(String(val)) + '</span></div>');
        }
    }
    addRow('所在地', f.location);
    addRow('爱好', f.hobbies);
    addRow('性别', f.gender);
    addRow('年龄', f.age == null ? '' : f.age);
    addRow('生日', f.birthday);
    addRow('宗教信仰', f.religion);
    addRow('学历', f.education);
    addRow('注册天数', f.createDays == null ? '' : (f.createDays + ' 天'));
    const hiddenHint = (u.hidden && u.hidden.length)
        ? '<div class="pf-hidden">对方将 ' + u.hidden.length + ' 项资料设为私密</div>'
        : '';
    return (rows.length ? rows.join('') : '<div class="pf-empty">还没有填写更多资料</div>') + hiddenHint;
};

/** 只读资料卡片（显示资料用，本人/他人共用） */
App.profileViewCard = function (u) {
    const statusHtml = (u.online !== undefined)
        ? '<div class="pf-status ' + (u.online ? 'on' : 'off') + '">' + (u.online ? '● 在线' : '○ 离线') + '</div>'
        : '';
    const sigHtml = (u.fields && u.fields.signature)
        ? '<div class="pf-signature">“' + App.escapeHtml(String(u.fields.signature)) + '”</div>'
        : '';
    return '<div class="pf-avatar-big">' + App.avatarWithStatus(u) + '</div>' +
        '<div class="pf-name">' + App.escapeHtml(u.nickname || u.username) + '</div>' +
        '<div class="pf-account">账号 ' + App.escapeHtml(u.account || '') + '</div>' +
        statusHtml +
        sigHtml +
        App.profileRowsHtml(u);
};

/** 显示资料（只读卡片）：本人含 [编辑资料][隐私设置]，他人含 [发消息] */
App.showProfile = function (userId) {
    Api.profile(userId).then(function (data) {
        if (!data || data.code !== 0 || !data.data) {
            App.notify((data && data.message) || '获取资料失败');
            return;
        }
        const u = data.data;
        const isSelf = (userId === App.user.id);
        let body, title;
        if (isSelf) {
            title = '我的资料';
            body = App.profileViewCard(u) +
                '<div class="modal-actions">' +
                '<button class="ghost" data-act="edit">编辑资料</button>' +
                '<button class="primary" data-act="privacy">隐私设置</button>' +
                '</div>';
        } else {
            title = '用户资料';
            body = App.profileViewCard(u) +
                '<div class="modal-actions">' +
                '<button class="ghost" id="pf-home">查看好友家园</button>' +
                '<button class="primary" id="pf-chat">发消息</button></div>';
        }
        const overlay = App.modal('<h3>' + title + '</h3>' + body);
        if (isSelf) {
            overlay.querySelector('[data-act="edit"]').onclick = function () {
                overlay.remove();
                App.editProfile();
            };
            overlay.querySelector('[data-act="privacy"]').onclick = function () {
                overlay.remove();
                App.openPrivacy();
            };
        } else {
            const homeBtn = overlay.querySelector('#pf-home');
            if (homeBtn) homeBtn.onclick = function () {
                overlay.remove();
                if (window.Moment) Moment.viewUserMoments(u.id, u.nickname || u.username);
            };
            const chatBtn = overlay.querySelector('#pf-chat');
            if (chatBtn) chatBtn.onclick = function () {
                overlay.remove();
                if (window.Chat) Chat.openConversation('USER', u.id, u.nickname || u.username);
            };
        }
    });
};

/**
 * 查看好友详细信息（微信式）：把"备注 / 拉黑 / 删除 / 查看好友家园"等好友操作
 * 统一收进这个详情面板。点好友头像、通讯录好友、聊天头部「资料」都会进入这里。
 * 非好友（如群成员、全局搜索结果、已删除好友的会话）回退到只读资料卡 App.showProfile。
 * @param friendId   目标用户 id
 * @param fallbackObj 可选：直接传入的好友对象（含 remark/blocked），避免回退到 showProfile
 */
App.showFriendDetail = function (friendId, fallbackObj) {
    const friendObj = fallbackObj || App.friendsById[friendId];
    // AI 助手账户：不进入好友详情（无拉黑/删除/改资料），直接打开对话
    if (friendObj && friendObj.isAssistant) {
        if (window.Chat) Chat.openConversation('USER', friendId, friendObj.nickname || friendObj.username);
        return;
    }
    if (!friendObj) { App.showProfile(friendId); return; }
    Api.profile(friendId).then(function (data) {
        const u = (data && data.code === 0 && data.data) ? data.data : friendObj;
        let overlay = null;
        // 原地重绘：好友操作后（拉黑/取消拉黑/备注）即时反映最新 remark/blocked
        function paint() {
            const f = App.friendsById[friendId] || friendObj;
            const remark = f.remark;
            const blocked = !!f.blocked;
            const displayName = u.nickname || u.username || '';
            const fields = u.fields || {};
            let html = '<h3>好友资料</h3>';
            html += '<div class="friend-detail">';
            html += '<div class="fd-avatar">' + App.avatarWithStatus(u) + '</div>';
            html += '<div class="fd-name">' + App.escapeHtml(displayName) + '</div>';
            if (remark) html += '<div class="fd-remark-tag">备注：' + App.escapeHtml(remark) + '</div>';
            html += '<div class="fd-account">账号 ' + App.escapeHtml(u.account || '') +
                ' · @' + App.escapeHtml(u.username || '') + '</div>';
            if (fields.signature) html += '<div class="fd-sign">“' + App.escapeHtml(String(fields.signature)) + '”</div>';
            if (blocked) html += '<div class="fd-blocked-hint">已拉黑 · 消息无法送达</div>';
            html += '</div>';
            // 详细资料（所在地/性别/年龄/生日/爱好/学历…，与资料卡一致，修复「详细信息丢了」）
            html += '<div class="fd-rows">' + App.profileRowsHtml(u) + '</div>';
            // 主操作：发消息 + 查看好友家园
            html += '<div class="modal-actions fd-primary">' +
                '<button class="primary" id="fd-chat">发消息</button>' +
                '<button class="ghost" id="fd-home">查看好友家园</button></div>';
            // 好友操作区：设置备注 / 拉黑或取消 / 删除
            html += '<div class="fd-ops">';
            html += '<button class="fd-op" id="fd-remark">设置备注</button>';
            if (!blocked) {
                html += '<button class="fd-op warn" id="fd-block">加入黑名单</button>';
            } else {
                html += '<button class="fd-op ok" id="fd-unblock">移出黑名单</button>';
            }
            html += '<button class="fd-op del" id="fd-delete">删除好友</button>';
            html += '</div>';
            if (overlay) {
                overlay.querySelector('.modal').innerHTML = html;
            } else {
                overlay = App.modal(html);
            }
            wire();
        }
        function wire() {
            const chatBtn = overlay.querySelector('#fd-chat');
            if (chatBtn) chatBtn.onclick = function () {
                overlay.remove();
                if (window.Chat) Chat.openConversation('USER', friendId, u.nickname || u.username);
            };
            const homeBtn = overlay.querySelector('#fd-home');
            if (homeBtn) homeBtn.onclick = function () {
                overlay.remove();
                if (window.Moment) Moment.viewUserMoments(friendId, u.nickname || u.username);
            };
            const remarkBtn = overlay.querySelector('#fd-remark');
            if (remarkBtn) remarkBtn.onclick = function () {
                const cur = App.friendsById[friendId] ? App.friendsById[friendId].remark : null;
                if (window.Friend) Friend.editRemark(friendId, cur, function (newRemark) {
                    // renderContacts 异步重建 friendsById 前先乐观更新，确保详情立即反映新备注
                    const f = App.friendsById[friendId] || friendObj;
                    f.remark = newRemark || null; App.friendsById[friendId] = f;
                    if (newRemark) App.friendRemarkMap[friendId] = newRemark; else delete App.friendRemarkMap[friendId];
                    paint();
                });
            };
            const blockBtn = overlay.querySelector('#fd-block');
            if (blockBtn) blockBtn.onclick = async function () {
                const nm = App.friendName(friendId, u.nickname || u.username);
                if (await App.confirm('确定拉黑「' + nm + '」？拉黑后双方将无法互发消息', { danger: true, okText: '拉黑' })) {
                    if (window.Friend) Friend.blockUser(friendId, function () {
                        // 乐观更新：renderContacts 异步刷新 friendsById 前，详情先显示「已拉黑」
                        const f = App.friendsById[friendId] || friendObj;
                        f.blocked = true; App.friendsById[friendId] = f;
                        paint();
                    });
                }
            };
            const unblockBtn = overlay.querySelector('#fd-unblock');
            if (unblockBtn) unblockBtn.onclick = function () {
                if (window.Friend) Friend.unblockUser(friendId, function () {
                    const f = App.friendsById[friendId] || friendObj;
                    f.blocked = false; App.friendsById[friendId] = f;
                    paint();
                });
            };
            const delBtn = overlay.querySelector('#fd-delete');
            if (delBtn) delBtn.onclick = async function () {
                const nm = App.friendName(friendId, u.nickname || u.username);
                if (await App.confirm('确定删除该好友？删除后将从彼此通讯录移除', { danger: true, okText: '删除' })) {
                    if (window.Friend) Friend.remove(friendId, function () { overlay.remove(); });
                }
            };
        }
        paint();
    });
};

/** 编辑资料（仅编辑字段，不含可见范围设置） */
App.editProfile = function () {
    Api.profile(App.user.id).then(function (data) {
        if (!data || data.code !== 0 || !data.data) {
            App.notify((data && data.message) || '获取资料失败');
            return;
        }
        const u = data.data;
        const f = u.fields || {};
        App._avatarUrl = null; // 本次编辑新上传的头像代理 URL（未上传则保留原头像）
        const g = function (opts, cur) {
            return opts.map(function (o) {
                return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>';
            }).join('');
        };
        const ph = u.avatar ? '' : '<div class="pf-avatar-ph">' + App.escapeHtml((u.nickname || '我').charAt(0)) + '</div>';
        const avImg = u.avatar
            ? '<img id="pf-avatar-img" src="' + App.escapeHtml(u.avatar) + '">'
            : '<img id="pf-avatar-img" style="display:none">';
        const body =
            '<div class="pf-edit">' +
            '<div class="pf-avatar-uploader" title="点击更换头像" onclick="document.getElementById(\'pf-avatar-file\').click()">' +
                avImg + ph +
                '<div class="pf-avatar-cam">📷</div>' +
                '<input type="file" id="pf-avatar-file" class="hidden" accept="image/*" onchange="App.onAvatarPick(this)">' +
            '</div>' +
            '<div class="pf-avatar-tip">点击头像即可上传新头像</div>' +
            '<div class="pf-grid">' +
                '<div class="pf-field"><label>昵称</label><input id="pf-nickname" class="modal-input" value="' + App.escapeHtml(u.nickname || '') + '"></div>' +
                '<div class="pf-field"><label>所在地</label><input id="pf-location" class="modal-input" placeholder="如：北京" value="' + App.escapeHtml(f.location || '') + '"></div>' +
                '<div class="pf-field"><label>爱好</label><input id="pf-hobbies" class="modal-input" placeholder="音乐、运动" value="' + App.escapeHtml(f.hobbies || '') + '"></div>' +
                '<div class="pf-field"><label>年龄</label><input id="pf-age" class="modal-input" type="number" min="0" max="150" value="' + App.escapeHtml(f.age == null ? '' : String(f.age)) + '"></div>' +
                '<div class="pf-field"><label>性别</label><select id="pf-gender" class="modal-input">' + g(App._genderOpts, f.gender) + '</select></div>' +
                '<div class="pf-field"><label>生日</label><input id="pf-birthday" class="modal-input" type="date" value="' + App.escapeHtml(f.birthday || '') + '"></div>' +
                '<div class="pf-field"><label>宗教</label><select id="pf-religion" class="modal-input">' + g(App._religionOpts, f.religion) + '</select></div>' +
                '<div class="pf-field"><label>学历</label><select id="pf-education" class="modal-input">' + g(App._eduOpts, f.education) + '</select></div>' +
            '</div>' +
            '<div class="pf-field full"><label>签名</label><textarea id="pf-signature" class="modal-input" placeholder="一句话介绍自己">' + App.escapeHtml(f.signature || '') + '</textarea></div>' +
            '<div class="pf-hint">提示：每个字段的「谁可以看」请在「隐私设置」中配置</div>' +
            '<div class="modal-actions">' +
            '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
            '<button class="primary" id="pf-save">保存</button>' +
            '</div>' +
            '</div>';
        const overlay = App.modal('<h3>编辑个人资料</h3>' + body, null, 'wide');
        overlay.querySelector('#pf-save').onclick = function () {
            const nv = {};
            nv.nickname = (document.getElementById('pf-nickname').value || '').trim() || null;
            nv.avatar = (App._avatarUrl != null) ? App._avatarUrl : (u.avatar || null);
            nv.signature = (document.getElementById('pf-signature').value || '').trim();
            nv.location = (document.getElementById('pf-location').value || '').trim();
            nv.hobbies = (document.getElementById('pf-hobbies').value || '').trim();
            nv.gender = document.getElementById('pf-gender').value;
            const ageRaw = (document.getElementById('pf-age').value || '').trim();
            nv.age = ageRaw ? Number(ageRaw) : null;
            nv.birthday = document.getElementById('pf-birthday').value || null;
            nv.religion = document.getElementById('pf-religion').value;
            nv.education = document.getElementById('pf-education').value;
            Api.updateProfile(nv).then(function (d) {
                if (d && d.code === 0) {
                    App.user = d.data;
                    App.saveSession();
                    overlay.remove();
                    App.notify('资料已更新');
                    const meAv = document.getElementById('me-avatar');
                    if (meAv) meAv.outerHTML = App.avatarWithStatus(App.user).replace('class="avatar"', 'class="avatar" id="me-avatar"');
                    const nk = document.getElementById('me-nickname');
                    if (nk) nk.textContent = App.user.nickname || App.user.username;
                    if (window.Chat) Chat.refreshConversations();
                } else {
                    App.notify((d && d.message) || '保存失败');
                }
            });
        };
    });
};

/** 编辑资料时选择头像文件：立即上传到 MinIO，拿到 8080 代理 URL 并刷新头像上传器预览 */
App.onAvatarPick = function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    Api.upload(file, 'photo/avatar').then(function (data) {
        if (data && data.code === 0 && data.data && data.data.url) {
            App._avatarUrl = data.data.url;
            const wrap = document.querySelector('.pf-avatar-uploader');
            if (wrap) {
                let img = wrap.querySelector('#pf-avatar-img');
                if (!img) {
                    img = document.createElement('img');
                    img.id = 'pf-avatar-img';
                    wrap.insertBefore(img, wrap.querySelector('.pf-avatar-cam'));
                }
                const ph = wrap.querySelector('.pf-avatar-ph');
                if (ph) ph.style.display = 'none';
                img.src = data.data.url;
                img.style.display = 'block';
                App.notify('头像已更新，记得点保存');
            }
        } else {
            App.notify((data && data.message) || '头像上传失败');
        }
    }).catch(function () { App.notify('头像上传失败'); });
};

/** 隐私设置（仅配置每个字段的可见范围：公开 / 好友 / 仅自己） */
App.openPrivacy = function () {
    Api.profile(App.user.id).then(function (data) {
        if (!data || data.code !== 0 || !data.data) {
            App.notify((data && data.message) || '获取资料失败');
            return;
        }
        const u = data.data;
        const labels = { signature: '签名', location: '所在地', hobbies: '爱好', gender: '性别', age: '年龄', birthday: '生日', religion: '宗教信仰', education: '学历', createDays: '注册天数' };
        const rows = App.PRIVACY_FIELDS.map(function (field) {
            const cur = (u.privacy && u.privacy[field]) || App.DEFAULT_PRIVACY[field] || 'PUBLIC';
            const opts = App.VIS_OPTS.map(function (v) {
                return '<option value="' + v[0] + '"' + (v[0] === cur ? ' selected' : '') + '>' + v[1] + '</option>';
            }).join('');
            return '<div class="pf-row"><label>' + (labels[field] || field) + '</label>' +
                '<select id="pf-vis-' + field + '" class="pf-vis" title="谁可以看这个字段">' + opts + '</select></div>';
        }).join('');
        const body =
            '<div class="pf-hint">设置每项资料谁可以看：公开 / 仅好友 / 仅自己</div>' +
            rows +
            '<div class="modal-actions">' +
            '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
            '<button class="primary" id="pf-save-privacy">保存</button>' +
            '</div>';
        const overlay = App.modal('<h3>隐私设置</h3>' + body);
        overlay.querySelector('#pf-save-privacy').onclick = function () {
            const privacy = {};
            App.PRIVACY_FIELDS.forEach(function (field) {
                const el = document.getElementById('pf-vis-' + field);
                if (el) privacy[field] = el.value;
            });
            Api.updateProfile({ privacy: privacy }).then(function (d) {
                if (d && d.code === 0) {
                    App.user = d.data;
                    App.saveSession();
                    overlay.remove();
                    App.notify('隐私设置已保存');
                } else {
                    App.notify((d && d.message) || '保存失败');
                }
            });
        };
    });
};

App.toast = function (msg, ok) {
    const box = document.getElementById('auth-msg');
    if (!box) return;
    box.textContent = msg;
    box.className = 'auth-msg ' + (ok ? 'ok' : 'err');
    if (ok) setTimeout(() => { if (box.textContent === msg) box.textContent = ''; }, 2000);
};

App.previewImage = function (src) {
    document.getElementById('img-modal-src').src = src;
    document.getElementById('img-modal').classList.remove('hidden');
};

App.notify = function (msg, type) {
    if (!type) {
        // 自动语义识别：无需逐一改造调用方，就能让失败提示自动变成“高警色”
        type = /失败|错误|无法|不能|异常/.test(msg || '') ? 'error' : 'info';
    }
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toast-stack';
        document.body.appendChild(stack);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(function () {
        t.classList.add('closing');
        setTimeout(function () { t.remove(); }, 200);
    }, 2200);
};

/* 主题切换（浅色 / 深色），持久化到 localStorage */
App.applyTheme = function (theme) {
    document.body.setAttribute('data-theme', theme);
    const btn = document.querySelector('.theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '🌙';
    localStorage.setItem('chat_theme', theme);
};

App.toggleTheme = function () {
    const cur = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    App.applyTheme(cur === 'dark' ? 'light' : 'dark');
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
        btn.classList.remove('spin-once');
        void btn.offsetWidth; // 强制重排以重启动画
        btn.classList.add('spin-once');
    }
};

/* 通用弹窗（cls 可附加额外样式类，如 'wide' 加宽） */
App.modal = function (innerHtml, onMount, cls) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<div class="modal' + (cls ? ' ' + cls : '') + '">' + innerHtml + '</div>';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
    if (onMount) onMount(overlay);
    return overlay;
};

/* 自定义确认弹窗（替代浏览器原生 confirm）：返回 Promise<boolean>。
 *  opts: { title, okText, cancelText, danger }；点遮罩 / 按 Esc = 取消，回车 = 确定 */
App.confirm = function (message, opts) {
    opts = opts || {};
    const title = opts.title || '请确认';
    const okText = opts.okText || '确定';
    const cancelText = opts.cancelText || '取消';
    const danger = !!opts.danger;
    return new Promise(function (resolve) {
        const body =
            '<p class="confirm-text">' + App.escapeHtml(message) + '</p>' +
            '<div class="modal-actions">' +
            '<button type="button" class="ghost" id="cf-cancel">' + App.escapeHtml(cancelText) + '</button>' +
            '<button type="button" class="primary' + (danger ? ' danger' : '') + '" id="cf-ok">' + App.escapeHtml(okText) + '</button>' +
            '</div>';
        let closed = false;
        function close(v) {
            if (closed) return;
            closed = true;
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(v);
        }
        const overlay = App.modal('<h3>' + App.escapeHtml(title) + '</h3>' + body, function (ov) {
            ov.querySelector('#cf-cancel').onclick = function () { close(false); };
            ov.querySelector('#cf-ok').onclick = function () { close(true); };
            ov.onclick = function (e) { if (e.target === ov) close(false); };
        }, 'narrow');
        function onKey(e) {
            if (e.key === 'Escape') close(false);
            else if (e.key === 'Enter') close(true);
        }
        document.addEventListener('keydown', onKey);
    });
};

/* ---------- 会话存储 ---------- */
App.saveSession = function () {
    localStorage.setItem('chat_token', App.token);
    localStorage.setItem('chat_user', JSON.stringify(App.user));
};

App.loadSession = function () {
    App.token = localStorage.getItem('chat_token');
    const u = localStorage.getItem('chat_user');
    App.user = u ? JSON.parse(u) : null;
};

App.clearSession = function () {
    localStorage.removeItem('chat_token');
    localStorage.removeItem('chat_user');
    App.token = null;
    App.user = null;
};

/* ---------- 登录 / 注册 ---------- */
App.authMode = 'login';
/** 验证码重新发送冷却秒数（默认 60，启动后由后端 /api/auth/code-config 覆盖） */
App.codeCooldown = 60;

App.validEmail = function (e) {
    return /^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+$/.test(e || '');
};
App.validPassword = function (p) {
    return /^(?=.*[A-Za-z])(?=.*\d).{7,}$/.test(p || '');
};

/**
 * 统一的「获取验证码」倒计时：禁用按钮并显示 Ns，到点恢复。
 * 冷却秒数来自后端配置（App.codeCooldown），避免前端硬编码。
 */
App.startCodeCountdown = function (btnId, seconds) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (btn._timer) clearInterval(btn._timer);
    let left = seconds || App.codeCooldown;
    btn.disabled = true;
    btn.textContent = left + 's';
    btn._timer = setInterval(function () {
        left--;
        if (left <= 0) {
            clearInterval(btn._timer);
            btn._timer = null;
            btn.disabled = false;
            btn.textContent = '获取验证码';
        } else {
            btn.textContent = left + 's';
        }
    }, 1000);
};

/**
 * 统一发送验证码：点击后【立即】禁用按钮并显示「发送中...」，避免后端发信延迟期间被重复点击导致重复发送。
 * 返回成功 → 启动真实倒计时；返回失败 / 网络异常 → 恢复按钮可重试。
 */
App.requestSendCode = function (btnId, email, type, okText) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (!App.validEmail(email)) { App.toast('请输入正确的邮箱', false); return; }
    if (btn.disabled) return; // 仍在冷却 / 发送中，忽略重复点击
    btn.disabled = true;
    btn.textContent = '发送中...';
    Api.sendCode(email, type).then(function (d) {
        if (!d || d.code !== 0) {
            App.toast((d && d.data && d.data.message) || (d && d.message) || '发送失败', false);
            btn.disabled = false;        // 失败：恢复可重试
            btn.textContent = '获取验证码';
            return;
        }
        App.toast((d.data && d.data.message) || (okText || '验证码已发送'), true);
        const cd = (d.data && d.data.cooldown) || App.codeCooldown;
        App.startCodeCountdown(btnId, cd);
    }).catch(function () {
        btn.disabled = false;
        btn.textContent = '获取验证码';
        App.toast('网络异常，请重试', false);
    });
};

App.showAuth = function (mode) {
    App.authMode = mode;
    const isSwitch = (mode === 'switch');
    const isReg = (mode === 'register');
    // 切换账号时隐藏 登录/注册 标签页（连容器一并隐藏，避免胶囊背景条在无可见按钮时留下一条空白背景）
    const authTabs = document.querySelector('.auth-tabs');
    if (authTabs) authTabs.classList.toggle('hidden', isSwitch);
    document.querySelectorAll('.auth-tabs button').forEach(function (b) {
        b.classList.toggle('hidden', isSwitch);
    });
    document.getElementById('tab-login').classList.toggle('active', mode === 'login');
    document.getElementById('tab-register').classList.toggle('active', mode === 'register');
    // 注册模式才显示：邮箱、验证码行、确认密码（昵称不再单独填写，默认等于用户名）
    document.getElementById('auth-email').classList.toggle('hidden', !isReg);
    document.getElementById('auth-code-row').classList.toggle('hidden', !isReg);
    document.getElementById('auth-confirm').classList.toggle('hidden', !isReg);
    // 「忘记密码」仅在登录模式显示
    const forgot = document.getElementById('auth-forgot');
    if (forgot) forgot.classList.toggle('hidden', mode !== 'login');
    const submit = document.getElementById('auth-submit');
    submit.textContent = isSwitch ? '切换并登录' : (isReg ? '注册并登录' : '登录');
    // 重置提交按钮的 loading 态，避免上一次提交失败/切换后按钮卡在“提交中”样式
    submit.disabled = false;
    submit.classList.remove('btn-loading');
    const cancel = document.getElementById('auth-cancel');
    if (cancel) cancel.classList.toggle('hidden', !isSwitch);
    const acc = document.getElementById('auth-username');
    acc.placeholder = isReg ? '用户名（必填）' : '邮箱 / 用户名 / 账号';
    document.getElementById('auth-password').placeholder = isReg ? '密码（字母+数字，长度>6）' : '密码';
    if (isSwitch) {
        acc.value = '';
        document.getElementById('auth-password').value = '';
    }
    document.getElementById('auth-msg').textContent = isSwitch
        ? '请输入要切换登录的账号（不能与当前账号相同）' : '';
};

App.submitAuth = function () {
    const account = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    // 注册只填用户名；昵称默认等于用户名（后端兆底），此处不再单独读取昵称字段
    const nickname = '';
    if (!account || !password) { App.toast('请输入账号和密码', false); return; }

    const submitBtn = document.getElementById('auth-submit');
    const setBusy = function (busy) {
        if (!submitBtn) return;
        submitBtn.disabled = !!busy;
        submitBtn.classList.toggle('btn-loading', !!busy);
    };
    const failNetwork = function () { setBusy(false); App.toast('网络异常，请稍后重试', false); };

    // 切换账号：校验不能与当前账号相同，成功后旧账号下线、新账号上线
    if (App.authMode === 'switch') {
        if (App.switchFromAccount && account === App.switchFromAccount) {
            App.toast('不能切换到当前账号', false);
            return;
        }
        setBusy(true);
        Api.switchAccount(account, password).then(function (data) {
            if (!data || data.code !== 0) { setBusy(false); App.toast(data ? data.message : '切换失败', false); return; }
            Ws.disconnect();
            App.token = data.data.token;
            App.user = data.data.user;
            App.saveSession();
            App.enterApp();
            App.notify('已切换到账号 ' + (App.user.account || ''), 'success');
        }).catch(failNetwork);
        return;
    }

    const done = function (data) {
        if (!data || data.code !== 0) { setBusy(false); App.toast(data ? data.message : '请求失败', false); return; }
        const d = data.data;
        App.token = d.token;
        App.user = d.user;
        App.saveSession();
        App.enterApp();
    };

    if (App.authMode === 'login') {
        setBusy(true);
        Api.login(account, password).then(done).catch(failNetwork);   // 邮箱 / 用户名 / 账号 登录
    } else {
        // 注册：需用户名 + 邮箱验证 + 密码强度
        const email = document.getElementById('auth-email').value.trim();
        const code = document.getElementById('auth-code').value.trim();
        const confirm = document.getElementById('auth-confirm').value;
        if (!account) { App.toast('请输入用户名', false); return; }
        if (!App.validEmail(email)) { App.toast('请输入正确的邮箱', false); return; }
        if (!App.validPassword(password)) { App.toast('密码须包含字母和数字，且长度大于6', false); return; }
        if (password !== confirm) { App.toast('两次输入的密码不一致', false); return; }
        if (!code) { App.toast('请先获取并填写邮箱验证码', false); return; }
        setBusy(true);
        Api.register(account, email, password, code, nickname).then(function (d) {
            if (d && d.code === 0) App.toast('注册成功，已自动登录', true); // 注册成功自动登录
            done(d);
        }).catch(failNetwork);
    }
};

/** 注册页「获取验证码」：点击即禁用按钮防止重复发送，倒计时由后端 cooldown 驱动 */
App.sendRegCode = function () {
    const email = document.getElementById('auth-email').value.trim();
    App.requestSendCode('auth-getcode', email, 'register', '验证码已发送');
};

App.afterLogin = function () {
    // 用 token 校验当前用户（页面刷新后恢复会话）
    Api.me().then(function (data) {
        if (data && data.code === 0) {
            App.user = data.data;
            App.user.online = true;       // 正在使用即视为在线
            App.saveSession();
            Api.setOnline();              // 同步后端在线状态（让好友看到自己上线）
            App.enterApp();
        } else {
            App.showLoginView();
        }
    });
};

App.enterApp = function () {
    if (Ws.client) Ws.disconnect();      // 切换账号时先断开旧连接，再以新身份重连
    document.getElementById('auth').classList.add('hidden');
    const appRoot = document.getElementById('app');
    appRoot.classList.remove('hidden');
    // 登录/切换成功后主面板的轻盈入场动画，避免硬切出现
    appRoot.classList.remove('app-enter');
    void appRoot.offsetWidth;
    appRoot.classList.add('app-enter');
    setTimeout(function () { appRoot.classList.remove('app-enter'); }, 520);
    document.getElementById('me-avatar').outerHTML = App.avatarWithStatus(App.user).replace('class="avatar"', 'class="avatar" id="me-avatar"');
    document.getElementById('me-nickname').textContent = App.user.nickname || App.user.username;
    const accEl = document.getElementById('me-account');
    if (accEl) accEl.textContent = '账号 ' + (App.user.account || '');
    if (window.Chat) Chat.setInputEnabled(false); // 未选择会话前禁止输入
    Ws.connect(App.token);
    Chat.refreshConversations();
    App.switchTab('chat');
    // 加载已屏蔽加急弹窗的发送方列表
    Api.urgentMuteList().then(function (d) {
        if (d && d.code === 0 && Array.isArray(d.data)) {
            App.mutedUrgentPeers = d.data.map(function (x) { return x.peerId; });
            // 刷新当前聊天窗口头部（若正在查看某单聊，需同步「已屏蔽加急」状态）
            if (App.current && App.current.type === 'USER' && window.Chat) Chat.renderChatHeader(App.current.type, App.current.id, App.current.name);
        }
    });
    // 加载好友备注映射（用于"看到好友相关内容优先显示备注"）
    Api.friendList().then(function (d) {
        if (d && d.code === 0 && Array.isArray(d.data)) App.loadFriendRemarks(d.data);
    });
    // 检查管理员角色，显示/隐藏管理 Tab
    App.checkAdmin();
    // 冻结账号：显示横幅并禁用建群/发朋友圈等受限入口
    App.applyFrozenState();
    // 登录后检查待弹窗通知（未读且未过期 → 弹窗；已读则刷新铃铛角标）
    App.checkNotices();
};

/** 冻结态：显示顶部横幅（实际接口拦截由后端 FrozenGuardInterceptor 兜底） */
App.applyFrozenState = function () {
    var frozen = !!(App.user && App.user.frozen);
    var banner = document.getElementById('frozen-banner');
    if (banner) banner.classList.toggle('hidden', !frozen);
    // 编辑资料入口在冻结时禁用
    var editBtn = document.querySelector('.edit-profile');
    if (editBtn) editBtn.style.display = frozen ? 'none' : '';
    // 多多的家园（朋友圈）入口在冻结时隐藏：冻结用户不可查看朋友圈
    var momentsTab = document.querySelector('.side-tabs button[data-tab="moments"]');
    if (momentsTab) momentsTab.style.display = frozen ? 'none' : '';
    // 若当前停留在朋友圈，立即切回消息（兜底，避免冻结用户看到朋友圈内容）
    if (frozen && App.activeTab === 'moments') {
        App.switchTab('chat');
    }
};

/** 检查当前用户是否为管理员，据此显示/隐藏侧边栏与底部 tabbar 的管理 Tab */
App.checkAdmin = function () {
    var adminTab = document.getElementById('tab-admin');
    var mAdmin = document.getElementById('mtab-admin');
    function show(v) {
        if (adminTab) adminTab.classList.toggle('hidden', !v);
        if (mAdmin) mAdmin.classList.toggle('hidden', !v);
    }
    if (!adminTab) return;
    // 优先使用 user.role 字段判断（后端返回）
    if (App.user && App.user.role === 'ADMIN') {
        show(true);
        return;
    }
    // 回退：调 API 确认（role 字段可能未随 toSafe 返回，用 API 兜底）
    Api.adminCheck().then(function (d) {
        show(d && d.code === 0 && d.data === true);
    }).catch(function () {
        show(false);
    });
};

/** 仅显示登录视图（不清除会话，用于切换账号中途） */
App.showAuthView = function () {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('auth').classList.remove('hidden');
};

App.showLoginView = function () {
    App.clearSession();
    App.showAuthView();
};

App.logout = function () {
    // 先通知后端：当前账号置离线并广播给好友
    Api.logout().finally(function () {
        Ws.disconnect();
        App.clearSession();
        App.conversations = [];
        App.current = null;
        App.showLoginView();
    });
};

/** 切换账号：记录当前账号，显示「切换并登录」界面（保留当前会话，未真正登出） */
App.switchAccount = function () {
    App.switchFromAccount = App.user ? App.user.account : null;
    App.showAuth('switch');
    App.showAuthView();
};

/** 取消切换：放弃切换，返回当前用户界面（旧账号保持在线） */
App.cancelSwitch = function () {
    document.getElementById('auth').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
};

/* ---------- 修改密码（需邮箱验证码） ---------- */
App.openChangePassword = function () {
    if (!App.user || !App.user.email) {
        App.toast('请先在「编辑资料」中绑定邮箱', false);
        App.editProfile();
        return;
    }
    const email = App.user.email;
    const html =
        '<div class="cp-modal">' +
        '<div class="cp-title">修改密码</div>' +
        '<div class="cp-email">当前邮箱：' + App.escapeHtml(email) + '</div>' +
        '<div class="auth-code-row">' +
        '<input id="cp-code" class="auth-input auth-code-input" placeholder="邮箱验证码">' +
        '<button id="cp-getcode" class="auth-code-btn" type="button" onclick="App.sendChangeCode()">获取验证码</button>' +
        '</div>' +
        '<input id="cp-newpwd" class="auth-input" type="password" placeholder="新密码（字母+数字，长度>6）">' +
        '<input id="cp-confirm" class="auth-input" type="password" placeholder="确认新密码">' +
        '<div class="cp-actions">' +
        '<button class="ghost" onclick="App.closeChangePassword()">取消</button>' +
        '<button class="primary" onclick="App.submitChangePassword()">确定修改</button>' +
        '</div>' +
        '<div id="cp-msg" class="cp-msg"></div>' +
        '</div>';
    App._cpOverlay = App.modal(html, null, 'narrow');
};

App.sendChangeCode = function () {
    if (!App.user || !App.user.email) { App.toast('请先绑定邮箱', false); return; }
    App.requestSendCode('cp-getcode', App.user.email, 'changepwd', '验证码已发送');
};

App.submitChangePassword = function () {
    const email = App.user ? App.user.email : null;
    const code = document.getElementById('cp-code').value.trim();
    const np = document.getElementById('cp-newpwd').value;
    const cf = document.getElementById('cp-confirm').value;
    const msg = document.getElementById('cp-msg');
    if (!App.validPassword(np)) { msg.textContent = '新密码须包含字母和数字，且长度大于6'; return; }
    if (np !== cf) { msg.textContent = '两次输入的新密码不一致'; return; }
    if (!code) { msg.textContent = '请先获取并填写邮箱验证码'; return; }
    Api.changePassword(email, code, np).then(function (d) {
        if (!d || d.code !== 0) { msg.textContent = d ? d.message : '修改失败'; return; }
        App.toast('密码修改成功', true);
        App.closeChangePassword();
    });
};

App.closeChangePassword = function () {
    if (App._cpOverlay) { App._cpOverlay.remove(); App._cpOverlay = null; }
};

/* ---------- 忘记密码（公开，邮箱验证码重置） ---------- */
App.openForgotPassword = function () {
    const html =
        '<div class="cp-modal">' +
        '<div class="cp-title">忘记密码</div>' +
        '<div class="cp-tip">通过绑定邮箱验证身份，重置该邮箱下全部账号的密码</div>' +
        '<input id="fp-email" class="auth-input" placeholder="注册时使用的邮箱">' +
        '<div class="auth-code-row">' +
        '<input id="fp-code" class="auth-input auth-code-input" placeholder="邮箱验证码">' +
        '<button id="fp-getcode" class="auth-code-btn" type="button" onclick="App.sendForgotCode()">获取验证码</button>' +
        '</div>' +
        '<input id="fp-newpwd" class="auth-input" type="password" placeholder="新密码（字母+数字，长度>6）">' +
        '<input id="fp-confirm" class="auth-input" type="password" placeholder="确认新密码">' +
        '<div class="cp-actions">' +
        '<button class="ghost" onclick="App.closeForgotPassword()">取消</button>' +
        '<button class="primary" onclick="App.submitForgotPassword()">重置密码</button>' +
        '</div>' +
        '<div id="fp-msg" class="cp-msg"></div>' +
        '</div>';
    App._fpOverlay = App.modal(html, null, 'narrow');
};

App.sendForgotCode = function () {
    const email = document.getElementById('fp-email').value.trim();
    App.requestSendCode('fp-getcode', email, 'resetpwd', '验证码已发送');
};

App.submitForgotPassword = function () {
    const email = document.getElementById('fp-email').value.trim();
    const code = document.getElementById('fp-code').value.trim();
    const np = document.getElementById('fp-newpwd').value;
    const cf = document.getElementById('fp-confirm').value;
    const msg = document.getElementById('fp-msg');
    if (!App.validEmail(email)) { msg.textContent = '请输入正确的邮箱'; return; }
    if (!App.validPassword(np)) { msg.textContent = '新密码须包含字母和数字，且长度大于6'; return; }
    if (np !== cf) { msg.textContent = '两次输入的新密码不一致'; return; }
    if (!code) { msg.textContent = '请先获取并填写邮箱验证码'; return; }
    Api.resetPassword(email, code, np).then(function (d) {
        if (!d || d.code !== 0) { msg.textContent = d ? d.message : '重置失败'; return; }
        App.toast('密码重置成功，请使用新密码登录', true);
        App.closeForgotPassword();
    });
};

App.closeForgotPassword = function () {
    if (App._fpOverlay) { App._fpOverlay.remove(); App._fpOverlay = null; }
};

/* ---------- 绑定 / 换绑邮箱（需登录 + 新邮箱验证码） ---------- */
App.openBindEmail = function () {
    const firstBind = !App.user || !App.user.email;
    const cur = firstBind ? '' : ('当前邮箱：' + App.escapeHtml(App.user.email));
    const tip = firstBind
        ? '<div class="cp-tip">首次绑定邮箱需同时设置符合格式的新密码（字母+数字，长度大于 6）</div>'
        : '';
    const pwdBlock = firstBind
        ? '<input id="bind-newpwd" class="auth-input" type="password" placeholder="新密码（字母+数字，长度>6）">' +
          '<input id="bind-confirm" class="auth-input" type="password" placeholder="确认新密码">'
        : '';
    const html =
        '<div class="cp-modal">' +
        '<div class="cp-title">' + (firstBind ? '绑定邮箱' : '换绑邮箱') + '</div>' +
        (cur ? '<div class="cp-email">' + cur + '</div>' : '') +
        tip +
        '<input id="bind-email" class="auth-input" placeholder="新邮箱地址">' +
        '<div class="auth-code-row">' +
        '<input id="bind-code" class="auth-input auth-code-input" placeholder="邮箱验证码">' +
        '<button id="bind-getcode" class="auth-code-btn" type="button" onclick="App.sendBindCode()">获取验证码</button>' +
        '</div>' +
        pwdBlock +
        '<div class="cp-actions">' +
        '<button class="ghost" onclick="App.closeBindEmail()">取消</button>' +
        '<button class="primary" onclick="App.submitBindEmail()">确定</button>' +
        '</div>' +
        '<div id="bind-msg" class="cp-msg"></div>' +
        '</div>';
    App._bindOverlay = App.modal(html, null, 'narrow');
};

App.sendBindCode = function () {
    const email = document.getElementById('bind-email').value.trim();
    App.requestSendCode('bind-getcode', email, 'bind', '验证码已发送');
};

App.submitBindEmail = function () {
    const firstBind = !App.user || !App.user.email;
    const email = document.getElementById('bind-email').value.trim();
    const code = document.getElementById('bind-code').value.trim();
    const msg = document.getElementById('bind-msg');
    if (!App.validEmail(email)) { msg.textContent = '请输入正确的邮箱'; return; }
    let np = null;
    if (firstBind) {
        np = document.getElementById('bind-newpwd').value;
        const cf = document.getElementById('bind-confirm').value;
        if (!App.validPassword(np)) { msg.textContent = '新密码须包含字母和数字，且长度大于6'; return; }
        if (np !== cf) { msg.textContent = '两次输入的新密码不一致'; return; }
    }
    if (!code) { msg.textContent = '请先获取并填写邮箱验证码'; return; }
    Api.bindEmail(email, code, np).then(function (d) {
        if (!d || d.code !== 0) { msg.textContent = d ? d.message : '绑定失败'; return; }
        App.user.email = email;
        App.saveSession();
        App.toast(firstBind ? '邮箱已绑定，并设置新密码' : '邮箱已换绑', true);
        App.closeBindEmail();
    });
};

App.closeBindEmail = function () {
    if (App._bindOverlay) { App._bindOverlay.remove(); App._bindOverlay = null; }
};

/** 点击自己的头像弹出的「个人中心」菜单：显示资料 / 编辑资料 / 隐私设置 / 切换账号 / 退出登录 */
App.openMeMenu = function () {
    const old = document.getElementById('me-menu');
    if (old) { old.remove(); return; }
    const items = [
        { icon: '👤', label: '显示资料', act: function () { App.showProfile(App.user.id); } },
        { icon: '✏️', label: '编辑资料', act: function () { App.editProfile(); } },
        { icon: '🔑', label: '修改密码', act: function () { App.openChangePassword(); } },
        { icon: '📧', label: (App.user && App.user.email) ? '换绑邮箱' : '绑定邮箱', act: function () { App.openBindEmail(); } },
        { icon: '🔒', label: '隐私设置', act: function () { App.openPrivacy(); } },
        { icon: '🔄', label: '切换账号', act: function () { App.switchAccount(); } },
        { icon: '🚪', label: '退出登录', act: function () { App.logout(); } }
    ];
    const menu = document.createElement('div');
    menu.id = 'me-menu';
    menu.className = 'me-menu';
    menu.innerHTML = items.map(function (it, i) {
        return '<div class="me-menu-item" data-i="' + i + '"><span class="mi-icon">' + it.icon + '</span><span class="mi-label">' + it.label + '</span></div>';
    }).join('');
    document.body.appendChild(menu);
    const av = document.getElementById('me-avatar');
    if (av) {
        const r = av.getBoundingClientRect();
        menu.style.top = (r.bottom + 8) + 'px';
        menu.style.left = r.left + 'px';
    }
    items.forEach(function (it, i) {
        menu.querySelector('[data-i="' + i + '"]').onclick = function () {
            menu.remove();
            it.act();
        };
    });
    // 点击菜单外部关闭
    setTimeout(function () {
        document.addEventListener('click', function close(e) {
            if (!menu.contains(e.target) && e.target !== av && !(av && av.contains(e.target))) {
                menu.remove();
                document.removeEventListener('click', close);
            }
        });
    }, 0);
};

/* ---------- Tab 切换 ---------- */
/* 移动端：根据窗口宽度判断是否手机视图 */
App.isMobile = function () {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
};

/* 移动端：设置当前全屏视图（list=侧边栏列表 / chat=聊天 / moments=朋友圈 / admin=管理） */
App.setMobileView = function (v) {
    var app = document.getElementById('app');
    if (!app) return;
    ['mv-list', 'mv-chat', 'mv-moments', 'mv-admin', 'mv-program', 'mv-study'].forEach(function (c) {
        app.classList.remove(c);
    });
    app.classList.add('mv-' + v);
    // 手机端切换全屏视图时的轻微滑入反馈，与原生 App 进阶时的手感保持一致
    app.classList.remove('mv-anim');
    void app.offsetWidth;
    app.classList.add('mv-anim');
};

/* 跨断点（旋转/缩放窗口）时重置视图：手机端默认列表，桌面端恢复三栏 */
App.resetMobileView = function () {
    var app = document.getElementById('app');
    if (!app) return;
    if (App.isMobile()) {
        var has = app.classList.contains('mv-list') || app.classList.contains('mv-chat') ||
            app.classList.contains('mv-moments') || app.classList.contains('mv-admin') ||
            app.classList.contains('mv-program') || app.classList.contains('mv-study');
        if (!has) App.setMobileView('list');
    } else {
        ['mv-list', 'mv-chat', 'mv-moments', 'mv-admin', 'mv-program', 'mv-study'].forEach(function (c) {
            app.classList.remove(c);
        });
        if (App.activeTab) App.switchTab(App.activeTab);
    }
};

App.switchTab = function (tab) {
    App.activeTab = tab;
    document.querySelectorAll('.side-tabs button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    // 同步底部 tabbar 的高亮态（手机端主导航）
    document.querySelectorAll('.mobile-tabbar .mtab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    App.searchResults = [];
    document.getElementById('global-search').value = '';
    // 主面板切换：朋友圈/程序空间用独立面板，管理后台为独立页面（/admin），其余用聊天主区
    const chatMain = document.querySelector('.chat');
    const momentsMain = document.getElementById('moments');
    const programMain = document.getElementById('program');
    var hideChat = (tab === 'moments' || tab === 'program');
    if (chatMain) chatMain.classList.toggle('hidden', hideChat);
    if (momentsMain) momentsMain.classList.toggle('hidden', tab !== 'moments');
    if (programMain) programMain.classList.toggle('hidden', tab !== 'program');
    // 主面板切换时给当前显示的面板加一个轻盈淡入动画，让 tab 跳转更丝滑
    var shownPanel = hideChat ? (tab === 'moments' ? momentsMain : programMain) : chatMain;
    if (shownPanel) {
        shownPanel.classList.remove('panel-fade');
        void shownPanel.offsetWidth;
        shownPanel.classList.add('panel-fade');
    }
    if (tab === 'chat') Chat.renderConversations();
    else if (tab === 'contacts') Friend.renderContacts();
    else if (tab === 'moments' && window.Moment) Moment.render();
    else if (tab === 'program' && window.Program) Program.render();
    else if (tab === 'admin') { if (window.Admin && window.Admin.open) window.Admin.open(); }

    // 离开程序空间时清掉左侧的程序空间导航（仅清 pg-side 标记的内容，不影响会话/好友列表）
    if (tab !== 'program' && window.Program && Program.clearSidebar) Program.clearSidebar();
    // 离开多多的家园时清掉左侧好友栏（仅清 moments-side 标记的内容）
    if (tab !== 'moments' && window.Moment && Moment.clearSidebar) Moment.clearSidebar();

    // 手机端：切到对应全屏视图（chat/contacts/groups 都显示侧边栏列表）
    if (App.isMobile()) {
        if (tab === 'moments') App.setMobileView('moments');
        else if (tab === 'program') App.setMobileView('program');
        else if (tab === 'admin') { if (window.Admin && window.Admin.open) window.Admin.open(); }
        else App.setMobileView('list');
    }
};

/** 检索门槛：纯数字（账号）需 ≥6 位才开始检索；含字母/中文（用户名）任意长度即可。
 *  避免输入少量数字就触发无意义的账号检索（账号为 10 位）。 */
App.searchThresholdOk = function (kw) {
    kw = (kw || '').trim();
    if (!kw) return false;
    if (/^\d+$/.test(kw)) return kw.length >= 6;
    return true;
};

/** 简单防抖：连续触发只在停顿 wait 毫秒后执行一次，避免输入时频繁请求。 */
App.debounce = function (fn, wait) {
    let t = null;
    return function () {
        const ctx = this, args = arguments;
        if (t) clearTimeout(t);
        t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
};

App.onSearch = function (kw) {
    kw = (kw || '').trim();
    if (App.activeTab === 'chat') {
        // 消息菜单：融合搜索（账号 + 聊天记录）
        if (window.Chat) Chat.renderUnifiedSearch(kw);
    } else if (App.activeTab === 'contacts') {
        // 通讯录：仅搜索「我添加的用户」（按账号 / 用户名，≥6 位门槛）
        if (window.Friend) Friend.searchMy(kw);
    }
};

/* ---------- 通知（管理员下发） ---------- */
App._noticeIds = [];   // 当前弹窗/标签页中的未读通知 id，用于「标为已读」
App._noticeWaitTimer = null; // 阅读时长倒计时计时器
App._noticeAll = [];   // 通知中心全量列表（含系统/用户两类）
App._noticeCat = 'ADMIN'; // 通知中心当前标签页：ADMIN=系统通知 / COMMENT=用户通知
App._noticeIsPopup = false; // 当前弹窗是「系统通知弹窗」(true) 还是「通知中心」(false)
App._noticeShownAt = 0; // 当前弹窗/标签页的展示起始时间，阅读时长倒计时以此为起点（而非发布时间）

/** 计算列表中「未读且设了阅读时长」的通知还需等待多少毫秒才能确认（取最大值）；<=0 表示无需等待。
 *  关键修复：以「用户看到弹窗的时刻」(App._noticeShownAt) 为计时起点，而非通知发布时间。
 *  否则用户晚于发布时间才打开（登录后 / 延迟推送）时，等待时长已被发布至今的流逝时间消耗完，形同虚设。 */
App.noticeWaitRemaining = function (list) {
    var now = Date.now();
    var shownAt = App._noticeShownAt || now;
    var maxRemain = 0;
    (list || []).forEach(function (n) {
        if (n.read) return; // 已读无需等待
        var wait = (typeof n.readWaitSeconds === 'number' && n.readWaitSeconds > 0) ? n.readWaitSeconds * 1000 : 0;
        if (wait <= 0) return;
        var remain = wait - (now - shownAt);
        if (remain > maxRemain) maxRemain = remain;
    });
    return maxRemain;
};

/** 渲染通知弹窗底部按钮（带阅读时长倒计时禁用）：btnLabel 为按钮文案，list 为当前弹窗通知列表 */
App.renderNoticeFoot = function (btnLabel, list) {
    var foot = document.getElementById('notice-box-foot');
    if (App._noticeWaitTimer) { clearInterval(App._noticeWaitTimer); App._noticeWaitTimer = null; }
    var remain = App.noticeWaitRemaining(list);
    if (remain <= 0) {
        foot.innerHTML = '<button class="ad-btn" id="notice-foot-btn" onclick="App.markNoticeReadAndClose()">' + btnLabel + '</button>';
        return;
    }
    foot.innerHTML = '<button class="ad-btn" id="notice-foot-btn" disabled onclick="App.markNoticeReadAndClose()">' + btnLabel + '（剩 ' + Math.ceil(remain / 1000) + 's）</button>';
    App._noticeWaitTimer = setInterval(function () {
        var btn = document.getElementById('notice-foot-btn');
        if (!btn) { clearInterval(App._noticeWaitTimer); App._noticeWaitTimer = null; return; }
        var r = App.noticeWaitRemaining(list);
        if (r <= 0) {
            btn.disabled = false;
            btn.onclick = App.markNoticeReadAndClose;
            btn.textContent = btnLabel;
            clearInterval(App._noticeWaitTimer); App._noticeWaitTimer = null;
        } else {
            btn.textContent = btnLabel + '（剩 ' + Math.ceil(r / 1000) + 's）';
        }
    }, 1000);
};

/** 登录后检查待弹窗通知（未读且未过期）。
 *  仅「系统通知」(ADMIN，如管理员下发/打回整改) 自动弹窗；
 *  「用户通知」(COMMENT，如朋友圈评论)只在铃铛红点 + 用户通知标签页呈现，不打扰式弹窗。 */
App.checkNotices = function () {
    Api.noticePending().then(function (d) {
        // 有未读系统通知则弹窗提醒；无论是否有待弹通知，都同步刷新铃铛红点（未读→红点，已读→隐藏）
        if (d && d.code === 0 && Array.isArray(d.data)) {
            var sysList = d.data.filter(function (n) { return n.category === 'ADMIN'; });
            if (sysList.length > 0) App.showNoticePopup(sysList, true);
        }
        App.refreshNoticeBadge();
    }).catch(function () { App.refreshNoticeBadge(); });
};

/** 点击铃铛：打开通知中心。
 *  通知分为两类标签页：
 *   - 系统通知(ADMIN)：管理员下发、打回整改等系统类通知；
 *   - 用户通知(COMMENT)：朋友圈评论/回复等用户互动通知。
 *  通知永久保留，可随时查看；只有「系统通知」且未读、在提醒窗口内才会在登录/在线时自动弹窗。
 *  用户通知仅以铃铛红点 + 标签页呈现，不打扰式弹窗。 */
App.openNoticeCenter = function () {
    if (!App._noticeCat) App._noticeCat = 'ADMIN';
    App._noticeIsPopup = false;
    App._refreshNoticeCenter();
    document.getElementById('notice-modal').classList.remove('hidden');
};

/** 重新拉取通知列表并渲染当前标签页（保留当前选中分类） */
App._refreshNoticeCenter = function () {
    Api.noticeList().then(function (d) {
        if (!d || d.code !== 0 || !Array.isArray(d.data)) {
            App.notify('加载通知失败');
            return;
        }
        App._noticeAll = d.data;
        App._noticeShownAt = Date.now(); // 重置阅读时长计时起点
        App._renderNoticeTabs();
        App._renderNoticeTab();
    }).catch(function () { App.notify('加载通知失败'); });
};

/** 渲染「系统通知 / 用户通知」切换标签，并标注各类未读数 */
App._renderNoticeTabs = function () {
    var list = App._noticeAll || [];
    var sysUnread = list.filter(function (n) { return n.category === 'ADMIN' && !n.read; }).length;
    var userUnread = list.filter(function (n) { return n.category === 'COMMENT' && !n.read; }).length;
    var bar = document.getElementById('notice-tabs');
    if (!bar) return;
    bar.innerHTML =
        '<button class="notice-tab' + (App._noticeCat === 'ADMIN' ? ' active' : '') + '" data-cat="ADMIN" onclick="App.switchNoticeTab(\'ADMIN\')">系统通知' + (sysUnread ? ' <span class="notice-tab-badge">' + sysUnread + '</span>' : '') + '</button>' +
        '<button class="notice-tab' + (App._noticeCat === 'COMMENT' ? ' active' : '') + '" data-cat="COMMENT" onclick="App.switchNoticeTab(\'COMMENT\')">用户通知' + (userUnread ? ' <span class="notice-tab-badge">' + userUnread + '</span>' : '') + '</button>';
};

/** 切换通知中心标签页（切换时重置阅读时长计时起点，保证最短阅读时间从切换后重新计） */
App.switchNoticeTab = function (cat) {
    App._noticeCat = cat;
    App._noticeShownAt = Date.now();
    App._renderNoticeTabs();
    App._renderNoticeTab();
};

/** 渲染当前标签页（按 category 过滤）下的通知列表与底部按钮 */
App._renderNoticeTab = function () {
    var list = (App._noticeAll || []).filter(function (n) { return (n.category || 'ADMIN') === App._noticeCat; });
    var now = Date.now();
    App._noticeIds = [];
    var box = document.getElementById('notice-modal-list');
    var label = (App._noticeCat === 'ADMIN') ? '系统' : '用户';
    if (list.length === 0) {
        box.innerHTML = '<div class="notice-empty">暂无' + label + '通知</div>';
    } else {
        box.innerHTML = list.map(function (n) {
            var read = n.read;
            if (!read) App._noticeIds.push(n.id);
            // 是否已过提醒窗口（过期后不再自动弹窗，但仍可在历史中查看）
            var expired = false;
            if (n.expireAt) {
                var t = Date.parse(n.expireAt.replace(' ', 'T'));
                if (!isNaN(t) && t <= now) expired = true;
            }
            var tag = read
                ? '<span class="notice-tag read">已读</span>'
                : (expired ? '<span class="notice-tag expired">已过期·未读</span>'
                           : '<span class="notice-tag unread">未读</span>');
            return '<div class="notice-item' + (!read && !expired ? ' unread' : '') + (read ? ' read' : '') + (expired ? ' expired' : '') + '"' +
                ' data-id="' + n.id + '" data-category="' + (n.category || '') + '" data-ref="' + (n.refId != null ? n.refId : '') + '" style="cursor:pointer">' +
                '<div class="notice-item-title">' + App.escapeHtml(n.title) + tag + '</div>' +
                (n.content ? '<div class="notice-item-content">' + App.escapeHtml(n.content) + '</div>' : '') +
                '<div class="notice-item-time">' + App.escapeHtml(App.msgTime(n.createTime)) +
                (expired ? ' · 提醒已结束' : '') +
                (read ? '' : ' <button type="button" class="notice-read-btn" onclick="App.markNoticeItemRead(' + n.id + ', event)">标为已读</button>') +
                '</div>' +
                '</div>';
        }).join('');
        // 点击通知项：评论类跳转到对应朋友圈动态，其它类型以后处理
        box.querySelectorAll('.notice-item').forEach(function (el) {
            el.onclick = function () {
                App.onNoticeItemClick({
                    id: Number(el.getAttribute('data-id')),
                    category: el.getAttribute('data-category'),
                    refId: el.getAttribute('data-ref') ? Number(el.getAttribute('data-ref')) : null
                });
            };
        });
    }
    document.getElementById('notice-modal-title').textContent = (App._noticeCat === 'ADMIN') ? '系统通知' : '用户通知';
    // 底部：当前标签页有未读则显示「全部标为已读」（受阅读时长倒计时约束），否则隐藏按钮
    var foot = document.getElementById('notice-box-foot');
    if (App._noticeIds.length > 0) {
        App.renderNoticeFoot('全部标为已读', list);
    } else {
        foot.innerHTML = '';
    }
};

/** 显示通知弹窗（登录后提醒 / 实时推送共用），仅用于「系统通知」(ADMIN) */
App.showNoticePopup = function (list, markReadOnClose) {
    App._noticeIsPopup = true;
    App._noticeShownAt = Date.now(); // 以用户看到弹窗的时刻为阅读时长计时起点
    App._noticeIds = (list || []).map(function (n) { return n.id; });
    var box = document.getElementById('notice-modal-list');
    box.innerHTML = (list || []).map(function (n) {
        return '<div class="notice-item unread" data-id="' + n.id + '" data-category="' + (n.category || '') + '" data-ref="' + (n.refId != null ? n.refId : '') + '" style="cursor:pointer">' +
            '<div class="notice-item-title">' + App.escapeHtml(n.title) + '</div>' +
            (n.content ? '<div class="notice-item-content">' + App.escapeHtml(n.content) + '</div>' : '') +
            '<div class="notice-item-time">' + App.escapeHtml(App.msgTime(n.createTime)) + '</div>' +
            '</div>';
    }).join('');
    box.querySelectorAll('.notice-item').forEach(function (el) {
        el.onclick = function () {
            App.onNoticeItemClick({
                id: Number(el.getAttribute('data-id')),
                category: el.getAttribute('data-category'),
                refId: el.getAttribute('data-ref') ? Number(el.getAttribute('data-ref')) : null
            });
        };
    });
    document.getElementById('notice-modal-title').textContent = '系统通知';
    // 「我知道了」按钮受阅读时长约束：未过等待期则禁用并倒计时
    App.renderNoticeFoot('我知道了', list);
    document.getElementById('notice-modal').classList.remove('hidden');
};

App.markNoticeReadAndClose = function () {
    var ids = (App._noticeIds && App._noticeIds.length > 0) ? App._noticeIds : null;
    var wasPopup = App._noticeIsPopup;
    if (ids) {
        // 必须等「标记已读」服务端提交并失效 userNotices 缓存后，再刷新红点/列表，
        // 否则 noticeList 会在 read 落库前拉回旧的未读数据，导致红点不消失。
        Api.noticeRead(ids)
            .then(function () {
                App.refreshNoticeBadge();
                if (wasPopup) App.closeNoticeModal();
                else if (App._noticeAll) App._refreshNoticeCenter(); // 通知中心：原地刷新为已读，保留在当前标签页
            })
            .catch(function () {
                App.refreshNoticeBadge();
                if (wasPopup) App.closeNoticeModal();
                else if (App._noticeAll) App._refreshNoticeCenter();
            });
    } else {
        if (wasPopup) App.closeNoticeModal();
        else App._refreshNoticeCenter();
    }
};

App.closeNoticeModal = function () {
    if (App._noticeWaitTimer) { clearInterval(App._noticeWaitTimer); App._noticeWaitTimer = null; }
    document.getElementById('notice-modal').classList.add('hidden');
    App._noticeIds = [];
};

/** 单条通知「标为已读」：仅标记已读、不跳转；原地刷新通知中心并同步铃铛红点。
 *  用于「用户通知」等不想点进内容的场景，stopPropagation 防止触发卡片跳转。 */
App.markNoticeItemRead = function (id, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (!id) return;
    Api.noticeRead([Number(id)])
        .then(function () { App.refreshNoticeBadge(); App._refreshNoticeCenter(); })
        .catch(function () { App.refreshNoticeBadge(); App._refreshNoticeCenter(); });
};

/** 点击通知项：标记已读并刷新红点（等已读提交后再刷，避免竞态）；
 *  - 朋友圈评论/回复(COMMENT)且有关联动态：跳转到广场对应动态并高亮；
 *  - 管理员打回/整改等(ADMIN)且带 refId：跳转到「我的」对应动态并高亮（显示违规徽章+修改入口）；
 *  - 其余不带关联内容的通知：暂不支持跳转。 */
App.onNoticeItemClick = function (n) {
    if (n && n.id) {
        Api.noticeRead([n.id])
            .then(function () { App.refreshNoticeBadge(); })
            .catch(function () { App.refreshNoticeBadge(); });
    }
    App.closeNoticeModal();
    if (n && n.refId && (n.category === 'COMMENT' || n.category === 'ADMIN' || n.category === 'LIKE')) {
        // 评论/点赞通知（公开内容）→ 广场定位；打回/整改等管理通知（属于「我的」内容）→ 跳到「我的」定位
        if (window.Moment && Moment.openMomentById) {
            Moment.openMomentById(Number(n.refId), { mine: n.category === 'ADMIN' });
        } else {
            App.switchTab('moments');
        }
    } else {
        // 不带关联内容的通知（如冻结/解冻等）：暂不支持跳转
        App.notify('该通知暂不支持跳转');
    }
};

/** 刷新铃铛与「多多的家园」红点：
 *  - 铃铛：统计该用户全部未读通知（有未读才提示，已读则不提示）
 *  - 多多的家园：仅统计未读的「评论类(COMMENT)」通知，作为朋友圈新评论的红标
 *  两者共用一次 noticeList 拉取（复用 userNotices 缓存）。 */
App.refreshNoticeBadge = function () {
    var badge = document.getElementById('notice-badge');
    var mbadge = document.getElementById('moments-tab-badge');
    var mtbadge = document.getElementById('mtab-moments-badge');
    function applyMomentBadge(n) {
        [mbadge, mtbadge].forEach(function (b) {
            if (!b) return;
            if (n > 0) { b.textContent = n > 99 ? '99+' : n; b.classList.remove('hidden'); }
            else b.classList.add('hidden');
        });
    }
    Api.noticeList().then(function (d) {
        var list = (d && d.code === 0 && Array.isArray(d.data)) ? d.data : [];
        var total = 0, comments = 0;
        list.forEach(function (x) {
            if (!x.read) {
                total++;
                if (x.category === 'COMMENT' || x.category === 'LIKE') comments++;
            }
        });
        if (badge) {
            if (total > 0) { badge.textContent = total > 99 ? '99+' : total; badge.classList.remove('hidden'); }
            else badge.classList.add('hidden');
        }
        applyMomentBadge(comments);
    }).catch(function () {
        if (badge) badge.classList.add('hidden');
        applyMomentBadge(0);
    });
};

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', function () {
    App.applyTheme(localStorage.getItem('chat_theme') || 'light');
    App.showAuth('login');
    App.loadSession();
    // 启动时拉取验证码统一配置（冷却秒数等），驱动「获取验证码」倒计时
    Api.codeConfig().then(function (d) {
        if (d && d.code === 0 && d.data && d.data.cooldown) {
            App.codeCooldown = d.data.cooldown;
        }
    }).catch(function () { /* 拉取失败则用默认 60s */ });
    // 窗口跨越手机/桌面断点时，重置布局视图
    if (window.matchMedia) {
        var mq = window.matchMedia('(max-width: 768px)');
        var onBreak = function () { App.resetMobileView(); };
        if (mq.addEventListener) mq.addEventListener('change', onBreak);
        else if (mq.addListener) mq.addListener(onBreak);
    }
    if (App.token && App.user) {
        App.afterLogin();
    }
    const input = document.getElementById('msg-input');
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            Chat.sendText();
        }
    });
    // 输入框内容变化：实时推送「窥探」内容（仅当对方正在查看时）
    input.addEventListener('input', function () {
        if (window.Chat) Chat.onInput();
    });
    // 点击自己的头像 / 昵称 → 弹出个人中心菜单（事件委托，头像 outerHTML 替换后依然有效）
    document.addEventListener('click', function (e) {
        const t = e.target;
        if (t && (t.id === 'me-avatar' || t.id === 'me-nickname')) {
            App.openMeMenu();
        }
    });
});
