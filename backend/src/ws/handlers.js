const hub = require('./hub');
const store = require('../services/store');

function send(ws, frame) {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame));
}

async function handle(ws, userId, msg) {
  const { type, requestId, payload } = msg || {};
  if (!type) return;
  try {
    switch (type) {
      case 'subscribe':
      case 'rejoin': {
        const roomId = payload?.roomId;
        if (!roomId) break;
        store.requireMember(roomId, userId);
        hub.subscribe(userId, roomId);
        send(ws, { type: type === 'rejoin' ? 'rejoined' : 'subscribed', payload: { roomId } });
        break;
      }
      case 'chat_message': {
        const msgDto = store.createMessage(userId, {
          roomId: payload.roomId, text: payload.text,
          clientMessageId: payload.clientMessageId, replyToId: payload.replyToId, type: 'text',
        });
        hub.broadcastToRoom(payload.roomId, {
          type: 'chat_message', requestId: requestId || payload.clientMessageId, payload: msgDto,
        });
        break;
      }
      case 'media_message': {
        const msgDto = store.createMessage(userId, {
          roomId: payload.roomId, text: payload.text, clientMessageId: payload.clientMessageId,
          replyToId: payload.replyToId, type: payload.type || 'file',
          fileUrl: payload.fileUrl, fileName: payload.fileName,
          fileSize: payload.fileSize, fileMimeType: payload.fileMimeType,
        });
        hub.broadcastToRoom(payload.roomId, {
          type: 'chat_message', requestId: requestId || payload.clientMessageId, payload: msgDto,
        });
        break;
      }
      case 'edit_message': {
        const msgDto = store.editMessage(userId, payload.messageId, payload.text);
        hub.broadcastToRoom(msgDto.roomId, {
          type: 'message_edited', payload: { id: msgDto.id, text: msgDto.text, editedAt: msgDto.editedAt },
        });
        break;
      }
      case 'delete_message': {
        const msgDto = store.softDeleteMessage(userId, payload.messageId);
        hub.broadcastToRoom(msgDto.roomId, {
          type: 'message_deleted', payload: { id: msgDto.id, deletedAt: msgDto.deletedAt },
        });
        break;
      }
      case 'forward_message': {
        const msgDto = store.forwardMessage(userId, {
          messageId: payload.messageId, targetRoomId: payload.targetRoomId,
          clientMessageId: payload.clientMessageId,
        });
        hub.broadcastToRoom(payload.targetRoomId, {
          type: 'chat_message', requestId: requestId || payload.clientMessageId, payload: msgDto,
        });
        break;
      }
      case 'message_reaction': {
        const result = store.toggleReaction(userId, payload.messageId, payload.emoji);
        hub.broadcastToRoom(result.roomId, {
          type: 'message_reaction',
          payload: {
            messageId: result.messageId, userId: result.userId,
            emoji: result.emoji, added: result.added, reactions: result.reactions,
          },
        });
        break;
      }
      case 'messages_read': {
        const { messageIds, roomId } = payload || {};
        // Phase 2: тот же потолок, что и в REST — иначе флуд одним фреймом
        if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > 500) {
          send(ws, { type: 'error', requestId, code: 'VALIDATION_ERROR', message: 'messageIds required, max 500' });
          break;
        }
        store.requireMember(roomId, userId);
        let readCount = 0;
        for (const mid of messageIds || []) {
          try {
            store.db.prepare('INSERT INTO MessageRead (id,messageId,userId,readAt) VALUES (?,?,?,?)')
              .run(store.cuid(), mid, userId, store.now());
            readCount++;
          } catch {}
        }
        send(ws, { type: 'messages_read_ack', requestId, payload: { readCount } });
        hub.broadcastToRoom(roomId, {
          type: 'messages_read', payload: { userId, messageIds },
        }, userId);
        break;
      }
      case 'typing_start': {
        const roomId = payload?.roomId;
        if (!roomId) break;
        hub.setTyping(roomId, userId);
        hub.broadcastToSubscribers(roomId, { type: 'typing_start', payload: { userId, roomId } }, userId);
        break;
      }
      case 'typing_stop': {
        const roomId = payload?.roomId;
        if (!roomId) break;
        hub.clearTyping(roomId, userId);
        hub.broadcastToSubscribers(roomId, { type: 'typing_stop', payload: { userId, roomId } }, userId);
        break;
      }
      case 'call_offer': {
        const roomId = payload?.roomId;
        const callId = 'call_' + Date.now();
        send(ws, { type: 'call_created', requestId, payload: { callId } });
        if (roomId) {
          hub.broadcastToRoom(roomId, {
            type: 'call_offer', payload: { callId, sdp: payload.sdp, fromUserId: userId },
          }, userId);
        }
        break;
      }
      case 'call_answer':
        hub.broadcastAll({ type: 'call_answer', payload: { callId: payload.callId, sdp: payload.sdp } }, userId);
        break;
      case 'ice_candidate':
        hub.broadcastAll({
          type: 'ice_candidate',
          payload: { callId: payload.callId, candidate: payload.candidate, fromUserId: userId },
        }, userId);
        break;
      case 'hangup':
        hub.broadcastAll({ type: 'call_ended', payload: { callId: payload.callId, endedBy: userId } });
        break;
      default:
        send(ws, { type: 'error', requestId, code: 'UNKNOWN_TYPE', message: 'Unknown type: ' + type });
    }
  } catch (err) {
    send(ws, { type: 'error', requestId, code: err.code || 'INTERNAL', message: err.message || 'Error' });
  }
}

module.exports = { handle };
