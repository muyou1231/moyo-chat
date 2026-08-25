/* 程序空间：功能聚合容器。目前内置「学习空间」模块，未来可在此继续添加更多工具。 */
window.Program = (function () {

    // 已上线的功能模块（后续新增功能只改这里即可）
    var modules = [
        {
            key: 'study',
            name: '学习空间',
            desc: 'AI 制定计划 · 知识点互问 · 资料摘要 · 番茄钟专注',
            icon: '📚',
            color: 'linear-gradient(135deg,#07c160,#10aeff)',
            open: function () { if (window.Study) Study.open(); }
        },
        {
            key: 'painting',
            name: '绘画管理',
            desc: '收藏与管理你的绘画作品，支持上传与删除',
            icon: '🎨',
            color: 'linear-gradient(135deg,#ff9c00,#f76260)',
            open: function () { if (window.Painting) Painting.open(); }
        }
        // 示例：未来新增
        // , { key:'toolbox', name:'工具箱', desc:'...', icon:'🧰', color:'...', open:function(){...} }
    ];

    function render() {
        var root = document.getElementById('program');
        if (!root) return;
        var cards = modules.map(function (m) {
            return '<div class="pg-card" data-key="' + m.key + '" style="--pg-c:' + m.color + '">' +
                '<div class="pg-card-icon">' + m.icon + '</div>' +
                '<div class="pg-card-name">' + App.escapeHtml(m.name) + '</div>' +
                '<div class="pg-card-desc">' + App.escapeHtml(m.desc) + '</div>' +
                '<div class="pg-card-go">进入 ›</div>' +
            '</div>';
        }).join('');

        root.innerHTML =
            '<div class="pg-head">' +
                '<div class="pg-title">程序空间</div>' +
                '<div class="pg-sub">把常用工具集中在这里，随用随取</div>' +
            '</div>' +
            '<div class="pg-grid">' + cards + '</div>' +
            '<div class="pg-foot">已上线 ' + modules.length + ' 个功能模块</div>';

        root.querySelectorAll('.pg-card').forEach(function (card) {
            var key = card.getAttribute('data-key');
            var m = modules.find(function (x) { return x.key === key; });
            if (m) card.onclick = function () { m.open(); highlight(key); };
        });

        // 桌面端：在左侧栏渲染程序空间导航（取代残留的群聊/会话列表）
        renderSidebar();
    }

    /** 左侧栏渲染程序空间导航（桌面端）。点击切换右侧 #program 内容并高亮当前项。 */
    function renderSidebar() {
        var side = document.getElementById('side-list');
        if (!side) return;
        // 移动端不显示侧栏（程序空间用卡片网格入口），跳过
        if (window.App && App.isMobile && App.isMobile()) return;
        var items = modules.map(function (m) {
            return '<div class="pg-nav-item" data-key="' + m.key + '">' +
                '<span class="pg-nav-ico">' + m.icon + '</span>' +
                '<span class="pg-nav-name">' + App.escapeHtml(m.name) + '</span>' +
                '<span class="pg-nav-go">›</span>' +
            '</div>';
        }).join('');
        side.innerHTML =
            '<div class="pg-nav-head">程序空间</div>' +
            '<div class="pg-nav">' + items + '</div>';
        side.classList.add('pg-side');
        bindSidebar();
    }

    function bindSidebar() {
        var side = document.getElementById('side-list');
        if (!side) return;
        side.querySelectorAll('.pg-nav-item').forEach(function (el) {
            var key = el.getAttribute('data-key');
            var m = modules.find(function (x) { return x.key === key; });
            if (!m) return;
            el.onclick = function () {
                m.open();
                highlight(key);
            };
        });
    }

    /** 高亮左侧导航中对应项（子模块激活时调用） */
    function highlight(key) {
        var side = document.getElementById('side-list');
        if (!side) return;
        side.querySelectorAll('.pg-nav-item').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-key') === key);
        });
    }

    /** 离开程序空间时清掉左侧导航（仅当它是程序空间导航时，避免误清其它列表） */
    function clearSidebar() {
        var side = document.getElementById('side-list');
        if (!side) return;
        if (side.classList.contains('pg-side')) {
            side.innerHTML = '';
            side.classList.remove('pg-side');
        }
    }

    return {
        render: render,
        modules: modules,
        highlight: highlight,
        clearSidebar: clearSidebar
    };
})();
