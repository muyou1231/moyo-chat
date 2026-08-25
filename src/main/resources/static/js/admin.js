/* 管理后台入口（供普通用户端 index.html 使用）：
   普通端「管理」标签点击后，在新窗口打开独立管理页面 /admin。
   真正的管理功能全部在 admin.html + admin-app.js 中，不与普通端耦合。 */
window.Admin = (function () {
    function open() {
        window.open('admin.html', '_blank');
    }
    return { open: open };
})();
