// ============================================================
//  users.js  –  Multi-user management
//  Stores/reads data/users.json
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const OWNER_PHONE = '+917025217998';

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    const initial = {
      [OWNER_PHONE]: {
        name: 'Arun',
        plan: 'owner',
        credits: 999999,
        totalBuilds: 0,
        joinedAt: new Date().toISOString().split('T')[0]
      }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function read() {
  ensureFile();
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

function write(data) {
  ensureFile();
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function normalize(phoneNumber) {
  return phoneNumber.replace('whatsapp:', '');
}

function isOwner(phoneNumber) {
  return normalize(phoneNumber) === OWNER_PHONE;
}

function getUser(phoneNumber) {
  return read()[normalize(phoneNumber)] || null;
}

// Creates a new free user; returns the user object
function registerUser(phoneNumber) {
  const phone = normalize(phoneNumber);
  const users = read();
  if (!users[phone]) {
    users[phone] = {
      name: phone,
      plan: 'free',
      credits: 3,
      totalBuilds: 0,
      joinedAt: new Date().toISOString().split('T')[0]
    };
    write(users);
  }
  return users[phone];
}

// Deduct 1 credit and increment totalBuilds (no-op for owner credits, still increments builds)
function deductCredit(phoneNumber) {
  const phone = normalize(phoneNumber);
  const users = read();
  if (!users[phone]) return;
  if (!isOwner(phoneNumber)) {
    users[phone].credits = Math.max(0, (users[phone].credits || 0) - 1);
  }
  users[phone].totalBuilds = (users[phone].totalBuilds || 0) + 1;
  write(users);
}

// Add credits to a user by their phone number (e.g. "+917025217998")
function addCredits(phoneNumber, amount) {
  const phone = normalize(phoneNumber);
  const users = read();
  if (!users[phone]) return false;
  users[phone].credits = (users[phone].credits || 0) + amount;
  write(users);
  return true;
}

function getAllUsers() {
  return read();
}

module.exports = { getUser, registerUser, deductCredit, addCredits, getAllUsers, isOwner };
