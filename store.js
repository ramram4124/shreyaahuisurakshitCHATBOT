'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENT STORE
//
// Replaces the in-memory Map so conversation history and the user registry
// survive bot restarts (critical on Railway where processes restart on deploy).
//
// Storage: a single JSON file at STORE_PATH (default: ./store.json).
// On Railway, set STORE_PATH to a path inside a mounted persistent volume,
// e.g. STORE_PATH=/data/store.json
//
// Structure of store.json:
// {
//   "conversations": {
//     "<userId>": [{ role, content }, ...]    ← rolling window, max 16 msgs
//   },
//   "users": {
//     "<userId>": { firstSeen, lastSeen, name?, messageCount }
//   },
//   "totalMessages": 0
// }
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const STORE_PATH     = process.env.STORE_PATH || path.join(__dirname, 'store.json');
const MAX_HISTORY    = 16; // max messages kept per user (8 pairs)

// ── In-memory cache ───────────────────────────────────────────────────────────

let _store = { conversations: {}, users: {}, totalMessages: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// LOAD / SAVE
// ─────────────────────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      _store = {
        conversations:  parsed.conversations  || {},
        users:          parsed.users          || {},
        totalMessages:  parsed.totalMessages  || 0,
      };
      const userCount = Object.keys(_store.users).length;
      console.log(`📦  Store loaded: ${userCount} known user(s), ${_store.totalMessages} total messages.`);
    } else {
      console.log('📦  No existing store found — starting fresh.');
    }
  } catch (err) {
    console.warn('⚠️   Could not load store, starting fresh:', err.message);
    _store = { conversations: {}, users: {}, totalMessages: 0 };
  }
}

/** Atomic write: write to temp file then rename so a crash never corrupts the store. */
function save() {
  try {
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('❌  Could not save store:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION HISTORY
// ─────────────────────────────────────────────────────────────────────────────

function getHistory(userId) {
  if (!_store.conversations[userId]) _store.conversations[userId] = [];
  return _store.conversations[userId];
}

function appendToHistory(userId, role, content) {
  if (!_store.conversations[userId]) _store.conversations[userId] = [];
  const history = _store.conversations[userId];
  history.push({ role, content });

  // Keep rolling window
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  _store.totalMessages++;
  save();
}

function resetHistory(userId) {
  _store.conversations[userId] = [];
  save();
}

// ─────────────────────────────────────────────────────────────────────────────
// USER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called on every inbound message to keep the user registry up to date.
 * @param {string} userId   WhatsApp JID, e.g. "919876543210@c.us"
 * @param {string} [name]   Display name from the WhatsApp contact, if available
 */
function touchUser(userId, name) {
  const now = Date.now();
  if (!_store.users[userId]) {
    _store.users[userId] = { firstSeen: now, lastSeen: now, messageCount: 0 };
  }
  const u = _store.users[userId];
  u.lastSeen = now;
  u.messageCount = (u.messageCount || 0) + 1;
  if (name && name.trim()) u.name = name.trim();
  save();
}

function getAllUserIds() {
  return Object.keys(_store.users);
}

function getUserCount() {
  return Object.keys(_store.users).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────

function getStats() {
  const userIds  = Object.keys(_store.users);
  const users    = _store.users;

  const topUsers = userIds
    .sort((a, b) => (users[b].messageCount || 0) - (users[a].messageCount || 0))
    .slice(0, 5)
    .map(id => {
      const shortId = id.replace('@c.us', '');
      const u = users[id];
      return `${u.name ? u.name + ' (' + shortId + ')' : shortId}: ${u.messageCount} msgs`;
    });

  return {
    totalUsers:    userIds.length,
    totalMessages: _store.totalMessages,
    topUsers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

load(); // Load on require

module.exports = {
  getHistory,
  appendToHistory,
  resetHistory,
  touchUser,
  getAllUserIds,
  getUserCount,
  getStats,
};
