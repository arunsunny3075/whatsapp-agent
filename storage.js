// ============================================================
//  storage.js  –  Deployment history per user
//  Stores/reads data/sites.json
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SITES_FILE)) fs.writeFileSync(SITES_FILE, '{}', 'utf8');
}

function read() {
  ensureFile();
  try { return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); }
  catch { return {}; }
}

function write(data) {
  ensureFile();
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function normalize(phoneNumber) {
  return phoneNumber.replace('whatsapp:', '');
}

// siteInfo = { siteId, siteName, siteUrl, requirement, builtAt }
function saveDeployment(phoneNumber, siteInfo) {
  const phone = normalize(phoneNumber);
  const data = read();
  if (!data[phone]) data[phone] = [];
  data[phone].unshift(siteInfo);       // newest first
  data[phone] = data[phone].slice(0, 10); // keep last 10
  write(data);
}

function getLastDeployment(phoneNumber) {
  const phone = normalize(phoneNumber);
  return (read()[phone] || [])[0] || null;
}

function getAllDeployments(phoneNumber) {
  const phone = normalize(phoneNumber);
  return (read()[phone] || []).slice(0, 5);
}

function deleteDeployment(phoneNumber, siteId) {
  const phone = normalize(phoneNumber);
  const data = read();
  if (data[phone]) data[phone] = data[phone].filter(s => s.siteId !== siteId);
  write(data);
}

module.exports = { saveDeployment, getLastDeployment, getAllDeployments, deleteDeployment };
