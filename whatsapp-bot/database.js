const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bot.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    is_group INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_phone TEXT NOT NULL,
    from_me INTEGER DEFAULT 0,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contact_phone) REFERENCES contacts(phone)
  );

  CREATE TABLE IF NOT EXISTS auto_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    response TEXT NOT NULL,
    match_type TEXT DEFAULT 'contains',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const defaultSettings = {
  bot_name: 'Corvo Bot',
  welcome_message: 'Olá! 👋 Bem-vindo ao Corvo Bot. Como posso ajudar?',
  auto_reply_enabled: '1',
  ai_reply_enabled: '0',
  prefix: '!',
};

for (const [key, value] of Object.entries(defaultSettings)) {
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
  if (!existing) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

module.exports = {
  db,

  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },

  addContact(phone, name = '', isGroup = 0) {
    const existing = db.prepare('SELECT phone FROM contacts WHERE phone = ?').get(phone);
    if (!existing) {
      db.prepare('INSERT INTO contacts (phone, name, is_group) VALUES (?, ?, ?)').run(phone, name, isGroup);
    } else if (name && !existing.name) {
      db.prepare('UPDATE contacts SET name = ? WHERE phone = ?').run(name, phone);
    }
  },

  getContacts() {
    return db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
  },

  addMessage(contactPhone, fromMe, content, messageType = 'text') {
    db.prepare('INSERT INTO messages (contact_phone, from_me, content, message_type) VALUES (?, ?, ?, ?)').run(
      contactPhone, fromMe ? 1 : 0, content, messageType
    );
  },

  getMessages(contactPhone, limit = 50) {
    return db.prepare('SELECT * FROM messages WHERE contact_phone = ? ORDER BY timestamp DESC LIMIT ?').all(
      contactPhone, limit
    ).reverse();
  },

  getConversations() {
    return db.prepare(`
      SELECT c.*, m.content as last_message, m.timestamp as last_time, m.from_me as last_from_me
      FROM contacts c
      LEFT JOIN messages m ON m.contact_phone = c.phone
      WHERE m.id = (SELECT MAX(id) FROM messages WHERE contact_phone = c.phone)
      ORDER BY m.timestamp DESC
    `).all();
  },

  addAutoReply(trigger, response, matchType = 'contains') {
    return db.prepare('INSERT INTO auto_replies (trigger, response, match_type) VALUES (?, ?, ?)').run(
      trigger, response, matchType
    );
  },

  getAutoReplies() {
    return db.prepare('SELECT * FROM auto_replies ORDER BY id DESC').all();
  },

  deleteAutoReply(id) {
    db.prepare('DELETE FROM auto_replies WHERE id = ?').run(id);
  },

  toggleAutoReply(id) {
    db.prepare('UPDATE auto_replies SET enabled = NOT enabled WHERE id = ?').run(id);
  },

  findAutoReply(text) {
    const replies = db.prepare('SELECT * FROM auto_replies WHERE enabled = 1').all();
    for (const reply of replies) {
      const trigger = reply.trigger.toLowerCase();
      const msg = text.toLowerCase();
      if (reply.match_type === 'exact' && msg === trigger) return reply;
      if (reply.match_type === 'contains' && msg.includes(trigger)) return reply;
      if (reply.match_type === 'starts' && msg.startsWith(trigger)) return reply;
    }
    return null;
  },

  getStats() {
    const totalContacts = db.prepare('SELECT COUNT(*) as count FROM contacts').get().count;
    const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
    const todayMessages = db.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE date(timestamp) = date('now')"
    ).get().count;
    return { totalContacts, totalMessages, todayMessages };
  }
};
