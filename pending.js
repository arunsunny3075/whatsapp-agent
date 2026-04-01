// ============================================================
//  pending.js  –  Temporary file/URL/email context storage
//  Holds uploaded file content, pasted URLs, or email text
//  so the user can follow up with a plain text instruction.
//  Entries expire after 2 hours.
// ============================================================

const fs   = require('fs');
const path = require('path');

const PENDING_DIR = path.join(__dirname, 'data', 'pending');
const EXPIRY_MS   = 2 * 60 * 60 * 1000; // 2 hours

function normalize(phone) {
  return phone.replace(/^whatsapp:/, '').replace(/[^+\d]/g, '');
}

function pendingPath(phone) {
  return path.join(PENDING_DIR, normalize(phone) + '-pending.json');
}

// Save a pending context for this user
// data = { type, filename?, content, summary }
function savePending(phone, data) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(pendingPath(phone), JSON.stringify({
    ...data,
    receivedAt: new Date().toISOString(),
    expiresAt:  new Date(Date.now() + EXPIRY_MS).toISOString()
  }, null, 2), 'utf8');
}

// Get pending context — returns null if expired or missing
function getPending(phone) {
  try {
    const p = pendingPath(phone);
    if (!fs.existsSync(p)) return null;
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (new Date(entry.expiresAt) < new Date()) {
      fs.unlinkSync(p);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

// Delete pending after it's been used
function clearPending(phone) {
  try {
    const p = pendingPath(phone);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

module.exports = { savePending, getPending, clearPending };
