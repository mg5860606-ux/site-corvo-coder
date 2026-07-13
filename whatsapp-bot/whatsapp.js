const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const path = require('path');
const db = require('./database');

const AUTH_DIR = path.join(__dirname, 'auth_info');
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let io = null;

function setSocketIo(socketIo) {
  io = socketIo;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Corvo WhatsApp Bot', 'Safari', '3.0'],
    markOnlineOnConnect: true,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionStatus = 'qr_ready';
      console.log('\n📱 Escaneie o QR Code abaixo com seu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      if (io) io.emit('qr', qr);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`❌ Conexão fechada. Razão: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        connectionStatus = 'logged_out';
        console.log('🚪 Sessão encerrada. Escaneie o QR novamente.');
      } else {
        connectionStatus = 'reconnecting';
        console.log('🔄 Reconectando...');
        setTimeout(startBot, 3000);
      }
      if (io) io.emit('connection', connectionStatus);
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCode = null;
      console.log('✅ Bot conectado ao WhatsApp!');
      if (io) io.emit('connection', connectionStatus);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const pushName = msg.pushName || '';
      const text = getTextFromMessage(msg.message);

      db.addContact(from, pushName, isGroup ? 1 : 0);
      db.addMessage(from, false, text || '[Mídia]', getMessageType(msg.message));

      console.log(`📩 ${isGroup ? ' Grupo' : ' DM'} de ${pushName || from}: ${text}`);

      if (io) {
        io.emit('new_message', {
          from,
          pushName,
          text,
          isGroup,
          timestamp: new Date().toISOString()
        });
      }

      if (!isGroup && text) {
        const autoReply = db.findAutoReply(text);
        if (autoReply) {
          await sendMessage(from, autoReply.response);
          continue;
        }

        const aiEnabled = db.getSetting('ai_reply_enabled');
        if (aiEnabled === '1') {
          await sendAIReply(from, text, pushName);
        }
      }
    }
  });

  return sock;
}

function getTextFromMessage(message) {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return null;
}

function getMessageType(message) {
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  return 'text';
}

async function sendMessage(jid, text) {
  if (!sock) return null;
  try {
    const sentMsg = await sock.sendMessage(jid, { text });
    db.addMessage(jid, true, text);
    return sentMsg;
  } catch (err) {
    console.error('❌ Erro ao enviar mensagem:', err.message);
    return null;
  }
}

async function sendMediaMessage(jid, buffer, caption = '', type = 'image') {
  if (!sock) return null;
  try {
    const msg = {};
    if (type === 'image') msg.image = buffer;
    if (type === 'video') msg.video = buffer;
    if (type === 'audio') msg.audio = buffer;
    if (type === 'document') msg.document = buffer;
    if (caption) msg.caption = caption;

    const sentMsg = await sock.sendMessage(jid, msg);
    db.addMessage(jid, true, caption || `[${type}]`, type);
    return sentMsg;
  } catch (err) {
    console.error('❌ Erro ao enviar mídia:', err.message);
    return null;
  }
}

async function sendAIReply(from, text, pushName = '') {
  const reply = `Olá ${pushName}! 👋 Recebi sua mensagem: "${text}"\n\nEste é um bot automático. Para falar com um humano, aguarde um momento.`;
  await sendMessage(from, reply);
}

async function sendBroadcast(text) {
  if (!sock) return;
  const contacts = db.getContacts().filter(c => !c.is_group);
  let sent = 0;
  for (const contact of contacts) {
    try {
      await sock.sendMessage(contact.phone, { text });
      sent++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`❌ Falha ao enviar para ${contact.phone}: ${err.message}`);
    }
  }
  return { total: contacts.length, sent };
}

function getStatus() {
  return {
    status: connectionStatus,
    hasQr: !!qrCode,
    phone: sock?.user?.id?.replace(/:.*@/, '@') || null,
    name: sock?.user?.name || null,
  };
}

function logout() {
  if (sock) {
    sock.logout();
    sock = null;
  }
  connectionStatus = 'logged_out';
  qrCode = null;
}

module.exports = {
  startBot,
  sendMessage,
  sendMediaMessage,
  sendBroadcast,
  getStatus,
  logout,
  setSocketIo,
};
