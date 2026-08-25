/* 程序空间：绘画管理（作品 CRUD）。
 * 用户可创建（上传图片或填外部链接 + 标题/描述）与删除自己的绘画作品。
 * 数据存后端 painting 表，图片走 MinIO 上传代理（prefix=image/painting）。 */
window.Painting = (function () {

    var state = {
        items: []
    };

    function val(id) {
        var el = document.getElementById(id);
        return el ? el.value.trim() : '';
    }

    /** 进入绘画管理：在程序空间容器内渲染（带返回按钮） */
    function open() {
        var root = document.getElementById('program');
        if (!root) return;
        root.innerHTML =
            '<div class="study-shell">' +
                '<div class="study-topbar">' +
                    '<button class="study-back" onclick="Program.render()">‹ 程序空间</button>' +
                    '<div class="study-topbar-title">绘画管理</div>' +
                '</div>' +
                '<div class="pg-subbar">' +
                    '<button class="primary" id="pt-create">＋ 新建作品</button>' +
                '</div>' +
                '<div class="study-body" id="study-body"></div>' +
            '</div>';
        var createBtn = root.querySelector('#pt-create');
        if (createBtn) createBtn.onclick = openCreate;
        renderList(document.getElementById('study-body'));
    }

    function renderList(body) {
        if (!body) return;
        body.innerHTML = '<div class="study-loading">加载中…</div>';
        Api.paintingList().then(function (d) {
            if (!d || d.code !== 0 || !Array.isArray(d.data)) {
                body.innerHTML = '<div class="empty-tip">加载失败</div>';
                return;
            }
            state.items = d.data;
            if (state.items.length === 0) {
                body.innerHTML = '<div class="study-empty">' +
                    '<div class="se-emoji">🎨</div>' +
                    '<div class="se-title">还没有绘画作品</div>' +
                    '<div class="se-sub">点击右上角「新建作品」，上传图片并写下标题与描述来收藏你的画作。</div>' +
                    '<button class="primary" onclick="Painting.openCreate()">新建作品</button>' +
                '</div>';
                return;
            }
            body.innerHTML = '<div class="pt-grid">' +
                state.items.map(card).join('') + '</div>';
            wire(body);
        }).catch(function () {
            body.innerHTML = '<div class="empty-tip">加载失败，请重试</div>';
        });
    }

    function card(p) {
        var src = p.imageUrl || '';
        return '<div class="pt-card" data-id="' + p.id + '" onclick="App.previewImage(' + JSON.stringify(src) + ')">' +
            '<div class="pt-thumb">' +
                '<img src="' + App.escapeHtml(src) + '" alt="' + App.escapeHtml(p.title) + '" loading="lazy">' +
            '</div>' +
            '<div class="pt-info">' +
                '<div class="pt-title">' + App.escapeHtml(p.title) + '</div>' +
                (p.description ? '<div class="pt-desc">' + App.escapeHtml(p.description) + '</div>' : '') +
                '<div class="pt-time">' + App.escapeHtml(App.msgTime(p.createTime)) + '</div>' +
            '</div>' +
            '<button class="pt-del" data-act="del" title="删除">🗑</button>' +
        '</div>';
    }

    function wire(body) {
        body.querySelectorAll('.pt-card').forEach(function (c) {
            var id = Number(c.getAttribute('data-id'));
            var del = c.querySelector('[data-act="del"]');
            if (del) del.onclick = function (e) {
                e.stopPropagation();
                App.confirm('确定删除该作品？删除后不可恢复', { danger: true, okText: '删除' }).then(function (ok) {
                    if (!ok) return;
                    Api.paintingDelete(id).then(function (d) {
                        if (d && d.code === 0) { App.notify('已删除'); renderList(body); }
                        else App.notify((d && d.message) || '删除失败');
                    });
                });
            };
        });
    }

    /** 新建作品弹窗：标题 + 描述 + 上传图片（或粘贴外部链接） */
    function openCreate() {
        var html =
            '<h3>新建绘画作品</h3>' +
            '<div class="pf-field"><label>标题</label><input id="pt-title" class="modal-input" placeholder="作品标题" maxlength="128"></div>' +
            '<div class="pf-field"><label>描述</label><textarea id="pt-desc" class="modal-input" placeholder="一句话描述这幅画（选填）"></textarea></div>' +
            '<div class="pf-field"><label>图片</label>' +
                '<div class="pt-uploader" id="pt-uploader">' +
                    '<img id="pt-prev" class="hidden" alt="">' +
                    '<div class="pt-up-tip" id="pt-up-tip">点击上传图片</div>' +
                    '<input type="file" id="pt-file" class="hidden" accept="image/*">' +
                '</div>' +
                '<div class="pt-url-row">' +
                    '<input id="pt-url" class="modal-input" placeholder="或粘贴图片链接（URL）">' +
                '</div>' +
            '</div>' +
            '<div class="modal-actions">' +
                '<button class="ghost" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>' +
                '<button class="primary" id="pt-save">保存</button>' +
            '</div>';
        var overlay = App.modal(html, null, 'wide');
        var fileInput = overlay.querySelector('#pt-file');
        var uploader = overlay.querySelector('#pt-uploader');
        var prev = overlay.querySelector('#pt-prev');
        var upTip = overlay.querySelector('#pt-up-tip');
        var urlInput = overlay.querySelector('#pt-url');
        var pickedUrl = ''; // 上传后拿到的代理 URL

        uploader.onclick = function () { fileInput.click(); };
        fileInput.onchange = function () {
            var file = fileInput.files && fileInput.files[0];
            if (!file) return;
            // 本地预览
            var local = URL.createObjectURL(file);
            prev.src = local;
            prev.classList.remove('hidden');
            upTip.textContent = '上传中…';
            Api.upload(file, 'image/painting').then(function (d) {
                if (d && d.code === 0 && d.data && d.data.url) {
                    pickedUrl = d.data.url;
                    upTip.textContent = '已上传，可保存';
                    urlInput.value = ''; // 上传优先，清空手动链接
                } else {
                    upTip.textContent = '上传失败，可重试或粘贴链接';
                    App.notify((d && d.message) || '上传失败');
                }
            }).catch(function () {
                upTip.textContent = '上传失败，可重试或粘贴链接';
                App.notify('上传失败');
            });
        };
        // 用户手填链接时，清空已上传
        urlInput.oninput = function () { if (urlInput.value.trim()) { pickedUrl = ''; prev.classList.add('hidden'); upTip.textContent = '点击上传图片'; } };

        overlay.querySelector('#pt-save').onclick = function () {
            var title = (document.getElementById('pt-title').value || '').trim();
            var desc = (document.getElementById('pt-desc').value || '').trim();
            var imageUrl = (pickedUrl || urlInput.value || '').trim();
            if (!title) { App.notify('请填写标题'); return; }
            if (!imageUrl) { App.notify('请上传图片或粘贴链接'); return; }
            Api.paintingCreate(title, desc, imageUrl).then(function (d) {
                overlay.remove();
                if (d && d.code === 0) { App.notify('已保存'); renderList(document.getElementById('study-body')); }
                else App.notify((d && d.message) || '保存失败');
            }).catch(function () { App.notify('保存失败'); });
        };
    }

    return {
        open: open,
        openCreate: openCreate
    };
})();
