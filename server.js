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

// SHA(Whats up motherfucker)
const ADMIN_PIN_HASH = '350170068158c30c3ad7bbbb1325d03828989a3ad4c004be51c6c53e085bb946';

// SHA-256 hashing helper
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Initial Database
let db = {
  users: {
    'admin': { pinHash: ADMIN_PIN_HASH, isBlocked: false }
  },
  messages: []
};

// Load saved data from JSON database file
if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE));
    if (!db.users['admin']) {
      db.users['admin'] = { pinHash: ADMIN_PIN_HASH, isBlocked: false };
    }
  } catch (e) {
    console.error("Error reading database:", e);
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// Serve public HTML/CSS files
app.use(express.static(path.join(__dirname, 'public')));

function validateUser(username, pin) {
  const user = db.users[username];
  if (!user) return { valid: false, error: "User does not exist." };
  if (user.isBlocked) return { valid: false, error: "This user account is blocked." };
  if (user.pinHash !== hashPin(pin)) return { valid: false, error: "Incorrect PIN." };
  return { valid: true, user };
}

io.on('connection', (socket) => {
  // Handle Login & Registration
  socket.on('login', ({ username, pin }, callback) => {
    username = username.trim();
    pin = String(pin).trim();

    if (!username || !pin) return callback({ success: false, error: "Name and PIN required." });

    if (db.users[username]) {
      const check = validateUser(username, pin);
      if (!check.valid) return callback({ success: false, error: check.error });
    } else {
      // Create new account automatically
      db.users[username] = { pinHash: hashPin(pin), isBlocked: false };
      saveData();
    }

    callback({
      success: true,
      isAdmin: username === 'admin',
      messages: db.messages
    });
  });

  // Handle Send Message
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

  // Handle Delete Message
  socket.on('delete_message', ({ username, pin, messageId }) => {
    const check = validateUser(username, pin);
    if (!check.valid) return;

    const index = db.messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    // Only owner or admin can delete
    if (db.messages[index].username === username || username === 'admin') {
      db.messages.splice(index, 1);
      saveData();
      io.emit('message_deleted', messageId);
    }
  });

  // Handle Edit Message
  socket.on('edit_message', ({ username, pin, messageId, newText }) => {
    const check = validateUser(username, pin);
    if (!check.valid || !newText.trim()) return;

    const msg = db.messages.find(m => m.id === messageId);
    // Users can only edit their own messages
    if (msg && msg.username === username) {
      msg.text = newText.trim();
      saveData();
      io.emit('message_edited', { id: messageId, newText: msg.text });
    }
  });

  // Handle Block User (Admin only)
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
