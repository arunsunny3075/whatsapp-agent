// ============================================================
//  conversations.js  –  Per-user conversation memory
//  Stores last job context so users can say "now add X",
//  "also include Y", etc. to build on previous results.
// ============================================================

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'conversations.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persist(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function normalize(phone) {
  return phone.replace(/^whatsapp:/, '').trim();
}

// Returns the conversation record for this user, or null if none / expired
function getConversation(phone) {
  const data = load();
  const entry = data[normalize(phone)];
  if (!entry) return null;
  // Expire after 7 days
  if (Date.now() - new Date(entry.updatedAt).getTime() > MAX_AGE_MS) return null;
  return entry;
}

// Saves / updates the conversation record for this user
// info = { lastRequirement, lastUrl, lastSiteId?, lastGistId?, lastRawUrl?, lastFilename? }
function saveConversation(phone, info) {
  const data = load();
  const key  = normalize(phone);
  data[key]  = {
    ...info,
    updatedAt: new Date().toISOString()
  };
  persist(data);
}

module.exports = { getConversation, saveConversation };
