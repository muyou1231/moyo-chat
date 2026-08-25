/* 多多的家园（朋友圈动态）：发布图文 + 全局查看范围(4选1) + 逐条查看权限 + 信息流 + 评论
 * 权限分两层：
 *  1) 全局查看范围（家园设置，一人一条）：谁也不可见 / 仅三天 / 一个月 / 半年内（无自定义时长）
 *  2) 逐条查看权限（发布时设置）：部分可见(allowList) + 不给谁看(denyList)
 */
window.Moment = (function () {

    // 草稿状态（切换 Tab 时保留，避免输入丢失）；visibility 默认仅好友
    let drafts = { content: '', images: [], visibility: 'FRIENDS', allowList: [], denyList: [] };
    // 当前视图：feed=广场(全部可见) / mine=我的动态
    let view = 'feed';
    // 查看好友家园：friendView={id,name}，非空时朋友圈主区域切换为该好友的动态
    let friendView = null;
    let feed = [];
    let pendingScrollMomentId = null; // 由通知跳转设置：feed 渲染完成后滚动并高亮到该动态
    // 每条动态的评论区状态：{ open, loaded, list, text, images }
    let commentBox = {};
    // 好友缓存（用于权限选择器）
    let friendsCache = null;
    // 重新发布（修改被打回/待审核动态）时的图片草稿
    let republishImages = [];
    // 我的全局查看范围缓存
    let mySetting = { visibility: 'HALF_YEAR' };

    // 全局查看范围（时间窗口 / 查询范围，对“我发布的所有动态”统一生效）
    const SCOPE = {
        INVISIBLE: { label: '不可见',     icon: '🚫' },
        THREE_DAY: { label: '近三天可见', icon: '🌗' },
        ONE_MONTH: { label: '一个月可见', icon: '🌓' },
        HALF_YEAR: { label: '近半年可见', icon: '🌒' }
    };
    // 逐条可见范围（关系范围，发布时选择，默认仅好友）
    const REL = {
        PUBLIC:  { label: '公开',   icon: '🌍' },
        FRIENDS: { label: '仅好友', icon: '👥' },
        PRIVATE: { label: '私密',   icon: '🔒' },
        PARTIAL: { label: '指定',   icon: '👥✨' }
    };

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    /** 相对时间：刚刚 / x分钟前 / x小时前 / 昨天 / M月D日 / YYYY-MM-DD */
    function formatTime(str) {
        if (!str) return '';
        const d = new Date(str.replace(' ', 'T'));
        if (isNaN(d.getTime())) return str;
        const now = new Date();
        const diff = (now.getTime() - d.getTime()) / 1000;
        if (diff < 60) return '刚刚';
        if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
        if (diff < 86400 * 2) return '昨天';
        if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function visMeta(v) { return REL[v] || REL.FRIENDS; }

    /** 权限摘要文案：逐条可见范围 + 部分可见/不给谁看 + 全局时间窗口(非常规时) */
    function permText(m) {
        const rel = (m && m.visibility) || 'FRIENDS';
        const base = REL[rel] ? REL[rel].label : '仅好友';
        let extra = '';
        if (rel === 'PARTIAL' && m && m.allowList && m.allowList.length) extra += ' · 仅' + m.allowList.length + '人';
        if (m && m.denyList && m.denyList.length) extra += ' · 不给' + m.denyList.length + '人看';
        const scope = (m && m.scope) || 'HALF_YEAR';
        if (scope === 'INVISIBLE') extra += ' · 不可见';
        else if (scope === 'THREE_DAY') extra += ' · 近三天';
        else if (scope === 'ONE_MONTH') extra += ' · 一个月';
        return base + extra;
    }

    function authorAvatar(a) {
        if (a && a.avatar) {
            return '<img class="mc-avatar-img" src="' + App.escapeHtml(a.avatar) + '" alt="">';
        }
        const name = (a && (a.nickname || a.username)) || '?';
        const ch = name.charAt(0);
        const color = 'hsl(' + ((name.charCodeAt(0) * 7) % 360) + ',55%,55%)';
        return '<div class="mc-avatar-img mc-avatar-fallback" style="background:' + color + ';color:#fff">' + App.escapeHtml(ch) + '</div>';
    }

    /* ---------- 渲染入口 ---------- */
    function render() {
        const root = document.getElementById('moments');
        if (!root) return;
        // 查看好友家园：渲染该好友的动态视图（含返回）
        if (friendView) { renderFriendHome(); return; }
        // 冻结账号禁止查看朋友圈（后端 /api/moment/** 同样由拦截器拒绝，此处为前端兜底）
        if (App.user && App.user.frozen) {
            root.innerHTML = '<div class="empty-tip">账号已被冻结，无法查看朋友圈</div>';
            return;
        }
        // 每次进入多多的家园都清空评论缓存，确保点击即重新查询（评论数来自 feed，评论内容展开时实时拉取）
        commentBox = {};
        let hasDraft = false;
        try { hasDraft = !!localStorage.getItem('moment_draft'); } catch (e) {}
        root.innerHTML =
            '<div class="moments-header">' +
            '<button type="button" class="mobile-back" onclick="App.setMobileView(\'list\')" title="返回">‹</button>' +
            '<span>多多的家园</span>' +
            '<div class="moments-header-actions">' +
            '<button type="button" class="moments-setting-btn" onclick="Moment.openSetting()">⚙ 家园设置</button>' +
            '<button type="button" class="moments-publish-btn" onclick="Moment.openComposer()">＋ 发布' + (hasDraft ? '<span class="draft-dot">草稿</span>' : '') + '</button>' +
            '</div>' +
            '</div>' +
            '<div class="moments-friends-bar" id="moments-friends-bar"></div>' +
            '<div class="moments-tabs">' +
            '<button type="button" class="mtab' + (view === 'feed' ? ' active' : '') + '" data-view="feed" onclick="Moment.switchView(\'feed\')">广场</button>' +
            '<button type="button" class="mtab' + (view === 'mine' ? ' active' : '') + '" data-view="mine" onclick="Moment.switchView(\'mine\')">我的</button>' +
            '</div>' +
            '<div class="moments-feed" id="moments-feed"></div>';
        if (view === 'feed') loadFeed(); else loadMine();
        // 首次加载时拉取我的全局查看范围
        if (!mySetting._loaded) loadMySetting();
        // 渲染左侧好友栏（桌面端）+ 内部横向好友栏（手机端）
        renderFriendSidebar();
    }


    function loadMySetting() {
        Api.momentGetSetting().then(function (d) {
            if (d && d.code === 0 && d.data) {
                mySetting = d.data;
                mySetting._loaded = true;
            }
        }).catch(function () {});
    }

    function switchView(v) {
        if (v === view && !friendView) return;
        view = v;
        friendView = null; // 切换到广场/我的即退出好友家园视图
        render();
    }

    /* ---------- 查看好友家园（他人动态视图） ---------- */
    /** 打开某好友的家园：拉取该用户按当前浏览者视角可见的动态。
     *  入口：资料卡「查看好友家园」、单聊头部「🏠 家园」按钮。 */
    function viewUserMoments(userId, name) {
        if (App.user && App.user.frozen) { App.notify('账号已被冻结，无法查看朋友圈'); return; }
        friendView = { id: userId, name: name || '好友' };
        if (App.activeTab !== 'moments') App.switchTab('moments');
        else render();
    }

    /** 退出好友家园视图，回到广场 */
    function exitFriendView() {
        friendView = null;
        view = 'feed';
        if (App.activeTab !== 'moments') App.switchTab('moments');
        else render();
    }

    /** 好友家园专属头部：返回按钮 + 「XX 的家园」 */
    function renderFriendHome() {
        const root = document.getElementById('moments');
        if (!root) return;
        const fv = friendView;
        commentBox = {};
        root.innerHTML =
            '<div class="moments-header">' +
            '<button type="button" class="mobile-back" onclick="Moment.exitFriendView()" title="返回">‹</button>' +
            '<span>' + App.escapeHtml(fv.name) + ' 的家园</span>' +
            '<div class="moments-header-actions">' +
            '<button type="button" class="moments-setting-btn" onclick="Moment.exitFriendView()">‹ 返回广场</button>' +
            '</div>' +
            '</div>' +
            '<div class="moments-friends-bar" id="moments-friends-bar"></div>' +
            '<div class="moments-feed" id="moments-feed"></div>';
        loadFriendMoments();
        // 渲染左侧好友栏（保持高亮当前好友）+ 内部横向好友栏
        renderFriendSidebar();
    }

    /** 左侧好友栏（桌面端）+ 内部横向好友栏（手机端）：第一项「全部」看所有好友动态，其余为好友 */
    function renderFriendSidebar() {
        ensureFriends(function (friends) {
            const list = Array.isArray(friends) ? friends : [];
            const curId = friendView ? friendView.id : null;
            const allActive = curId == null ? ' active' : '';
            // 桌面端：渲染左侧 #side-list
            const side = document.getElementById('side-list');
            if (side && !(window.App && App.isMobile && App.isMobile())) {
                const items = list.map(function (f) {
                    const fid = f.id;
                    const active = (curId === fid) ? ' active' : '';
                    const name = App.escapeHtml(f.nickname || f.username || ('用户' + fid));
                    return '<div class="ms-friend' + active + '" data-fid="' + fid + '" data-name="' + name + '">' +
                        '<span class="ms-friend-avatar">' + (f.avatar ? '<img src="' + App.escapeHtml(f.avatar) + '" alt="">' : App.escapeHtml((f.nickname || f.username || '?').charAt(0))) + '</span>' +
                        '<span class="ms-friend-name">' + name + '</span>' +
                        '</div>';
                }).join('');
                side.innerHTML =
                    '<div class="ms-side-head">多多的家园</div>' +
                    '<div class="ms-friend ms-all' + allActive + '" data-fid="0" data-name="全部">' +
                    '<span class="ms-friend-avatar">🏠</span><span class="ms-friend-name">全部</span>' +
                    '</div>' +
                    (items || '<div class="ms-friend-empty">还没有好友</div>') +
                    '<div class="ms-side-foot">点击好友查看 TA 的家园</div>';
                side.classList.add('moments-side');
                side.querySelectorAll('.ms-friend').forEach(function (el) {
                    el.onclick = function () {
                        const fid = el.getAttribute('data-fid');
                        if (fid === '0') switchFriend(null, null);
                        else switchFriend(Number(fid), el.getAttribute('data-name'));
                    };
                });
            }
            // 手机端：朋友圈内部顶部横向好友栏
            const bar = document.getElementById('moments-friends-bar');
            if (bar) {
                const chips = list.map(function (f) {
                    const fid = f.id;
                    const active = (curId === fid) ? ' active' : '';
                    const name = App.escapeHtml(f.nickname || f.username || ('用户' + fid));
                    return '<span class="ms-chip' + active + '" data-fid="' + fid + '" data-name="' + name + '">' + name + '</span>';
                }).join('');
                bar.innerHTML = '<span class="ms-chip ms-chip-all' + allActive + '" data-fid="0" data-name="全部">全部</span>' + (chips || '<span class="ms-chip-empty">暂无好友</span>');
                bar.querySelectorAll('.ms-chip').forEach(function (el) {
                    el.onclick = function () {
                        const fid = el.getAttribute('data-fid');
                        if (fid === '0') switchFriend(null, null);
                        else switchFriend(Number(fid), el.getAttribute('data-name'));
                    };
                });
            }
        });
    }

    /** 切换好友家园：fid 为 null 表示「全部」（广场） */
    function switchFriend(fid, name) {
        if (fid == null) {
            // 全部：退出好友视图，回到广场
            friendView = null;
            view = 'feed';
            if (App.activeTab !== 'moments') App.switchTab('moments');
            else render();
        } else {
            viewUserMoments(fid, name);
        }
    }

    /** 清除多多的家园在左侧栏的标记（切到其它 tab 时调用，避免残留） */
    function clearSidebar() {
        const side = document.getElementById('side-list');
        if (!side) return;
        if (side.classList.contains('moments-side')) {
            side.innerHTML = '';
            side.classList.remove('moments-side');
        }
    }

    /** 加载好友家园动态：GET /api/moment/user/{id}（后端按浏览者视角过滤可见范围） */
    function loadFriendMoments() {
        const fv = friendView;
        if (!fv) return;
        Api.momentUserMoments(fv.id, 50).then(function (d) {
            if (d && d.code === 0 && Array.isArray(d.data)) {
                feed = d.data;
            } else {
                feed = [];
            }
            renderFeed();
        }).catch(function () {
            feed = [];
            renderFeed();
        });
    }


    /* ---------- 发布（右上角「发布」按钮 → 弹窗编辑 + 草稿） ---------- */
    let composerOverlay = null; // 当前打开的发布弹窗 DOM

    /** 读取本地保存的草稿（仅一份，localStorage 持久化，刷新后仍可恢复） */
    function loadDraft() {
        try {
            const s = localStorage.getItem('moment_draft');
            if (!s) return null;
            const d = JSON.parse(s) || {};
            return {
                content: d.content || '',
                images: Array.isArray(d.images) ? d.images : [],
                visibility: d.visibility || 'FRIENDS',
                allowList: Array.isArray(d.allowList) ? d.allowList : [],
                denyList: Array.isArray(d.denyList) ? d.denyList : []
            };
        } catch (e) { return null; }
    }

    /** 打开发布弹窗：若本地存有草稿则直接填充上次的草稿内容 */
    function openComposer() {
        if (App.user && App.user.frozen) { App.notify('账号已被冻结，无法发布动态'); return; }
        const saved = loadDraft();
        drafts = saved || { content: '', images: [], visibility: 'FRIENDS', allowList: [], denyList: [] };
        const overlay = App.modal('<h3>发布动态</h3>' + composerModalHtml(), function (ov) {
            const ta = ov.querySelector('#moment-content');
            if (ta) ta.oninput = function () { drafts.content = ta.value; };
        }, 'wide');
        composerOverlay = overlay;
    }

    function composerModalHtml() {
        const imgPreviews = drafts.images.map(function (url, i) {
            return '<div class="mc-thumb">' +
                '<img src="' + App.escapeHtml(url) + '" alt="">' +
                '<span class="mc-thumb-del" onclick="Moment.removeImage(' + i + ')">×</span>' +
                '</div>';
        }).join('');
        return '' +
            '<textarea id="moment-content" class="composer-text moment-editor-text" placeholder="这一刻的想法…">' + App.escapeHtml(drafts.content) + '</textarea>' +
            '<div class="composer-imgs" id="moment-imgs">' + imgPreviews + '</div>' +
            '<div class="composer-bar">' +
            '<div class="composer-left">' +
            '<button type="button" class="composer-img-btn" onclick="document.getElementById(\'moment-img-input\').click()">🖼 图片</button>' +
            '<input type="file" id="moment-img-input" accept="image/*" multiple hidden onchange="Moment.onPickImages(this)">' +
            '<span class="composer-perm-hint" id="moment-perm-hint">🔒 ' + App.escapeHtml(composerPermHint()) + '</span>' +
            '<button type="button" class="composer-perm-btn" onclick="Moment.openComposerPerm()">查看权限</button>' +
            '</div>' +
            '<div class="composer-right">' +
            '<button type="button" class="composer-ai-btn" onclick="Moment.assistantCopy()">✨ 助手帮写</button>' +
            '<button type="button" class="composer-draft-btn" onclick="Moment.saveDraft()">保存草稿</button>' +
            '<button type="button" class="composer-publish" id="moment-publish" onclick="Moment.publish()">发表</button>' +
            '</div>' +
            '</div>';
    }

    /** 保存草稿（仅一份，覆盖式写入 localStorage；保留弹窗以便继续编辑/发表） */
    function saveDraft() {
        const ta = document.getElementById('moment-content');
        if (ta) drafts.content = ta.value;
        try {
            localStorage.setItem('moment_draft', JSON.stringify({
                content: drafts.content,
                images: drafts.images,
                visibility: drafts.visibility,
                allowList: drafts.allowList,
                denyList: drafts.denyList
            }));
        } catch (e) { App.notify('草稿保存失败'); return; }
        // 若头部「发布」按钮正显示，刷新其「草稿」标记
        const btn = document.querySelector('.moments-publish-btn');
        if (btn && !btn.querySelector('.draft-dot')) {
            btn.insertAdjacentHTML('beforeend', '<span class="draft-dot">草稿</span>');
        }
        App.notify('草稿已保存');
    }

    /** 弹窗内图片预览重渲染（只更新图片容器，保留文本输入与光标） */
    function renderComposerImgs() {
        const box = document.getElementById('moment-imgs');
        if (!box) return;
        box.innerHTML = drafts.images.map(function (url, i) {
            return '<div class="mc-thumb"><img src="' + App.escapeHtml(url) + '" alt=""><span class="mc-thumb-del" onclick="Moment.removeImage(' + i + ')">×</span></div>';
        }).join('');
    }

    /** 权限变更后刷新弹窗内的权限摘要 */
    function updateComposerPermHint() {
        const el = document.getElementById('moment-perm-hint');
        if (el) el.textContent = '🔒 ' + composerPermHint();
    }

    /** 发布框权限摘要：本条可见范围 + 部分可见/不给谁看 + 全局时间窗口 */
    function composerPermHint() {
        const rel = drafts.visibility || 'FRIENDS';
        let t = REL[rel] ? REL[rel].label : '仅好友';
        if (rel === 'PARTIAL' && drafts.allowList && drafts.allowList.length) t += ' · 仅' + drafts.allowList.length + '人';
        if (drafts.denyList && drafts.denyList.length) t += ' · 不给' + drafts.denyList.length + '人看';
        const scope = mySetting.visibility || 'HALF_YEAR';
        if (scope === 'INVISIBLE') t += '（不可见）';
        else if (scope === 'THREE_DAY') t += '（近三天）';
        else if (scope === 'ONE_MONTH') t += '（一个月）';
        return t;
    }

    function onPickImages(input) {
        const files = input.files;
        if (!files || !files.length) return;
        const tasks = [];
        for (let i = 0; i < files.length; i++) {
            tasks.push(Api.upload(files[i], 'photo/moment'));
        }
        App.notify('图片上传中…');
        Promise.all(tasks).then(function (res) {
            let ok = 0;
            res.forEach(function (r) {
                if (r && r.code === 0 && r.data && r.data.url) {
                    drafts.images.push(r.data.url);
                    ok++;
                }
            });
            if (ok < files.length) App.notify('有 ' + (files.length - ok) + ' 张图片上传失败');
            renderComposerImgs();
        }).catch(function () {
            App.notify('图片上传失败');
            renderComposerImgs();
        });
        input.value = '';
    }

    function removeImage(idx) {
        drafts.images.splice(idx, 1);
        renderComposerImgs();
    }

    function publish() {
        if (App.user && App.user.frozen) {
            App.notify('账号已被冻结，无法发布动态');
            return;
        }
        const content = (drafts.content || '').trim();
        const images = drafts.images;
        if (!content && (!images || !images.length)) {
            App.notify('说点什么或发张图吧');
            return;
        }
        const btn = document.getElementById('moment-publish');
        if (btn) { btn.disabled = true; btn.textContent = '发表中…'; }
        Api.momentPublish(content, images, drafts.visibility, drafts.allowList, drafts.denyList).then(function (d) {
            if (d && d.code === 0) {
                try { localStorage.removeItem('moment_draft'); } catch (e) {}
                if (composerOverlay) { composerOverlay.remove(); composerOverlay = null; }
                drafts = { content: '', images: [], visibility: 'FRIENDS', allowList: [], denyList: [] };
                // 人工审核(PENDING)/AI 审核中(AI_REVIEWING)动态对其他人不可见，且不应出现在广场；
                // 故发布后直接跳到「我的」视图，由服务端重新拉取（含刚刚发布的动态及其状态）。
                const st = (d.data && d.data.status) || 'NORMAL';
                let tip = '已发布';
                if (st === 'AI_REVIEWING') tip = '已提交，AI 审核中…';
                else if (st === 'PENDING') tip = '已提交，等待审核';
                App.notify(tip);
                view = 'mine';
                if (App.activeTab !== 'moments') App.switchTab('moments');
                else render();
            } else {
                App.notify((d && d.message) || '发布失败');
                if (btn) { btn.disabled = false; btn.textContent = '发表'; }
            }
        }).catch(function () {
            App.notify('发布失败');
            if (btn) { btn.disabled = false; btn.textContent = '发表'; }
        });
    }

    /* ---------- 信息流 / 我的 ---------- */
    function loadFeed() {
        Api.momentFeed(50).then(function (d) {
            if (d && d.code === 0 && Array.isArray(d.data)) {
                feed = d.data;
            } else {
                feed = [];
            }
            renderFeed();
        }).catch(function () {
            feed = [];
            renderFeed();
        });
    }

    function loadMine() {
        Api.momentMine(50).then(function (d) {
            if (d && d.code === 0 && Array.isArray(d.data)) {
                feed = d.data;
            } else {
                feed = [];
            }
            renderFeed();
        }).catch(function () {
            feed = [];
            renderFeed();
        });
    }

    /** AI 审核完成（后端异步回写后推送给作者本人的 WS 消息）的实时刷新入口。
     *  用户发布动态后处于「AI 审核中…」状态，审核完成后无需手动刷新即可看到结果：
     *  - 正在看「多多的家园」时，按当前 tab（我的/广场）局部刷新 feed 列表，徽标自动从「审核中」变为「通过 / 未通过」；
     *  - 不在家园 tab 时，仅轻量提示审核结果，不打扰当前操作。 */
    function onAiReviewDone(wm) {
        const pass = !!(wm && wm.pass);
        const status = (wm && wm.status) || (pass ? 'NORMAL' : 'PENDING');
        const suggestion = wm && wm.aiSuggestion ? wm.aiSuggestion : '';
        if (App.activeTab === 'moments') {
            // 局部刷新 feed 容器即可（不重建整个 DOM，避免打断用户滚动/草稿）
            if (view === 'mine') loadMine();
            else loadFeed();
        } else {
            // 不在家园：仅提示，作者切回时即为最新状态
            const tip = pass ? '动态 AI 审核已通过' : ('动态 AI 审核未通过' + (suggestion ? '：' + suggestion : ''));
            App.notify(tip);
        }
    }

    /** 人工复审链路状态变化（申请成功 / 管理员打回 / 管理员通过）的实时刷新入口。
     *  作者端无需手动刷新即可看到最新状态徽标与打回原因：
     *  - 正在看「多多的家园」：按当前 tab 局部刷新 feed（我的/广场）；
     *  - 不在家园：轻量提示，切回即为最新。 */
    function onManualReviewUpdate(wm) {
        const action = (wm && wm.action) || '';
        const status = (wm && wm.status) || '';
        const rejectReason = (wm && wm.rejectReason) || '';
        if (App.activeTab === 'moments') {
            if (view === 'mine') loadMine();
            else loadFeed();
        } else {
            const tip = action === 'APPLIED' ? '已申请人工复审，等待管理员复核'
                : action === 'REJECTED' ? ('动态人工审核未通过，已打回' + (rejectReason ? '：' + rejectReason : ''))
                : action === 'APPROVED' ? '动态人工审核已通过，已恢复可见'
                : '动态审核状态已更新';
            App.notify(tip);
        }
    }

    function renderFeed() {
        const box = document.getElementById('moments-feed');
        if (!box) return;
        if (!feed.length) {
            let tip;
            if (friendView) {
                tip = '「' + App.escapeHtml(friendView.name) + '」还没有发布公开可见的动态';
            } else {
                tip = view === 'mine'
                    ? '你还没有发布动态<br>切到「广场」发表第一条吧'
                    : '还没有动态<br>点击右上角「发布」发表你的第一条动态吧';
            }
            box.innerHTML = '<div class="empty-tip">' + tip + '</div>';
            return;
        }
        box.innerHTML = feed.map(renderCard).join('');
        // 通知跳转：feed 渲染完成后滚动到目标动态并高亮
        if (pendingScrollMomentId != null) {
            const sid = pendingScrollMomentId;
            pendingScrollMomentId = null;
            setTimeout(function () {
                if (!scrollToMoment(sid)) fetchAndShowMoment(sid);
            }, 80);
        }
    }

    /** 平滑滚动并高亮某条动态卡片；找不到返回 false */
    function scrollToMoment(id) {
        const el = document.getElementById('moment-' + id);
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('moment-highlight');
        setTimeout(function () { el.classList.remove('moment-highlight'); }, 2200);
        return true;
    }

    /** 兜底：feed 中未找到（如超出前 50 条、或权限边界），调用单条详情接口拉取并临时插入 */
    function fetchAndShowMoment(id) {
        Api.momentGet(id).then(function (d) {
            if (d && d.code === 0 && d.data) {
                feed = [d.data].concat(feed || []);
                renderFeed();
                setTimeout(function () { scrollToMoment(id); }, 80);
            } else {
                App.notify('该动态不存在或你无权查看');
            }
        }).catch(function () { App.notify('该动态不存在或你无权查看'); });
    }

    /** 由通知点击触发：跳转到对应动态并高亮。
     *  opts.mine=true（被打回/整改等属于「我的」内容的管理通知）→ 切到「我的」视图；
     *    广场只显示 NORMAL，REJECTED 内容在广场看不到、且只有「我的」才会显示违规徽章与「修改」入口，故必须到「我的」定位。
     *  否则（朋友圈评论/回复等公开内容）→ 切到广场视图定位高亮。 */
    function openMomentById(id, opts) {
        if (!id) return;
        id = Number(id);
        if (App.user && App.user.frozen) { App.notify('账号已被冻结，无法查看朋友圈'); return; }
        pendingScrollMomentId = id;
        const goMine = !!(opts && opts.mine);
        view = goMine ? 'mine' : 'feed';
        if (App.activeTab !== 'moments') {
            if (App.switchTab) App.switchTab('moments');
        } else {
            render();
        }
    }

    function gridClass(n) {
        if (n === 1) return 'single';
        if (n === 4) return 'g2';
        return 'g3';
    }

    function renderCard(m) {
        const a = m.author || {};
        const isSelf = (App.user && a.id === App.user.id);
        const imgs = (m.images || []);
        let imgHtml = '';
        if (imgs.length) {
            imgHtml = '<div class="mc-imgs ' + gridClass(imgs.length) + '">' + imgs.map(function (u) {
                const su = String(u).replace(/'/g, "\\'");
                return '<img class="mc-img" src="' + App.escapeHtml(u) + '" alt="" onclick="App.previewImage(\'' + su + '\')">';
            }).join('') + '</div>';
        }
        const vis = visMeta(m.visibility);
        // 「修改权限」仅出现在「我的」视图、且是自己的动态；广场发布流程保持不变
        const status = m.status || 'NORMAL';
        const isMine = isSelf && view === 'mine';
        let statusBadge = '';
        // AI 审核不通过（PENDING + aiReview=FAIL）：展示 AI 原因；已申请人工复审则提示等待
        const aiFail = isMine && status === 'PENDING' && m.aiReview === 'FAIL';
        const appliedManual = isMine && (m.manualReview === true || status === 'MANUAL_REVIEWING');
        // 可被「申请人工复审」的入口：AI 审核不通过 / 被管理员打回，且尚未申请
        const canApplyManual = isMine && !appliedManual && (aiFail || status === 'REJECTED');
        if (isMine && status === 'REJECTED') {
            // 管理员已打回（无论此前是否申请过人工复审）：显示打回结果，而非「人工审核中」
            const reviewed = appliedManual ? '人工审核' : '审核';
            statusBadge = '<span class="mc-badge danger">已打回·' + reviewed + '未通过</span>' +
                (m.rejectReason ? '<span class="mc-reject-reason">打回原因：' + App.escapeHtml(m.rejectReason) + '</span>' : '');
        } else if (aiFail && appliedManual) {
            statusBadge = '<span class="mc-badge warn">已申请人工复审</span>' +
                (m.aiSuggestion ? '<span class="mc-reject-reason">AI 审核意见：' + App.escapeHtml(m.aiSuggestion) + '</span>' : '');
        } else if (aiFail) {
            statusBadge = '<span class="mc-badge warn">AI 审核未通过</span>' +
                (m.aiSuggestion ? '<span class="mc-reject-reason">AI 意见：' + App.escapeHtml(m.aiSuggestion) + '</span>' : '');
        } else if (isMine && status === 'AI_REVIEWING') {
            statusBadge = '<span class="mc-badge reviewing"><span class="mc-spinner"></span>AI 审核中…</span>';
        } else if (isMine && status === 'MANUAL_REVIEWING') {
            statusBadge = '<span class="mc-badge warn">人工审核中</span>' +
                (m.aiSuggestion ? '<span class="mc-reject-reason">AI 审核意见：' + App.escapeHtml(m.aiSuggestion) + '</span>' : '');
        } else if (isMine && status === 'PENDING') {
            statusBadge = '<span class="mc-badge warn">审核中</span>';
        }
        // 「申请人工复审」按钮：AI 审核未通过 / 被管理员打回 且尚未申请时显示；申请成功后状态变 MANUAL_REVIEWING，按钮消失并显示「人工审核中」
        const manualBtn = canApplyManual
            ? '<button type="button" class="mc-btn mc-btn-primary" onclick="Moment.applyManualReview(' + m.id + ')">申请人工复审</button>' : '';
        const repubBtn = (isMine && (status === 'REJECTED' || status === 'PENDING'))
            ? '<button type="button" class="mc-edit" onclick="Moment.openRepublish(' + m.id + ')">修改</button>' : '';
        const editBtn = (isSelf && view === 'mine')
            ? '<button type="button" class="mc-edit" onclick="Moment.openEditPerm(' + m.id + ')">修改权限</button>' : '';
        const delBtn = isSelf ? '<button type="button" class="mc-del" onclick="Moment.del(' + m.id + ')">删除</button>' : '';
        const authorClick = (window.App && a.id) ? ('onclick="App.showProfile(' + a.id + ')" style="cursor:pointer"') : '';
        const box = commentBox[m.id] || (commentBox[m.id] = { open: false, showInput: false, replyTo: null, loaded: false, list: [], text: '', images: [] });
        // 评论数来自 feed 的 commentCount（后端子查询，进入标签即刷新），不依赖本地缓存
        const commentBadge = m.commentCount || 0;
        const cmtLabel = box.open
            ? '收起'
            : ('评论' + (commentBadge ? ' (' + commentBadge + ')' : ''));
        // 点赞状态：likeCount / liked 由后端 feed 富化时填充
        const likeCount = m.likeCount || 0;
        const liked = !!m.liked;
        const likeBtn = '<button type="button" class="mc-like-btn' + (liked ? ' liked' : '') +
            '" onclick="Moment.toggleLike(' + m.id + ')">' +
            (liked ? '❤️' : '🤍') + ' ' + (likeCount ? likeCount : '赞') + '</button>';
        return '' +
            '<div class="moment-card" id="moment-' + m.id + '">' +
            '<div class="mc-avatar" ' + authorClick + '>' + authorAvatar(a) + '</div>' +
            '<div class="mc-body">' +
            '<div class="mc-name" ' + authorClick + '>' + App.escapeHtml(App.friendName(a.id, a.nickname || a.username || '用户')) + '</div>' +
            (m.content ? '<div class="mc-content">' + App.escapeHtml(m.content) + '</div>' : '') +
            imgHtml +
            '<div class="mc-foot">' +
            '<span class="mc-time">' + formatTime(m.createTime) + '</span>' +
            statusBadge +
            (isSelf ? '<span class="mc-vis" title="可见范围">' + vis.icon + ' ' + App.escapeHtml(permText(m)) + '</span>' : '') +
            '<button type="button" class="mc-comment-btn" onclick="Moment.toggleComments(' + m.id + ')">' + (box.open ? '🔼 ' : '💬 ') + cmtLabel + '</button>' +
            likeBtn +
            repubBtn +
            manualBtn +
            editBtn +
            delBtn +
            '</div>' +
            (box.open ? renderComments(m, box) : '') +
            '</div>' +
            '</div>';
    }

    /* ---------- 全局查看范围设置（4 选 1，无自定义时长） ---------- */
    function ensureFriends(cb) {
        if (friendsCache) { cb(friendsCache); return; }
        Api.friendList().then(function (d) {
            friendsCache = (d && d.code === 0 && Array.isArray(d.data)) ? d.data : [];
            cb(friendsCache);
        }).catch(function () { friendsCache = []; cb(friendsCache); });
    }

    function friendChecks(containerId, selected, friends) {
        if (!friends || !friends.length) return '<div id="' + containerId + '" class="perm-friends"><div class="perm-empty">暂无好友</div></div>';
        const sel = {};
        (selected || []).forEach(function (id) { sel[id] = true; });
        const html = friends.map(function (f) {
            const id = f.id;
            const checked = sel[id] ? 'checked' : '';
            const name = App.escapeHtml(f.nickname || f.username || ('用户' + id));
            return '<label class="perm-friend"><input type="checkbox" data-id="' + id + '" ' + checked + '> ' + name + '</label>';
        }).join('');
        return '<div id="' + containerId + '" class="perm-friends">' + html + '</div>';
    }

    function readChecked(containerId) {
        const box = document.getElementById(containerId);
        if (!box) return [];
        const arr = [];
        box.querySelectorAll('input[type=checkbox]:checked').forEach(function (c) {
            arr.push(Number(c.getAttribute('data-id')));
        });
        return arr;
    }

    /** 打开全局查看范围弹窗：4 选 1，无自定义时长，无 allow/deny */
    function openSetting() {
        const cur = { visibility: mySetting.visibility || 'HALF_YEAR' };
        const pills = Object.keys(SCOPE).map(function (k) {
            return '<button type="button" class="vis-pill' + (cur.visibility === k ? ' active' : '') +
                '" data-vis="' + k + '">' + SCOPE[k].icon + ' ' + SCOPE[k].label + '</button>';
        }).join('');
        const body = '' +
            '<p style="font-size:13px;color:var(--text-sub);margin-bottom:14px">查看范围对“我发布的所有动态”统一生效（无自定义时长）</p>' +
            '<div class="perm-vis">' + pills + '</div>' +
            '<div class="modal-actions">' +
            '<button type="button" class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
            '<button type="button" class="primary" id="pe-save">保存设置</button>' +
            '</div>';
        const overlay = App.modal('<h3>家园权限设置</h3>' + body, null, 'wide');
        overlay.querySelectorAll('.vis-pill').forEach(function (p) {
            p.onclick = function () {
                cur.visibility = p.getAttribute('data-vis');
                overlay.querySelectorAll('.vis-pill').forEach(function (x) { x.classList.toggle('active', x === p); });
            };
        });
        overlay.querySelector('#pe-save').onclick = function () {
            Api.momentSaveSetting({ visibility: cur.visibility }).then(function (d) {
                if (d && d.code === 0) {
                    mySetting = d.data || cur;
                    mySetting._loaded = true;
                    overlay.remove();
                    if (view === 'feed') loadFeed(); else loadMine();
                    App.notify('家园权限已更新');
                } else {
                    App.notify((d && d.message) || '保存失败');
                }
            }).catch(function () { App.notify('保存失败'); });
        };
    }

    /** 打开「查看权限」弹窗：可见范围(公开/好友/私密/指定) + 指定好友(allowList) + 不给谁看(denyList) */
    function openComposerPerm() {
        ensureFriends(function (friends) {
            const cur = { visibility: drafts.visibility || 'FRIENDS' };
            const relPills = Object.keys(REL).map(function (k) {
                return '<button type="button" class="vis-pill' + (cur.visibility === k ? ' active' : '') +
                    '" data-vis="' + k + '">' + REL[k].icon + ' ' + REL[k].label + '</button>';
            }).join('');
            const allowHtml = friendChecks('cp-allow', drafts.allowList, friends);
            const denyHtml = friendChecks('cp-deny', drafts.denyList, friends);
            const body = '' +
                '<p style="font-size:13px;color:var(--text-sub);margin-bottom:12px">谁能看这条动态？时间范围在「家园设置」统一设置</p>' +
                '<div class="perm-label">可见范围</div>' +
                '<div class="perm-vis">' + relPills + '</div>' +
                '<div id="cp-allow-row" style="display:' + (cur.visibility === 'PARTIAL' ? 'block' : 'none') + '">' +
                '<div class="perm-label">指定可见（仅选中的好友能看本条）</div>' + allowHtml +
                '</div>' +
                '<div class="perm-row">' +
                '<div class="perm-label">不给谁看（这些好友看不到本条，优先级最高）</div>' + denyHtml +
                '</div>' +
                '<div class="modal-actions">' +
                '<button type="button" class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button type="button" class="primary" id="cp-save">确定</button>' +
                '</div>';
            const overlay = App.modal('<h3>查看权限</h3>' + body, null, 'wide');
            overlay.querySelectorAll('.vis-pill').forEach(function (p) {
                p.onclick = function () {
                    cur.visibility = p.getAttribute('data-vis');
                    overlay.querySelectorAll('.vis-pill').forEach(function (x) { x.classList.toggle('active', x === p); });
                    const allowRow = overlay.querySelector('#cp-allow-row');
                    if (allowRow) allowRow.style.display = (cur.visibility === 'PARTIAL') ? 'block' : 'none';
                };
            });
            overlay.querySelector('#cp-save').onclick = function () {
                drafts.visibility = cur.visibility;
                drafts.allowList = readChecked('cp-allow');
                drafts.denyList = readChecked('cp-deny');
                overlay.remove();
                updateComposerPermHint();
            };
        });
    }

    /** 修改「我的」中某条已发布动态的可见范围（叠加全局时间窗口；先总体、后本条） */
    function openEditPerm(id) {
        const m = feed.find(function (x) { return x.id === id; });
        if (!m) return;
        ensureFriends(function (friends) {
            const cur = { visibility: m.visibility || 'FRIENDS' };
            const relPills = Object.keys(REL).map(function (k) {
                return '<button type="button" class="vis-pill' + (cur.visibility === k ? ' active' : '') +
                    '" data-vis="' + k + '">' + REL[k].icon + ' ' + REL[k].label + '</button>';
            }).join('');
            const allowHtml = friendChecks('ep-allow', m.allowList, friends);
            const denyHtml = friendChecks('ep-deny', m.denyList, friends);
            const body = '' +
                '<p style="font-size:13px;color:var(--text-sub);margin-bottom:12px">修改这条动态的可见范围。全局「查询范围」仍统一生效（先查总体、再查本条）</p>' +
                '<div class="perm-label">可见范围</div>' +
                '<div class="perm-vis">' + relPills + '</div>' +
                '<div id="ep-allow-row" style="display:' + (cur.visibility === 'PARTIAL' ? 'block' : 'none') + '">' +
                '<div class="perm-label">指定可见（仅选中的好友能看本条）</div>' + allowHtml +
                '</div>' +
                '<div class="perm-row">' +
                '<div class="perm-label">不给谁看（这些好友看不到本条，优先级最高）</div>' + denyHtml +
                '</div>' +
                '<div class="modal-actions">' +
                '<button type="button" class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button type="button" class="primary" id="ep-save">保存</button>' +
                '</div>';
            const overlay = App.modal('<h3>修改可见范围</h3>' + body, null, 'wide');
            overlay.querySelectorAll('.vis-pill').forEach(function (p) {
                p.onclick = function () {
                    cur.visibility = p.getAttribute('data-vis');
                    overlay.querySelectorAll('.vis-pill').forEach(function (x) { x.classList.toggle('active', x === p); });
                    const allowRow = overlay.querySelector('#ep-allow-row');
                    if (allowRow) allowRow.style.display = (cur.visibility === 'PARTIAL') ? 'block' : 'none';
                };
            });
            overlay.querySelector('#ep-save').onclick = function () {
                const vis = cur.visibility;
                const allowList = readChecked('ep-allow');
                const denyList = readChecked('ep-deny');
                Api.momentUpdatePermission(m.id, vis, allowList, denyList).then(function (d) {
                    if (d && d.code === 0) {
                        m.visibility = vis;
                        m.allowList = allowList;
                        m.denyList = denyList;
                        overlay.remove();
                        renderFeed();
                        App.notify('已更新可见范围');
                    } else {
                        App.notify((d && d.message) || '保存失败');
                    }
                }).catch(function () { App.notify('保存失败'); });
            };
        });
    }

    /** 重新发布（修改被打回/待审核的动态）：作者本人，编辑内容/图片/可见范围后提交。
     *  人工审核模式下重新发布会再次进入「待审核」队列；自动审核模式直接发布。 */
    function openRepublish(id) {
        const m = feed.find(function (x) { return x.id === id; });
        if (!m) return;
        const cur = {
            content: m.content || '',
            visibility: m.visibility || 'FRIENDS',
            allowList: (m.allowList || []).slice(),
            denyList: (m.denyList || []).slice()
        };
        republishImages = (m.images || []).slice();
        const willRecheck = (m.status === 'REJECTED' || m.status === 'PENDING');
        ensureFriends(function (friends) {
            const relPills = Object.keys(REL).map(function (k) {
                return '<button type="button" class="vis-pill' + (cur.visibility === k ? ' active' : '') +
                    '" data-vis="' + k + '">' + REL[k].icon + ' ' + REL[k].label + '</button>';
            }).join('');
            const allowHtml = friendChecks('rp-allow', cur.allowList, friends);
            const denyHtml = friendChecks('rp-deny', cur.denyList, friends);
            const imgPreviews = republishImages.map(function (u, i) {
                return '<div class="mc-thumb"><img src="' + App.escapeHtml(u) + '" alt=""><span class="mc-thumb-del" onclick="Moment._rpRemoveImg(' + i + ')">×</span></div>';
            }).join('');
            const body = '' +
                '<p style="font-size:13px;color:var(--text-sub);margin-bottom:12px">修改内容后重新发布' +
                (willRecheck ? '，将再次送审（审核通过后才对所有人公开）' : '') + '</p>' +
                '<textarea id="rp-content" class="composer-text" placeholder="这一刻的想法…">' + App.escapeHtml(cur.content) + '</textarea>' +
                '<div class="composer-imgs" id="rp-imgs">' + imgPreviews + '</div>' +
                '<div class="composer-bar"><div class="composer-left">' +
                '<button type="button" class="composer-img-btn" onclick="document.getElementById(\'rp-img-input\').click()">🖼 图片</button>' +
                '<input type="file" id="rp-img-input" accept="image/*" multiple hidden onchange="Moment._rpPickImages(this)">' +
                '</div></div>' +
                '<div class="perm-label">可见范围</div>' +
                '<div class="perm-vis">' + relPills + '</div>' +
                '<div id="rp-allow-row" style="display:' + (cur.visibility === 'PARTIAL' ? 'block' : 'none') + '">' +
                '<div class="perm-label">指定可见（仅选中的好友能看本条）</div>' + allowHtml + '</div>' +
                '<div class="perm-row"><div class="perm-label">不给谁看（这些好友看不到本条，优先级最高）</div>' + denyHtml + '</div>' +
                '<div class="modal-actions">' +
                '<button type="button" class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button type="button" class="primary" id="rp-save">重新发布</button>' +
                '</div>';
            const overlay = App.modal('<h3>修改并重新发布</h3>' + body, null, 'wide');
            overlay.querySelectorAll('.vis-pill').forEach(function (p) {
                p.onclick = function () {
                    cur.visibility = p.getAttribute('data-vis');
                    overlay.querySelectorAll('.vis-pill').forEach(function (x) { x.classList.toggle('active', x === p); });
                    const allowRow = overlay.querySelector('#rp-allow-row');
                    if (allowRow) allowRow.style.display = (cur.visibility === 'PARTIAL') ? 'block' : 'none';
                };
            });
            overlay.querySelector('#rp-save').onclick = function () {
                const ta = overlay.querySelector('#rp-content');
                const content = ta ? ta.value.trim() : '';
                if (!content && (!republishImages || !republishImages.length)) { App.notify('说点什么或发张图吧'); return; }
                const btn = overlay.querySelector('#rp-save');
                btn.disabled = true; btn.textContent = '发布中…';
                Api.momentRepublish(m.id, content, republishImages, cur.visibility, readChecked('rp-allow'), readChecked('rp-deny')).then(function (d) {
                    if (d && d.code === 0) {
                        overlay.remove();
                        App.notify('已重新发布' + (d.data && d.data.status === 'PENDING' ? '，等待审核' : ''));
                        const idx = feed.findIndex(function (x) { return x.id === m.id; });
                        if (idx >= 0) feed[idx] = Object.assign(feed[idx], d.data);
                        renderFeed();
                    } else {
                        App.notify((d && d.message) || '发布失败');
                        if (btn) { btn.disabled = false; btn.textContent = '重新发布'; }
                    }
                }).catch(function () {
                    App.notify('发布失败');
                    if (btn) { btn.disabled = false; btn.textContent = '重新发布'; }
                });
            };
        });
    }

    function _rpPickImages(input) {
        const files = input.files;
        if (!files || !files.length) return;
        const tasks = [];
        for (let i = 0; i < files.length; i++) tasks.push(Api.upload(files[i], 'photo/moment'));
        App.notify('图片上传中…');
        Promise.all(tasks).then(function (res) {
            res.forEach(function (r) {
                if (r && r.code === 0 && r.data && r.data.url) republishImages.push(r.data.url);
            });
            _rpRenderImgs();
        }).catch(function () { App.notify('图片上传失败'); });
        input.value = '';
    }

    function _rpRemoveImg(idx) {
        republishImages.splice(idx, 1);
        _rpRenderImgs();
    }

    function _rpRenderImgs() {
        const box = document.getElementById('rp-imgs');
        if (!box) return;
        box.innerHTML = republishImages.map(function (u, i) {
            return '<div class="mc-thumb"><img src="' + App.escapeHtml(u) + '" alt=""><span class="mc-thumb-del" onclick="Moment._rpRemoveImg(' + i + ')">×</span></div>';
        }).join('');
    }

    /* ---------- 评论区 ---------- */
    function toggleComments(id) {
        const m = feed.find(function (x) { return x.id === id; });
        if (!m) return;
        const box = commentBox[id] || (commentBox[id] = { open: false, showInput: false, replyTo: null, loaded: false, list: [], text: '', images: [] });
        if (!box.open) {
            // 点击「评论」展开评论区，并显示输入框（输入框点击评论按钮才出现）
            box.open = true;
            box.showInput = true;
            box.replyTo = null;
            if (!box.loaded) loadComments(m, box); else renderFeed();
        } else {
            // 再次点击收起整个评论区（含输入框）
            box.open = false;
            box.showInput = false;
            box.replyTo = null;
            renderFeed();
        }
    }

    function loadComments(m, box) {
        Api.momentComments(m.id).then(function (d) {
            box.list = (d && d.code === 0 && Array.isArray(d.data)) ? d.data : [];
            box.loaded = true;
            renderFeed();
        }).catch(function () {
            box.list = [];
            box.loaded = true;
            renderFeed();
        });
    }

    function renderComments(m, box) {
        const listHtml = (box.list && box.list.length)
            ? box.list.map(function (c) { return renderComment(m, c); }).join('')
            : '<div class="mc-comment-empty">还没有评论，快来抢沙发～</div>';

        const imgPreviews = (box.images || []).map(function (url, i) {
            return '<div class="mc-thumb sm">' +
                '<img src="' + App.escapeHtml(url) + '" alt="">' +
                '<span class="mc-thumb-del" onclick="Moment.removeCommentImage(' + m.id + ',' + i + ')">×</span>' +
                '</div>';
        }).join('');

        const composerHtml = box.showInput ? (
            '<div class="mc-comment-composer">' +
            '<textarea id="mc-cmt-' + m.id + '" class="mc-comment-input" placeholder="' +
                (box.replyTo ? '回复 ' + App.escapeHtml(box.replyTo.name) + '：' : '写下你的评论…') +
                '" oninput="Moment.onCommentInput(' + m.id + ', this.value)">' + App.escapeHtml(box.text || '') + '</textarea>' +
            '<div class="mc-comment-imgs" id="mc-cmt-imgs-' + m.id + '">' + imgPreviews + '</div>' +
            '<div class="mc-comment-bar">' +
            (box.replyTo ? '<button type="button" class="composer-ghost sm" onclick="Moment.cancelReply(' + m.id + ')">取消回复</button>' : '') +
            '<button type="button" class="composer-img-btn" onclick="document.getElementById(\'mc-cmt-file-' + m.id + '\').click()">🖼 图片</button>' +
            '<input type="file" id="mc-cmt-file-' + m.id + '" accept="image/*" multiple hidden onchange="Moment.onPickCommentImages(' + m.id + ', this)">' +
            '<button type="button" class="composer-publish sm" onclick="Moment.submitComment(' + m.id + ')">发送</button>' +
            '</div>' +
            '</div>'
        ) : '';
        return '' +
            '<div class="mc-comments">' +
            '<div class="mc-comment-list">' + listHtml + '</div>' +
            composerHtml +
            '</div>';
    }

    function renderComment(m, c) {
        const a = c.author || {};
        const isCmtAuthor = (App.user && a.id === App.user.id);
        const isMomentAuthor = (App.user && m.author && m.author.id === App.user.id);
        const name = App.escapeHtml(App.friendName(a.id, a.nickname || a.username || '用户'));
        const canReply = App.user && a.id !== App.user.id;
        // 点击整条评论 = 回复该评论（不能回复自己）；名字点击查看资料需阻止冒泡
        const rowClick = canReply ? ('onclick="Moment.replyComment(' + m.id + ',' + c.id + ')"') : '';
        const nameClick = a.id ? ('onclick="event.stopPropagation();App.showProfile(' + a.id + ')" style="cursor:pointer"') : '';
        let imgs = '';
        if (c.images && c.images.length) {
            imgs = '<div class="mc-comment-imgs-view">' + c.images.map(function (u) {
                const su = String(u).replace(/'/g, "\\'");
                return '<img src="' + App.escapeHtml(u) + '" alt="" onclick="App.previewImage(\'' + su + '\')">';
            }).join('') + '</div>';
        }
        // 回复评论显示「谁回复了谁」：A 回复 B：内容（B 为被回复者昵称，可点击查看资料）
        const replyToName = c.replyToName ? App.escapeHtml(App.friendName(c.replyToId, c.replyToName)) : '';
        const replyToId = c.replyToId || null;
        const replyToClick = replyToId ? ('onclick="event.stopPropagation();App.showProfile(' + replyToId + ')" style="cursor:pointer"') : '';
        const replyHtml = replyToName
            ? '<span class="mc-comment-reply"> 回复 </span>' +
              '<span class="mc-comment-name mc-comment-target" ' + replyToClick + '>' + replyToName + '</span>'
            : '';
        const delBtn = (isCmtAuthor || isMomentAuthor)
            ? '<button type="button" class="mc-comment-del" onclick="event.stopPropagation();Moment.delComment(' + c.id + ')">删除</button>' : '';
        return '' +
            '<div class="mc-comment-item' + (canReply ? ' mc-comment-replyable' : '') + '" ' + rowClick + '>' +
            '<span class="mc-comment-name" ' + nameClick + '>' + name + '</span>' +
            replyHtml +
            (c.content ? '<span class="mc-comment-text">：' + App.escapeHtml(c.content) + '</span>' : '') +
            imgs +
            '<span class="mc-comment-time">' + formatTime(c.createTime) + '</span>' +
            delBtn +
            '</div>';
    }

    function onCommentInput(id, val) {
        const box = commentBox[id];
        if (box) box.text = val;
    }

    /** 点击某条评论进行回复（不能回复自己）。从已加载的评论列表解析被回复者信息。 */
    function replyComment(momentId, commentId) {
        const box = commentBox[momentId];
        const c = box && box.list && box.list.find(function (x) { return x.id === commentId; });
        if (!c) return;
        const a = c.author || {};
        const authorId = a.id;
        const authorName = a.nickname || a.username || '用户';
        if (App.user && authorId === App.user.id) {
            App.notify('不能回复自己');
            return;
        }
        const m = feed.find(function (x) { return x.id === momentId; });
        box.open = true;
        box.showInput = true;
        box.replyTo = { id: commentId, name: authorName };
        if (!box.loaded && m) loadComments(m, box); else renderFeed();
        setTimeout(function () {
            const ta = document.getElementById('mc-cmt-' + momentId);
            if (ta) { ta.focus(); ta.scrollIntoView({ block: 'nearest' }); }
        }, 0);
    }

    /** 取消当前回复态（回到普通评论） */
    function cancelReply(id) {
        const box = commentBox[id];
        if (box) { box.replyTo = null; renderFeed(); }
    }

    function onPickCommentImages(id, input) {
        const box = commentBox[id];
        if (!box) return;
        const files = input.files;
        if (!files || !files.length) return;
        const tasks = [];
        for (let i = 0; i < files.length; i++) tasks.push(Api.upload(files[i], 'photo/comment'));
        App.notify('图片上传中…');
        Promise.all(tasks).then(function (res) {
            res.forEach(function (r) {
                if (r && r.code === 0 && r.data && r.data.url) box.images.push(r.data.url);
            });
            renderFeed();
        }).catch(function () {
            App.notify('图片上传失败');
            renderFeed();
        });
        input.value = '';
    }

    function removeCommentImage(id, idx) {
        const box = commentBox[id];
        if (box) box.images.splice(idx, 1);
        renderFeed();
    }

    function submitComment(id) {
        const m = feed.find(function (x) { return x.id === id; });
        if (!m) return;
        const box = commentBox[id];
        const content = (box.text || '').trim();
        const images = box.images || [];
        if (!content && !images.length) {
            App.notify('写点评论或发张图吧');
            return;
        }
        const parentId = box.replyTo ? box.replyTo.id : null;
        Api.momentComment(id, content, images, parentId).then(function (d) {
            if (d && d.code === 0) {
                box.text = '';
                box.images = [];
                box.replyTo = null; // 回复后回到普通评论态，输入框保留可继续评论
                if (d.data) { box.list = box.list || []; box.list.push(d.data); }
                renderFeed();
                App.notify('评论成功');
            } else {
                App.notify((d && d.message) || '评论失败');
            }
        }).catch(function () {
            App.notify('评论失败');
        });
    }

    async function delComment(commentId) {
        if (!await App.confirm('确定删除这条评论？', { danger: true })) return;
        Api.momentCommentDelete(commentId).then(function (d) {
            if (d && d.code === 0) {
                for (const id in commentBox) {
                    const box = commentBox[id];
                    if (box.list) box.list = box.list.filter(function (c) { return c.id !== commentId; });
                }
                renderFeed();
                App.notify('已删除');
            } else {
                App.notify((d && d.message) || '删除失败');
            }
        });
    }

    /** 收到评论不再弹窗提示：评论会生成 category=COMMENT 的持久化通知，
     *  前端在「多多的家园」标签上标红（见 App.refreshNoticeBadge），用户打开标签即见最新内容。 */

    async function del(id) {
        if (!await App.confirm('确定删除这条动态？', { danger: true })) return;
        Api.momentDelete(id).then(function (d) {
            if (d && d.code === 0) {
                feed = feed.filter(function (x) { return x.id !== id; });
                delete commentBox[id];
                renderFeed();
                App.notify('已删除');
            } else {
                App.notify((d && d.message) || '删除失败');
            }
        });
    }

    /** AI 审核未通过后，申请人工复审 */
    async function applyManualReview(id) {
        if (!await App.confirm('确定申请人工复审？管理员将尽快复核这条动态。', { danger: false })) return;
        Api.momentApplyManualReview(id).then(function (d) {
            if (d && d.code === 0) {
                App.notify('已申请人工复审，请等待管理员复核');
                renderFeed();
            } else {
                App.notify((d && d.message) || '申请失败');
            }
        }).catch(function () { App.notify('网络错误，请重试'); });
    }

    /** 让 moyo 助手帮写文案：调用后端 AI 生成，填入发布框 */
    async function assistantCopy() {
        const ta = document.getElementById('moment-content');
        const topic = ta ? ta.value.trim() : '';
        App.notify('moyo助手正在为你构思文案…');
        Api.aiAssistantCopy(topic).then(function (d) {
            if (d && d.code === 0 && d.data) {
                if (ta) {
                    ta.value = d.data.trim();
                    drafts.content = d.data.trim();
                }
                App.notify('moyo助手已生成文案，可直接修改发表');
            } else {
                App.notify((d && d.message) || '生成失败');
            }
        }).catch(function () { App.notify('生成失败，请重试'); });
    }

    /** 点赞 / 取消点赞（切换）：调用接口后就地更新按钮与本地数据，避免整列表重渲染导致评论区折叠 */
    function toggleLike(id) {
        id = Number(id);
        Api.momentLike(id).then(function (d) {
            if (d && d.code === 0 && d.data) {
                const liked = !!(d.data.liked);
                const likeCount = d.data.likeCount || 0;
                // 更新数据模型（feed 同时承接广场与「我的」视图）
                for (let i = 0; i < feed.length; i++) {
                    if (feed[i].id === id) { feed[i].liked = liked; feed[i].likeCount = likeCount; }
                }
                // 就地更新按钮，保持评论展开状态
                const btn = document.querySelector('#moment-' + id + ' .mc-like-btn');
                if (btn) {
                    btn.classList.toggle('liked', liked);
                    btn.innerHTML = (liked ? '❤️' : '🤍') + ' ' + (likeCount ? likeCount : '赞');
                }
            } else {
                App.notify((d && d.message) || '操作失败');
            }
        }).catch(function () { App.notify('网络错误，请重试'); });
    }

    return {
        render: render,
        openMomentById: openMomentById,
        viewUserMoments: viewUserMoments,
        exitFriendView: exitFriendView,
        clearSidebar: clearSidebar,
        openComposer: openComposer,
        saveDraft: saveDraft,
        publish: publish,
        onPickImages: onPickImages,
        removeImage: removeImage,
        del: del,
        applyManualReview: applyManualReview,
        assistantCopy: assistantCopy,
        openSetting: openSetting,
        openComposerPerm: openComposerPerm,
        openEditPerm: openEditPerm,
        openRepublish: openRepublish,
        _rpPickImages: _rpPickImages,
        _rpRemoveImg: _rpRemoveImg,
        switchView: switchView,
        onAiReviewDone: onAiReviewDone,
        onManualReviewUpdate: onManualReviewUpdate,
        toggleComments: toggleComments,
        replyComment: replyComment,
        cancelReply: cancelReply,
        onCommentInput: onCommentInput,
        onPickCommentImages: onPickCommentImages,
        removeCommentImage: removeCommentImage,
        submitComment: submitComment,
        delComment: delComment,
        toggleLike: toggleLike
    };
})();
