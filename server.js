// ============================================================
//  server.js  –  WhatsApp AI Agent Server
//
//  Phase 2 features:
//  • Upgrade 1: GitHub Gist output for code files
//  • Upgrade 2: Multi-step conversation memory
//  • Upgrade 3: Smarter system prompt (handled in agent.js)
//  • Upgrade 4: Voice prompt enhancer (Groq LLM)
//  • Market proxy: /market/quote, /market/history, /market/indices
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

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Clients ─────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Groq — lazy init so missing key doesn't crash startup
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

// Fetch raw code from a GitHub Gist
async function fetchGistCode(rawUrl) {
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return (await res.text()).slice(0, 50000);
    return null;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  UPGRADE 4 — VOICE PROMPT ENHANCER
// ════════════════════════════════════════════════════════════

async function enhancePrompt(rawTranscription) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `You are a prompt engineer for an AI app/code builder.
Your job is to take a rough voice note transcription and expand it into a detailed, specific, professional build prompt.

RULES:
- Keep the core idea exactly as intended
- Add specific UI details (colors, layout, features) for web apps
- Add technical requirements (responsive, dark theme, localStorage) for web apps
- Add code quality requirements (error handling, comments, edge cases) for code requests
- Add edge cases to handle
- Keep it under 400 words
- Output ONLY the enhanced prompt, nothing else
- Do not add features the user didn't ask for
- If it's a code request (VBA/Python/SQL/script), add code quality requirements instead of UI details`
          },
          {
            role: 'user',
            content: `Enhance this voice note into a detailed build prompt:\n\n"${rawTranscription}"`
          }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || rawTranscription;
  } catch (err) {
    console.warn('[enhancePrompt] Failed, using raw transcription:', err.message);
    return rawTranscription; // Fail silently
  }
}

// ════════════════════════════════════════════════════════════
//  UPGRADE 2 — CONTINUATION DETECTION
// ════════════════════════════════════════════════════════════

const CONTINUATION_PATTERNS = [
  /^now\s/i,
  /^also\s/i,
  /^and\s+add\s/i,
  /^add\s/i,
  /^remove\s/i,
  /\bthat\s+app\b/i,
  /\bthe\s+app\b/i,
  /\bsame\s+app\b/i,
  /\bprevious\b/i,
  /^change\s/i,
  /^modify\s/i,
  /^fix\s/i,
  /^make\s+it\s/i,
  /^make\s+the\s/i
];

// "update:" is already handled as its own command — exclude it here
function isContinuation(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('update:') || lower.startsWith('update last')) return false;
  return CONTINUATION_PATTERNS.some(re => re.test(text));
}

// ════════════════════════════════════════════════════════════
//  CORE JOB RUNNER
// ════════════════════════════════════════════════════════════

async function runAgentJob(from, requirement, jobId, imageData = null, existingSiteId = null) {
  try {
    const result = await runAgent(requirement, jobId, imageData, existingSiteId);
    jobs.set(jobId, { ...jobs.get(jobId), status: 'done', result });

    if (result.success) {
      // ── Gist output (VBA, Python, SQL, scripts) ────────────
      if (result.isGist) {
        // Save to conversation memory (for "now add X" continuations)
        saveConversation(from, {
          lastRequirement: requirement.slice(0, 200),
          lastUrl:         result.url,
          lastGistId:      result.gistId,
          lastRawUrl:      result.rawUrl,
          lastFilename:    result.filename,
          lastSiteId:      null
        });
        deductCredit(from);

        await sendWhatsApp(from,
          `✅ *Code is ready!*\n\n` +
          `📄 File: ${result.filename || 'code'}\n` +
          `🔗 View: ${result.url}\n` +
          `📥 Raw: ${result.rawUrl || result.url}\n\n` +
          `📋 Open the link to copy or download your code.\n` +
          `💡 Tip: The Raw link gives you plain text to paste directly.`
        );

      // ── Web app output (Netlify) ───────────────────────────
      } else {
        saveDeployment(from, {
          siteId:      result.siteId   || existingSiteId || 'unknown',
          siteName:    result.siteName || 'unknown',
          siteUrl:     result.url,
          requirement: requirement.slice(0, 200),
          builtAt:     new Date().toISOString()
        });
        // Save to conversation memory too
        saveConversation(from, {
          lastRequirement: requirement.slice(0, 200),
          lastUrl:         result.url,
          lastSiteId:      result.siteId || existingSiteId || null,
          lastGistId:      null,
          lastRawUrl:      null,
          lastFilename:    null
        });
        deductCredit(from);

        await sendWhatsApp(from,
          `✅ *App is live!*\n\n` +
          `🔗 ${result.url}\n\n` +
          `📝 ${result.summary}`
        );
      }

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
//  VOICE NOTE HANDLER  (with Upgrade 4 — prompt enhancement)
// ════════════════════════════════════════════════════════════

async function handleVoiceNote(from, mediaUrl, user) {
  const tempPath = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  try {
    const response = await downloadTwilioMedia(mediaUrl);
    const buffer   = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 25 * 1024 * 1024) {
      return sendWhatsApp(from, '❌ Voice note too long. Please keep under 5 minutes.');
    }

    fs.writeFileSync(tempPath, buffer);

    // Transcribe with Groq Whisper
    const transcription = await getGroq().audio.transcriptions.create({
      file:            fs.createReadStream(tempPath),
      model:           'whisper-large-v3',
      response_format: 'text'
    });

    const rawText = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
    if (!rawText) throw new Error('Transcription returned empty text');
    console.log(`[Voice] Transcribed: ${rawText.slice(0, 100)}`);

    // Enhance with Groq LLM
    const enhancedPrompt = await enhancePrompt(rawText);
    const previewText    = enhancedPrompt.slice(0, 150);
    const isEnhanced     = enhancedPrompt !== rawText;

    // Notify user
    await sendWhatsApp(from,
      `🎤 *Voice note received!*\n\n` +
      `📝 You said: "${rawText.slice(0, 100)}${rawText.length > 100 ? '...' : ''}"\n\n` +
      (isEnhanced
        ? `✨ Enhanced to:\n"${previewText}${enhancedPrompt.length > 150 ? '...' : ''}"\n\n`
        : '') +
      `⚙️ Building now! Usually 2-4 mins.`
    );

    // Credit check
    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return sendWhatsApp(from,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: rawText.slice(0, 80), startedAt: new Date() });
    runAgentJob(from, enhancedPrompt, jobId);

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
    const response = await downloadTwilioMedia(mediaUrl);
    const buffer   = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 5 * 1024 * 1024) {
      return sendWhatsApp(from, '❌ Image too large. Please send a smaller screenshot.');
    }

    const base64    = buffer.toString('base64');
    const mediaType = mediaContentType.split(';')[0].trim();
    const imageData = { base64, mediaType };

    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return sendWhatsApp(from,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

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
  const from       = req.body.From || '';
  const msgBody    = (req.body.Body || '').trim();
  const numMedia   = parseInt(req.body.NumMedia || '0', 10);
  const mediaType0 = req.body.MediaContentType0 || '';
  const mediaUrl0  = req.body.MediaUrl0 || '';

  // ── User registration ─────────────────────────────────────
  let user    = getUser(from);
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
      `🖼️ [screenshot] → Clone any UI\n` +
      `💻 VBA/Python/SQL/scripts → Auto-creates Gist\n\n` +
      `update: [changes] → Update your last app\n` +
      `now/also/add [changes] → Continue last task\n` +
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

  // ── UPGRADE 2: CONTINUATION ("now add X", "also Y", etc.) ─
  if (msgBody && isContinuation(msgBody)) {
    const conv = getConversation(from);
    if (!conv) {
      return twimlReply(res, `No previous task found. Please describe what you want to build from scratch!`);
    }

    // Credit check
    const freshUser = getUser(from);
    if (!isOwner(from) && (!freshUser || freshUser.credits <= 0)) {
      return twimlReply(res,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

    twimlReply(res,
      `🔄 *Continuing your last task...*\n\n` +
      `✏️ Change: "${msgBody.slice(0, 80)}${msgBody.length > 80 ? '...' : '"'}\n` +
      `⏱️ Usually 2-4 mins. I'll send the updated link when ready!`
    );

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: msgBody, startedAt: new Date() });

    // Web app continuation → fetch code from Netlify, redeploy same site
    if (conv.lastSiteId) {
      fetchExistingCode(conv.lastUrl)
        .then(existingCode => {
          const requirement = existingCode
            ? `EXISTING CODE (from ${conv.lastUrl}):\n\n${existingCode}\n\nMODIFICATION REQUEST: ${msgBody}\n\nModify the existing code to implement the update. Keep everything that works. When deploying, use site_id="${conv.lastSiteId}" to redeploy to the same site.`
            : `MODIFICATION REQUEST: ${msgBody}\n\nUpdate the app at ${conv.lastUrl}. When deploying, use site_id="${conv.lastSiteId}" to redeploy to the same site.`;
          return runAgentJob(from, requirement, jobId, null, conv.lastSiteId);
        })
        .catch(err => {
          const requirement = `MODIFICATION REQUEST: ${msgBody}\n\nUpdate the app at ${conv.lastUrl}. When deploying, use site_id="${conv.lastSiteId}".`;
          runAgentJob(from, requirement, jobId, null, conv.lastSiteId);
        });

    // Code file continuation → fetch raw from Gist, create updated Gist
    } else if (conv.lastGistId && conv.lastRawUrl) {
      fetchGistCode(conv.lastRawUrl)
        .then(existingCode => {
          const requirement = existingCode
            ? `EXISTING CODE (${conv.lastFilename || 'file'}):\n\n${existingCode}\n\nMODIFICATION REQUEST: ${msgBody}\n\nModify the existing code to add/change the requested feature. Keep all working functionality. Create an updated Gist with the modified code.`
            : `MODIFICATION REQUEST: ${msgBody}\n\nUpdate the code from ${conv.lastUrl}. Create a new Gist with the modifications.`;
          return runAgentJob(from, requirement, jobId);
        })
        .catch(() => {
          runAgentJob(from, `MODIFICATION REQUEST: ${msgBody}\n\nContext: previous task was "${conv.lastRequirement}". Create an updated version.`, jobId);
        });

    } else {
      // Fallback: use previous requirement as context
      const requirement = `Previous task: "${conv.lastRequirement}"\nURL: ${conv.lastUrl}\n\nMODIFICATION REQUEST: ${msgBody}`;
      runAgentJob(from, requirement, jobId);
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
      return twimlReply(res,
        `🎉 You've used all 3 free builds!\n\n` +
        `💳 Want to continue? Payment options coming soon.\n` +
        `📩 Message +917025217998 to request more credits.`
      );
    }

    twimlReply(res,
      `🔄 *Updating your app...*\n\n` +
      `📝 Change: "${updateText.slice(0, 80)}${updateText.length > 80 ? '...' : '"'}\n` +
      `⏱️ Usually 2-4 mins. I'll send the updated link when ready!`
    );

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'running', task: `update: ${updateText}`, startedAt: new Date() });

    fetchExistingCode(last.siteUrl)
      .then(existingCode => {
        const requirement = existingCode
          ? `Here is the existing code for the app at ${last.siteUrl}:\n\n${existingCode}\n\nUPDATE REQUIREMENT: ${updateText}\n\nModify the existing code. Keep everything that works. When deploying, use site_id="${last.siteId}" to redeploy to the same site.`
          : `UPDATE REQUIREMENT: ${updateText}\n\nUpdate the app at ${last.siteUrl}. When deploying, use site_id="${last.siteId}" to redeploy to the same site.`;
        return runAgentJob(from, requirement, jobId, null, last.siteId);
      })
      .catch(err => {
        const requirement = `UPDATE REQUIREMENT: ${updateText}\n\nUpdate the app at ${last.siteUrl}. When deploying, use site_id="${last.siteId}".`;
        runAgentJob(from, requirement, jobId, null, last.siteId);
      });
    return;
  }

  // ── VOICE NOTE ────────────────────────────────────────────
  if (numMedia > 0 && mediaType0.includes('audio')) {
    twimlReply(res,
      `🎤 *Voice note received!*\n\n` +
      `🔄 Transcribing + enhancing with AI... give me a moment.`
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

  // ── CREDIT CHECK ─────────────────────────────────────────
  user = getUser(from);
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
    `📋 Task: "${msgBody.slice(0, 80)}${msgBody.length > 80 ? '...' : '"'}\n\n` +
    `⏱️ Usually takes 2–4 mins. I'll send the live link when it's ready!`
  );

  const jobId = Date.now().toString();
  jobs.set(jobId, { status: 'running', task: msgBody, startedAt: new Date() });
  runAgentJob(from, msgBody, jobId);
});

// ════════════════════════════════════════════════════════════
//  MARKET DATA PROXY  (/market/*)
// ════════════════════════════════════════════════════════════

const marketCache = {};

function cacheGet(key) {
  const entry = marketCache[key];
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  return null;
}

function cacheSet(key, data, ttlMs) {
  marketCache[key] = { data, expiresAt: Date.now() + ttlMs };
}

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function fetchYahoo(urlPath) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const res = await fetch(`https://${host}${urlPath}`, {
        headers: YF_HEADERS,
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`[Market] ${host} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

function extractQuote(data, symbol) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const meta = result.meta;
  return {
    symbol: meta.symbol || symbol,
    shortName: meta.shortName || meta.symbol || symbol,
    regularMarketPrice: meta.regularMarketPrice || meta.chartPreviousClose || null,
    regularMarketChange: meta.regularMarketPrice && meta.chartPreviousClose
      ? parseFloat((meta.regularMarketPrice - meta.chartPreviousClose).toFixed(2)) : null,
    regularMarketChangePercent: meta.regularMarketPrice && meta.chartPreviousClose
      ? parseFloat(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2)) : null,
    regularMarketVolume: meta.regularMarketVolume || null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow:  meta.fiftyTwoWeekLow  || null,
    currency:     meta.currency     || 'INR',
    exchangeName: meta.exchangeName || null,
    marketState:  meta.marketState  || 'UNKNOWN',
    previousClose: meta.chartPreviousClose || null
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
  const symbolsParam = req.query.symbols || '^NSEI,^NSEBANK,^BSESN,RELIANCE.NS,TCS.NS';
  const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
  const cacheKey = `quote:${symbols.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const results = await Promise.allSettled(
      symbols.map(async sym => {
        const data = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`);
        return extractQuote(data, sym);
      })
    );
    const quotes = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { symbol: symbols[i], error: r.reason?.message }
    );
    cacheSet(cacheKey, quotes, 60 * 1000);
    res.json(quotes);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch quotes', detail: err.message });
  }
});

app.get('/market/history', async (req, res) => {
  const symbol   = req.query.symbol   || '^NSEI';
  const interval = req.query.interval || '1d';
  const range    = req.query.range    || '1mo';
  const cacheKey = `history:${symbol}:${interval}:${range}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data   = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error(`No history data for ${symbol}`);
    const { timestamp, indicators } = result;
    const quote = indicators?.quote?.[0] || {};
    const payload = {
      symbol, interval, range,
      meta: { currency: result.meta?.currency, regularMarketPrice: result.meta?.regularMarketPrice, chartPreviousClose: result.meta?.chartPreviousClose },
      timestamps: timestamp || [],
      open: quote.open || [], high: quote.high || [], low: quote.low || [], close: quote.close || [], volume: quote.volume || []
    };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch history', detail: err.message });
  }
});

app.get('/market/indices', async (req, res) => {
  const INDEX_SYMBOLS = [
    { symbol: '^NSEI',    name: 'NIFTY 50'   },
    { symbol: '^NSEBANK', name: 'BANK NIFTY' },
    { symbol: '^BSESN',   name: 'SENSEX'     },
    { symbol: '^CNXIT',   name: 'NIFTY IT'   }
  ];
  const cached = cacheGet('indices');
  if (cached) return res.json(cached);
  try {
    const results = await Promise.allSettled(
      INDEX_SYMBOLS.map(async ({ symbol, name }) => {
        const data = await fetchYahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`);
        return { ...extractQuote(data, symbol), displayName: name };
      })
    );
    const indices = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { symbol: INDEX_SYMBOLS[i].symbol, displayName: INDEX_SYMBOLS[i].name, error: r.reason?.message }
    );
    cacheSet('indices', indices, 60 * 1000);
    res.json(indices);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch indices', detail: err.message });
  }
});

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeJobs: [...jobs.values()].filter(j => j.status === 'running').length,
    uptime: Math.floor(process.uptime()) + 's',
    features: ['text', 'voice+enhance', 'image', 'history', 'update', 'users', 'gist', 'continuation', 'market-proxy']
  });
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 WhatsApp Agent running on port ${PORT}`);
  console.log(`✅ Phase 2: gist + conversation memory + voice enhancement`);
  console.log(`✅ Owner: +917025217998`);
});
