/* 群聊：群列表 / 建群 / 成员管理 / 订阅群消息 */
window.Group = (function () {

    const subscribed = {};

    function el() { return document.getElementById('side-list'); }

    function ensureSubscribe(groupId) {
        if (subscribed[groupId] || !Ws.client || !Ws.client.connected) return;
        Ws.client.subscribe('/topic/group/' + groupId, function (frame) {
            try {
                const wm = JSON.parse(frame.body);
                Chat.onIncoming(wm);
            } catch (e) { console.error(e); }
        });
        subscribed[groupId] = true;
    }

    function subscribeMyGroups() {
        subscribed = {}; // 重置订阅记录：WebSocket 重连后必须重新订阅，否则群消息会失联
        Api.groupList().then(function (data) {
            if (data && data.code === 0 && data.data) {
                data.data.forEach(function (g) { ensureSubscribe(g.id); });
            }
        });
    }

    /** 收到「加入群聊」通知：订阅群消息主题，刷新会话列表，并重渲染群列表页 */
    function onGroupEvent(wm) {
        if (!wm || !wm.groupId) return;
        // 订阅该群 WS 主题，保证之后的群消息实时推送（关键：建群后才登录/才收到通知的成员此前未订阅）
        ensureSubscribe(wm.groupId);
        // 把群加入会话列表（conversation/list 已含群），并触发兜底订阅
        Chat.refreshConversations();
        const isOwner = !!(App.user && wm.ownerId && App.user.id === wm.ownerId);
        if (!isOwner) {
            App.notify('你已加入群聊「' + (wm.groupName || '新群') + '」');
        }
        if (App.activeTab === 'contacts' && window.Friend) Friend.renderContacts();
    }

    function renderGroups() {
        Api.groupList().then(function (data) {
            const list = el();
            list.innerHTML = '';
            const btn = document.createElement('button');
            btn.className = 'auth-submit';
            btn.style.margin = '12px';
            btn.style.width = 'calc(100% - 24px)';
            btn.textContent = '+ 创建群聊';
            if (App.user && App.user.frozen) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.style.cursor = 'not-allowed';
                btn.title = '账号已被冻结，无法创建群聊';
            } else {
                btn.onclick = createUI;
            }
            list.appendChild(btn);

            const groups = (data && data.code === 0 && data.data) ? data.data : [];
            const title = document.createElement('div');
            title.className = 'section-title';
            title.textContent = '我的群聊';
            list.appendChild(title);

            if (!groups.length) {
                list.insertAdjacentHTML('beforeend', '<div class="empty-tip">还没有群，点上方创建</div>');
            }
            groups.forEach(function (g) {
                const item = document.createElement('div');
                item.className = 'item';
                item.innerHTML = App.avatarHtml({ id: g.id, name: g.name, avatar: g.avatar }) +
                    '<div class="meta"><div class="name">' + App.escapeHtml(g.name) +
                    (g.deleted ? '<span class="dissolved-tag">已解散</span>' : '') + '</div>' +
                    '<div class="sub">群成员 ' + (g.memberCount || 0) + ' 人</div></div>';
                item.onclick = function () { Chat.openConversation('GROUP', g.id, g.name); };
                list.appendChild(item);
            });
        });
    }

    function createUI() {
        Api.friendList().then(function (fdata) {
            const friends = (fdata && fdata.code === 0 && fdata.data) ? fdata.data : [];
            let rows = '';
            if (!friends.length) {
                rows = '<div class="sub">你还没有好友，无法创建群聊</div>';
            } else {
                friends.forEach(function (f) {
                    rows += '<label class="member-row"><input type="checkbox" value="' + f.id + '"> ' +
                        App.escapeHtml(f.nickname || f.username) + '</label>';
                });
            }
            const overlay = App.modal(
                '<h3>创建群聊</h3>' +
                '<input id="grp-name" class="modal-input" placeholder="群名称">' +
                '<div>' + rows + '</div>' +
                '<div class="modal-actions">' +
                '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button class="primary" id="grp-create">创建</button>' +
                '</div>'
            );
            overlay.querySelector('#grp-create').onclick = function () {
                const name = overlay.querySelector('#grp-name').value.trim();
                if (!name) { App.notify('请输入群名称'); return; }
                const ids = [];
                overlay.querySelectorAll('input[type=checkbox]:checked').forEach(function (c) { ids.push(Number(c.value)); });
                Api.groupCreate(name, ids).then(function (d) {
                    overlay.remove();
                    if (d && d.code === 0) {
                        App.notify('群聊已创建');
                        if (d.data && d.data.id) ensureSubscribe(d.data.id);
                        Chat.refreshConversations();
                        if (App.activeTab === 'contacts' && window.Friend) Friend.renderContacts();
                        else renderGroups();
                    } else {
                        App.notify(d ? d.message : '创建失败');
                    }
                });
            };
        });
    }

    function openMemberModal(groupId) {
        Promise.all([Api.groupMembers(groupId), Api.friendList()]).then(function (res) {
            const members = (res[0] && res[0].code === 0 && res[0].data) ? res[0].data : [];
            const friends = (res[1] && res[1].code === 0 && res[1].data) ? res[1].data : [];
            const memberIds = members.map(function (m) { return m.id; });
            const me = members.find(function (m) { return m.id === App.user.id; });
            const iAmOwner = me && me.role === 'OWNER';

            let rows = '';
            members.forEach(function (m) {
                const canRemove = iAmOwner && m.role !== 'OWNER';
                rows += '<div class="member-row">' + App.entityClickable(m, 'USER', m.id) +
                    '<span style="flex:1">' + App.escapeHtml(m.nickname || m.username) +
                    (m.role === 'OWNER' ? ' (群主)' : '') + '</span>' +
                    (canRemove ? '<button class="op del" data-rm="' + m.id + '">移除</button>' : '') + '</div>';
            });

            let invite = '';
            const candidates = friends.filter(function (f) { return memberIds.indexOf(f.id) < 0; });
            if (candidates.length) {
                invite = '<h3 style="margin-top:14px">邀请好友</h3>';
                candidates.forEach(function (f) {
                    invite += '<label class="member-row"><input type="checkbox" class="inv" value="' + f.id + '"> ' +
                        App.escapeHtml(f.nickname || f.username) + '</label>';
                });
            }

            const overlay = App.modal(
                '<h3>群成员（' + members.length + '）</h3>' + rows + invite +
                '<div class="modal-actions">' +
                (me ? (iAmOwner ? '<button class="ghost danger" id="grp-dissolve">解散群聊</button>'
                                : '<button class="ghost" id="grp-quit">退出群聊</button>') : '') +
                (candidates.length ? '<button class="primary" id="grp-invite">邀请</button>' : '') +
                '</div>'
            );

            overlay.querySelectorAll('[data-rm]').forEach(function (b) {
                b.onclick = function () {
                    Api.groupRemove(groupId, Number(b.getAttribute('data-rm'))).then(function (d) {
                        App.notify(d && d.code === 0 ? '已移除' : (d && d.message));
                        openMemberModal(groupId);
                    });
                };
            });
            const inviteBtn = overlay.querySelector('#grp-invite');
            if (inviteBtn) inviteBtn.onclick = function () {
                const ids = [];
                overlay.querySelectorAll('input.inv:checked').forEach(function (c) { ids.push(Number(c.value)); });
                Api.groupInvite(groupId, ids).then(function (d) {
                    App.notify(d && d.code === 0 ? '已邀请' : (d && d.message));
                    openMemberModal(groupId);
                });
            };
            const quitBtn = overlay.querySelector('#grp-quit');
            if (quitBtn) quitBtn.onclick = function () {
                Api.groupQuit(groupId).then(function () {
                    overlay.remove();
                    App.notify('已退出群聊');
                    if (App.current && App.current.type === 'GROUP' && App.current.id === groupId) {
                        App.current = null;
                        document.getElementById('chat-header').textContent = '选择一个会话开始聊天';
                        document.getElementById('chat-messages').innerHTML = '';
                    }
                    Chat.refreshConversations();
                    renderGroups();
                });
            };
            const dissolveBtn = overlay.querySelector('#grp-dissolve');
            if (dissolveBtn)             dissolveBtn.onclick = async function () {
                if (!await App.confirm('确定解散该群聊？解散后所有成员仍可查看历史消息，但无法再发送消息', { danger: true })) return;
                Api.groupDissolve(groupId).then(function (d) {
                    if (d && d.code === 0) {
                        overlay.remove();
                        App.notify('群聊已解散');
                        if (App.current && App.current.type === 'GROUP' && App.current.id === groupId) {
                            App.current = null;
                            document.getElementById('chat-header').textContent = '选择一个会话开始聊天';
                            document.getElementById('chat-messages').innerHTML = '';
                        }
                        Chat.refreshConversations();
                        renderGroups();
                    } else {
                        App.notify(d && d.message || '解散失败');
                    }
                });
            };
        });
    }

    /** 收到「群聊已解散」通知：提示并刷新（若当前正打开该群则禁用输入） */
    function onGroupDissolved(wm) {
        if (!wm || !wm.groupId) return;
        App.notify('群聊「' + (wm.groupName || '群聊') + '」已被群主解散');
        if (App.current && App.current.type === 'GROUP' && App.current.id === wm.groupId) {
            if (window.Chat) Chat.onGroupDissolved(wm.groupId);
        }
        Chat.refreshConversations();
        if (App.activeTab === 'contacts' && window.Friend) Friend.renderContacts();
    }

    return {
        renderGroups: renderGroups,
        subscribeMyGroups: subscribeMyGroups,
        ensureSubscribe: ensureSubscribe,
        onGroupEvent: onGroupEvent,
        onGroupDissolved: onGroupDissolved,
        openMemberModal: openMemberModal
    };
})();
