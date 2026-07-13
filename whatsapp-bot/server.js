const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const wa = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

wa.setSocketIo(io);

// === API ROUTES ===

app.get('/api/status', (req, res) => {
  res.json(wa.getStatus());
});

app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

app.get('/api/conversations', (req, res) => {
  res.json(db.getConversations());
});

app.get('/api/messages/:phone', (req, res) => {
  const messages = db.getMessages(req.params.phone);
  res.json(messages);
});

app.post('/api/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'Phone and text required' });
  const result = await wa.sendMessage(phone, text);
  res.json({ ok: !!result });
});

app.post('/api/broadcast', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const result = await wa.sendBroadcast(text);
  res.json(result);
});

app.get('/api/auto-replies', (req, res) => {
  res.json(db.getAutoReplies());
});

app.post('/api/auto-replies', (req, res) => {
  const { trigger, response, matchType } = req.body;
  if (!trigger || !response) return res.status(400).json({ error: 'Trigger and response required' });
  const result = db.addAutoReply(trigger, response, matchType);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/auto-replies/:id', (req, res) => {
  db.deleteAutoReply(parseInt(req.params.id));
  res.json({ ok: true });
});

app.put('/api/auto-replies/:id/toggle', (req, res) => {
  db.toggleAutoReply(parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  const keys = ['bot_name', 'welcome_message', 'auto_reply_enabled', 'ai_reply_enabled', 'prefix'];
  const settings = {};
  for (const key of keys) settings[key] = db.getSetting(key);
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    db.setSetting(key, value);
  }
  res.json({ ok: true });
});

app.get('/api/logout', (req, res) => {
  wa.logout();
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === SOCKET.IO ===

io.on('connection', (socket) => {
  console.log('🔌 Painel conectado:', socket.id);
  socket.emit('connection', wa.getStatus().status);

  socket.on('disconnect', () => {
    console.log('🔌 Painel desconectado:', socket.id);
  });
});

// === START ===

const PORT = process.env.BOT_PORT || 3001;

server.listen(PORT, () => {
  console.log(`\n🚀 Corvo WhatsApp Bot`);
  console.log(`📡 Painel: http://localhost:${PORT}`);
  console.log(`📡 API:    http://localhost:${PORT}/api/status\n`);
  wa.startBot();
});
