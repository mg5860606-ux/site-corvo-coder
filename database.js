const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'corvo.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        credits INTEGER DEFAULT 100,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT DEFAULT 'Nova Conversa',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        files_json TEXT,
        code TEXT,
        type TEXT DEFAULT 'text',
        source TEXT,
        has_images INTEGER DEFAULT 0,
        has_audio INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT,
        size INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
`);

// Migration: add plan + stripe columns if missing
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT"); } catch {}

function hashPassword(password, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
}

function verifyPassword(password, hash, salt) {
    const result = crypto.scryptSync(password, salt, 64).toString('hex');
    return result === hash;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Clean expired sessions periodically
setInterval(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}, 60 * 60 * 1000);

module.exports = {
    db,

    // === AUTH ===
    register(name, email, password) {
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) return { error: 'Email já cadastrado' };
        const { hash, salt } = hashPassword(password);
        const id = 'user-' + crypto.randomBytes(8).toString('hex');
        db.prepare('INSERT INTO users (id, name, email, password_hash, salt) VALUES (?, ?, ?, ?, ?)').run(id, name, email, hash, salt);
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, id, expiresAt);
        return { token, user: { id, name, email, credits: 100 } };
    },

    login(email, password) {
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!user) return { error: 'Email não encontrado' };
        if (!verifyPassword(password, user.password_hash, user.salt)) return { error: 'Senha incorreta' };
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);
        return { token, user: { id: user.id, name: user.name, email: user.email, credits: user.credits } };
    },

    getSession(token) {
        if (!token) return null;
        const session = db.prepare("SELECT s.*, u.name, u.email, u.credits, u.plan, u.stripe_customer_id, u.stripe_subscription_id FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token);
        if (!session) return null;
        return { id: session.user_id, name: session.name, email: session.email, credits: session.credits, plan: session.plan || 'free', stripe_customer_id: session.stripe_customer_id, stripe_subscription_id: session.stripe_subscription_id };
    },

    logout(token) {
        if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },

    getUser(id) {
        return db.prepare('SELECT id, name, email, credits, created_at FROM users WHERE id = ?').get(id);
    },
    getUserByEmail(email) {
        return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    },

    // === CREDITS ===
    getCredits(userId) {
        const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
        return user ? user.credits : 0;
    },
    setCredits(userId, credits) {
        db.prepare('UPDATE users SET credits = ?, updated_at = datetime("now") WHERE id = ?').run(credits, userId);
    },
    useCredit(userId) {
        const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
        if (user && user.credits > 0) {
            db.prepare('UPDATE users SET credits = credits - 1, updated_at = datetime("now") WHERE id = ?').run(userId);
            return true;
        }
        return false;
    },

    // === CHATS ===
    listChats(userId) {
        return db.prepare('SELECT id, title, created_at, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    },
    getChat(chatId) {
        return db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    },
    createChat(userId, title) {
        const result = db.prepare('INSERT INTO chats (user_id, title) VALUES (?, ?)').run(userId, title || 'Nova Conversa');
        return result.lastInsertRowid;
    },
    updateChatTitle(chatId, title) {
        db.prepare('UPDATE chats SET title = ?, updated_at = datetime("now") WHERE id = ?').run(title, chatId);
    },
    deleteChat(chatId) {
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM files WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
    },

    // === MESSAGES ===
    getMessages(chatId) {
        return db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId);
    },
    addMessage(chatId, role, content, extra = {}) {
        const result = db.prepare(`INSERT INTO messages (chat_id, role, content, files_json, code, type, source, has_images, has_audio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            chatId, role, content,
            extra.filesJson || null,
            extra.code || null,
            extra.type || 'text',
            extra.source || null,
            extra.hasImages ? 1 : 0,
            extra.hasAudio ? 1 : 0
        );
        db.prepare('UPDATE chats SET updated_at = datetime("now") WHERE id = ?').run(chatId);
        return result.lastInsertRowid;
    },

    // === FILES ===
    getChatFiles(chatId) {
        const rows = db.prepare('SELECT file_path, content, size FROM files WHERE chat_id = ?').all(chatId);
        const files = {};
        for (const row of rows) {
            files[row.file_path] = { content: row.content, size: row.size };
        }
        return files;
    },
    saveChatFiles(chatId, filesObj) {
        db.prepare('DELETE FROM files WHERE chat_id = ?').run(chatId);
        const insert = db.prepare('INSERT INTO files (chat_id, file_path, content, size) VALUES (?, ?, ?, ?)');
        for (const [filePath, file] of Object.entries(filesObj)) {
            if (file && file.content) {
                insert.run(chatId, filePath, file.content, file.size || file.content.length);
            }
        }
    },
    mergeChatFiles(chatId, newFiles) {
        const existing = this.getChatFiles(chatId);
        for (const [path, file] of Object.entries(newFiles)) {
            if (file && file.content) {
                existing[path] = { content: file.content, size: file.size || file.content.length };
            }
        }
        this.saveChatFiles(chatId, existing);
        return existing;
    },

    // === PLAN / STRIPE ===
    setPlan(userId, plan, credits) {
        db.prepare('UPDATE users SET plan = ?, credits = ?, updated_at = datetime("now") WHERE id = ?').run(plan, credits, userId);
    },
    setStripeIds(userId, customerId, subscriptionId) {
        if (customerId) db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);
        if (subscriptionId) db.prepare('UPDATE users SET stripe_subscription_id = ? WHERE id = ?').run(subscriptionId, userId);
    },
    getUserByStripeCustomer(customerId) {
        return db.prepare('SELECT id, name, email, credits, plan FROM users WHERE stripe_customer_id = ?').get(customerId);
    },
    getUserByStripeSub(subscriptionId) {
        return db.prepare('SELECT id, name, email, credits, plan FROM users WHERE stripe_subscription_id = ?').get(subscriptionId);
    }
};
