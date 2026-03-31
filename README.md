# 🤖 WhatsApp AI Dev Agent

Send a requirement to WhatsApp → Claude builds the app → You get a live Netlify URL back.

```
You (WhatsApp)
    │  "Build me a BMI calculator with dark theme"
    ▼
Twilio Webhook
    │
    ▼
Express Server (Render)
    │  "Working on it! ⚙️"  ──────────────────────────► Your WhatsApp
    │
    ▼
Claude Agent Loop
  ├─ write_file(index.html)
  ├─ run_bash(validate)
  └─ deploy_to_netlify()
    │
    ▼
Netlify (live app)
    │
    ▼
Twilio → "✅ Live at https://bmi-calc-3847.netlify.app"  ► Your WhatsApp
```

---

## 📋 Prerequisites

- Node.js 18+
- A [Twilio account](https://twilio.com) (free sandbox works)
- A [Netlify account](https://netlify.com) (free)
- An [Anthropic API key](https://console.anthropic.com)
- A [Render account](https://render.com) (free)

---

## 🛠️ Setup (One Time)

### Step 1 — Get your API keys

**Anthropic:**
1. Go to https://console.anthropic.com/settings/keys
2. Create a new key → copy it

**Netlify:**
1. Go to https://app.netlify.com/user/applications
2. Click "New access token" → copy it

**Twilio:**
1. Go to https://console.twilio.com
2. Note your Account SID and Auth Token from the dashboard
3. Go to Messaging → Try it out → Send a WhatsApp message
4. Enable the WhatsApp Sandbox
5. Follow instructions to join the sandbox from your WhatsApp

---

### Step 2 — Deploy to Render (free hosting)

1. Push this project to a **GitHub repo**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/whatsapp-agent.git
   git push -u origin main
   ```

2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name**: whatsapp-agent
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

5. Add Environment Variables (click "Environment"):
   ```
   ANTHROPIC_API_KEY       = sk-ant-...
   TWILIO_ACCOUNT_SID      = AC...
   TWILIO_AUTH_TOKEN       = ...
   TWILIO_WHATSAPP_FROM    = whatsapp:+14155238886
   ALLOWED_WHATSAPP_NUMBER = whatsapp:+91XXXXXXXXXX  ← your number
   NETLIFY_AUTH_TOKEN      = ...
   ```

6. Click **Create Web Service**
7. Wait ~2 mins → you'll get a URL like: `https://whatsapp-agent-xxxx.onrender.com`

---

### Step 3 — Connect Twilio to your server

1. In Twilio Console → Messaging → Settings → WhatsApp Sandbox Settings
2. Set **"When a message comes in"** to:
   ```
   https://whatsapp-agent-xxxx.onrender.com/webhook
   ```
3. Method: **HTTP POST**
4. Save

---

### Step 4 — Test it!

Send this to your Twilio WhatsApp sandbox number:
```
Build a beautiful expense tracker with charts, add/delete expenses, 
categories, and a monthly summary. Dark theme.
```

You'll get:
1. Immediate reply: "⚙️ Got it! Building your app..."
2. 2-4 mins later: "✅ Live at https://expense-tracker-3847.netlify.app"

---

## 💬 Usage Tips

### What to send:
```
Build a Pomodoro timer with task list and sound alerts

Make a currency converter for USD, EUR, GBP, INR with live rates

Create a markdown editor with live preview and export to PDF

Build a habit tracker with streaks, calendar view, and local storage

Make a QR code generator that works offline
```

### Special commands:
- Send **`status`** → see if any jobs are currently running

### ⚠️ Note on Render free tier:
Render's free tier **spins down after 15 minutes of inactivity**.  
The first WhatsApp message after inactivity will take ~30-50 seconds to wake up  
(Twilio may retry automatically). After wake-up, everything is fast.

**To avoid spin-down** (optional): Use a free uptime monitor like  
[UptimeRobot](https://uptimerobot.com) to ping `/health` every 14 minutes.

---

## 🏗️ Architecture

```
server.js     Express webhook, Twilio integration, job tracking
agent.js      Claude agentic loop with tool use (up to 25 iterations)
deploy.js     Netlify REST API: create site → zip → deploy → wait → URL
```

### Claude's Tools:
| Tool | What it does |
|------|-------------|
| `write_file` | Creates HTML, CSS, JS files |
| `read_file` | Reads files it wrote |
| `run_bash` | Validates code, runs builds |
| `list_files` | Checks what's in the job dir |
| `deploy_to_netlify` | Zips + deploys + returns URL |

### Error recovery:
If deployment fails, Claude reads the error message and automatically:
1. Identifies the root cause
2. Fixes the relevant files  
3. Retries the deployment (up to 3 times)

---

## 💰 Cost Estimate

Per build (typical):
- Claude API: ~8-15K tokens ≈ ₹2-6
- Twilio messages: 2 messages ≈ $0.01 ≈ ₹0.80
- Netlify: Free tier (100 sites, 100GB bandwidth/month)
- Render: Free

**~₹3-7 per app built**

---

## 🔒 Security

- Only `ALLOWED_WHATSAPP_NUMBER` can trigger the agent
- All credentials are in environment variables (never in code)
- Each build runs in an isolated temp directory
- Temp files cleaned up after every job

---

## 🚀 Upgrading to Production WhatsApp

When you want a real WhatsApp number (not sandbox):
1. Go to Twilio → Messaging → Senders → WhatsApp Senders
2. Apply for a WhatsApp Business number ($1-5/month)
3. Update `TWILIO_WHATSAPP_FROM` in Render env vars

---

## 📁 Project Structure

```
whatsapp-agent/
├── server.js         # Express + Twilio webhook
├── agent.js          # Claude agentic loop
├── deploy.js         # Netlify REST API deployment
├── package.json
├── .env.example      # Template for env vars
└── README.md
```
