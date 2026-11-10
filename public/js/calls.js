// public/js/calls.js
// COMBAIN v2 — WebRTC calls

let localStream = null;
let pendingIceCandidates = [];


// ────────────────────────────────────────
// Load ICE servers
// ────────────────────────────────────────

async function loadIceServers() {
  try {
    const config = await apiGetConfig();
    Store._iceServers = Array.isArray(config.ice_servers) ? config.ice_servers
      : (Array.isArray(config.iceServers) ? config.iceServers : []);
    return Store._iceServers;
  } catch (error) {
    console.warn('[CALL] Failed to load ICE servers:', error);
    Store._iceServers = [];
    return [];
  }
}


// ────────────────────────────────────────
// Create peer connection
// ────────────────────────────────────────

function createPeerConnection(callId) {
  const pc = new RTCPeerConnection({ iceServers: Store._iceServers || [] });
  Store.peerConnection = pc;

  pc.ontrack = event => {
    const stream = event.streams?.[0];
    if (!stream) return;
    Store.remoteStream = stream;
    showRemoteVideo(stream);
  };

  pc.onicecandidate = event => {
    if (!event.candidate || !Store.activeCallId) return;
    wsSend('ice_candidate', { callId, candidate: event.candidate.candidate });
  };

  pc.onconnectionstatechange = () => {
 console.log('[CALL] Connection state:', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupCall();
      hideCallUI();
    }
  };

  return pc;
}


// ────────────────────────────────────────
// Outgoing call
// ────────────────────────────────────────

async function makeCall() {
  const roomId = Store.activeRoomId;
  if (!roomId) return;
  if (Store.peerConnection) { toast('A call is already active', 'fail'); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const requestId = 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const pc = createPeerConnection(null);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend('call_offer', { roomId, sdp: offer.sdp }, requestId);
    showCallUI();
  } catch (error) {
    console.warn('[CALL] Failed to start call:', error);
    cleanupCall();
    toast('Cannot access camera/microphone', 'fail');
  }
}


// ────────────────────────────────────────
// Server created call
// ────────────────────────────────────────

function callCreated(payload) {
  if (!payload?.callId) return;
  Store.activeCallId = payload.callId;
  flushPendingIceCandidates();
}


// ────────────────────────────────────────
// Incoming call
// ────────────────────────────────────────

function callIncoming(payload) {
  if (!payload?.callId || !payload?.sdp) return;
  const { callId, sdp, fromUserId } = payload;

  if (Store.peerConnection) {
    // Busy — reject
    wsSend('hangup', { callId });
    return;
  }

  showIncomingCall(
    fromUserId,
    async () => {
      await acceptIncomingCall(callId, sdp);
    },
    () => {
      // Reject
      wsSend('hangup', { callId });
      hideIncomingCall();
    }
  );
}


// ────────────────────────────────────────
// Accept incoming call
// ────────────────────────────────────────

async function acceptIncomingCall(callId, sdp) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    Store.activeCallId = callId;
    const pc = createPeerConnection(callId);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    await pc.setRemoteDescription({ type: 'offer', sdp });
    await flushPendingIceCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend('call_answer', { callId, sdp: answer.sdp });
    showCallUI();
  } catch (error) {
    console.warn('[CALL] Failed to accept call:', error);
    cleanupCall();
    toast('Cannot access camera/microphone', 'fail');
  }
}


// ────────────────────────────────────────
// Answer received
// ────────────────────────────────────────

async function callAnswerReceived(payload) {
  if (!payload?.callId || !payload?.sdp) return;
  if (payload.callId !== Store.activeCallId) return;
  const pc = Store.peerConnection;
  if (!pc) return;
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    await flushPendingIceCandidates();
  } catch (error) {
    console.warn('[CALL] Failed to apply answer:', error);
  }
}


// ────────────────────────────────────────
// ICE received
// ────────────────────────────────────────

async function callIceReceived(payload) {
  if (!payload?.callId || !payload?.candidate) return;
  if (Store.activeCallId && payload.callId !== Store.activeCallId) return;
  const pc = Store.peerConnection;

  if (!pc || !pc.remoteDescription) {
    pendingIceCandidates.push(payload);
    return;
  }

  try { await pc.addIceCandidate({ candidate: payload.candidate }); }
  catch (error) { console.warn('[CALL] ICE candidate failed:', error); }
}


// ────────────────────────────────────────
// Flush buffered ICE
// ────────────────────────────────────────

async function flushPendingIceCandidates() {
  const pc = Store.peerConnection;
  if (!pc || !pc.remoteDescription || pendingIceCandidates.length === 0) return;
  const candidates = pendingIceCandidates.splice(0);
  for (const payload of candidates) {
    if (Store.activeCallId && payload.callId !== Store.activeCallId) continue;
    try { await pc.addIceCandidate({ candidate: payload.candidate }); }
    catch (error) { console.warn('[CALL] Buffered ICE failed:', error); }
  }
}


// ────────────────────────────────────────
// Hangup
// ────────────────────────────────────────

function doHangup() {
  const callId = Store.activeCallId;
  if (callId) wsSend('hangup', { callId });
  cleanupCall();
  hideCallUI();
}


// ────────────────────────────────────────
// Remote hangup
// ────────────────────────────────────────

function callEnded(payload) {
  if (payload?.callId && Store.activeCallId && payload.callId !== Store.activeCallId) return;
  cleanupCall();
  hideCallUI();
  if (typeof hideIncomingCall === 'function') hideIncomingCall();
  toast('Call ended', 'ok');
}


// ────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────

function cleanupCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
    localStream = null;
  }
  if (Store.peerConnection) {
    try { Store.peerConnection.close(); } catch {}
    Store.peerConnection = null;
  }
  Store.remoteStream = null;
  Store.activeCallId = null;
  pendingIceCandidates = [];

  // Stop videos
  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo) remoteVideo.srcObject = null;
  const localVideo = document.getElementById('localVideo');
  if (localVideo) localVideo.srcObject = null;
}


// ────────────────────────────────────────
// Video UI adapters
// ────────────────────────────────────────

function showRemoteVideo(stream) {
  const video = document.getElementById('remoteVideo');
  if (!video) return;
  video.srcObject = stream;
  const result = video.play?.();
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function showLocalVideo(stream) {
  const video = document.getElementById('localVideo');
  if (!video) return;
  video.srcObject = stream;
  video.muted = true;
  const result = video.play?.();
  if (result && typeof result.catch === 'function') result.catch(() => {});
}
