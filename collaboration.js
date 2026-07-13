// === COLLABORATION WEB SOCKET MODULE ===
// Real-time multiplayer collaboration for Corvo Coder VS Code

let collabWss = null;
const WebSocket = require('ws');

const USER_COLORS = ['#7c5cfc','#22c55e','#f472b6','#3b82f6','#eab308','#ef4444','#14b8a6','#f97316'];

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getFreeColor(room) {
    const used = new Set();
    for (const [, u] of room.users) if (u.color) used.add(u.color);
    for (const c of USER_COLORS) if (!used.has(c)) return c;
    return USER_COLORS[room.users.size % USER_COLORS.length];
}

function broadcastOthers(room, senderWs, type, data) {
    const sender = room.users.get(senderWs);
    const msg = JSON.stringify({
        type, data,
        sender: sender ? { id: sender.id, name: sender.name, color: sender.color } : null
    });
    for (const [ws] of room.users) {
        if (ws !== senderWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

function usersList(room) {
    return Array.from(room.users.values()).map(u => ({ id: u.id, name: u.name, color: u.color }));
}

function setupCollab(server) {
    collabWss = new WebSocket.Server({ server, path: '/collaboration' });
    console.log('[COLLAB] WebSocket ready on /collaboration');
    
    const rooms = new Map(); // roomCode -> { code, users: Map<ws->user>, files: {} }

    collabWss.on('connection', (ws) => {
        let currentRoom = null, userData = null;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30000);

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                switch (msg.type) {
                    case 'create_room': {
                        const code = generateRoomCode();
                        const room = { code, users: new Map(), files: {} };
                        userData = {
                            id: msg.userId || 'u' + Date.now().toString(36),
                            name: msg.userName || 'Anônimo',
                            color: getFreeColor(room)
                        };
                        room.users.set(ws, userData);
                        rooms.set(code, room);
                        currentRoom = room;
                        ws.send(JSON.stringify({
                            type: 'room_joined',
                            data: {
                                roomCode: code, userId: userData.id,
                                userName: userData.name, userColor: userData.color,
                                files: room.files, users: usersList(room)
                            }
                        }));
                        console.log('[COLLAB] Sala', code, 'criada por', userData.name);
                        break;
                    }
                    case 'join_room': {
                        const code = (msg.roomCode || '').toUpperCase();
                        const room = rooms.get(code);
                        if (!room) {
                            ws.send(JSON.stringify({ type: 'room_error', data: { message: 'Sala não encontrada' } }));
                            return;
                        }
                        userData = {
                            id: msg.userId || 'u' + Date.now().toString(36),
                            name: msg.userName || 'Anônimo',
                            color: getFreeColor(room)
                        };
                        room.users.set(ws, userData);
                        currentRoom = room;
                        ws.send(JSON.stringify({
                            type: 'room_joined',
                            data: {
                                roomCode: code, userId: userData.id,
                                userName: userData.name, userColor: userData.color,
                                files: room.files, users: usersList(room)
                            }
                        }));
                        broadcastOthers(room, ws, 'user_joined', {
                            id: userData.id, name: userData.name,
                            color: userData.color, userCount: room.users.size
                        });
                        broadcastOthers(room, null, 'user_count', {
                            count: room.users.size, users: usersList(room)
                        });
                        console.log('[COLLAB]', userData.name, 'entrou na sala', code, `(${room.users.size} usuários)`);
                        break;
                    }
                    case 'file_change': {
                        if (!currentRoom || !userData) return;
                        if (msg.data.path) {
                            currentRoom.files[msg.data.path] = msg.data.content;
                        }
                        broadcastOthers(currentRoom, ws, 'file_change', {
                            path: msg.data.path, content: msg.data.content
                        });
                        break;
                    }
                    case 'cursor_update': {
                        if (!currentRoom || !userData) return;
                        broadcastOthers(currentRoom, ws, 'cursor_update', {
                            userId: userData.id, userName: userData.name,
                            userColor: userData.color, filePath: msg.data.filePath,
                            lineNumber: msg.data.lineNumber, column: msg.data.column
                        });
                        break;
                    }
                    case 'request_files': {
                        if (!currentRoom) return;
                        ws.send(JSON.stringify({ type: 'file_sync', data: { files: currentRoom.files || {} } }));
                        break;
                    }
                }
            } catch (e) { console.log('[COLLAB] Erro:', e.message); }
        });

        ws.on('close', () => {
            clearInterval(ping);
            if (currentRoom && userData) {
                currentRoom.users.delete(ws);
                if (currentRoom.users.size === 0) {
                    rooms.delete(currentRoom.code);
                    console.log('[COLLAB] Sala', currentRoom.code, 'fechada');
                } else {
                    broadcastOthers(currentRoom, ws, 'user_left', { id: userData.id, name: userData.name });
                    broadcastOthers(currentRoom, null, 'user_count', {
                        count: currentRoom.users.size, users: usersList(currentRoom)
                    });
                    console.log('[COLLAB]', userData.name, 'saiu da sala', currentRoom.code,
                        `(${currentRoom.users.size} restantes)`);
                }
            }
        });
    });
}

module.exports = { setupCollab };