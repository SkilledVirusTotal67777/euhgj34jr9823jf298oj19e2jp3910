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

// Correct SHA-256 Hash of "972"
const ADMIN_PIN_HASH = '3658d7fa3c43456f3c9c87db0490e872039516e6375336254560167cc3db2ea2';

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function getDmKey(u1, u2) {
  return [u1, u2].sort().join(':::');
}

let db = {
  users: {
    'admin': { pinHash: ADMIN_PIN_HASH, isBlocked: false, isMuted: false, nameColor: '#ff4d4d' }
  },
  messages: [],
  dms: {}
};

if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE));
    if (!db.users['admin']) {
      db.users['admin'] = { pinHash: ADMIN_PIN_HASH, isBlocked: false, isMuted: false, nameColor: '#ff4d4d' };
    } else {
      // Force repair admin PIN hash if corrupted
      db.users['admin'].pinHash = ADMIN_PIN_HASH;
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

const onlineUsers = new Map(); // socket.id -> username
const userSpamTracker = new Map(); // username -> lastMessageTimestamp

// Derogatory slur filter regex
const SLUR_REGEX = /\b(nigg[aerx]s?|fagg?ots?|kikes?|chinks?|spics?|retards?|cunts?|trannys?)\b/i;

const FUNNY_REPLACEMENTS = [
  "said a no no word! :(",
  "lost their talking privileges for saying something silly! 🙈",
  "accidentally dropped their ice cream on the floor! 🍦",
  "tried to speak alien language! 👾",
  "forgot how to use polite words! 🤐"
];

function broadcastOnlineUsers() {
  const usersList = Array.from(new Set(onlineUsers.values())).map(u => ({
    username: u,
    color: db.users[u]?.nameColor || '#4caf50',
    isMuted: db.users[u]?.isMuted || false
  }));
  io.emit('update_online_users', usersList);
}

function validateUser(username, pin) {
  const user = db.users[username];
  if (!user) return { valid: false, error: "User does not exist." };
  if (user.isBlocked) return { valid: false, error: "This account has been banned by Admin." };
  if (user.pinHash !== hashPin(pin)) return { valid: false, error: "Incorrect PIN for registered account." };
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
      // Register new user account
      db.users[username] = { 
        pinHash: hashPin(pin), 
        isBlocked: false, 
        isMuted: false, 
        nameColor: '#4caf50' 
      };
      saveData();
    }

    socket.username = username;
    socket.join(username);
    onlineUsers.set(socket.id, username);
    broadcastOnlineUsers();

    callback({
      success: true,
      isAdmin: username === 'admin',
      messages: db.messages,
      allUsers: Object.keys(db.users),
      nameColor: db.users[username].nameColor || '#4caf50'
    });
  });

  socket.on('disconnect', () => {
    if (onlineUsers.has(socket.id)) {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
    }
  });

  /* --- Public Chat & Spam/Slur Filter --- */
  socket.on('send_message', ({ username, pin, text }) => {
    const check = validateUser(username, pin);
    if (!check.valid || !text.trim()) return;

    if (check.user.isMuted) {
      return socket.emit('chat_error', '⚠️ You are currently muted by Admin.');
    }

    // Spam Filter: 1 message per second limit
    const now = Date.now();
    const lastTime = userSpamTracker.get(username) || 0;
    if (now - lastTime < 1000) {
      return socket.emit('chat_error', '⚠️ Slow down! Spam filter active (1 msg/sec).');
    }
    userSpamTracker.set(username, now);

    let finalText = text.trim();
    let isFiltered = false;

    // Slur Filter check
    if (SLUR_REGEX.test(finalText)) {
      isFiltered = true;
      const randomFunny = FUNNY_REPLACEMENTS[Math.floor(Math.random() * FUNNY_REPLACEMENTS.length)];
      finalText = `${username} ${randomFunny}`;
    }

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
      username,
      color: check.user.nameColor || '#4caf50',
      text: finalText,
      isFiltered,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    db.messages.push(msg);
    saveData();
    io.emit('new_message', msg);
  });

  /* --- Direct Messaging --- */
  socket.on('get_dm_data', ({ username, pin }, callback) => {
    const check = validateUser(username, pin);
    if (!check.valid) return callback({ success: false });

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

    if (check.user.isMuted) {
      return socket.emit('chat_error', '⚠️ You are muted and cannot send DMs.');
    }

    const now = Date.now();
    const lastTime = userSpamTracker.get(username) || 0;
    if (now - lastTime < 1000) {
      return socket.emit('chat_error', '⚠️ Slow down! Spam filter active.');
    }
    userSpamTracker.set(username, now);

    const key = getDmKey(username, recipient);
    if (!db.dms[key]) db.dms[key] = [];

    let finalText = text.trim();
    let isFiltered = false;

    if (SLUR_REGEX.test(finalText)) {
      isFiltered = true;
      const randomFunny = FUNNY_REPLACEMENTS[Math.floor(Math.random() * FUNNY_REPLACEMENTS.length)];
      finalText = `${username} ${randomFunny}`;
    }

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
      sender: username,
      recipient,
      color: check.user.nameColor || '#4caf50',
      text: finalText,
      isFiltered,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    db.dms[key].push(msg);
    saveData();

    io.to(username).to(recipient).emit('new_dm', { key, msg });
  });

  /* --- Customization & Commands --- */
  socket.on('set_name_color', ({ username, pin, color }) => {
    const check = validateUser(username, pin);
    if (!check.valid) return;

    if (db.users[username]) {
      db.users[username].nameColor = color;
      saveData();
      broadcastOnlineUsers();
      socket.emit('color_updated', color);
    }
  });

  /* --- Admin Controls --- */
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

  socket.on('toggle_mute', ({ username, pin, targetUsername }) => {
    const check = validateUser(username, pin);
    if (!check.valid || username !== 'admin') return;

    if (db.users[targetUsername] && targetUsername !== 'admin') {
      db.users[targetUsername].isMuted = !db.users[targetUsername].isMuted;
      saveData();
      broadcastOnlineUsers();
      io.emit('user_muted_status', { targetUsername, isMuted: db.users[targetUsername].isMuted });
    }
  });

  socket.on('ban_user', ({ username, pin, targetUsername }) => {
    const check = validateUser(username, pin);
    if (!check.valid || username !== 'admin') return;

    if (db.users[targetUsername] && targetUsername !== 'admin') {
      db.users[targetUsername].isBlocked = true;
      saveData();
      io.emit('user_banned', targetUsername);
      broadcastOnlineUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
