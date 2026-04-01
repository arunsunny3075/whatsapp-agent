// ============================================================
//  server.js  –  WhatsApp Universal Builder
//
//  Handles: text, voice, image, documents (Excel/Word/PDF/CSV),
//  URL links, email content, multi-media, and more.
//  Builds: web apps (Netlify), code files (GitHub Gist).
// ============================================================

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const twilio     = require('twilio');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const Groq       = require('groq-sdk');

const { runAgent }   = require('./agent');
const { saveDeployment, getLastDeployment, getAllDeployments, deleteDeployment } = require('./storage');
const { getUser, registerUser, deductCredit, addCredits, getAllUsers, isOwner }  = require('./users');
const { getConversation, saveConversation } = require('./conversations');
const { savePending, getPending, clearPending }  = require('./pending');
const { processFile } = require('./fileProcessor');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Clients ─────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

let _groq = null;
function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const jobs = new Map();

// ════════════════════════════════════════════════════════════
//  UTILITY HELPERS
// ════════════════════════════════════════════════════════════

// Safe text preview — avoids ternary-inside-template-literal bugs
function clip(text, len) {
  if (!text) return '';
  return text.length <= len ? text : text.slice(0, len) + '...';
}

function twimlReply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type('text/xml').send(twiml.toString());
}

async function sendWhatsApp(to, body) {
  return twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to, body });
}

async function downloadTwilioMedia(mediaUrl) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
  return response;
}

async function fetchExistingCode(siteUrl) {
  try {
    for (const url of [siteUrl.replace(/\/$/, '') + '/index.html', siteUrl.replace(/\/$/, '') + '/']) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) return (await res.text()).slice(0, 50000);
    }
    return null;
  } catch { return null; }
}

async function fetchGistCode(rawUrl) {
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
    return res.ok ? (await res.text()).slice(0, 50000) : null;
  } catch { return null; }
}

// Guess filename from MIME type when Twilio doesn't provide one
function guessFilename(provided, mimeType) {
  if (provided && provided.trim()) return provided.trim();
  const map = {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document.xlsx',
    'application/vnd.ms-excel':                                          'document.xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document.docx',
    'application/msword': 'document.doc',
    'application/pdf':    'document.pdf',
    'text/csv':           'data.csv',
    'text/plain':         'file.txt',
    'application/json':   'data.json',
    'text/html':          'page.html',
    'text/javascript':    'script.js',
    'text/x-python':      'script.py'
  };
  return map[(mimeType || '').split(';')[0].trim()] || 'attachment';
}

// ════════════════════════════════════════════════════════════
//  UPGRADE 4 — VOICE PROMPT ENHANCER
// ════════════════════════════════════════════════════════════

async function enhancePrompt(rawText) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `You are a prompt engineer for an AI app/code builder.
Take a rough voice note and expand it into a detailed, specific build prompt.
Rules:
- Keep the core idea exactly as intended
- Add UI details (colors, layout, features) for web apps
- Add code quality requirements for code requests
- Add edge cases to handle
- Under 400 words
- Output ONLY the enhanced prompt
- Do not add features the user didn't ask for`
          },
          { role: 'user', content: `Enhance this voice note into a detailed build prompt:\n\n"${rawText}"` }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || rawText;
  } catch (err) {
    console.warn('[enhancePrompt] Failed, using raw text:', err.message);
    return rawText;
  }
}

// ════════════════════════════════════════════════════════════
//  UPGRADE 2 — CONTINUATION DETECTION
// ════════════════════════════════════════════════════════════

const CONTINUATION_PATTERNS = [
  /^now\s/i, /^also\s/i, /^and\s+add\s/i, /^add\s/i, /^remove\s/i,
  /\bthat\s+app\b/i, /\bthe\s+app\b/i, /\bsame\s+app\b/i, /\bprevious\b/i,
  /^change\s/i, /^modify\s/i, /^fix\s/i, /^make\s+it\s/i, /^make\s+the\s/i
];

function isContinuation(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('update:') || lower.startsWith('update last')) return false;
  return CONTINUATION_PATTERNS.some(re => re.test(text));
}

// ════════════════════════════════════════════════════════════
//  UPGRADE 4 — SMART INTENT DETECTION
// ════════════════════════════════════════════════════════════

function detectIntent(message) {
  const intents = {
    dashboard: /dashboard|analytics|metrics|KPI|chart|graph|report/i,
    game:      /\bgame\b|play|score|level|player|enemy/i,
    tool:      /calculator|converter|tracker|planner|scheduler/i,
    website:   /\bwebsite\b|landing page|portfolio|blog|e-commerce/i,
    vba:       /VBA|macro|\.bas\b|spreadsheet automation/i,
    python:    /\bPython\b|script|automate|data pipeline/i,
    sql:       /\bSQL\b|\bSELECT\b|\bquery\b|database report/i,
    clone:     /\blike\b|\bsimilar to\b|inspired by|copy of|same as/i,
    form:      /\bform\b|survey|questionnaire|collect data/i,
    threed:    /\b3[Dd]\b|three\.?js|parallax|glassmorphism|particle/i
  };
  for (const [intent, re] of Object.entries(intents)) {
    if (re.test(message)) return intent;
  }
  return 'general';
}

// ════════════════════════════════════════════════════════════
//  CORE JOB RUNNER
// ════════════════════════════════════════════════════════════

async function runAgentJob(from, requirement, jobId, imageData = null, existingSiteId = null, imageDataArray = null) {
  try {
    const result = await runAgent(requirement, jobId, imageData, existingSiteId, imageDataArray);
    jobs.set(jobId, { ...jobs.get(jobId), status: 'done', result });

    if (result.success) {
      if (result.isGist) {
        saveConversation(from, {
          lastRequirement: requirement.slice(0, 200),
          lastUrl: result.url, lastGistId: result.gistId,
          lastRawUrl: result.rawUrl, lastFilename: result.filename, lastSiteId: null
        });
        deductCredit(from);
        await sendWhatsApp(from,
          `✅ *Code is ready!*\n\n` +
          `📄 File: ${result.filename || 'code'}\n` +
          `🔗 View: ${result.url}\n` +
          `📥 Raw: ${result.rawUrl || result.url}\n\n` +
          `📋 Open the link to copy or download.\n` +
          `💡 The Raw link gives you plain text to paste directly.`
        );
      } else {
        saveDeployment(from, {
          siteId:      result.siteId   || existingSiteId || 'unknown',
          siteName:    result.siteName || 'unknown',
          siteUrl:     result.url,
          requirement: requirement.slice(0, 200),
          builtAt:     new Date().toISOString()
        });
        saveConversation(from, {
          lastRequirement: requirement.slice(0, 200),
          lastUrl: result.url, lastSiteId: result.siteId || existingSiteId || null,
          lastGistId: null, lastRawUrl: null, lastFilename: null
        });
        deductCredit(from);
        await sendWhatsApp(from,
          `✅ *App is live!*\n\n` +
          `🔗 ${result.url}\n\n` +
          `📝 ${clip(result.summary, 300)}`
        );
      }
    } else {
      await sendWhatsApp(from, `❌ *Build failed*\n\n${clip(result.error, 200)}\n\nSend your requirement again to retry.`);
    }

    console.log(`[Job ${jobId}] Reply sent.`);
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);

  } catch (err) {
    console.error(`[Job ${jobId}] Fatal: ${err.message}\n${err.stack}`);
    sendWhatsApp(from, `❌ Something went wrong: ${err.message}\n\nTry again!`).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════
//  VOICE NOTE HANDLER
// ════════════════════════════════════════════════════════════

async function handleVoiceNote(from, mediaUrl, user) {
  const tempPath = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  try {
    const response = await downloadTwilioMedia(mediaUrl);
    const buffer   = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 25 * 1024 * 1024) return sendWhatsApp(from, '❌ Voice note too long. Keep under 5 minutes.');
    fs.writeFileSync(tempPath, buffer);

    const transcription = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tempPath), model: 'whisper-large-v3', response_format: 'text'
    });
    const rawText = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
    if (!rawText) throw new Error('Transcription returned empty text');

    const enhanced  = await enhancePrompt(rawText);
    const isEnhanced = enhanced !== rawText;

    await sendWhatsApp(from,
      `🎤 *Voice note received!*\n\n` +
      `📝 You said: "${clip(rawText, 100)}"\n\n` +
      (isEnhanced ? `✨ Enhanced to:\n"${clip(enhanced, 150)}"\n\n` : '') +
      `⚙️ Building now! Usually 2-4 mins.`
    );

    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return sendWhatsApp(from, `🎉 You've used all 3 free builds!\n\n📩 Message +917025217998 for more credits.`);
    }

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: clip(rawText, 80), startedAt: new Date() });
    runAgentJob(from, enhanced, jobId);

  } catch (err) {
    console.error(`[Voice] ${err.message}`);
    sendWhatsApp(from,
      err.message.includes('download')
        ? `❌ Couldn't download your voice note. Please send as text.`
        : `❌ Couldn't transcribe audio: ${err.message}. Please send as text.`
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// ════════════════════════════════════════════════════════════
//  IMAGE HANDLER  (single or multiple — Upgrade 6)
// ════════════════════════════════════════════════════════════

async function handleImages(from, imageItems, caption, user) {
  try {
    const imageDataArray = await Promise.all(
      imageItems.map(async item => {
        const response = await downloadTwilioMedia(item.url);
        const buffer   = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 5 * 1024 * 1024) throw new Error('Image too large (max 5MB each)');
        return { base64: buffer.toString('base64'), mediaType: item.type.split(';')[0].trim() };
      })
    );

    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return sendWhatsApp(from, `🎉 You've used all 3 free builds!\n\n📩 Message +917025217998 for more credits.`);
    }

    const jobId = Date.now().toString();
    const count = imageDataArray.length;

    const requirement = caption ||
      (count > 1
        ? `I'm sending ${count} screenshots. Analyze all of them and build a web app that combines the best elements from each design into one cohesive, beautiful UI. Deploy to Netlify.`
        : `Clone this UI screenshot as a fully working web app. Replicate the exact layout, colors, typography, components and functionality. Make it pixel-perfect with working interactions. Deploy to Netlify.`
      );

    jobs.set(jobId, { status: 'running', task: count > 1 ? `Multi-image build (${count})` : 'UI clone', startedAt: new Date() });

    if (count === 1) {
      runAgentJob(from, requirement, jobId, imageDataArray[0]);
    } else {
      runAgentJob(from, requirement, jobId, null, null, imageDataArray);
    }
  } catch (err) {
    console.error(`[Images] ${err.message}`);
    sendWhatsApp(from, `❌ Couldn't process image(s): ${err.message}. Please try again.`).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════
//  DOCUMENT HANDLER  (Upgrade 1)
// ════════════════════════════════════════════════════════════

async function handleDocument(from, mediaUrl, mimeType, filename, user) {
  const tempPath = path.join(os.tmpdir(), `doc-${Date.now()}-${filename}`);
  try {
    const response = await downloadTwilioMedia(mediaUrl);
    const buffer   = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 50 * 1024 * 1024) {
      return sendWhatsApp(from, `❌ File too large (max 50MB). Please send a smaller file.`);
    }

    fs.writeFileSync(tempPath, buffer);
    const fileResult = await processFile(buffer, filename, mimeType);

    // Store in pending context for follow-up instruction
    savePending(from, {
      type:     fileResult.type,
      filename: filename,
      content:  fileResult.content,
      summary:  fileResult.summary
    });

    await sendWhatsApp(from, fileResult.previewMessage);

  } catch (err) {
    console.error(`[Document] ${err.message}`);
    sendWhatsApp(from, `❌ Couldn't process *${filename}*: ${err.message}\n\nPlease try again or paste the content as text.`).catch(() => {});
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// ════════════════════════════════════════════════════════════
//  WEBHOOK
// ════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  const from     = req.body.From || '';
  const msgBody  = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  // Extract ALL media items (Upgrade 6)
  const mediaItems = [];
  for (let i = 0; i < numMedia; i++) {
    mediaItems.push({
      url:  req.body[`MediaUrl${i}`]           || '',
      type: req.body[`MediaContentType${i}`]   || '',
      name: req.body[`MediaFilename${i}`]      || ''
    });
  }

  const audioItems = mediaItems.filter(m => m.type.includes('audio'));
  const imageItems = mediaItems.filter(m => m.type.includes('image'));
  const docItems   = mediaItems.filter(m => !m.type.includes('audio') && !m.type.includes('image'));

  // ── User registration ─────────────────────────────────────
  let user    = getUser(from);
  const isNew = !user;
  if (!user) user = registerUser(from);

  if (isNew && !isOwner(from)) {
    return twimlReply(res,
      `👋 *Welcome to AI Universal Builder!*\n\n` +
      `Send me anything: text, voice note, screenshot, Excel, PDF, or a URL.\n` +
      `I'll build it — web app, VBA macro, Python script, you name it.\n\n` +
      `You have *3 FREE builds*. Type 'help' to see everything I can do 🚀`
    );
  }

  const cmd = msgBody.toLowerCase();

  // ── STATUS ─────────────────────────────────────────────────
  if (cmd === 'status') {
    const active = [...jobs.values()].filter(j => j.status === 'running');
    return twimlReply(res,
      active.length > 0
        ? `⚙️ ${active.length} job(s) running:\n${active.map(j => `• ${clip(j.task || '', 60)}`).join('\n')}`
        : '✅ No active jobs. Send me something to build!'
    );
  }

  // ── HELP (Upgrade 8 — enhanced) ────────────────────────────
  if (cmd === 'help') {
    return twimlReply(res,
      `🤖 *WhatsApp Universal Builder*\n\n` +
      `*📥 Send anything:*\n` +
      `📝 Text → Build any app\n` +
      `🎤 Voice note → Speak it, I'll enhance + build\n` +
      `🖼️ Screenshot(s) → Clone the UI\n` +
      `📊 Excel file → Analyze + build VBA or app\n` +
      `📄 Word/PDF → Extract + build from content\n` +
      `📋 CSV → Process + visualize data\n` +
      `🔗 Website URL → Clone or improve it\n` +
      `📧 Paste email → Extract requirements + build\n\n` +
      `*⚡ Commands:*\n` +
      `update: [changes] → Update last app\n` +
      `now/also/add [X] → Continue last task\n` +
      `last app / my apps → See your builds\n` +
      `delete last app → Remove from Netlify\n` +
      `status → Active jobs\n` +
      `help → This menu\n\n` +
      `*💻 Auto-routed:*\n` +
      `VBA → .bas Gist | Python → .py Gist\n` +
      `SQL → .sql Gist | Web app → Netlify URL`
    );
  }

  // ── LAST APP ───────────────────────────────────────────────
  if (cmd === 'last app' || cmd === 'my last app') {
    const last = getLastDeployment(from);
    if (!last) return twimlReply(res, `You haven't built anything yet! Send me a requirement 🚀`);
    const date = new Date(last.builtAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    return twimlReply(res,
      `🔗 *Your last build:*\n\n📱 ${last.siteName}\n🌐 ${last.siteUrl}\n📅 ${date}\n📋 ${clip(last.requirement, 100)}`
    );
  }

  // ── MY APPS ────────────────────────────────────────────────
  if (cmd === 'my apps' || cmd === 'list apps') {
    const apps = getAllDeployments(from);
    if (!apps.length) return twimlReply(res, `No apps yet! Send me a requirement 🚀`);
    return twimlReply(res, `📱 *Your recent builds:*\n\n` + apps.map((a, i) => `${i + 1}. ${a.siteName} — ${a.siteUrl}`).join('\n'));
  }

  // ── DELETE LAST APP ────────────────────────────────────────
  if (cmd === 'delete last app') {
    const last = getLastDeployment(from);
    if (!last) return twimlReply(res, `No apps to delete!`);
    twimlReply(res, `🗑️ Deleting *${last.siteName}*...`);
    fetch(`https://api.netlify.com/api/v1/sites/${last.siteId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}` }
    })
      .then(() => { deleteDeployment(from, last.siteId); return sendWhatsApp(from, `🗑️ Deleted *${last.siteName}*.`); })
      .catch(err => sendWhatsApp(from, `❌ Delete failed: ${err.message}`).catch(() => {}));
    return;
  }

  // ── OWNER: USERS ──────────────────────────────────────────
  if (cmd === 'users' && isOwner(from)) {
    const all   = getAllUsers();
    const lines = Object.entries(all).map(([p, u]) => `${p}: ${u.plan} | ${u.credits}cr | ${u.totalBuilds} builds`).join('\n');
    return twimlReply(res, `👥 *All Users:*\n\n${lines || 'None yet'}`);
  }

  // ── OWNER: GIVE CREDITS ───────────────────────────────────
  if (cmd.startsWith('give credits ') && isOwner(from)) {
    const parts = msgBody.split(' ');
    if (parts.length >= 4) {
      const amount = parseInt(parts[2], 10);
      const target = parts[3];
      if (isNaN(amount) || amount <= 0) return twimlReply(res, `❌ Invalid amount`);
      return twimlReply(res, addCredits(target, amount)
        ? `✅ Added ${amount} credits to ${target}`
        : `❌ User ${target} not found`
      );
    }
    return twimlReply(res, `Usage: give credits [amount] [phone]`);
  }

  // ── CONTINUATION ("now add X", "also Y", etc.) ────────────
  if (msgBody && isContinuation(msgBody)) {
    const conv = getConversation(from);
    if (!conv) return twimlReply(res, `No previous task found. Please describe what you want to build!`);

    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return twimlReply(res, `🎉 All 3 free builds used!\n\n📩 Message +917025217998 for more credits.`);
    }

    twimlReply(res,
      `🔄 *Continuing your last task...*\n\n` +
      `✏️ Change: "${clip(msgBody, 80)}"\n` +
      `⏱️ 2-4 mins. I'll send the updated link when ready!`
    );

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: msgBody, startedAt: new Date() });

    if (conv.lastSiteId) {
      fetchExistingCode(conv.lastUrl)
        .then(code => {
          const req = code
            ? `EXISTING CODE (from ${conv.lastUrl}):\n\n${code}\n\nMODIFICATION: ${msgBody}\n\nModify the code. Keep everything that works. Use site_id="${conv.lastSiteId}" when deploying.`
            : `MODIFICATION: ${msgBody}\n\nUpdate the app at ${conv.lastUrl}. Use site_id="${conv.lastSiteId}".`;
          return runAgentJob(from, req, jobId, null, conv.lastSiteId);
        })
        .catch(() => runAgentJob(from, `MODIFICATION: ${msgBody}\n\nUpdate app at ${conv.lastUrl}. Use site_id="${conv.lastSiteId}".`, jobId, null, conv.lastSiteId));
    } else if (conv.lastGistId && conv.lastRawUrl) {
      fetchGistCode(conv.lastRawUrl)
        .then(code => {
          const req = code
            ? `EXISTING CODE (${conv.lastFilename || 'file'}):\n\n${code}\n\nMODIFICATION: ${msgBody}\n\nModify the code. Keep all functionality. Create an updated Gist.`
            : `MODIFICATION: ${msgBody}\n\nContext: previous task was "${conv.lastRequirement}". Create updated version as Gist.`;
          return runAgentJob(from, req, jobId);
        })
        .catch(() => runAgentJob(from, `MODIFICATION: ${msgBody}\n\nPrevious: "${conv.lastRequirement}". Update it.`, jobId));
    } else {
      runAgentJob(from, `Previous: "${conv.lastRequirement}"\nURL: ${conv.lastUrl}\n\nMODIFICATION: ${msgBody}`, jobId);
    }
    return;
  }

  // ── UPDATE: ────────────────────────────────────────────────
  if (cmd.startsWith('update:') || (cmd.startsWith('update ') && !cmd.startsWith('update last'))) {
    const updateText = msgBody.slice(msgBody.toLowerCase().startsWith('update:') ? 7 : 7).trim();
    if (!updateText) return twimlReply(res, `Please include what to change. Example: update: make background blue`);

    const last = getLastDeployment(from);
    if (!last) return twimlReply(res, `No previous app found. Send a new requirement first!`);

    user = getUser(from);
    if (!isOwner(from) && (!user || user.credits <= 0)) {
      return twimlReply(res, `🎉 All 3 free builds used!\n\n📩 Message +917025217998 for more credits.`);
    }

    twimlReply(res,
      `🔄 *Updating your app...*\n\n` +
      `📝 Change: "${clip(updateText, 80)}"\n` +
      `⏱️ 2-4 mins. I'll send the updated link when ready!`
    );

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: `update: ${clip(updateText, 60)}`, startedAt: new Date() });

    fetchExistingCode(last.siteUrl)
      .then(code => {
        const req = code
          ? `Existing code at ${last.siteUrl}:\n\n${code}\n\nUPDATE: ${updateText}\n\nModify only what's needed. Use site_id="${last.siteId}".`
          : `UPDATE: ${updateText}\n\nUpdate the app at ${last.siteUrl}. Use site_id="${last.siteId}".`;
        return runAgentJob(from, req, jobId, null, last.siteId);
      })
      .catch(() => runAgentJob(from, `UPDATE: ${updateText}\n\nUpdate app at ${last.siteUrl}. Use site_id="${last.siteId}".`, jobId, null, last.siteId));
    return;
  }

  // ── VOICE NOTE ────────────────────────────────────────────
  if (audioItems.length > 0) {
    twimlReply(res, `🎤 *Voice note received!*\n\n🔄 Transcribing + enhancing... give me a moment.`);
    handleVoiceNote(from, audioItems[0].url, user).catch(err => {
      sendWhatsApp(from, `❌ Couldn't transcribe: ${err.message}. Please send as text.`).catch(() => {});
    });
    return;
  }

  // ── IMAGES (single or multiple) ───────────────────────────
  if (imageItems.length > 0) {
    const count = imageItems.length;
    twimlReply(res,
      count > 1
        ? `🖼️ *${count} images received!*\n\n🔍 Analyzing all of them...\n⚙️ Building now! Usually 3-5 mins.`
        : `🖼️ *Screenshot received!*\n\n🔍 Analyzing your UI...\n⚙️ Building a clone now! Usually 3-5 mins.`
    );
    handleImages(from, imageItems, msgBody || null, user).catch(err => {
      sendWhatsApp(from, `❌ Couldn't process image(s): ${err.message}.`).catch(() => {});
    });
    return;
  }

  // ── DOCUMENTS (Excel, Word, PDF, CSV, code files) ─────────
  if (docItems.length > 0) {
    const item     = docItems[0];
    const filename = guessFilename(item.name, item.type);
    twimlReply(res, `📂 *Receiving your file...*\n\nProcessing *${filename}* — this takes a moment.`);
    handleDocument(from, item.url, item.type, filename, user).catch(err => {
      sendWhatsApp(from, `❌ Couldn't process ${filename}: ${err.message}.`).catch(() => {});
    });
    return;
  }

  // ── URL-ONLY DETECTION (Upgrade 2) ───────────────────────
  const URL_RE   = /https?:\/\/[^\s]+/gi;
  const foundUrls = msgBody.match(URL_RE) || [];
  const isUrlOnly = foundUrls.length > 0 && msgBody.replace(URL_RE, '').trim().length < 10;

  if (isUrlOnly && foundUrls.length > 0) {
    savePending(from, {
      type: 'url',
      filename: foundUrls[0],
      content: `URL: ${foundUrls[0]}`,
      summary: `Website URL: ${foundUrls[0]}`
    });
    return twimlReply(res,
      `🔗 *Got your link!*\n\n` +
      `${clip(foundUrls[0], 60)}\n\n` +
      `What would you like me to do?\n\n` +
      `1️⃣ Clone this website's design\n` +
      `2️⃣ Build something similar / inspired by it\n` +
      `3️⃣ Extract the content and reformat it\n` +
      `4️⃣ Build an improved version with better UX\n\n` +
      `Reply with the number or describe what you want!`
    );
  }

  // ── CREDIT CHECK ─────────────────────────────────────────
  user = getUser(from);
  if (!isOwner(from) && (!user || user.credits <= 0)) {
    return twimlReply(res,
      `🎉 You've used all 3 free builds!\n\n` +
      `💳 Payment options coming soon.\n` +
      `📩 Message +917025217998 to request more credits.`
    );
  }

  // ── EMPTY MESSAGE ─────────────────────────────────────────
  if (!msgBody) return twimlReply(res, `Please send a text message, voice note, image, file, or URL!`);

  // ── EMAIL DETECTION (Upgrade 3) ──────────────────────────
  const isEmailContent = /^(From:|Subject:|To:|---------- Forwarded|Begin forwarded)/mi.test(msgBody);
  let requirement = msgBody;

  if (isEmailContent) {
    const subjectMatch = msgBody.match(/Subject:\s*(.+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'email content';
    savePending(from, {
      type: 'email',
      filename: 'email',
      content: msgBody,
      summary: `Email: ${subject}`
    });
    return twimlReply(res,
      `📧 *Email detected!*\n\n` +
      `Subject: ${clip(subject, 60)}\n\n` +
      `I've read your email. What would you like me to build from it?\n\n` +
      `Examples:\n• "build a web app from this"\n• "write VBA to automate this process"\n• "create a form to collect this data"`
    );
  }

  // ── PENDING CONTEXT — prepend file/URL/email content ─────
  const pending = getPending(from);
  if (pending) {
    // Check if reply is a number (URL option selection)
    const urlOptionMap = {
      '1': 'Clone this website\'s design faithfully',
      '2': 'Build something similar inspired by this website',
      '3': 'Extract the content and reformat it beautifully',
      '4': 'Build an improved version with better UX and modern design'
    };

    if (pending.type === 'url' && urlOptionMap[msgBody.trim()]) {
      requirement =
        `USER PROVIDED URL: ${pending.content}\n\n` +
        `INSTRUCTION: ${urlOptionMap[msgBody.trim()]}\n\n` +
        `Use the fetch_url tool to analyze the website, then build as instructed. Deploy to Netlify.`;
    } else {
      requirement =
        `USER PROVIDED FILE: ${pending.filename}\n` +
        `FILE TYPE: ${pending.type}\n` +
        `FILE SUMMARY: ${pending.summary}\n\n` +
        `FILE CONTENT/STRUCTURE:\n${pending.content}\n\n` +
        `USER INSTRUCTION: ${msgBody}\n\n` +
        `Build/create/process exactly as requested above, using the actual column names, field names, and data structure from the file.`;
    }
    clearPending(from);
  } else if (foundUrls.length > 0) {
    // URL embedded in a message with instructions
    const urlsStr = foundUrls.join(', ');
    requirement = `${msgBody}\n\n[Note: Message contains URL(s): ${urlsStr}. Use fetch_url tool to analyze before building.]`;
  }

  // ── INTENT DETECTION ─────────────────────────────────────
  const intent = detectIntent(requirement);
  console.log(`[Webhook] from=${from} intent=${intent} len=${requirement.length}`);

  // ── BUILD ─────────────────────────────────────────────────
  twimlReply(res,
    `⚙️ *Got it! Building now...*\n\n` +
    `📋 Task: "${clip(msgBody, 80)}"\n\n` +
    `⏱️ Usually 2-4 mins. I'll send the live link when ready!`
  );

  const jobId = Date.now().toString();
  jobs.set(jobId, { status: 'running', task: clip(msgBody, 80), intent, startedAt: new Date() });
  runAgentJob(from, requirement, jobId);
});

// ════════════════════════════════════════════════════════════
//  MARKET DATA PROXY
// ════════════════════════════════════════════════════════════

const marketCache = {};

function cacheGet(key) {
  const e = marketCache[key];
  return (e && Date.now() < e.expiresAt) ? e.data : null;
}
function cacheSet(key, data, ttlMs) {
  marketCache[key] = { data, expiresAt: Date.now() + ttlMs };
}

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

async function fetchYahoo(urlPath) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const res = await fetch(`https://${host}${urlPath}`, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function extractQuote(data, symbol) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const meta = result.meta;
  return {
    symbol: meta.symbol || symbol, shortName: meta.shortName || symbol,
    regularMarketPrice: meta.regularMarketPrice || null,
    regularMarketChange: meta.regularMarketPrice && meta.chartPreviousClose
      ? parseFloat((meta.regularMarketPrice - meta.chartPreviousClose).toFixed(2)) : null,
    regularMarketChangePercent: meta.regularMarketPrice && meta.chartPreviousClose
      ? parseFloat(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2)) : null,
    regularMarketVolume: meta.regularMarketVolume || null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null, fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    currency: meta.currency || 'INR', exchangeName: meta.exchangeName || null,
    marketState: meta.marketState || 'UNKNOWN', previousClose: meta.chartPreviousClose || null
  };
}

app.use('/market', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/market/quote', async (req, res) => {
  const symbols  = (req.query.symbols || '^NSEI,^NSEBANK,^BSESN,RELIANCE.NS,TCS.NS').split(',').map(s => s.trim()).filter(Boolean);
  const cacheKey = `quote:${symbols.join(',')}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const results = await Promise.allSettled(symbols.map(async sym => {
      const data = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`);
      return extractQuote(data, sym);
    }));
    const quotes = results.map((r, i) => r.status === 'fulfilled' ? r.value : { symbol: symbols[i], error: r.reason?.message });
    cacheSet(cacheKey, quotes, 60000);
    res.json(quotes);
  } catch (err) { res.status(502).json({ error: 'Failed to fetch quotes', detail: err.message }); }
});

app.get('/market/history', async (req, res) => {
  const symbol   = req.query.symbol   || '^NSEI';
  const interval = req.query.interval || '1d';
  const range    = req.query.range    || '1mo';
  const cacheKey = `history:${symbol}:${interval}:${range}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data   = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error(`No data`);
    const q = result.indicators?.quote?.[0] || {};
    const payload = {
      symbol, interval, range,
      meta: { currency: result.meta?.currency, regularMarketPrice: result.meta?.regularMarketPrice },
      timestamps: result.timestamp || [],
      open: q.open || [], high: q.high || [], low: q.low || [], close: q.close || [], volume: q.volume || []
    };
    cacheSet(cacheKey, payload, 300000);
    res.json(payload);
  } catch (err) { res.status(502).json({ error: 'Failed to fetch history', detail: err.message }); }
});

app.get('/market/indices', async (req, res) => {
  const INDEX_SYMBOLS = [
    { symbol: '^NSEI', name: 'NIFTY 50' }, { symbol: '^NSEBANK', name: 'BANK NIFTY' },
    { symbol: '^BSESN', name: 'SENSEX' },  { symbol: '^CNXIT',   name: 'NIFTY IT' }
  ];
  const cached = cacheGet('indices');
  if (cached) return res.json(cached);
  try {
    const results = await Promise.allSettled(INDEX_SYMBOLS.map(async ({ symbol, name }) => {
      const data = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`);
      return { ...extractQuote(data, symbol), displayName: name };
    }));
    const indices = results.map((r, i) => r.status === 'fulfilled' ? r.value : { symbol: INDEX_SYMBOLS[i].symbol, displayName: INDEX_SYMBOLS[i].name, error: r.reason?.message });
    cacheSet('indices', indices, 60000);
    res.json(indices);
  } catch (err) { res.status(502).json({ error: 'Failed to fetch indices', detail: err.message }); }
});

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeJobs: [...jobs.values()].filter(j => j.status === 'running').length,
    uptime: Math.floor(process.uptime()) + 's',
    features: [
      'text', 'voice+enhance', 'image-multi', 'excel', 'word', 'pdf', 'csv',
      'url-clone', 'email-detect', 'gist', 'continuation', 'update', 'users', 'market-proxy'
    ]
  });
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 WhatsApp Universal Builder on port ${PORT}`);
  console.log(`✅ Phase 3: files, URL cloning, email detect, multi-image, 3D/advanced web`);
});
