/* 语音通话（WebRTC 端到端音频，仅信令经服务端中转）
 * 信令复用现有 /topic/user/{uid} 单播通道：客户端 -> /app/call.signal -> 服务端转发给目标。
 * 媒体流由浏览器 P2P 直连，服务端不接触音频数据。
 */
window.Call = (function () {
    var ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

    var state = {
        pc: null,
        localStream: null,
        remoteStream: null,
        peer: null,          // {id, name, avatar}
        role: null,          // 'caller' | 'callee'
        callId: null,        // 发起方生成的本次通话唯一标识
        _offerSdp: null,     // 被叫方暂存的 offer SDP
        ringingTimer: null,
        durationTimer: null,
        startTs: 0,
        connected: false,    // 通话是否已接通（用于计算时长 / 判断结果）
        result: null,        // 通话结果码：connected|cancel|reject|busy|noanswer|failed
        iceQueue: []
    };

    function el(id) { return document.getElementById(id); }

    /* ---------- WebRTC ---------- */
    function hasWebrtc() {
        return typeof window.RTCPeerConnection !== 'undefined'
            && navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    }

    function createPc() {
        var pc = new RTCPeerConnection({ iceServers: ICE });
        pc.onicecandidate = function (e) {
            if (e && e.candidate) sendSignal('ICE', { candidate: e.candidate });
        };
        pc.ontrack = function (e) {
            state.remoteStream = e.streams && e.streams[0];
            attachRemote(state.remoteStream);
        };
        state.pc = pc;
        return pc;
    }

    function attachRemote(stream) {
        var a = el('call-remote-audio');
        if (a && stream) { try { a.srcObject = stream; } catch (e) {} }
    }

    function addLocalTracks(pc) {
        if (state.localStream) {
            state.localStream.getTracks().forEach(function (t) { pc.addTrack(t, state.localStream); });
        }
    }

    function flushIce() {
        if (!state.pc) return;
        state.iceQueue.forEach(function (c) {
            try { state.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
        });
        state.iceQueue = [];
    }

    /* ---------- 信令收发 ---------- */
    function sendSignal(type, extra) {
        if (!window.Ws || !Ws.client || !Ws.client.connected) { App.notify('实时连接未建立，无法通话'); return; }
        var payload = {
            type: type,
            from: App.user.id,
            to: state.peer ? state.peer.id : null,
            callId: state.callId
        };
        if (extra) {
            if (extra.sdp) payload.sdp = extra.sdp;
            if (extra.candidate) payload.candidate = extra.candidate;
            if (extra.reason) payload.reason = extra.reason;
        }
        Ws.client.send('/app/call.signal', {}, JSON.stringify(payload));
    }

    /* ---------- 发起通话 ---------- */
    function startCallFromCurrent() {
        if (!App.current) { App.notify('请先打开一个会话'); return; }
        if (App.user && App.user.frozen) { App.notify('账号已被冻结，无法发起通话'); return; }
        if (isActive()) { App.notify('当前已有通话进行中'); return; }
        if (App.current.type === 'USER') {
            var conv = App.conversations.find(function (c) { return c.type === 'USER' && c.id === App.current.id; });
            callUser({ id: App.current.id, name: App.current.name, avatar: conv ? conv.avatar : null });
        } else if (App.current.type === 'GROUP') {
            openGroupPicker(App.current.id);
        }
    }

    function callUser(peer) {
        if (!hasWebrtc()) { App.notify('当前环境不支持语音通话（需 HTTPS 或 localhost）'); return; }
        state.peer = peer;
        state.role = 'caller';
        state.callId = App.user.id + '-' + Date.now();
        showCalling(peer);
        startRingingTimeout();
        createPc();
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then(function (stream) {
                state.localStream = stream;
                addLocalTracks(state.pc);
                return state.pc.createOffer();
            })
            .then(function (offer) {
                return state.pc.setLocalDescription(offer).then(function () { return offer; });
            })
            .then(function (offer) {
                sendSignal('OFFER', { sdp: offer.sdp });
            })
            .catch(function () {
                state.result = 'failed';
                endCall('无法访问麦克风，通话未建立', true);
            });
    }

    function startRingingTimeout() {
        state.ringingTimer = setTimeout(function () {
            if (state.role === 'caller' && state.pc) {
                state.result = 'noanswer';
                endCall('对方未接听', true);
            }
        }, 30000);
    }

    /* ---------- 信令分发 ---------- */
    function onSignal(wm) {
        if (!wm) return;
        switch (wm.type) {
            case 'CALL_OFFER': return onOffer(wm);
            case 'CALL_ANSWER': return onAnswer(wm);
            case 'CALL_ICE': return onIce(wm);
            case 'CALL_BYE': return onBye(wm);
        }
    }

    function onOffer(wm) {
        // 已有通话 / 冻结：忙线，自动拒绝
        if (isActive() || (App.user && App.user.frozen)) {
            state.peer = { id: wm.from };
            state.callId = wm.callId;
            sendSignal('BYE', { reason: 'busy' });
            return;
        }
        state.peer = peerInfo(wm.from);
        state.role = 'callee';
        state.callId = wm.callId;
        state._offerSdp = wm.sdp;
        showIncoming(state.peer);
    }

    function acceptCall() {
        if (!hasWebrtc()) { rejectCall(); return; }
        if (!state._offerSdp) return;
        hideIncoming();
        showInCall(state.peer, 'connecting');
        createPc();
        var pc = state.pc;
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then(function (stream) {
                state.localStream = stream;
                addLocalTracks(pc);
                return pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: state._offerSdp }));
            })
            .then(function () { flushIce(); return pc.createAnswer(); })
            .then(function (answer) { return pc.setLocalDescription(answer).then(function () { return answer; }); })
            .then(function (answer) { sendSignal('ANSWER', { sdp: answer.sdp }); startDuration(); })
            .catch(function () { state.result = 'failed'; endCall('无法访问麦克风，通话未建立', true); });
    }

    function rejectCall() {
        if (state.peer) sendSignal('BYE', { reason: 'reject' });
        cleanup();
        hideIncoming();
    }

    function onAnswer(wm) {
        if (state.role !== 'caller' || !state.callId || wm.callId !== state.callId) return;
        clearRinging();
        hideCalling();
        showInCall(state.peer, 'connecting');
        state.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: wm.sdp }))
            .then(function () { flushIce(); startDuration(); })
            .catch(function () {});
    }

    function onIce(wm) {
        if (!state.callId || (wm.callId && wm.callId !== state.callId)) return;
        if (!wm.candidate) return;
        if (state.pc && state.pc.remoteDescription && state.pc.remoteDescription.type) {
            try { state.pc.addIceCandidate(new RTCIceCandidate(wm.candidate)); } catch (e) {}
        } else {
            state.iceQueue.push(wm.candidate);
        }
    }

    function onBye(wm) {
        if (!state.callId || (wm.callId && wm.callId !== state.callId)) {
            if (isIncomingShown()) hideIncoming();
            return;
        }
        var reason = wm.reason || 'normal';
        if (reason === 'busy') state.result = 'busy';
        else if (reason === 'reject') state.result = 'reject';
        var msg = reason === 'reject' ? '对方拒绝了通话' : (reason === 'busy' ? '对方忙线中' : '通话已结束');
        endCall(msg, false);
    }

    /* ---------- 挂断 / 结束 ---------- */
    function hangup() {
        if (!state.connected) state.result = 'cancel';
        if (state.peer) sendSignal('BYE', { reason: 'normal' });
        endCall('通话已结束', false);
    }

    function endCall(msg, notify) {
        stopDuration();
        clearRinging();
        var connected = state.connected;
        var dur = connected ? Math.max(0, Math.floor((Date.now() - state.startTs) / 1000)) : 0;
        var resultCode = state.result || (connected ? 'connected' : 'cancel');
        // 仅发起方写入一条通话记录（单条落库，双方共享同一会话都会收到回执并渲染）
        if (state.role === 'caller' && state.peer) {
            try { Chat.saveCallRecord('USER', state.peer.id, resultCode, dur); } catch (e) {}
        }
        cleanup();
        hideCalling(); hideInCall(); hideIncoming();
        if (notify !== false && msg) App.notify(msg);
    }

    function cleanup() {
        if (state.localStream) { state.localStream.getTracks().forEach(function (t) { t.stop(); }); state.localStream = null; }
        if (state.pc) { try { state.pc.close(); } catch (e) {} state.pc = null; }
        state.remoteStream = null;
        state.peer = null;
        state.role = null;
        state.callId = null;
        state._offerSdp = null;
        state.iceQueue = [];
        var a = el('call-remote-audio'); if (a) { try { a.srcObject = null; } catch (e) {} }
    }

    function isActive() { return !!(state.pc || state.role); }
    function isIncomingShown() { var m = el('call-incoming'); return m && !m.classList.contains('hidden'); }
    function clearRinging() { if (state.ringingTimer) { clearTimeout(state.ringingTimer); state.ringingTimer = null; } }
    function stopDuration() { if (state.durationTimer) { clearInterval(state.durationTimer); state.durationTimer = null; } }

    function startDuration() {
        state.connected = true;
        state.startTs = Date.now();
        var durEl = el('call-duration');
        if (durEl) durEl.textContent = '00:00';
        state.durationTimer = setInterval(function () {
            if (durEl) durEl.textContent = fmtDur(Date.now() - state.startTs);
        }, 1000);
    }
    function fmtDur(ms) {
        var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s = s % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    /* ---------- 静音 ---------- */
    function toggleMute(btn) {
        if (!state.localStream) return;
        var track = state.localStream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        var muted = !track.enabled;
        if (btn) {
            btn.textContent = muted ? '🔇 取消静音' : '🎙 静音';
            btn.classList.toggle('muted', muted);
        }
    }

    /* ---------- 群内选人 ---------- */
    function openGroupPicker(groupId) {
        Api.groupMembers(groupId).then(function (d) {
            var list = (d && d.data) || [];
            var others = list.filter(function (m) { return m.userId !== App.user.id; });
            showPicker(others);
        }).catch(function () { App.notify('获取群成员失败'); });
    }

    function peerInfo(userId) {
        var conv = App.conversations.find(function (c) { return (c.type === 'USER' && c.id === userId); });
        if (conv) return { id: userId, name: conv.name, avatar: conv.avatar };
        return { id: userId, name: '用户' + userId, avatar: null };
    }

    /* ---------- UI ---------- */
    function showIncoming(peer) {
        var m = el('call-incoming'); if (!m) return;
        m.querySelector('.ci-name').textContent = (peer.name || '对方') + ' 邀请你语音通话';
        var av = m.querySelector('.ci-avatar'); if (av) av.innerHTML = App.avatarHtml({ nickname: peer.name, avatar: peer.avatar });
        m.classList.remove('hidden');
    }
    function hideIncoming() { var m = el('call-incoming'); if (m) m.classList.add('hidden'); }

    function showCalling(peer) {
        var m = el('call-calling'); if (!m) return;
        m.querySelector('.cc-name').textContent = '正在等待 ' + (peer.name || '对方') + ' 接听…';
        var av = m.querySelector('.cc-avatar'); if (av) av.innerHTML = App.avatarHtml({ nickname: peer.name, avatar: peer.avatar });
        m.classList.remove('hidden');
    }
    function hideCalling() { var m = el('call-calling'); if (m) m.classList.add('hidden'); }

    function showInCall(peer) {
        var m = el('call-incall'); if (!m) return;
        m.querySelector('.ci2-name').textContent = peer.name || '对方';
        var av = m.querySelector('.ci2-avatar'); if (av) av.innerHTML = App.avatarHtml({ nickname: peer.name, avatar: peer.avatar });
        var dur = el('call-duration'); if (dur) dur.textContent = '连接中…';
        m.classList.remove('hidden');
    }
    function hideInCall() { var m = el('call-incall'); if (m) m.classList.add('hidden'); }

    function showPicker(members) {
        var modal = el('call-picker');
        var list = el('call-picker-list');
        if (!modal || !list) { App.notify('群语音通话面板未加载'); return; }
        if (!members.length) { App.notify('群里没有其他成员'); return; }
        list.innerHTML = members.map(function (m) {
            var name = m.nickname || m.username || ('用户' + m.userId);
            var av = App.avatarHtml({ nickname: name, avatar: m.avatar });
            return '<div class="picker-item" onclick="Call.callFromPicker(' + m.userId + ',\''
                + (name || '').replace(/'/g, "\\'") + '\',\''
                + (m.avatar || '').replace(/'/g, "\\'") + '\')">' + av + '<span>' + App.escapeHtml(name) + '</span></div>';
        }).join('');
        modal.classList.remove('hidden');
    }
    function hidePicker() { var modal = el('call-picker'); if (modal) modal.classList.add('hidden'); }

    function callFromPicker(userId, name, avatar) {
        hidePicker();
        callUser({ id: userId, name: name, avatar: avatar || null });
    }

    return {
        startCallFromCurrent: startCallFromCurrent,
        onSignal: onSignal,
        acceptCall: acceptCall,
        rejectCall: rejectCall,
        hangup: hangup,
        toggleMute: toggleMute,
        callFromPicker: callFromPicker,
        hidePicker: hidePicker,
        _state: state,
        _sendSignal: sendSignal
    };
})();
