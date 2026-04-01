// ============================================================
//  server.js  –  WhatsApp AI Agent Server
//  Receives WhatsApp messages via Twilio, runs Claude agent,
//  deploys to Netlify, and replies with the live URL.
//
//  Supports: text requirements, voice notes (Groq Whisper),
//  screenshots (Claude Vision), app history, update commands,
//  multi-user credit system.
// ============================================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Groq = require('groq-sdk');

const { runAgent } = require('./agent');
const { saveDeployment, getLastDeployment, getAllDeployments, deleteDeployment } = require('./storage');
const { getUser, registerUser, deductCredit, addCredits, getAllUsers, isOwner } = require('./users');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Clients ─────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Groq is lazily initialized so missing key doesn't crash startup
let _groq = null;
function getGroq() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — add it in Render env vars');
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// ── In-memory job tracker ────────────────────────────────────
const jobs = new Map();

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════

function twimlReply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.type('text/xml').send(twiml.toString());
}

async function sendWhatsApp(to, body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body
  });
}

// Download media from Twilio URL using Basic Auth
async function downloadTwilioMedia(mediaUrl) {
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
  return response;
}

// Fetch existing HTML from a live Netlify site for update jobs
async function fetchExistingCode(siteUrl) {
  try {
    const urls = [
      siteUrl.replace(/\/$/, '') + '/index.html',
      siteUrl.replace(/\/$/, '') + '/'
    ];
    for (const url of urls) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) return (await res.text()).slice(0, 50000);
    }
    return null;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  CORE JOB RUNNER  (called after Twilio has been ACK'd)
// ════════════════════════════════════════════════════════════

async function runAgentJob(from, requirement, jobId, imageData = null, existingSiteId = null) {
  try {
    const result = await runAgent(requirement, jobId, imageData, existingSiteId);
    jobs.set(jobId, { ...jobs.get(jobId), status: 'done', result });

    if (result.success) {
      saveDeployment(from, {
        siteId:      result.siteId   || existingSiteId || 'unknown',
        siteName:    result.siteName || 'unknown',
        siteUrl:     result.url,
        requirement: requirement.slice(0, 200),
        builtAt:     new Date().toISOString()
      });
      deductCredit(from);

      await sendWhatsApp(from,
        `✅ *App is live!*\n\n` +
        `🔗 ${result.url}\n\n` +
        `📝 ${result.summary}`
      );
    } else {
      await sendWhatsApp(from,
        `❌ *Build failed*\n\n${result.error}\n\nSend your requirement again to retry.`
      );
    }

    console.log(`[Job ${jobId}] Reply sent.`);
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);

  } catch (err) {
    console.error(`[Job ${jobId}] Fatal error: ${err.message}`);
    console.error(`[Job ${jobId}] Fatal stack: ${err.stack}`);
    sendWhatsApp(from, `❌ Something went wrong: ${err.message}\n\nTry again!`)
      .catch(e => console.error(`[Job ${jobId}] Also failed to send error reply: ${e.message}`));
  }
}

// ════════════════════════════════════════════════════════════
//  VOICE NOTE HANDLER
// ════════════════════════════════════════════════════════════

async function handleVoiceNote(from, mediaUrl, user) {
  const tempPath = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  try {
    // 1. Download audio
    const response = await downloadTwilioMedia(mediaUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // 2. Size check (> 25 MB)
    if (buffer.length > 25 * 1024 * 1024) {
      return sendWhatsApp(from, '❌ Voice note too long. Please keep under 5 minutes.');
    }

    fs.writeFileSync(tempPath, buffer);

    // 3. Transcribe with Groq Whisper
    const transcription = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-large-v3',
      response_format: 'text'
    });

    const text = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
    if (!text) throw new Error('Transcription returned empty text');

    console.log(`[Voice] Transcribed: ${text.slice(0, 100)}`);

    // 4. Notify user with transcription + building status
    await sendWhatsApp(from,
      `🎤 *Voice note received!*\n\n` +
      `📝 Transcribed: "${text.slice(0, 100)}${text.length > 100 ? '..."' : '"'}\n\n` +
      `⚙️ Building your app now! Usually 2-4 mins.`
    );

    // 5. Credit check
    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return sendWhatsApp(from,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

    // 6. Run agent
    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: text, startedAt: new Date() });
    runAgentJob(from, text, jobId);

  } catch (err) {
    console.error(`[Voice] Error: ${err.message}`);
    const msg = err.message.includes('too long')
      ? `❌ Voice note too long. Please keep under 5 minutes.`
      : err.message.includes('download')
        ? `❌ Couldn't download your voice note. Please send as text.`
        : `❌ Couldn't transcribe audio: ${err.message}. Please send as text.`;
    sendWhatsApp(from, msg).catch(() => {});
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// ════════════════════════════════════════════════════════════
//  IMAGE / SCREENSHOT HANDLER
// ════════════════════════════════════════════════════════════

async function handleImage(from, mediaUrl, mediaContentType, user) {
  try {
    // 1. Download image
    const response = await downloadTwilioMedia(mediaUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // 2. Size check (> 5 MB)
    if (buffer.length > 5 * 1024 * 1024) {
      return sendWhatsApp(from, '❌ Image too large. Please send a smaller screenshot.');
    }

    const base64 = buffer.toString('base64');
    const mediaType = mediaContentType.split(';')[0].trim();
    const imageData = { base64, mediaType };

    // 3. Credit check
    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return sendWhatsApp(from,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

    // 4. Run agent with vision
    const jobId = Date.now().toString();
    const requirement =
      'Clone this UI screenshot as a fully working web app. ' +
      'Replicate the exact layout, colors, typography, components and functionality you see. ' +
      'Make it pixel-perfect with working interactions. Deploy it to Netlify.';

    jobs.set(jobId, { status: 'running', task: 'UI clone from screenshot', startedAt: new Date() });
    runAgentJob(from, requirement, jobId, imageData);

  } catch (err) {
    console.error(`[Image] Error: ${err.message}`);
    sendWhatsApp(from, `❌ Couldn't process image: ${err.message}. Please try again.`).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════
//  WEBHOOK
// ════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  const from          = req.body.From || '';               // whatsapp:+917025217998
  const msgBody       = (req.body.Body || '').trim();
  const numMedia      = parseInt(req.body.NumMedia || '0', 10);
  const mediaType0    = req.body.MediaContentType0 || '';
  const mediaUrl0     = req.body.MediaUrl0 || '';

  // ── User registration + first-time welcome ─────────────────
  let user = getUser(from);
  const isNew = !user;
  if (!user) user = registerUser(from);

  if (isNew && !isOwner(from)) {
    return twimlReply(res,
      `👋 *Welcome to AI App Builder!*\n\n` +
      `Send me any app requirement and I'll build + deploy it in 2-4 mins. ` +
      `You have *3 FREE builds* to try!\n\n` +
      `Type 'help' to see all commands 🚀`
    );
  }

  const cmd = msgBody.toLowerCase();

  // ── STATUS ─────────────────────────────────────────────────
  if (cmd === 'status') {
    const active = [...jobs.values()].filter(j => j.status === 'running');
    return twimlReply(res,
      active.length > 0
        ? `⚙️ ${active.length} job(s) running:\n${active.map(j => `• ${(j.task || '').slice(0, 60)}...`).join('\n')}`
        : '✅ No active jobs. Send me a requirement!'
    );
  }

  // ── HELP ───────────────────────────────────────────────────
  if (cmd === 'help') {
    return twimlReply(res,
      `🤖 *WhatsApp App Builder — Commands:*\n\n` +
      `📝 [any requirement] → Build a new app\n` +
      `🎤 [voice note] → Speak your requirement\n` +
      `🖼️ [screenshot] → Clone any UI\n\n` +
      `update: [changes] → Update your last app\n` +
      `last app → See your most recent app\n` +
      `my apps → See your last 5 apps\n` +
      `delete last app → Remove last app\n` +
      `status → Check if a build is running\n` +
      `help → Show this menu`
    );
  }

  // ── LAST APP ───────────────────────────────────────────────
  if (cmd === 'last app' || cmd === 'my last app') {
    const last = getLastDeployment(from);
    if (!last) return twimlReply(res, `You haven't built any apps yet! Send me a requirement 🚀`);
    const date = new Date(last.builtAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    return twimlReply(res,
      `🔗 *Your last app:*\n\n` +
      `📱 ${last.siteName}\n` +
      `🌐 ${last.siteUrl}\n` +
      `📅 Built: ${date}\n` +
      `📋 Task: ${last.requirement}`
    );
  }

  // ── MY APPS ────────────────────────────────────────────────
  if (cmd === 'my apps' || cmd === 'list apps') {
    const apps = getAllDeployments(from);
    if (!apps.length) return twimlReply(res, `No apps yet! Send me a requirement 🚀`);
    const list = apps.map((a, i) => `${i + 1}. ${a.siteName} — ${a.siteUrl}`).join('\n');
    return twimlReply(res, `📱 *Your recent apps:*\n\n${list}`);
  }

  // ── DELETE LAST APP ────────────────────────────────────────
  if (cmd === 'delete last app') {
    const last = getLastDeployment(from);
    if (!last) return twimlReply(res, `No apps to delete!`);

    twimlReply(res, `🗑️ Deleting *${last.siteName}*...`);
    fetch(`https://api.netlify.com/api/v1/sites/${last.siteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}` }
    })
      .then(() => {
        deleteDeployment(from, last.siteId);
        return sendWhatsApp(from, `🗑️ Deleted *${last.siteName}*. It's gone from Netlify.`);
      })
      .catch(err => sendWhatsApp(from, `❌ Failed to delete: ${err.message}`).catch(() => {}));
    return;
  }

  // ── OWNER: USERS ──────────────────────────────────────────
  if (cmd === 'users' && isOwner(from)) {
    const all = getAllUsers();
    const lines = Object.entries(all)
      .map(([phone, u]) => `${phone}: ${u.plan} | ${u.credits} credits | ${u.totalBuilds} builds`)
      .join('\n');
    return twimlReply(res, `👥 *All Users:*\n\n${lines || 'No users yet'}`);
  }

  // ── OWNER: GIVE CREDITS ───────────────────────────────────
  if (cmd.startsWith('give credits ') && isOwner(from)) {
    // e.g. "give credits 10 +917025217998"
    const parts = msgBody.split(' ');
    if (parts.length >= 4) {
      const amount = parseInt(parts[2], 10);
      const target = parts[3];
      if (isNaN(amount) || amount <= 0) return twimlReply(res, `❌ Invalid amount`);
      const ok = addCredits(target, amount);
      return twimlReply(res, ok
        ? `✅ Added ${amount} credits to ${target}`
        : `❌ User ${target} not found — they need to message first`
      );
    }
    return twimlReply(res, `Usage: give credits [amount] [phone e.g. +917025217998]`);
  }

  // ── UPDATE: ────────────────────────────────────────────────
  if (cmd.startsWith('update:') || (cmd.startsWith('update ') && !cmd.startsWith('update last'))) {
    const updateText = msgBody.slice(msgBody.toLowerCase().startsWith('update:') ? 7 : 7).trim();
    if (!updateText) return twimlReply(res, `Please include what to change. Example: update: make background blue`);

    const last = getLastDeployment(from);
    if (!last) return twimlReply(res, `No previous app found. Send a new requirement first!`);

    // Credit check
    user = getUser(from); // re-read fresh
    if (!isOwner(from) && (!user || user.credits <= 0)) {
      return twimlReply(res,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

    twimlReply(res,
      `🔄 *Updating your app...*\n\n` +
      `📝 Change: "${updateText.slice(0, 80)}${updateText.length > 80 ? '..."' : '"'}\n` +
      `⏱️ Usually 2-4 mins. I'll send the updated link when ready!`
    );

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: `update: ${updateText}`, startedAt: new Date() });

    // Fetch existing code then run agent
    fetchExistingCode(last.siteUrl)
      .then(existingCode => {
        const requirement = existingCode
          ? `Here is the existing code for the app at ${last.siteUrl}:\n\n${existingCode}\n\nUPDATE REQUIREMENT: ${updateText}\n\nModify the existing code to implement the update. Keep everything that works, only change what's needed. When deploying, use site_id="${last.siteId}" to redeploy to the same site.`
          : `UPDATE REQUIREMENT: ${updateText}\n\nUpdate the app at ${last.siteUrl}. When deploying, use site_id="${last.siteId}" to redeploy to the same site.`;
        return runAgentJob(from, requirement, jobId, null, last.siteId);
      })
      .catch(err => {
        console.error(`[Job ${jobId}] Update setup error: ${err.message}`);
        const requirement = `UPDATE REQUIREMENT: ${updateText}\n\nUpdate the app at ${last.siteUrl}. When deploying, use site_id="${last.siteId}" to redeploy to the same site.`;
        runAgentJob(from, requirement, jobId, null, last.siteId);
      });
    return;
  }

  // ── VOICE NOTE ────────────────────────────────────────────
  if (numMedia > 0 && mediaType0.includes('audio')) {
    twimlReply(res,
      `🎤 *Voice note received!*\n\n` +
      `🔄 Transcribing with Whisper AI... give me a moment.`
    );
    handleVoiceNote(from, mediaUrl0, user).catch(err => {
      console.error(`[Voice] Unhandled: ${err.message}`);
      sendWhatsApp(from, `❌ Couldn't transcribe audio: ${err.message}. Please send as text.`).catch(() => {});
    });
    return;
  }

  // ── IMAGE / SCREENSHOT ────────────────────────────────────
  if (numMedia > 0 && mediaType0.includes('image')) {
    twimlReply(res,
      `🖼️ *Screenshot received!*\n\n` +
      `🔍 Analyzing your UI...\n` +
      `⚙️ Building a clone now! Usually 3-5 mins.`
    );
    handleImage(from, mediaUrl0, mediaType0, user).catch(err => {
      console.error(`[Image] Unhandled: ${err.message}`);
      sendWhatsApp(from, `❌ Couldn't process image: ${err.message}. Please try again.`).catch(() => {});
    });
    return;
  }

  // ── CREDIT CHECK (before building) ───────────────────────
  user = getUser(from); // re-read fresh
  if (!isOwner(from) && (!user || user.credits <= 0)) {
    return twimlReply(res,
      `🎉 You've used all 3 free builds!\n\n` +
      `💳 Want to continue? Payment options coming soon.\n` +
      `📩 Message +917025217998 to request more credits.`
    );
  }

  // ── REGULAR TEXT → AGENT ─────────────────────────────────
  if (!msgBody) {
    return twimlReply(res, `Please send a text message, voice note, or screenshot!`);
  }

  twimlReply(res,
    `⚙️ Got it! Building your app now...\n\n` +
    `📋 Task: "${msgBody.slice(0, 80)}${msgBody.length > 80 ? '..."' : '"'}\n\n` +
    `⏱️ Usually takes 2–4 mins. I'll send the live link when it's ready!`
  );

  const jobId = Date.now().toString();
  jobs.set(jobId, { status: 'running', task: msgBody, startedAt: new Date() });
  runAgentJob(from, msgBody, jobId);
});

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeJobs: [...jobs.values()].filter(j => j.status === 'running').length,
    uptime: Math.floor(process.uptime()) + 's',
    features: ['text', 'voice', 'image', 'history', 'update', 'users']
  });
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 WhatsApp Agent running on port ${PORT}`);
  console.log(`✅ Owner: +917025217998 | Features: voice, image, history, users`);
});
