const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'database.json');
const ADMIN_PIN_HASH = '350170068158c30c3ad7bbbb1325d03828989a3ad4c004be51c6c53e085bb946';

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function getDmKey(u1, u2) {
  return [u1, u2].sort().join(':::');
}

let db = {
  users: {
    'admin': { pinHash: ADMIN_PIN_HASH, isBlocked: false }
  },
  messages: [],
  dms: {} // Format: "user1:::user2": [ { id, sender, recipient, text, time } ]
};

if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE));
    if (!db.users['admin']) {
      db.users['admin'] = { pinHash: ADMIN_PIN_HASH, isBlocked: false };
    }
    if (!db.dms) db.dms = {};
  } catch (e) {
    console.error("Error reading database:", e);
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

app.use(express.static(path.join(__dirname, 'public')));

const onlineUsers = new Map();

function broadcastOnlineUsers() {
  const usersList = Array.from(new Set(onlineUsers.values()));
  io.emit('update_online_users', usersList);
}

function validateUser(username, pin) {
  const user = db.users[username];
  if (!user) return { valid: false, error: "User does not exist." };
  if (user.isBlocked) return { valid: false, error: "This user account is blocked." };
  if (user.pinHash !== hashPin(pin)) return { valid: false, error: "Incorrect PIN." };
  return { valid: true, user };
}

io.on('connection', (socket) => {
  
  socket.on('login', ({ username, pin }, callback) => {
    username = username.trim();
    pin = String(pin).trim();

    if (!username || !pin) return callback({ success: false, error: "Name and PIN required." });

    if (db.users[username]) {
      const check = validateUser(username, pin);
      if (!check.valid) return callback({ success: false, error: check.error });
    } else {
      db.users[username] = { pinHash: hashPin(pin), isBlocked: false };
      saveData();
    }

    socket.username = username;
    socket.join(username); // Socket room for private DMs
    onlineUsers.set(socket.id, username);
    broadcastOnlineUsers();

    callback({
      success: true,
      isAdmin: username === 'admin',
      messages: db.messages,
      allUsers: Object.keys(db.users)
    });
  });

  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
    }
  });

  /* --- Public Chat --- */
  socket.on('send_message', ({ username, pin, text }) => {
    const check = validateUser(username, pin);
    if (!check.valid || !text.trim()) return;

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
      username,
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    db.messages.push(msg);
    saveData();
    io.emit('new_message', msg);
  });

  socket.on('delete_message', ({ username, pin, messageId }) => {
    const check = validateUser(username, pin);
    if (!check.valid) return;

    const index = db.messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    if (db.messages[index].username === username || username === 'admin') {
      db.messages.splice(index, 1);
      saveData();
      io.emit('message_deleted', messageId);
    }
  });

  socket.on('edit_message', ({ username, pin, messageId, newText }) => {
    const check = validateUser(username, pin);
    if (!check.valid || !newText.trim()) return;

    const msg = db.messages.find(m => m.id === messageId);
    if (msg && msg.username === username) {
      msg.text = newText.trim();
      saveData();
      io.emit('message_edited', { id: messageId, newText: msg.text });
    }
  });

  /* --- Direct Messaging (DM) --- */
  socket.on('get_dm_data', ({ username, pin }, callback) => {
    const check = validateUser(username, pin);
    if (!check.valid) return callback({ success: false });

    // Find all active DM partners for this user
    const activePartners = new Set();
    Object.keys(db.dms).forEach(key => {
      const parts = key.split(':::');
      if (parts.includes(username)) {
        const partner = parts[0] === username ? parts[1] : parts[0];
        activePartners.add(partner);
      }
    });

    callback({
      success: true,
      activePartners: Array.from(activePartners),
      allUsers: Object.keys(db.users).filter(u => u !== username)
    });
  });

  socket.on('get_dm_history', ({ username, pin, targetUser }, callback) => {
    const check = validateUser(username, pin);
    if (!check.valid) return callback({ success: false });

    const key = getDmKey(username, targetUser);
    const history = db.dms[key] || [];
    callback({ success: true, history });
  });

  socket.on('send_dm', ({ username, pin, recipient, text }) => {
    const check = validateUser(username, pin);
    if (!check.valid || !text.trim() || !db.users[recipient]) return;

    const key = getDmKey(username, recipient);
    if (!db.dms[key]) db.dms[key] = [];

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
      sender: username,
      recipient,
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    db.dms[key].push(msg);
    saveData();

    // Send real-time event to sender & recipient
    io.to(username).to(recipient).emit('new_dm', { key, msg });
  });

  socket.on('block_user', ({ username, pin, targetUsername }) => {
    const check = validateUser(username, pin);
    if (!check.valid || username !== 'admin') return;

    if (db.users[targetUsername] && targetUsername !== 'admin') {
      db.users[targetUsername].isBlocked = true;
      saveData();
      io.emit('user_blocked', targetUsername);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
