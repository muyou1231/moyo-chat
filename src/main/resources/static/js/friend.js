/* 通讯录：好友搜索 / 申请 / 同意拒绝 / 列表 / 删除 / 备注；群聊合并进通讯录 */
window.Friend = (function () {

    function el() { return document.getElementById('side-list'); }

    // 搜索缓存：减少重复输入 / 重复关键字对后端的查询压力
    let lastGroups = [];                 // 最近一次加载的群聊，供通讯录搜索按群名本地过滤
    let searchTimer = null;              // 通讯录搜索防抖计时器
    let addSearchTimer = null;           // 添加好友搜索防抖计时器
    const friendSearchCache = new Map(); // kw -> { friends, groups, t }
    const userSearchCache = new Map();   // kw -> { users, t }
    const SEARCH_CACHE_TTL = 60000;      // 缓存有效期 60s，过期自动重查

    function cacheGet(map, kw) {
        const e = map.get(kw);
        if (e && (Date.now() - e.t) < SEARCH_CACHE_TTL) return e.v;
        map.delete(kw);
        return null;
    }
    function cacheSet(map, kw, v) { map.set(kw, { v: v, t: Date.now() }); }

    function afterAction(msg) {
        App.notify(msg || '操作成功');
        Chat.refreshConversations();
        renderContacts();
    }

    function renderContacts() {
        Promise.all([Api.friendRequests(), Api.friendList(), Api.groupList()]).then(function (res) {
            const reqData = res[0] || {}, listData = res[1] || {}, grpData = res[2] || {};
            build(
                (reqData.data || []),
                (listData.data || []),
                (grpData.data || [])
            );
        });
    }

    function build(requests, friends, groups) {
        const list = el();
        list.innerHTML = '';
        // 用完整好友列表重建备注映射（确保新增/删除/改备注后前端昵称显示一致）
        App.loadFriendRemarks(friends);
        lastGroups = groups || [];
        // 通讯录数据变化（增删好友/改备注/切 Tab）后，搜索缓存失效，下次搜索重新拉取
        friendSearchCache.clear();
        userSearchCache.clear();
        // 待处理好友申请数：驱动「通讯录」Tab 角标
        App.friendRequestCount = requests.length;
        updateContactsBadge();

        const normalFriends = friends.filter(function (f) { return !f.blocked; });
        const blockedFriends = friends.filter(function (f) { return f.blocked; });

        // 添加朋友（独立入口，仿微信顶部「添加朋友」）
        const addEntry = document.createElement('div');
        addEntry.className = 'item add-friend-entry';
        addEntry.innerHTML = '<div class="meta"><div class="name">添加朋友</div>' +
            '<div class="sub">通过账号 / 用户名查找并添加</div></div>' +
            '<span class="add-friend-arrow">›</span>';
        addEntry.onclick = function () { openAddFriend(); };
        list.appendChild(addEntry);

        // 新的朋友
        if (requests.length) {
            addTitle('新的朋友');
            requests.forEach(function (u) {
                const item = document.createElement('div');
                item.className = 'item';
                item.innerHTML = App.entityClickable(u, 'USER', u.id) +
                    '<div class="meta"><div class="name">' + App.escapeHtml(u.nickname || u.username) + '</div>' +
                    '<div class="sub">请求添加你为好友</div></div>';
                const ok = document.createElement('button');
                ok.className = 'op ok';
                ok.textContent = '同意';
                ok.onclick = function () { accept(u.id); };
                const no = document.createElement('button');
                no.className = 'op no';
                no.textContent = '拒绝';
                no.onclick = function () { reject(u.id); };
                item.appendChild(ok);
                item.appendChild(no);
                list.appendChild(item);
            });
        }

        // 我的好友（moyo AI 助手置顶，带 AI 标识）
        addTitle('我的好友');
        if (!normalFriends.length && !requests.length && !(App.searchResults && App.searchResults.length)) {
            list.insertAdjacentHTML('beforeend',
                '<div class="empty-tip">还没有好友～ 点上方「添加朋友」，输入对方 <b>≥6 位账号</b> 或用户名发起申请</div>');
        }
        normalFriends.forEach(function (u) {
            const remark = u.remark;
            const displayName = remark || (u.nickname || u.username);
            // moyo AI 助手：特殊置顶条目
            if (u.isAssistant) {
                const item = document.createElement('div');
                item.className = 'item assistant-item';
                // 在线状态文案随自身 aiStatus 变化（在线/离线/维修中/忙碌）
                const st = (u.aiStatus || 'ONLINE').toUpperCase();
                const stText = (st === 'OFFLINE') ? '离线'
                    : (st === 'MAINTENANCE') ? '维修中'
                    : (st === 'BUSY') ? '忙碌'
                    : '在线';
                const stCls = 'ai-status-txt st-' + st.toLowerCase();
                item.innerHTML = App.entityClickable(u, 'USER', u.id) +
                    '<div class="meta"><div class="name">' + App.escapeHtml(displayName) +
                    ' <span class="ai-badge">AI</span></div>' +
                    '<div class="sub">你的智能伙伴 · <span class="' + stCls + '">' + stText + '</span></div></div>' +
                    '<span class="add-friend-arrow">›</span>';
                item.onclick = function () { Chat.openConversation('USER', u.id, displayName); };
                list.appendChild(item);
                return;
            }
            const subHtml = '账号 ' + App.escapeHtml(u.account || '') +
                (remark ? ' · <span class="remark-tag">备注</span>' : '');
            const item = document.createElement('div');
            item.className = 'item';
            item.innerHTML = App.entityClickable(u, 'USER', u.id) +
                '<div class="meta"><div class="name">' + App.escapeHtml(displayName) + '</div>' +
                '<div class="sub">' + subHtml + '</div></div>' +
                '<span class="add-friend-arrow">›</span>';
            // 点击好友 → 打开"查看好友详细信息"（备注/拉黑/删除/查看家园都在那里）
            item.onclick = function () { App.showFriendDetail(u.id, u); };
            list.appendChild(item);
        });

        // 黑名单（被我拉黑的好友，可取消拉黑）
        if (blockedFriends.length) {
            addTitle('黑名单');
            blockedFriends.forEach(function (u) {
                const item = document.createElement('div');
                item.className = 'item blocked';
                item.innerHTML = App.entityClickable(u, 'USER', u.id) +
                    '<div class="meta"><div class="name">' + App.escapeHtml(u.nickname || u.username) + '</div>' +
                    '<div class="sub">已拉黑 · 消息无法送达</div></div>' +
                    '<span class="add-friend-arrow">›</span>';
                item.onclick = function () { App.showFriendDetail(u.id, u); };
                list.appendChild(item);
            });
        }

        // 我的群聊（原「群聊」Tab 合并进通讯录）
        addTitle('我的群聊');
        const createBtn = document.createElement('button');
        createBtn.className = 'auth-submit';
        createBtn.style.margin = '6px 12px 12px';
        createBtn.style.width = 'calc(100% - 24px)';
        createBtn.textContent = '+ 创建群聊';
        if (App.user && App.user.frozen) {
            createBtn.disabled = true;
            createBtn.style.opacity = '0.5';
            createBtn.style.cursor = 'not-allowed';
            createBtn.title = '账号已被冻结，无法创建群聊';
        } else {
            createBtn.onclick = function () { if (window.Group) Group.createUI(); };
        }
        list.appendChild(createBtn);

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
    }

    function addTitle(text) {
        const t = document.createElement('div');
        t.className = 'section-title';
        t.textContent = text;
        el().appendChild(t);
    }

    /** 渲染「通讯录搜索」结果：好友（按账号/备注/用户名匹配）+ 群聊（按群名匹配）。
     *  直接渲染，不再调用 renderContacts 重拉全量，配合缓存提升检索速度。 */
    function renderSearch(kw, friends, groups) {
        const list = el();
        list.innerHTML = '';
        addTitle('搜索结果');
        if ((!friends || !friends.length) && (!groups || !groups.length)) {
            list.insertAdjacentHTML('beforeend',
                '<div class="empty-tip">未找到匹配「' + App.escapeHtml(kw) + '」的好友或群聊</div>');
            return;
        }
        (friends || []).forEach(function (u) {
            const remark = u.remark;
            const displayName = remark || (u.nickname || u.username);
            const item = document.createElement('div');
            item.className = 'item';
            item.innerHTML = App.entityClickable(u, 'USER', u.id) +
                '<div class="meta"><div class="name">' + App.escapeHtml(displayName) + '</div>' +
                '<div class="sub">账号 ' + App.escapeHtml(u.account || '') + '</div></div>' +
                '<span class="add-friend-arrow">›</span>';
            item.onclick = function () { App.showFriendDetail(u.id, u); };
            list.appendChild(item);
        });
        (groups || []).forEach(function (g) {
            const item = document.createElement('div');
            item.className = 'item';
            item.innerHTML = App.avatarHtml({ id: g.id, name: g.name, avatar: g.avatar }) +
                '<div class="meta"><div class="name">' + App.escapeHtml(g.name) +
                (g.deleted ? '<span class="dissolved-tag">已解散</span>' : '') + '</div>' +
                '<div class="sub">群成员 ' + (g.memberCount || 0) + ' 人</div></div>';
            item.onclick = function () { Chat.openConversation('GROUP', g.id, g.name); };
            list.appendChild(item);
        });
    }

    /** 通讯录内搜索：每次输入变化即检索一次（内部 180ms 防抖，避免逐字请求）。
     *  好友按 账号 / 备注 / 用户名 匹配（后端 friend/search 已支持 remark LIKE）；
     *  群聊按群名在本地 lastGroups 中过滤。命中前端缓存则直接渲染，不再请求后端。 */
    function searchMy(kw) {
        kw = (kw || '').trim();
        if (!kw) { App.searchResults = []; renderContacts(); return; }
        const cached = cacheGet(friendSearchCache, kw);
        if (cached) { renderSearch(kw, cached.friends, cached.groups); return; }
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
            Api.friendSearchMy(kw).then(function (data) {
                const friends = (data && data.code === 0 && data.data) ? data.data : [];
                const lk = kw.toLowerCase();
                const groups = (lastGroups || []).filter(function (g) {
                    return g.name && g.name.toLowerCase().indexOf(lk) >= 0;
                });
                cacheSet(friendSearchCache, kw, { friends: friends, groups: groups });
                renderSearch(kw, friends, groups);
            }).catch(function () {
                renderSearch(kw, [], []);
            });
        }, 180);
    }

    /** 编辑好友备注：弹窗输入，保存到后端。cb(newRemark) 在保存成功后回调（用于详情面板原地重绘） */
    function editRemark(friendId, current, cb) {
        const html =
            '<div class="cp-modal">' +
            '<div class="cp-title">设置备注</div>' +
            '<input id="remark-input" class="auth-input" maxlength="64" placeholder="备注名（最多 64 字，留空清除）" value="' + App.escapeHtml(current || '') + '">' +
            '<div class="cp-actions">' +
            '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
            '<button class="primary" id="remark-save">保存</button>' +
            '</div>' +
            '</div>';
        const overlay = App.modal(html, null, 'narrow');
        overlay.querySelector('#remark-save').onclick = function () {
            const val = (document.getElementById('remark-input').value || '').trim();
            Api.friendRemark(friendId, val).then(function (d) {
                if (d && d.code === 0) {
                    App.notify(val ? '备注已保存' : '备注已清除');
                    overlay.remove();
                    renderContacts();
                    if (cb) cb(val);
                } else {
                    App.notify((d && d.message) || '保存失败');
                }
            }).catch(function () { App.notify('保存失败'); });
        };
    }

    /** 添加朋友：独立面板，全局搜人（账号 / 用户名 / 昵称）或搜索可添加的 AI 助手 */
    function openAddFriend() {
        const html =
            '<div class="cp-modal add-friend-modal">' +
            '<div class="cp-title">添加朋友</div>' +
            '<div class="af-tabs">' +
            '<button class="af-tab active" data-tab="user" id="af-tab-user">找用户</button>' +
            '<button class="af-tab" data-tab="ai" id="af-tab-ai">找 AI 助手</button>' +
            '</div>' +
            '<div class="af-search-row">' +
            '<input id="af-kw" class="auth-input" placeholder="输入账号（≥6 位）/ 用户名 / 昵称">' +
            '<button class="primary" id="af-search">搜索</button>' +
            '</div>' +
            '<div class="af-hint" id="af-hint">账号为纯数字，需输入至少 6 位；用户名 / 昵称任意长度。</div>' +
            '<div id="af-list" class="af-list"><div class="empty-tip">输入关键字，查找并添加</div></div>' +
            '</div>';
        const overlay = App.modal(html, function (ov) {
            let curTab = 'user';
            const inp = ov.querySelector('#af-kw');
            const hint = ov.querySelector('#af-hint');
            const tabs = ov.querySelectorAll('.af-tab');
            tabs.forEach(function (t) {
                t.onclick = function () {
                    tabs.forEach(x => x.classList.remove('active'));
                    t.classList.add('active');
                    curTab = t.getAttribute('data-tab');
                    if (curTab === 'ai') {
                        hint.textContent = '可搜索并添加任意 AI 助手（含默认助手），加好友立即生效。';
                    } else {
                        hint.textContent = '账号为纯数字，需输入至少 6 位；用户名 / 昵称任意长度。';
                    }
                    doAddSearch(inp.value, ov.querySelector('#af-list'), curTab);
                };
            });
            if (inp) {
                inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ov.querySelector('#af-search').click(); });
                inp.addEventListener('input', function () { doAddSearch(inp.value, ov.querySelector('#af-list'), curTab); });
                setTimeout(function () { inp.focus(); }, 30);
            }
            overlay.__afTab = function () { return curTab; };
        }, 'wide');
        overlay.querySelector('#af-search').onclick = function () {
            doAddSearch(overlay.querySelector('#af-kw').value, overlay.querySelector('#af-list'), overlay.__afTab ? overlay.__afTab() : 'user');
        };
    }

    /** 添加好友：检索（带前端缓存 + 防抖）。tab=user 搜普通用户，tab=ai 搜可添加的 AI 助手。 */
    function doAddSearch(kw, box, tab) {
        tab = tab || 'user';
        if (addSearchTimer) { clearTimeout(addSearchTimer); addSearchTimer = null; }
        kw = (kw || '').trim();
        if (!kw) { box.innerHTML = '<div class="empty-tip">输入关键字，查找并添加</div>'; return; }
        if (tab === 'user' && !App.searchThresholdOk(kw)) {
            box.innerHTML = '<div class="empty-tip">账号需至少 6 位数字</div>';
            return;
        }
        const cacheKey = tab + ':' + kw;
        const cached = cacheGet(userSearchCache, cacheKey);
        if (cached) { renderAddResults(cached, box); return; }
        box.innerHTML = '<div class="empty-tip">搜索中…</div>';
        addSearchTimer = setTimeout(function () {
            const call = (tab === 'ai') ? Api.searchAssistant(kw) : Api.userSearch(kw);
            call.then(function (data) {
                const users = (data && data.code === 0 && data.data) ? data.data : [];
                cacheSet(userSearchCache, cacheKey, users);
                renderAddResults(users, box);
            }).catch(function () { box.innerHTML = '<div class="empty-tip">搜索失败</div>'; });
        }, 250);
    }

    function renderAddResults(users, box) {
        if (!users.length) { box.innerHTML = '<div class="empty-tip">没有找到相关用户</div>'; return; }
        box.innerHTML = '';
        users.forEach(function (u) {
            const isSelf = (App.user && u.id === App.user.id);
            const isFriend = !!u.isFriend;
            const item = document.createElement('div');
            item.className = 'item';
            item.innerHTML = App.entityClickable(u, 'USER', u.id) +
                '<div class="meta"><div class="name">' + App.escapeHtml(u.nickname || u.username) +
                (u.isAssistant ? ' <span class="ai-badge">AI</span>' : '') + '</div>' +
                '<div class="sub">账号 ' + App.escapeHtml(u.account || '') + ' · @' + App.escapeHtml(u.username) + '</div></div>';
            if (isSelf) {
                const tag = document.createElement('span');
                tag.className = 'sub';
                tag.textContent = '我自己';
                item.appendChild(tag);
            } else if (isFriend) {
                const tag = document.createElement('span');
                tag.className = 'sub';
                tag.textContent = '已是好友';
                item.appendChild(tag);
                // 已是好友：名称优先显示备注
                const nm = item.querySelector('.name');
                if (nm) nm.textContent = App.friendName(u.id, u.nickname || u.username);
            } else {
                const btn = document.createElement('button');
                btn.className = 'op add';
                const isAi = !!u.isAssistant;
                btn.textContent = isAi ? '添加 AI' : '加好友';
                btn.onclick = function (e) {
                    e.stopPropagation();
                    Api.friendApply(u.id).then(function (d) {
                        if (d && d.code === 0) {
                            App.notify(isAi ? '已添加 AI 助手' : '好友申请已发送');
                            btn.textContent = isAi ? '已添加' : '已发送';
                            btn.disabled = true;
                            // 添加成功（AI 直接通过 / 真人申请）后立即刷新好友列表与会话列表，无需手动刷新
                            renderContacts();
                            if (window.Chat) Chat.refreshConversations();
                        } else {
                            App.notify(d && d.message);
                        }
                    });
                };
                item.appendChild(btn);
            }
            item.onclick = function () {
                if (!isSelf) Chat.openConversation('USER', u.id, u.nickname || u.username);
            };
            box.appendChild(item);
        });
    }

    function apply(id) {
        Api.friendApply(id).then(function (d) { afterAction(d && d.code === 0 ? '好友申请已发送' : (d && d.message)); });
    }

    function accept(from) {
        Api.friendAccept(from).then(function (d) { afterAction(d && d.code === 0 ? '已添加好友' : (d && d.message)); });
    }

    function reject(from) {
        Api.friendReject(from).then(function () { afterAction('已拒绝'); });
    }

    function remove(id, cb) {
        Api.friendDelete(id).then(function (d) {
            afterAction(d && d.code === 0 ? '已删除好友' : (d && d.message));
            if (cb) cb();
        });
    }

    function blockUser(id, cb) {
        Api.friendBlock(id).then(function (d) {
            if (d && d.code === 0) {
                App.notify('已拉黑，对方将出现在你的黑名单');
                Chat.refreshConversations();
                renderContacts();
                if (cb) cb(true);
            } else {
                App.notify(d && d.message || '操作失败');
                if (cb) cb(false);
            }
        });
    }

    function unblockUser(id, cb) {
        Api.friendUnblock(id).then(function (d) {
            if (d && d.code === 0) {
                App.notify('已取消拉黑，恢复好友关系');
                Chat.refreshConversations();
                renderContacts();
                if (cb) cb(true);
            } else {
                App.notify(d && d.message || '操作失败');
                if (cb) cb(false);
            }
        });
    }

    /* 收到好友申请实时通知 */
    function onRequest(wm) {
        const u = wm.fromUser || {};
        const name = u.nickname || u.username || '有人';
        App.notify(name + ' 请求添加你为好友');
        // 实时更新「通讯录」Tab 角标（提示对方有新的好友申请）
        App.friendRequestCount = (App.friendRequestCount || 0) + 1;
        updateContactsBadge();
        if (App.activeTab === 'contacts') renderContacts();
    }

    /** 更新「通讯录」Tab 上待处理好友申请数角标（侧边栏与底部 tabbar 同步） */
    function updateContactsBadge() {
        const n = App.friendRequestCount || 0;
        const apply = function (b) {
            if (!b) return;
            if (n <= 0) { b.textContent = ''; b.classList.remove('show'); }
            else { b.textContent = n > 99 ? '99+' : String(n); b.classList.add('show'); }
        };
        apply(document.getElementById('contacts-tab-badge'));
        apply(document.getElementById('mtab-contacts-badge'));
    }

    return {
        renderContacts: renderContacts,
        searchMy: searchMy,
        openAddFriend: openAddFriend,
        editRemark: editRemark,
        blockUser: blockUser,
        unblockUser: unblockUser,
        remove: remove,
        onRequest: onRequest
    };
})();
