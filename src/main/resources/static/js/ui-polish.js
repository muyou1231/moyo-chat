/* ============================================================================
 * ui-polish.js — 跨页面通用体验增强层（index.html / admin.html 共用）。
 *
 * 设计原则：只做「无侵入」的体验升级，不改变任何既有业务逻辑、不改变任何既有函数签名：
 *   1. 弹窗 / 菜单关闭动画：全站到处都是 `xxxOverlay.remove()`（包括内联 HTML 里的
 *      `onclick="this.closest('.modal-overlay').remove()"`），逐一改造成本高且容易漏改。
 *      这里改用一个更省事的办法：只对几个「已知是浮层容器」的类名，包一层
 *      Element.prototype.remove，先播放退出动画，再真正从 DOM 摘除；其余元素的
 *      remove() 行为完全不变（原生同步移除），不影响任何既有逻辑判断。
 *   2. 尊重系统「减少动态效果」无障碍设置：偏好该设置的用户，跳过所有装饰性动画延时。
 *
 * 必须作为页面第一个 <script> 加载（早于 app.js / admin-app.js 等业务脚本）。
 * ========================================================================= */
(function () {
    'use strict';

    var reduceMotion = false;
    try {
        reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { /* 忽略，按不偏好处理 */ }
    if (reduceMotion) {
        document.documentElement.classList.add('reduce-motion');
    }

    // 容器类名 → 退出动画时长（毫秒）。需与 style-premium.css 中对应 .closing 动画时长保持一致。
    var CLOSE_ANIM_MS = {
        'modal-overlay': 160,
        'me-menu': 120,
        'ad-modal': 160
    };

    var nativeRemove = Element.prototype.remove;
    if (typeof nativeRemove !== 'function') return; // 极老浏览器兜底：不拦截

    Element.prototype.remove = function () {
        var self = this;
        if (reduceMotion || !self.classList || self.__closing) {
            return nativeRemove.call(self);
        }
        var ms = -1;
        for (var cls in CLOSE_ANIM_MS) {
            if (CLOSE_ANIM_MS.hasOwnProperty(cls) && self.classList.contains(cls)) {
                ms = CLOSE_ANIM_MS[cls];
                break;
            }
        }
        if (ms < 0 || !self.isConnected) {
            return nativeRemove.call(self);
        }
        self.__closing = true;
        self.classList.add('closing');
        setTimeout(function () { nativeRemove.call(self); }, ms);
    };

    /** 供业务代码可选调用：按钮 loading 态的统一开关（禁用 + 显示旋转圈，文案不丢失）。 */
    window.UiPolish = {
        setButtonBusy: function (btn, busy) {
            if (!btn) return;
            btn.disabled = !!busy;
            btn.classList.toggle('btn-loading', !!busy);
        },
        reduceMotion: reduceMotion
    };
})();
