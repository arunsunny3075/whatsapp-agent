// ============================================================
//  WhatsApp AI Agent Server
//  Receives WhatsApp messages via Twilio, runs Claude agent,
//  deploys to Netlify, and replies with the live URL.
// ============================================================

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { runAgent } = require('./agent');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Twilio client (for sending proactive messages back) ─────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Security: Only your number can trigger the agent ────────
const ALLOWED_NUMBER = process.env.ALLOWED_WHATSAPP_NUMBER; // e.g. whatsapp:+919876543210

// ── In-memory job tracker (for status queries) ──────────────
const jobs = new Map();

// ── POST /webhook  (Twilio sends all incoming WhatsApp msgs) ─
app.post('/webhook', async (req, res) => {
  const from = req.body.From;           // e.g. whatsapp:+919876543210
  const msgBody = req.body.Body?.trim();

  // Block all numbers except yours
  if (from !== ALLOWED_NUMBER) {
    console.warn(`[BLOCKED] Message from unknown number: ${from}`);
    return res.status(403).send('Forbidden');
  }

  // Handle status check command
  if (msgBody?.toLowerCase() === 'status') {
    const activeJobs = [...jobs.values()].filter(j => j.status === 'running');
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(
      activeJobs.length > 0
        ? `⚙️ ${activeJobs.length} job(s) running:\n${activeJobs.map(j => `• ${j.task.slice(0, 60)}...`).join('\n')}`
        : '✅ No active jobs. Send me a requirement!'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  // ── Immediately acknowledge to Twilio (15s timeout) ────────
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(
    `⚙️ Got it! Building your app now...\n\n` +
    `📋 Task: "${msgBody?.slice(0, 80)}${msgBody?.length > 80 ? '...' : ''}"\n\n` +
    `⏱️ Usually takes 2–4 mins. I'll send the live link when it's ready!`
  );
  res.type('text/xml').send(twiml.toString());

  // ── Run the agent asynchronously ────────────────────────────
  const jobId = Date.now().toString();
  jobs.set(jobId, { status: 'running', task: msgBody, startedAt: new Date() });

  runAgent(msgBody, jobId)
    .then(result => {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'done', result });

      const message = result.success
        ? `✅ *App is live!*\n\n` +
          `🔗 ${result.url}\n\n` +
          `📝 ${result.summary}`
        : `❌ *Build failed*\n\n${result.error}\n\nSend your requirement again to retry.`;

      return twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,  // e.g. whatsapp:+14155238886
        to: from,
        body: message
      });
    })
    .then(() => {
      console.log(`[Job ${jobId}] Reply sent.`);
      // Clean up old jobs after 10 mins
      setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
    })
    .catch(err => {
      console.error(`[Job ${jobId}] Fatal error:`, err.message);
      twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: from,
        body: `❌ Something went wrong on my end: ${err.message}\n\nTry again!`
      }).catch(() => {});
    });
});

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeJobs: [...jobs.values()].filter(j => j.status === 'running').length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 WhatsApp Agent running on port ${PORT}`);
  console.log(`✅ Allowed number: ${ALLOWED_NUMBER}`);
});
