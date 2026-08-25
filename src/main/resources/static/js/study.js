/* 学习空间：AI 对话（流式）+ 我的计划 + 番茄钟。
 * 作为「程序空间」的子模块，由 Study.open() 在 #program 容器内渲染（带返回按钮）。
 * AI 工具统一为「对话式」界面，走 /api/ai/stream（SSE 流式输出）。计划走 /api/study/*。 */
window.Study = (function () {

    var state = {
        sub: 'ai',                 // ai | plans | pomodoro
        plans: [],
        studyStats: {},           // 学习统计总览（今日/累计）
        expanded: {},             // planId -> 是否已展开正文
        pomodoro: {
            defaultMin: 25,
            total: 25 * 60,
            remaining: 25 * 60,
            running: false,
            timer: null
        },
        // 对话式 AI 状态
        aiMode: 'chat',           // chat | plan | quiz | summarize —— 同时作为「子线 thread」标识
        // 四类独立记录线：每个 thread 一份自己的消息流与记忆，互不混合。
        // 每条线结构：{ role:'user'|'ai', content, mode, title, id, streaming, plan, fullRaw }
        threads: { chat: [], plan: [], quiz: [], summarize: [] },
        sessionId: null,          // 当前选中的 AI 会话 id（null=尚未选择/旧数据）
        sessionTitle: '',         // 当前会话标题
        sessions: [],             // AI 会话列表 [{id,title,count}]
        // 异步流管理：sessionId(数字或 'none') -> { abort, mode, aiMsg, req }
        // 支持「AI 生成中切走/切其它会话」不中断，回来仍可见「生成中」并持续接收
        activeStreams: {}
    };

    var AI_MODES = [
        { key: 'chat', icon: '💬', name: 'AI 对话', hint: '自由提问，答疑解惑' },
        { key: 'plan', icon: '📝', name: '制定计划', hint: '拆解目标为每日任务' },
        { key: 'quiz', icon: '❓', name: '知识点互问', hint: '按薄弱点智能出题' },
        { key: 'summarize', icon: '📄', name: '资料摘要', hint: '提炼要点并归类' }
    ];

    function val(id) {
        var el = document.getElementById(id);
        return el ? el.value.trim() : '';
    }

    /** 当前子线（thread）的消息数组：四类独立记录线，切换 aiMode 即切换线 */
    function curThread() {
        return state.threads[state.aiMode] || (state.threads[state.aiMode] = []);
    }

    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec));
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    }

    /** 进入学习空间：在程序空间容器内渲染本页（带返回程序空间网格的按钮） */
    function open() {
        // 进入学习空间时，关闭好友聊天窗口（左侧好友会话框不再显示，AI 有独立会话框）
        if (window.App && App.current) {
            App.current = null;
            var ch = document.getElementById('chat-header');
            var cm = document.getElementById('chat-messages');
            var ci = document.getElementById('chat-input');
            if (ch) ch.innerHTML = '选择一个会话开始聊天';
            if (cm) cm.innerHTML = '';
            if (ci) ci.style.display = 'none';
        }
        // 恢复 AI 会话列表与当前会话历史
        loadSessions();
        var root = document.getElementById('program');
        if (!root) return;
        root.innerHTML =
            '<div class="study-shell">' +
                '<div class="study-topbar">' +
                    '<button class="study-back" onclick="Program.render()">‹ 程序空间</button>' +
                    '<div class="study-topbar-title">学习空间</div>' +
                '</div>' +
                '<div class="study-subnav">' +
                    '<button class="study-sub' + (state.sub === 'ai' ? ' active' : '') + '" data-sub="ai">🤖 智能工具</button>' +
                    '<button class="study-sub' + (state.sub === 'plans' ? ' active' : '') + '" data-sub="plans">📚 我的计划</button>' +
                    '<button class="study-sub' + (state.sub === 'pomodoro' ? ' active' : '') + '" data-sub="pomodoro">⏱ 番茄钟</button>' +
                '</div>' +
                '<div class="study-body" id="study-body"></div>' +
            '</div>';
        root.querySelectorAll('.study-sub').forEach(function (b) {
            b.onclick = function () {
                state.sub = b.getAttribute('data-sub');
                root.querySelectorAll('.study-sub').forEach(function (x) {
                    x.classList.toggle('active', x.getAttribute('data-sub') === state.sub);
                });
                renderSub();
            };
        });
        renderSub();
    }

    function renderSub() {
        var body = document.getElementById('study-body');
        if (!body) return;
        if (state.sub === 'ai') renderAi(body);
        else if (state.sub === 'plans') renderPlans(body);
        else if (state.sub === 'pomodoro') renderPomodoro(body);
    }

    /* ---------- AI 对话式工具（流式 SSE） ---------- */

    /** 根据当前 mode 返回输入框占位符与额外表单 */
    function aiModeMeta() {
        switch (state.aiMode) {
            case 'plan': return { ph: '描述你的学习目标，如：30 天搞定考研英语（每天 2 小时，目前四级水平）', extra: '' };
            case 'quiz': return { ph: '学科与薄弱点，如：高数 · 定积分与级数', extra: '' };
            case 'summarize': return { ph: '粘贴笔记 / 错题内容，让 AI 提炼要点…', extra: '' };
            case 'chat':
            default: return { ph: '例如：怎么高效记忆英语单词？', extra: '' };
        }
    }

    function renderAi(body) {
        var isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
        var tabs;
        // 手机端「会话选择」下拉框（仅移动端渲染，替代占空间的横向会话列表）
        var sessSelect = '';
        if (isMobile) {
            var sopts = '<option value="__new__">＋ 新建会话</option>' +
                state.sessions.map(function (s) {
                    return '<option value="' + s.id + '"' + (state.sessionId === s.id ? ' selected' : '') + '>' +
                        App.escapeHtml(s.title) + '</option>';
                }).join('');
            sessSelect = '<select class="ai-sess-select" id="ai-sess-select" aria-label="AI 会话">' + sopts + '</select>';
        }
        if (isMobile) {
            // 手机端：用下拉框代替横向按钮组，只占一行，给对话腾出空间
            var opts = AI_MODES.map(function (m) {
                return '<option value="' + m.key + '"' + (m.key === state.aiMode ? ' selected' : '') + '>' +
                    m.icon + ' ' + m.name + '</option>';
            }).join('');
            tabs = '<select class="ai-mode-select" id="ai-mode-select" aria-label="AI 模式">' + opts + '</select>' +
                sessSelect +
                '<button class="ai-sess-new-mini" id="ai-sess-new" title="新建会话">＋</button>';
        } else {
            tabs = AI_MODES.map(function (m) {
                return '<button class="ai-mode' + (m.key === state.aiMode ? ' active' : '') + '" data-mode="' + m.key + '">' +
                    '<span class="am-icon">' + m.icon + '</span>' +
                    '<span class="am-name">' + m.name + '</span>' +
                    '<span class="am-hint">' + m.hint + '</span>' +
                '</button>';
            }).join('');
        }

        // 左侧 AI 会话列表（仅桌面端渲染）
        var sessHtml = state.sessions.map(function (s) {
            var active = (state.sessionId === s.id) ? ' active' : '';
            return '<div class="ai-sess' + active + '" data-sid="' + s.id + '">' +
                '<div class="ai-sess-main">' +
                    '<div class="ai-sess-title">' + App.escapeHtml(s.title) + '</div>' +
                    '<div class="ai-sess-count">' + (s.count || 0) + ' 条消息</div>' +
                '</div>' +
                '<button class="ai-sess-del" data-del="' + s.id + '" title="删除会话">🗑</button>' +
            '</div>';
        }).join('');

        body.innerHTML =
            '<div class="ai-layout">' +
                (isMobile ? '' :
                '<div class="ai-sessions">' +
                    '<div class="ai-sessions-head">' +
                        '<span>AI 会话</span>' +
                        '<button class="ai-sess-new" id="ai-sess-new-desktop" title="新建会话">＋</button>' +
                    '</div>' +
                    '<div class="ai-sessions-list" id="ai-sessions-list">' +
                        (sessHtml || '<div class="ai-sess-empty">还没有会话，点 ＋ 新建</div>') +
                    '</div>' +
                '</div>') +
                '<div class="ai-chat">' +
                    '<div class="ai-modes">' + tabs + '</div>' +
                    '<div class="ai-msgs-head">' +
                        '<span class="amh-label">' + (state.sessionTitle ? App.escapeHtml(state.sessionTitle) : '对话记录') + '</span>' +
                        '<button class="ai-clear" id="ai-clear"' + (curThread().length ? '' : ' style="display:none"') + '>清空对话</button>' +
                    '</div>' +
                    '<div class="ai-msgs" id="ai-msgs"></div>' +
                    '<div class="ai-inputbar">' +
                        '<textarea id="ai-input" class="ai-input" rows="1" placeholder="' + aiModeMeta().ph + '"></textarea>' +
                        '<button class="ai-send" id="ai-send">发送</button>' +
                    '</div>' +
                    '<div class="ai-foot">AI 生成内容仅供参考，学习规划请结合自身情况调整</div>' +
                '</div>' +
            '</div>';

        // 新建会话（手机端小按钮 + 桌面端侧栏按钮）
        var newBtn = body.querySelector('#ai-sess-new');
        if (newBtn) newBtn.onclick = createAiSession;
        var newBtnD = body.querySelector('#ai-sess-new-desktop');
        if (newBtnD) newBtnD.onclick = createAiSession;

        // 手机端：会话下拉框切换（selected=__new__ 表示新建）
        var sessSel = body.querySelector('#ai-sess-select');
        if (sessSel) {
            sessSel.onchange = function () {
                var v = sessSel.value;
                if (v === '__new__') {
                    createAiSession();
                    // 还原下拉框到当前会话，等待新建完成后由 renderAi 重绘
                    if (state.sessionId != null) sessSel.value = String(state.sessionId);
                } else {
                    switchAiSession(Number(v));
                }
            };
        }

        // 切换会话（桌面端侧栏）
        body.querySelectorAll('.ai-sess').forEach(function (el) {
            var sid = Number(el.getAttribute('data-sid'));
            el.onclick = function (e) {
                if (e.target.getAttribute('data-del')) return; // 删除按钮单独处理
                switchAiSession(sid);
            };
        });
        // 删除会话（桌面端侧栏）
        body.querySelectorAll('[data-del]').forEach(function (b) {
            b.onclick = function (e) {
                e.stopPropagation();
                var sid = Number(b.getAttribute('data-del'));
                deleteAiSession(sid);
            };
        });

        // 清空对话
        var clearBtn = body.querySelector('#ai-clear');
        if (clearBtn) clearBtn.onclick = clearAiHistory;

        // 模式切换（同时切换「子线 thread」：每个类型各自独立的聊天记录与记忆）
        function applyMode(mode) {
            state.aiMode = mode;
            body.querySelectorAll('.ai-mode').forEach(function (x) {
                x.classList.toggle('active', x.getAttribute('data-mode') === state.aiMode);
            });
            var sel = body.querySelector('#ai-mode-select');
            if (sel && sel.value !== mode) sel.value = mode;
            var input = body.querySelector('#ai-input');
            if (input) input.placeholder = aiModeMeta().ph;
            // 切换子线：清空输入框残留的停止态，重绘当前线的消息（互不打扰）
            renderMessages(body);
        }
        body.querySelectorAll('.ai-mode').forEach(function (b) {
            b.onclick = function () { applyMode(b.getAttribute('data-mode')); };
        });
        var modeSel = body.querySelector('#ai-mode-select');
        if (modeSel) {
            modeSel.onchange = function () { applyMode(modeSel.value); };
        }

        var sendBtn = body.querySelector('#ai-send');
        var input = body.querySelector('#ai-input');
        sendBtn.onclick = sendAiMessage;
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendAiMessage();
            }
        });
        // 输入框自适应高度
        input.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 140) + 'px';
        });

        renderMessages(body);
    }

    /** 加载 AI 会话列表；若当前无选中会话则自动选中第一个 */
    function loadSessions() {
        if (!window.Api || !Api.studySessions) return;
        Api.studySessions().then(function (d) {
            if (d && d.code === 0 && Array.isArray(d.data)) {
                state.sessions = d.data;
                if (state.sessionId == null && state.sessions.length) {
                    state.sessionId = state.sessions[0].id;
                    state.sessionTitle = state.sessions[0].title;
                } else if (state.sessionId != null) {
                    var hit = state.sessions.find(function (s) { return s.id === state.sessionId; });
                    if (hit) state.sessionTitle = hit.title;
                }
            }
            var body = document.getElementById('study-body');
            if (body) renderAi(body);
            if (state.sessionId != null) loadAiHistory();
        });
    }

    /** 新建 AI 会话：弹窗填标题，创建后切换 */
    function createAiSession() {
        var html = '<div class="modal">' +
            '<h3>新建 AI 会话</h3>' +
            '<div class="pf-field"><label>会话标题</label>' +
            '<input id="cs-title" class="modal-input" placeholder="例如：考研英语规划、高数答疑" maxlength="128"></div>' +
            '<div class="modal-actions">' +
            '<button class="modal-btn cancel" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
            '<button class="modal-btn ok" id="cs-ok">创建</button>' +
            '</div></div>';
        var overlay = App.modal(html, null, 'narrow');
        if (!overlay) return;
        var input = overlay.querySelector('#cs-title');
        var ok = overlay.querySelector('#cs-ok');
        if (input) setTimeout(function () { input.focus(); }, 30);
        var submit = function () {
            var title = input ? input.value.trim() : '';
            ok.disabled = true;
            Api.studyCreateSession(title || '新会话').then(function (d) {
                overlay.remove();
                if (d && d.code === 0 && d.data) {
                    var s = d.data;
                    state.sessions.unshift({ id: s.id, title: s.title, count: 0 });
                    state.sessionId = s.id;
                    state.sessionTitle = s.title;
                    resetThreads();
                    var body = document.getElementById('study-body');
                    if (body) renderAi(body);
                    App.notify('已创建会话');
                } else {
                    ok.disabled = false;
                    App.notify((d && d.message) || '创建失败');
                }
            }).catch(function () { ok.disabled = false; });
        };
        if (ok) ok.onclick = submit;
        if (input) input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    }

    /** 切换会话：加载该会话历史（不中断其它会话正在进行的 AI 生成，实现异步） */
    function switchAiSession(sid) {
        state.sessionId = sid;
        var hit = state.sessions.find(function (s) { return s.id === sid; });
        state.sessionTitle = hit ? hit.title : '';
        resetThreads();
        var body = document.getElementById('study-body');
        if (body) renderAi(body);
        loadAiHistory();
    }

    /** 删除会话：连同旗下消息，删除后重置选中 */
    function deleteAiSession(sid) {
        App.confirm('确定删除该 AI 会话？会话内的全部对话将一并删除。', { danger: true, okText: '删除' }).then(function (ok) {
            if (!ok) return;
            Api.studyDeleteSession(sid).then(function (d) {
                if (d && d.code === 0) {
                    state.sessions = state.sessions.filter(function (s) { return s.id !== sid; });
                    if (state.sessionId === sid) {
                        state.sessionId = state.sessions.length ? state.sessions[0].id : null;
                        state.sessionTitle = state.sessionId ? state.sessions[0].title : '';
                        resetThreads();
                    }
                    var body = document.getElementById('study-body');
                    if (body) renderAi(body);
                    if (state.sessionId != null) loadAiHistory();
                    App.notify('已删除会话');
                } else {
                    App.notify((d && d.message) || '删除失败');
                }
            });
        });
    }

    function renderMessages(body) {
        var box = body.querySelector('#ai-msgs');
        if (!box) return;
        var msgs = curThread();
        if (msgs.length === 0) {
            box.innerHTML = '<div class="ai-empty">' +
                '<div class="ae-emoji">🎓</div>' +
                '<div class="ae-title">让 AI 做你的学习搭子</div>' +
                '<div class="ae-sub">选择上方功能，在输入框写下目标或问题，AI 会逐字「思考」并实时显示。</div>' +
            '</div>';
            return;
        }
        box.innerHTML = msgs.map(function (m, i) {
            return renderBubble(m, i);
        }).join('');
        bindBubbleActions(body);
        box.scrollTop = box.scrollHeight;
    }

    /** 渲染单条消息气泡：user=纯文本；ai=根据模式/是否已解析为计划渲染不同形态 */
    function renderBubble(m, i) {
        if (m.role === 'user') {
            return '<div class="ai-row user"><div class="ai-bubble user">' + App.escapeHtml(m.content) + '</div></div>';
        }
        // AI 气泡
        if (m.streaming) {
            if (m.mode === 'plan') {
                // plan 模式流式期间不暴露原始 JSON：显示「生成中」占位，done 后才渲染卡片（对用户的透明）
                return '<div class="ai-row ai"><div class="ai-avatar">🤖</div>' +
                    '<div class="ai-bubble ai" data-i="' + i + '">' +
                        '<div class="ai-plan-loading"><span class="ai-cursor">▍</span> AI 正在为你制定计划…</div>' +
                    '</div></div>';
            }
            // 其他模式：展示实时累计文本（逐字打字机体感快）
            return '<div class="ai-row ai"><div class="ai-avatar">🤖</div>' +
                '<div class="ai-bubble ai" data-i="' + i + '">' +
                    '<span class="ai-stream">' + App.escapeHtml(m.content) + '</span><span class="ai-cursor">▍</span>' +
                '</div></div>';
        }
        // 已完成：plan 模式且能解析成结构化计划 -> 渲染为「计划卡片预览」（对用户透明，不暴露 JSON）
        // 兜底：plan 模式但 m.plan 缺失（如从历史回放恢复、content 是 JSON 文本）时，就地解析一次。
        if (m.mode === 'plan') {
            var planObj = m.plan;
            if (!planObj) planObj = extractPlanJson(m.content);
            if (planObj) {
                return '<div class="ai-row ai"><div class="ai-avatar">🤖</div>' +
                    '<div class="ai-bubble ai plan-card-preview" data-i="' + i + '">' +
                        planPreviewHtml(planObj) +
                    '</div></div>';
            }
        }
        // 其他：纯文本结果
        return '<div class="ai-row ai"><div class="ai-avatar">🤖</div>' +
            '<div class="ai-bubble ai" data-i="' + i + '">' +
                '<pre class="ai-result">' + App.escapeHtml(m.content) + '</pre>' +
            '</div></div>';
    }

    /** 计划卡片预览 HTML（与「我的计划」风格一致；此处只读，保存后才进入持久化管理） */
    function planPreviewHtml(plan) {
        var steps = Array.isArray(plan.steps) ? plan.steps : [];
        var doneCount = steps.filter(function (s) { return s.done; }).length;
        var pct = steps.length ? Math.round(doneCount / steps.length * 100) : 0;
        var note = plan.note || '';
        var listHtml = steps.map(function (s, i) {
            var text = s.text || '';
            var done = !!s.done;
            return '<li class="sp-step' + (done ? ' done' : '') + '" data-i="' + i + '">' +
                '<span class="sp-box' + (done ? ' checked' : '') + '"></span>' +
                '<div class="sp-step-text">' + App.escapeHtml(text) + '</div>' +
            '</li>';
        }).join('');
        return '<div class="sp-preview-title">' + App.escapeHtml(plan.title || 'AI 学习计划') + '</div>' +
            '<div class="sp-progress"><div class="sp-bar" style="width:' + pct + '%"></div>' +
                '<span class="sp-pct">' + doneCount + '/' + steps.length + ' 步</span></div>' +
            '<ul class="sp-steps preview">' + listHtml + '</ul>' +
            (note ? '<div class="sp-note"><span class="sp-note-label">备注</span>' +
                '<div class="sp-note-text">' + App.escapeHtml(note) + '</div></div>' : '');
        // 注意：操作按钮由 bindBubbleActions 统一渲染并绑定事件，
        // 此处不内联按钮，避免「静态按钮无事件」导致保存无反应。
    }

    /** 为已完成（非流式）的 AI 气泡绑定操作：计划卡片 -> 保存/复制；文本 -> 复制/保存 */
    function bindBubbleActions(body) {
        body.querySelectorAll('.ai-bubble.ai').forEach(function (b) {
            var i = Number(b.getAttribute('data-i'));
            var m = curThread()[i];
            if (!m || m.streaming) return;
            // 已绑定则跳过（避免重复叠加按钮）。用 data-bound 标记，而非 .ai-bubble-actions 是否存在——
            // 否则 plan 卡片（由本函数统一创建按钮）会因自带 .ai-bubble-actions 而被误杀，导致保存按钮无事件。
            if (b.getAttribute('data-bound')) return;
            var bar = document.createElement('div');
            bar.className = 'ai-bubble-actions';
            if (m.mode === 'plan' && m.plan) {
                // 计划卡片：直接保存结构化计划；复制原始文本兜底
                var sv = document.createElement('button');
                sv.className = 'op ok'; sv.textContent = '保存到我的计划';
                sv.onclick = function () { savePlanFromBubble(m); };
                var cp = document.createElement('button');
                cp.className = 'op'; cp.textContent = '复制';
                cp.onclick = function () { copyText(m.content); };
                bar.appendChild(sv); bar.appendChild(cp);
            } else {
                var copy = document.createElement('button');
                copy.className = 'op'; copy.textContent = '复制';
                copy.onclick = function () { copyText(m.content); };
                var sv2 = document.createElement('button');
                sv2.className = 'op ok'; sv2.textContent = '保存到我的计划';
                sv2.onclick = function () { saveResult(m.content, m.title || 'AI 生成内容'); };
                bar.appendChild(copy); bar.appendChild(sv2);
            }
            b.appendChild(bar);
            b.setAttribute('data-bound', '1');
        });
    }

    /** 计划已解析为结构化对象时，直接以规范 JSON 保存（不暴露原始 JSON 给用户） */
    function savePlanFromBubble(m) {
        var plan = m.plan;
        if (!plan) { saveResult(m.content, m.title || 'AI 生成内容'); return; }
        var normSteps = (Array.isArray(plan.steps) ? plan.steps : [])
            .filter(function (s) { return s && (s.text || '').trim(); })
            .map(function (s) { return { text: s.text.trim(), done: false }; });
        var norm = {
            title: (plan.title || m.title || 'AI 生成计划').trim(),
            steps: normSteps,
            note: plan.note || ''
        };
        var finalTitle = norm.title;
        var finalContent = JSON.stringify(norm);
        var html = '<h3>保存到我的计划</h3>' +
            '<input id="sp-title" class="modal-input" placeholder="计划标题" value="' + App.escapeHtml(finalTitle) + '">' +
            '<div class="modal-desc">检测到结构化计划（' + normSteps.length + ' 个步骤），将保存为可勾选的计划表。</div>' +
            '<div class="modal-actions">' +
                '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button class="primary" id="sp-save">保存</button>' +
            '</div>';
        var overlay = App.modal(html);
        overlay.querySelector('#sp-save').onclick = function () {
            var t = (document.getElementById('sp-title').value || '').trim() || finalTitle || '未命名计划';
            Api.studySavePlan(t, finalContent).then(function (d) {
                overlay.remove();
                if (d && d.code === 0) App.notify('已保存到我的计划');
                else App.notify((d && d.message) || '保存失败');
            });
        };
    }

    function sendAiMessage() {
        var body = document.getElementById('study-body');
        var input = body && body.querySelector('#ai-input');
        if (!input) return;
        var text = input.value.trim();
        if (!text) { App.notify('请输入内容'); return; }

        // 组装请求体（按 mode 传不同字段）
        var req = { mode: state.aiMode, prompt: text };
        var title = '';
        if (state.aiMode === 'plan') {
            // 从一句话里尽量拆出 目标/时长/基础；简单启发式：以括号或逗号分隔
            var parts = text.split(/[，,（）()]/).map(function (s) { return s.trim(); });
            req.goal = parts[0] || text;
            if (parts[1]) req.duration = parts[1];
            if (parts[2]) req.level = parts[2];
            title = '学习计划-' + parts[0].slice(0, 12);
        } else if (state.aiMode === 'quiz') {
            var sp = text.split(/[·•\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
            req.subject = sp[0] || text;
            req.weakPoints = sp.slice(1).join(' ') || '';
            req.count = 5;
            title = '互问自测-' + (sp[0] || '题目');
        } else if (state.aiMode === 'summarize') {
            req.prompt = text;
            title = '资料摘要';
        } else {
            title = 'AI对话-' + text.slice(0, 12);
        }

        // 先乐观显示用户消息 + 空 AI 占位（流式进行中）——写入当前子线 thread
        input.value = '';
        input.style.height = 'auto';
        curThread().push({ role: 'user', content: text });
        var aiMsg = { role: 'ai', content: '', fullRaw: '', streaming: true, mode: state.aiMode, title: title, id: null };
        curThread().push(aiMsg);
        renderMessages(body);

        var sendBtn = body.querySelector('#ai-send');
        var clearBtn = body.querySelector('#ai-clear');
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.textContent = '停止';
            sendBtn.classList.add('stopping');
            sendBtn.onclick = function () { stopCurrentStream(); };
        }
        if (clearBtn) clearBtn.style.display = 'none';

        // 该会话的会话键（用于 activeStreams 索引；null 会话统一用 'none'）
        var streamKey = (state.sessionId == null ? 'none' : String(state.sessionId));

        var box = body.querySelector('#ai-msgs');

        // 1) 若无会话，先自动建一个（标题取首句），再发送
        var doSend = function (sessionId) {
            // 落库：追加 user + 创建 ai 占位（按当前 thread 隔离），拿到 aiId
            Api.studyChatSend(sessionId, state.aiMode, state.aiMode, text).then(function (d) {
                if (!d || d.code !== 0) {
                    aiMsg.streaming = false;
                    aiMsg.content = '⚠️ ' + ((d && d.message) || '保存对话失败');
                    delete state.activeStreams[streamKey];
                    renderMessages(document.getElementById('study-body'));
                    return;
                }
                aiMsg.id = d.data.id;
                startStream();
            }).catch(function () {
                aiMsg.streaming = false;
                aiMsg.content = '⚠️ 网络异常，保存对话失败';
                delete state.activeStreams[streamKey];
                renderMessages(document.getElementById('study-body'));
            });
        };

        // 若当前无选中会话，先建一个（标题取输入首句），再发送
        if (state.sessionId == null) {
            Api.studyCreateSession(text.slice(0, 20)).then(function (sd) {
                if (sd && sd.code === 0 && sd.data) {
                    state.sessionId = sd.data.id;
                    state.sessionTitle = sd.data.title;
                    state.sessions.unshift({ id: sd.data.id, title: sd.data.title, count: 0 });
                    renderAi(document.getElementById('study-body'));
                    streamKey = String(state.sessionId);
                }
                doSend(state.sessionId || 0);
            }).catch(function () { doSend(0); });
        } else {
            doSend(state.sessionId);
        }

        function startStream() {
            // 对话记忆：仅 chat 子线把「本线」之前已完成的对话作为 history 传给后端（让 AI 记住本线上下文）
            // 注意：用 curThread() 而非全量，确保四个类型各自独立的记忆，互不串线。
            if (state.aiMode === 'chat' && curThread().length > 1) {
                var histMsgs = curThread().slice(0, curThread().length - 1);
                var history = histMsgs.filter(function (m) {
                    return m && m.content && !m.streaming;
                }).map(function (m) {
                    return { role: m.role === 'ai' ? 'assistant' : 'user', content: m.content };
                });
                if (history.length) req.history = history;
            }
            // 记录活跃流（按会话归属，支持异步：切走不中断）
            state.activeStreams[streamKey] = { abort: null, mode: state.aiMode, aiMsg: aiMsg, req: req, sessionId: state.sessionId };

            var streamPromise = Api.aiStream(req,
                function onToken(delta) {
                    aiMsg.content += delta;
                    aiMsg.fullRaw += delta;
                    // 实时落库：流式每收到一段就更新后端，刷新中途也能恢复半截
                    if (aiMsg.id != null) saveAiHistory(aiMsg.id, aiMsg.content);
                    // 仅当「当前视图正是该会话、且该子线」时才增量更新 DOM（切走/切其它线则只更新内存）
                    if (isActiveSessionView(streamKey) && state.aiMode === aiMsg.mode && box) {
                        var idx = curThread().indexOf(aiMsg);
                        if (state.aiMode !== 'plan') {
                            var streamEl = box.querySelector('.ai-bubble.ai[data-i="' + idx + '"] .ai-stream');
                            if (streamEl) {
                                streamEl.textContent = aiMsg.content;
                                box.scrollTop = box.scrollHeight;
                                var b = box.parentElement; if (b) b.scrollTop = b.scrollHeight;
                            }
                        }
                        // plan 模式流式期间显示「生成中」占位，不碰 DOM 文本（done 后渲染卡片）
                    }
                },
                function onDone(aborted) {
                    finishStream(aborted ? null : 'done');
                },
                function onError(msg) {
                    aiMsg.streaming = false;
                    if (!abortedFlag(aiMsg)) aiMsg.content = (aiMsg.content || '') + '\n\n⚠️ ' + msg;
                    if (aiMsg.id != null) saveAiHistory(aiMsg.id, aiMsg.content);
                    delete state.activeStreams[streamKey];
                    if (isActiveSessionView(streamKey) && state.aiMode === aiMsg.mode) renderMessages(document.getElementById('study-body'));
                }
            );
            state.activeStreams[streamKey].abort = streamPromise;

            function finishStream(kind) {
                aiMsg.streaming = false;
                // plan 模式：解析结构化计划，渲染为「计划卡片预览」（对用户透明，不暴露 JSON）
                if (kind === 'done' && state.aiMode === 'plan') {
                    var parsed = extractPlanJson(aiMsg.fullRaw || aiMsg.content);
                    if (parsed) aiMsg.plan = parsed;
                }
                if (aiMsg.id != null) saveAiHistory(aiMsg.id, aiMsg.content); // 最终落库
                delete state.activeStreams[streamKey];
                // 若当前视图正是该会话且该子线，重画（含停止按钮复位）；切走/切其它线则不打扰
                if (isActiveSessionView(streamKey) && state.aiMode === aiMsg.mode) {
                    renderMessages(document.getElementById('study-body'));
                    resetSendBtn();
                }
            }
        }
    }

    /** 当前 DOM 是否正在展示某个会话的 AI 对话（用于判断流式 token 要不要更新界面） */
    function isActiveSessionView(streamKey) {
        if (state.sub !== 'ai') return false;
        if (streamKey === 'none') return state.sessionId == null;
        return String(state.sessionId) === streamKey;
    }

    /** 停止「当前视图所在会话」正在进行的流（其它会话的流不受影响，保持异步） */
    function stopCurrentStream() {
        var key = (state.sessionId == null ? 'none' : String(state.sessionId));
        var st = state.activeStreams[key];
        if (st && st.abort) { try { st.abort.abort(); } catch (e) {} }
        delete state.activeStreams[key];
        resetSendBtn();
    }

    /** 复位发送按钮（恢复为「发送」态，仅在当前视图会话时操作 DOM） */
    function resetSendBtn() {
        var body = document.getElementById('study-body');
        if (!body) return;
        var sendBtn = body.querySelector('#ai-send');
        if (sendBtn) {
            sendBtn.textContent = '发送';
            sendBtn.classList.remove('stopping');
            sendBtn.disabled = false;
            sendBtn.onclick = sendAiMessage;
        }
        var clearBtn = body.querySelector('#ai-clear');
        if (clearBtn) clearBtn.style.display = curThread().length ? '' : 'none';
    }

    /** 判断某 aiMsg 是否已被用户主动停止（content 已被标记中断） */
    function abortedFlag(aiMsg) {
        return /⚠️ 已停止/.test(aiMsg.content || '');
    }

    /* ---------- 对话历史后端持久化 ---------- */
    /** 从后端拉取当前会话的 AI 对话历史（刷新/换设备可靠恢复），按子线 thread 分桶后渲染当前线。 */
    function loadAiHistory() {
        if (!window.Api || !Api.studyChatList) return;
        if (state.sessionId == null) { resetThreads(); return; }
        Api.studyChatList(state.sessionId).then(function (d) {
            if (d && d.code === 0 && Array.isArray(d.data)) {
                // 全量消息按 thread 分桶到 state.threads，四类各自独立记录与记忆
                resetThreads();
                d.data.forEach(function (m) {
                    var thread = (m.thread && state.threads[m.thread]) ? m.thread : (m.mode || 'chat');
                    if (!state.threads[thread]) thread = 'chat';
                    var msg = {
                        id: m.id,
                        role: m.role === 'ai' ? 'ai' : 'user',
                        content: m.content || '',
                        mode: m.mode || 'chat',
                        title: (m.role === 'ai' ? 'AI 回复' : '我'),
                        streaming: false
                    };
                    // 历史回放：plan 模式的 AI 回复后端只存了原始 JSON 文本，需重新解析出结构化 plan，
                    // 否则刷新/重开会话后卡片会退化成 <pre> 显示 JSON 源码。
                    if (msg.role === 'ai' && msg.mode === 'plan') {
                        var parsed = extractPlanJson(msg.content);
                        if (parsed) msg.plan = parsed;
                    }
                    state.threads[thread].push(msg);
                });
            } else {
                resetThreads();
            }
            var body = document.getElementById('study-body');
            if (body) renderMessages(body);
        }).catch(function () {
            resetThreads();
        });
    }

    /** 清空四条子线的内存消息（切换会话/加载历史前调用） */
    function resetThreads() {
        state.threads = { chat: [], plan: [], quiz: [], summarize: [] };
    }

    /** 流式过程中实时更新某条 AI 回复到后端（中途刷新也能恢复半截内容） */
    function saveAiHistory(id, content) {
        if (window.Api && Api.studyChatUpdate) Api.studyChatUpdate(id, content);
    }

    /** 清空对话：二次确认后清除当前子线的后端与内存（同时停止当前会话正在进行的流） */
    function clearAiHistory() {
        var thread = state.aiMode; // 只清当前子线（四类各自独立记录，互不影响）
        App.confirm('确定清空当前「' + aiModeMeta().name + '」的对话记录？此操作不可恢复（其它类型不受影响）。', { danger: true, okText: '清空' }).then(function (ok) {
            if (!ok) return;
            // 停止当前会话的活跃流（不中断其它会话）
            var key = (state.sessionId == null ? 'none' : String(state.sessionId));
            var st = state.activeStreams[key];
            if (st && st.abort) { try { st.abort.abort(); } catch (e) {} }
            delete state.activeStreams[key];
            if (window.Api && Api.studyChatClear) {
                Api.studyChatClear(state.sessionId || 0, thread).then(function (d) {
                    if (d && d.code === 0) App.notify('已清空「' + aiModeMeta().name + '」记录');
                    else App.notify((d && d.message) || '清空失败');
                });
            }
            state.threads[thread] = [];
            var body = document.getElementById('study-body');
            if (body) renderAi(body);
        });
    }

    function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { App.notify('已复制'); }, function () { App.notify('复制失败'); });
                return;
            }
        } catch (e) { /* 忽略，走兜底 */ }
        try {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); ta.remove();
            App.notify('已复制');
        } catch (e2) { App.notify('复制失败'); }
    }

    /** 从 AI 回复里尽量提取结构化计划 JSON：纯 JSON 或提取首个 {...} 块（鲁棒版） */
    /** 容错解析：把 AI 常见的「残缺/半格式化」JSON 尽量修复成合法对象。
     *  典型残缺（百炼模型偶发不守格式）：
     *   - {": "标题"              -> 缺键名 title
     *   - "steps": ["text":"..."] -> 裸步骤缺 {}
     *   - 字段间缺少引号 / 多余逗号等
     *  仅在标准 JSON.parse 失败时才调用，尽量「抢救」成结构化计划。 */
    function repairPlanJson(raw) {
        if (!raw) return null;
        var t = raw.trim();
        // 取首个 { 到最后一个 } 之间的内容
        var s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s === -1 || e <= s) return null;
        var body = t.slice(s + 1, e); // 去掉首尾花括号，单独处理

        function unq(str) {
            // 去首尾引号并反转义
            str = str.trim();
            if ((str.charAt(0) === '"' || str.charAt(0) === "'") && str.charAt(str.length - 1) === str.charAt(0)) {
                str = str.slice(1, -1);
            }
            return str.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }

        var title = '';
        var steps = [];
        var note = '';

        // 1) title：匹配 "title" 或残缺的 ": 之后直到逗号/换行
        var titleM = body.match(/"title"\s*:\s*"([\s\S]*?)"/i)
            || body.match(/"title"\s*:\s*'([\s\S]*?)'/i)
            || body.match(/\{?\s*":\s*"([\s\S]*?)"/)          // 残缺：{": "标题"
            || body.match(/":\s*"([\s\S]*?)"/);                // 兜底缺键名
        if (titleM) title = unq(titleM[1]);

        // 2) note：匹配 "note" : "..."
        var noteM = body.match(/"note"\s*:\s*"([\s\S]*?)"/i)
            || body.match(/"note"\s*:\s*'([\s\S]*?)'/i);
        if (noteM) note = unq(noteM[1]);

        // 3) steps：扫描所有引号包裹串，过滤掉键名(title/steps/note/text)与过短串，
        //    余下的长串视为步骤文本（覆盖模型「缺 } 黏连」「缺引号」等残缺写法）。
        //    注：若模型把某个步骤的 } 写丢导致黏连，该步骤已不可逆损坏，只能尽力抢救其余步骤。
        var strRe = /"([^"]{2,})"/g;
        var sm;
        while ((sm = strRe.exec(body)) !== null) {
            var v = sm[1].trim();
            if (v === 'title' || v === 'steps' || v === 'note' || v === 'text') continue;
            if (v.indexOf('text":"') !== -1 || v.indexOf('":') !== -1) continue; // 跳过黏连残留
            if (v.length >= 6 && !steps.some(function (x) { return x.text === v; })) {
                steps.push({ text: v });
            }
        }

        if (steps.length === 0 && !title) return null; // 实在抽不出内容，放弃
        return { title: title || 'AI 学习计划', steps: steps, note: note };
    }

    function extractPlanJson(content) {
        if (!content) return null;
        var t = (content + '').trim();
        // 候选串：整段 / 去代码块 / 首个 { 到最后一个 } 的子串
        var candidates = [t];
        var m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (m) candidates.push(m[1].trim());
        var s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s !== -1 && e > s) candidates.push(t.slice(s, e + 1));
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            // 先直接 parse
            try { var o = JSON.parse(c); if (o && o.steps) return o; } catch (e1) {}
            // 再尝试修复常见转义问题（步骤文本里未转义的双引号 / 非法控制字符）
            try {
                var fixed = c
                    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ') // 去掉非法控制字符
                    .replace(/\\"/g, '"');                                      // 先把已转义的双引号还原
                // 针对 "text": "..." 中文本内的裸双引号做粗修复（仅当整体 parse 失败）
                var o2 = JSON.parse(fixed);
                if (o2 && o2.steps) return o2;
            } catch (e2) {}
        }
        // 标准解析失败：用容错修复器抢救残缺 JSON（百炼模型偶发格式错乱）
        return repairPlanJson(t);
    }

    /**
     * 弹窗填写标题后保存为「我的计划」。
     * 若 AI 回复可解析为结构化计划（含 steps），则自动规范化为标准 JSON 保存，
     * 步骤统一初始化 done=false；否则按纯文本保存（兼容旧版）。
     */
    function saveResult(content, defaultTitle) {
        var structured = extractPlanJson(content);
        var finalContent;
        var finalTitle = defaultTitle || 'AI 生成内容';
        if (structured) {
            // 规范化：只保留 title/steps(text)/note，done 统一置 false
            var normSteps = (Array.isArray(structured.steps) ? structured.steps : [])
                .filter(function (s) { return s && (s.text || '').trim(); })
                .map(function (s) { return { text: s.text.trim(), done: false }; });
            var norm = {
                title: (structured.title || defaultTitle || 'AI 生成计划').trim(),
                steps: normSteps,
                note: structured.note || ''
            };
            finalContent = JSON.stringify(norm);
            if (norm.title) finalTitle = norm.title;
        } else {
            finalContent = content || '';
        }
        var html = '<h3>保存为我的计划</h3>' +
            '<input id="sp-title" class="modal-input" placeholder="计划标题" value="' + App.escapeHtml(finalTitle) + '">' +
            (structured ? '<div class="modal-desc">检测到结构化计划（' + ((Array.isArray(structured.steps) ? structured.steps : []).length) + ' 个步骤），将保存为可勾选的计划表。</div>'
                         : '<div class="modal-desc">将以纯文本形式保存。</div>') +
            '<div class="modal-actions">' +
                '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button class="primary" id="sp-save">保存</button>' +
            '</div>';
        var overlay = App.modal(html);
        overlay.querySelector('#sp-save').onclick = function () {
            var t = (document.getElementById('sp-title').value || '').trim() || finalTitle || '未命名计划';
            Api.studySavePlan(t, finalContent).then(function (d) {
                overlay.remove();
                if (d && d.code === 0) App.notify('已保存到我的计划');
                else App.notify((d && d.message) || '保存失败');
            });
        };
    }

    /* ---------- 我的计划 ---------- */
    function renderPlans(body) {
        body.innerHTML = '<div class="study-loading">加载中…</div>';
        // 并行加载：我的计划 + 学习统计总览
        var plansP = Api.studyMyPlans();
        var statsP = (Api.studyStats ? Api.studyStats() : Promise.resolve({ code: 0, data: {} }));
        Promise.all([plansP, statsP]).then(function (res) {
            var d = res[0];
            var sd = res[1];
            if (!d || d.code !== 0 || !Array.isArray(d.data)) {
                body.innerHTML = '<div class="empty-tip">加载失败</div>';
                return;
            }
            state.plans = d.data;
            state.studyStats = (sd && sd.code === 0 && sd.data) ? sd.data : {};
            if (state.plans.length === 0) {
                body.innerHTML = studyStatsBar() +
                    '<div class="study-empty">' +
                    '<div class="se-emoji">🗒️</div>' +
                    '<div class="se-title">还没有保存的计划</div>' +
                    '<div class="se-sub">在「智能工具」里生成结果后，点击「保存到我的计划」即可在这里查看与管理。</div>' +
                    '<button class="primary" onclick="Study.goAi()">去生成计划</button>' +
                    '</div>';
                return;
            }
            body.innerHTML = studyStatsBar() +
                '<div class="study-plan-head">共 ' + state.plans.length + ' 个计划</div>' +
                state.plans.map(planCard).join('');
            wirePlans(body);
        }).catch(function () {
            body.innerHTML = '<div class="empty-tip">加载失败，请重试</div>';
        });
    }

    /** 学习统计总览条：今日番茄钟/打卡时长 + 累计，引导用户看到自己的学习过程 */
    function studyStatsBar() {
        var s = state.studyStats || {};
        var todayPomo = s.todayPomodoro || 0;
        var todayCheck = s.todayCheckin || 0;
        var totalPomo = s.totalPomodoro || 0;
        var totalCheck = s.totalCheckin || 0;
        var totalCnt = s.totalCheckinCount || 0;
        function hm(min) {
            min = Number(min) || 0;
            var h = Math.floor(min / 60), m = min % 60;
            return (h > 0 ? h + ' 小时' : '') + (m > 0 ? m + ' 分' : (h === 0 ? '0 分' : ''));
        }
        return '<div class="study-stats">' +
            '<div class="ss-cell"><div class="ss-num">' + hm(todayPomo) + '</div><div class="ss-label">今日番茄钟</div></div>' +
            '<div class="ss-cell"><div class="ss-num">' + hm(todayCheck) + '</div><div class="ss-label">今日打卡</div></div>' +
            '<div class="ss-cell"><div class="ss-num">' + hm(totalPomo) + '</div><div class="ss-label">累计番茄钟</div></div>' +
            '<div class="ss-cell"><div class="ss-num">' + hm(totalCheck) + '</div><div class="ss-label">累计打卡</div></div>' +
            '<div class="ss-cell"><div class="ss-num">' + totalCnt + ' 天</div><div class="ss-label">累计打卡天数</div></div>' +
            '</div>';
    }

    /** 尝试把 content 解析为结构化计划；失败返回 null（按纯文本处理） */
    function parsePlan(content) {
        if (!content) return null;
        var t = (content + '').trim();
        if (!t.startsWith('{') && !t.startsWith('[')) return null;
        try {
            var obj = JSON.parse(t);
            if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.steps) return obj;
            return null;
        } catch (e) { return null; }
    }

    /**
     * 渲染单条计划卡片。
     * 结构化计划（含 steps 数组）渲染为可勾选/可编辑的计划表；
     * 旧版纯文本计划渲染为展开/收起的 pre。
     */
    function planCard(p) {
        var structured = parsePlan(p.content);
        if (!structured) {
            // 旧版纯文本：保持原有展开/收起行为
            var expanded = !!state.expanded[p.id];
            return '<div class="study-plan" data-id="' + p.id + '">' +
                '<div class="sp-head">' +
                    '<div class="sp-title">' + App.escapeHtml(p.title) + '</div>' +
                    '<div class="sp-actions">' +
                        '<button class="op" data-act="toggle">' + (expanded ? '收起' : '展开') + '</button>' +
                        '<button class="op del" data-act="del">删除</button>' +
                    '</div>' +
                '</div>' +
                '<div class="sp-time">' + App.escapeHtml(App.msgTime(p.createTime)) + '</div>' +
                '<pre class="sp-content' + (expanded ? ' expanded' : '') + '">' + App.escapeHtml(p.content || '') + '</pre>' +
            '</div>';
        }
        // 结构化：渲染计划表
        var steps = Array.isArray(structured.steps) ? structured.steps : [];
        var doneCount = steps.filter(function (s) { return s.done; }).length;
        var pct = steps.length ? Math.round(doneCount / steps.length * 100) : 0;
        var note = structured.note || '';
        var listHtml = steps.map(function (s, i) {
            var text = s.text || '';
            var done = !!s.done;
            return '<li class="sp-step' + (done ? ' done' : '') + '" data-i="' + i + '">' +
                '<label class="sp-check">' +
                    '<input type="checkbox" data-act="check"' + (done ? ' checked' : '') + '>' +
                    '<span class="sp-box"></span>' +
                '</label>' +
                '<div class="sp-step-text" data-act="edit" title="双击编辑">' + App.escapeHtml(text) + '</div>' +
                '<button class="sp-step-del" data-act="stepdel" title="删除此步">✕</button>' +
            '</li>';
        }).join('');
        var checkinMin = p.checkinMinutes || 0;
        var pomoMin = p.pomodoroMinutes || 0;
        var days = p.checkinDays || '';
        var dayCount = days ? days.split(',').filter(Boolean).length : 0;
        function hm(min) {
            min = Number(min) || 0;
            var h = Math.floor(min / 60), m = min % 60;
            return (h > 0 ? h + 'h' : '') + (m > 0 ? m + 'm' : (h === 0 ? '0m' : ''));
        }
        return '<div class="study-plan structured" data-id="' + p.id + '">' +
            '<div class="sp-head">' +
                '<div class="sp-title">' + App.escapeHtml(p.title) + '</div>' +
                '<div class="sp-actions">' +
                    '<button class="op" data-act="add">＋步骤</button>' +
                    '<button class="op" data-act="save">保存</button>' +
                    '<button class="op del" data-act="del">删除</button>' +
                '</div>' +
            '</div>' +
            '<div class="sp-time">' + App.escapeHtml(App.msgTime(p.createTime)) + '</div>' +
            '<div class="sp-progress"><div class="sp-bar" style="width:' + pct + '%"></div>' +
                '<span class="sp-pct">' + doneCount + '/' + steps.length + ' 已完成</span></div>' +
            '<ul class="sp-steps">' + listHtml + '</ul>' +
            '<div class="sp-stats">' +
                '<div class="sps-cell"><span class="sps-num">' + hm(checkinMin) + '</span><span class="sps-lbl">打卡时长</span></div>' +
                '<div class="sps-cell"><span class="sps-num">' + hm(pomoMin) + '</span><span class="sps-lbl">番茄钟</span></div>' +
                '<div class="sps-cell"><span class="sps-num">' + dayCount + '天</span><span class="sps-lbl">打卡天数</span></div>' +
                '<button class="op checkin" data-act="checkin">📍 打卡</button>' +
            '</div>' +
            (note ? '<div class="sp-note"><span class="sp-note-label">备注</span>' +
                '<div class="sp-note-text" data-act="editnote" title="双击编辑">' + App.escapeHtml(note) + '</div></div>' : '') +
        '</div>';
    }

    /** 当前编辑态：卡片内对 steps/note 的临时修改（未保存前仅前端内存态） */
    function readDraft(card) {
        var id = Number(card.getAttribute('data-id'));
        var plan = state.plans.filter(function (x) { return x.id === id; })[0];
        var structured = parsePlan(plan ? plan.content : '');
        if (!structured) return null;
        var steps = Array.isArray(structured.steps) ? structured.steps.map(function (s) { return { text: s.text || '', done: !!s.done }; }) : [];
        // 从 DOM 读回当前勾选/编辑态
        card.querySelectorAll('.sp-step').forEach(function (li) {
            var i = Number(li.getAttribute('data-i'));
            if (steps[i] == null) return;
            var cb = li.querySelector('input[data-act="check"]');
            if (cb) steps[i].done = cb.checked;
            var txt = li.querySelector('[data-act="edit"]');
            if (txt) steps[i].text = txt.getAttribute('data-text') != null ? txt.getAttribute('data-text') : txt.textContent;
        });
        var noteEl = card.querySelector('[data-act="editnote"]');
        var note = noteEl ? (noteEl.getAttribute('data-text') != null ? noteEl.getAttribute('data-text') : noteEl.textContent) : (structured.note || '');
        return { title: plan ? plan.title : '未命名计划', steps: steps, note: note };
    }

    function wirePlans(body) {
        body.querySelectorAll('.study-plan').forEach(function (card) {
            var id = Number(card.getAttribute('data-id'));
            // 纯文本卡片的「展开/收起」
            var toggleBtn = card.querySelector('[data-act="toggle"]');
            if (toggleBtn) toggleBtn.onclick = function () {
                state.expanded[id] = !state.expanded[id];
                var pre = card.querySelector('.sp-content');
                pre.classList.toggle('expanded', state.expanded[id]);
                this.textContent = state.expanded[id] ? '收起' : '展开';
            };
            // 结构化卡片：勾选
            card.querySelectorAll('input[data-act="check"]').forEach(function (cb) {
                cb.onchange = function () {
                    var li = cb.closest('.sp-step');
                    li.classList.toggle('done', cb.checked);
                    updateProgress(card);
                };
            });
            // 双击编辑步骤文字
            card.querySelectorAll('[data-act="edit"]').forEach(function (el) {
                el.ondblclick = function () { editStepText(el); };
            });
            var noteEl = card.querySelector('[data-act="editnote"]');
            if (noteEl) noteEl.ondblclick = function () { editStepText(noteEl, true); };
            // 删除某步
            card.querySelectorAll('[data-act="stepdel"]').forEach(function (btn) {
                btn.onclick = function () {
                    var li = btn.closest('.sp-step');
                    li.remove();
                    updateProgress(card);
                };
            });
            // 加步骤
            var addBtn = card.querySelector('[data-act="add"]');
            if (addBtn) addBtn.onclick = function () {
                var ul = card.querySelector('.sp-steps');
                if (!ul) return;
                var li = document.createElement('li');
                li.className = 'sp-step';
                li.setAttribute('data-i', ul.children.length);
                li.innerHTML = '<label class="sp-check"><input type="checkbox" data-act="check"><span class="sp-box"></span></label>' +
                    '<div class="sp-step-text" data-act="edit" title="双击编辑">新步骤（双击编辑）</div>' +
                    '<button class="sp-step-del" data-act="stepdel" title="删除此步">✕</button>';
                ul.appendChild(li);
                li.querySelector('input[data-act="check"]').onchange = function () {
                    li.classList.toggle('done', this.checked); updateProgress(card);
                };
                li.querySelector('[data-act="edit"]').ondblclick = function () { editStepText(this); };
                li.querySelector('[data-act="stepdel"]').onclick = function () { li.remove(); updateProgress(card); };
                updateProgress(card);
                if (App.notify) App.notify('已添加步骤，编辑后点「保存」');
            };
            // 保存
            var saveBtn = card.querySelector('[data-act="save"]');
            if (saveBtn) saveBtn.onclick = function () {
                var draft = readDraft(card);
                if (!draft) { App.notify('该计划不是可编辑结构'); return; }
                var json = JSON.stringify(draft);
                saveBtn.disabled = true;
                Api.studyUpdatePlan(id, json).then(function (d) {
                    saveBtn.disabled = false;
                    if (d && d.code === 0) {
                        // 同步回内存态，避免下次渲染丢失
                        var plan = state.plans.filter(function (x) { return x.id === id; })[0];
                        if (plan) plan.content = json;
                        App.notify('计划已保存');
                    } else {
                        App.notify((d && d.message) || '保存失败');
                    }
                });
            };
            // 删除
            var delBtn = card.querySelector('[data-act="del"]');
            if (delBtn) delBtn.onclick = function () {
                App.confirm('确定删除该计划？删除后不可恢复', { danger: true, okText: '删除' }).then(function (ok) {
                    if (!ok) return;
                    Api.studyDeletePlan(id).then(function (d) {
                        if (d && d.code === 0) { App.notify('已删除'); renderPlans(body); }
                        else App.notify((d && d.message) || '删除失败');
                    });
                });
            };
            // 打卡
            var checkinBtn = card.querySelector('[data-act="checkin"]');
            if (checkinBtn) checkinBtn.onclick = function () { openCheckin(id); };
        });
    }

    /** 打卡弹窗：填本次学习时长（分钟），上报后刷新统计 */
    function openCheckin(planId) {
        var html = '<h3>计划打卡</h3>' +
            '<div class="pf-field"><label>本次学习时长（分钟）</label>' +
            '<input id="ck-min" class="modal-input" type="number" min="0" max="1440" placeholder="如 30" value="30"></div>' +
            '<div class="modal-desc">打卡会记录到「我的计划」与今日学习统计；填 0 表示仅标记今天已打卡。</div>' +
            '<div class="modal-actions">' +
            '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
            '<button class="primary" id="ck-ok">打卡</button>' +
            '</div>';
        var overlay = App.modal(html);
        if (!overlay) return;
        var input = overlay.querySelector('#ck-min');
        var ok = overlay.querySelector('#ck-ok');
        if (input) setTimeout(function () { input.focus(); }, 30);
        if (ok) ok.onclick = function () {
            var min = parseInt(input ? input.value : '0', 10);
            if (isNaN(min) || min < 0) min = 0;
            if (min > 1440) min = 1440;
            ok.disabled = true;
            Api.studyCheckin(planId, min).then(function (d) {
                overlay.remove();
                if (d && d.code === 0) {
                    App.notify('✅ 打卡成功' + (min > 0 ? '（' + min + ' 分钟）' : ''));
                    renderPlans(document.getElementById('study-body'));
                } else {
                    ok.disabled = false;
                    App.notify((d && d.message) || '打卡失败');
                }
            }).catch(function () { ok.disabled = false; });
        };
        if (input) input.onkeydown = function (e) { if (e.key === 'Enter') ok.onclick(); };
    }

    /** 编辑步骤/备注文字（双击触发，就地变输入框） */
    function editStepText(el, isNote) {
        if (el.querySelector('textarea, input')) return;
        var cur = el.getAttribute('data-text') != null ? el.getAttribute('data-text') : el.textContent;
        var ta = document.createElement('textarea');
        ta.className = 'sp-edit-input';
        ta.value = cur;
        el.textContent = '';
        el.appendChild(ta);
        ta.focus();
        ta.onblur = function () {
            var v = ta.value.trim();
            el.setAttribute('data-text', v);
            if (isNote) el.textContent = v;
            else el.textContent = v || '（空步骤）';
        };
        ta.onkeydown = function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { ta.blur(); }
            if (e.key === 'Escape') { ta.blur(); }
        };
    }

    /** 重算卡片进度条 */
    function updateProgress(card) {
        var steps = card.querySelectorAll('.sp-step');
        var done = card.querySelectorAll('.sp-step.done').length;
        var total = steps.length;
        var pct = total ? Math.round(done / total * 100) : 0;
        var bar = card.querySelector('.sp-bar');
        var pctEl = card.querySelector('.sp-pct');
        if (bar) bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = done + '/' + total + ' 已完成';
    }

    function goAi() {
        state.sub = 'ai';
        var root = document.getElementById('program');
        if (root) root.querySelectorAll('.study-sub').forEach(function (x) {
            x.classList.toggle('active', x.getAttribute('data-sub') === 'ai');
        });
        renderSub();
    }

    /* ---------- 番茄钟（纯本地计时） ---------- */
    function renderPomodoro(body) {
        var p = state.pomodoro;
        var r = 86, c = 2 * Math.PI * r;
        var ratio = p.total > 0 ? (p.remaining / p.total) : 0;
        var offset = c * (1 - ratio);
        body.innerHTML =
            '<div class="pomo-wrap">' +
                '<div class="pomo-ring">' +
                    '<svg viewBox="0 0 200 200">' +
                        '<circle class="pomo-bg" cx="100" cy="100" r="' + r + '"></circle>' +
                        '<circle class="pomo-fg" cx="100" cy="100" r="' + r + '" stroke-dasharray="' + c + '" stroke-dashoffset="' + offset + '"></circle>' +
                    '</svg>' +
                    '<div class="pomo-time" id="pomo-time">' + fmt(p.remaining) + '</div>' +
                '</div>' +
                '<div class="pomo-controls">' +
                    '<div class="pomo-set">' +
                        '<label>时长(分钟)</label>' +
                        '<input id="pomo-min" type="number" min="1" max="180" value="' + p.defaultMin + '"' + (p.running ? ' disabled' : '') + '>' +
                        '<button class="primary" id="pomo-apply"' + (p.running ? ' disabled' : '') + '>设定</button>' +
                    '</div>' +
                    '<div class="pomo-btns">' +
                        '<button class="primary" id="pomo-toggle">' + (p.running ? '暂停' : '开始') + '</button>' +
                        '<button class="ghost" id="pomo-reset">重置</button>' +
                    '</div>' +
                '</div>' +
                '<div class="pomo-tip">专注 25 分钟，休息 5 分钟。番茄钟仅本地计时，不会上传。</div>' +
            '</div>';
        wirePomodoro(body);
    }

    function updatePomo() {
        var body = document.getElementById('study-body');
        if (!body) return;
        var p = state.pomodoro;
        var timeEl = body.querySelector('#pomo-time');
        var fg = body.querySelector('.pomo-fg');
        if (timeEl) timeEl.textContent = fmt(p.remaining);
        if (fg) {
            var r = 86, c = 2 * Math.PI * r;
            var ratio = p.total > 0 ? (p.remaining / p.total) : 0;
            fg.setAttribute('stroke-dashoffset', c * (1 - ratio));
        }
    }

    function pomoStop(finished) {
        var p = state.pomodoro;
        if (p.timer) { clearInterval(p.timer); p.timer = null; }
        p.running = false;
        var body = document.getElementById('study-body');
        var btn = body && body.querySelector('#pomo-toggle');
        if (btn) btn.textContent = '开始';
        if (finished) {
            p.remaining = p.total;   // 完成后重置，便于下一轮「开始」
            updatePomo();
            // 番茄钟完成：自动上报到「今日学习统计」（全局累计，不绑定具体计划）
            var doneMin = Math.round(p.total / 60);
            if (doneMin > 0 && window.Api && Api.studyPomodoroReport) {
                Api.studyPomodoroReport(doneMin).then(function (d) {
                    if (App.notify && d && d.code === 0) {
                        // 静默成功；若当前在「我的计划」页则刷新统计条
                        if (state.sub === 'plans') {
                            var body = document.getElementById('study-body');
                            if (body) renderPlans(body);
                        }
                    }
                }).catch(function () {});
            }
        }
    }

    function wirePomodoro(body) {
        var p = state.pomodoro;
        var toggle = body.querySelector('#pomo-toggle');
        var reset = body.querySelector('#pomo-reset');
        var apply = body.querySelector('#pomo-apply');
        var minInput = body.querySelector('#pomo-min');

        toggle.onclick = function () {
            if (p.running) {
                pomoStop(false);
                return;
            }
            if (p.remaining <= 0) p.remaining = p.total;
            p.running = true;
            toggle.textContent = '暂停';
            p.timer = setInterval(function () {
                p.remaining--;
                if (p.remaining <= 0) {
                    p.remaining = 0;
                    updatePomo();
                    pomoStop(true);
                    App.notify('🍅 番茄钟完成，休息一下吧！');
                    beep();
                    return;
                }
                updatePomo();
            }, 1000);
        };

        reset.onclick = function () {
            pomoStop(false);
            p.remaining = p.total = p.defaultMin * 60;
            updatePomo();
        };

        apply.onclick = function () {
            var m = parseInt(minInput.value, 10);
            if (!m || m < 1) m = 1;
            if (m > 180) m = 180;
            p.defaultMin = m;
            pomoStop(false);
            p.remaining = p.total = m * 60;
            minInput.value = m;
            updatePomo();
        };
    }

    /** 完成提示音（WebAudio 短促蜂鸣） */
    function beep() {
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            var ac = new AC();
            var o = ac.createOscillator();
            var g = ac.createGain();
            o.connect(g); g.connect(ac.destination);
            o.frequency.value = 880;
            o.start();
            g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.8);
            o.stop(ac.currentTime + 0.8);
        } catch (e) { /* 忽略：浏览器不支持音频时不打断体验 */ }
    }

    return {
        open: open,
        goAi: goAi
    };
})();
