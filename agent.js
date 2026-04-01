// ============================================================
//  agent.js  –  Claude Agentic Loop
//  Iteration-proof: never fails on complex tasks.
//  Always returns a URL — even as partial/emergency deploy.
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');
const os        = require('os');
const { deployToNetlify, deployToExistingSite } = require('./deploy');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tool definitions ────────────────────────────────────────
const TOOLS = [
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: "Relative file path e.g. 'index.html'" },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'read_file',
    description: 'Read the content of a file you previously wrote.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' }
      },
      required: ['path']
    }
  },
  {
    name: 'run_bash',
    description: 'Run a shell command in the job directory. Timeout: 60 seconds.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' }
      },
      required: ['command']
    }
  },
  {
    name: 'list_files',
    description: 'List all files in the current job directory recursively.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_url',
    description: 'Fetch the HTML content of any public URL for analysis, cloning, or reference.',
    input_schema: {
      type: 'object',
      properties: {
        url:          { type: 'string', description: 'Full URL including https://' },
        extract_type: {
          type: 'string',
          enum: ['full_html', 'text_only', 'structure'],
          description: 'full_html: complete HTML, text_only: readable text only, structure: headings/layout only'
        }
      },
      required: ['url', 'extract_type']
    }
  },
  {
    name: 'checkpoint_deploy',
    description: 'Deploy current progress as a checkpoint to get a live URL immediately. Use this when you have substantial code written but are not finished — saves progress so user always gets something. You can continue building and call deploy_to_netlify at the end to update the same URL.',
    input_schema: {
      type: 'object',
      properties: {
        site_name: { type: 'string', description: 'Checkpoint site name e.g. "my-app-checkpoint-1234"' },
        message:   { type: 'string', description: 'What is complete and what is still planned' }
      },
      required: ['site_name', 'message']
    }
  },
  {
    name: 'deploy_to_netlify',
    description: 'Deploy a web app to Netlify. Use ONLY for apps meant to be visited in a browser. For NEW apps: provide deploy_dir and site_name. For UPDATES: also provide site_id.',
    input_schema: {
      type: 'object',
      properties: {
        deploy_dir: { type: 'string', description: "Directory to deploy e.g. '.' or 'dist'" },
        site_name:  { type: 'string', description: 'Netlify site name: lowercase, hyphens, max 63 chars' },
        site_id:    { type: 'string', description: 'Optional: existing site ID for updates' }
      },
      required: ['deploy_dir', 'site_name']
    }
  },
  {
    name: 'create_gist',
    description: 'Create a GitHub Gist for code files (VBA .bas, Python .py, SQL .sql, Shell .sh, PowerShell .ps1). Use instead of deploy_to_netlify for non-web outputs.',
    input_schema: {
      type: 'object',
      properties: {
        filename:    { type: 'string', description: 'Filename with extension e.g. "macro.bas", "script.py"' },
        content:     { type: 'string', description: 'Full file content with error handling and comments' },
        description: { type: 'string', description: 'One-line description of what the code does' }
      },
      required: ['filename', 'content', 'description']
    }
  }
];

// ── System prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are an elite full-stack developer and technical expert agent. Users send requirements via WhatsApp and you build, write, or create anything technical — completely autonomously.

## WHAT YOU CAN BUILD
1. Web apps (HTML/CSS/JS/React) → deploy to Netlify
2. Dashboards and data visualizations → deploy to Netlify
3. VBA macros for Excel/Word/Outlook → GitHub Gist (.bas)
4. Python scripts and tools → GitHub Gist (.py)
5. SQL queries and stored procedures → GitHub Gist (.sql)
6. Shell/PowerShell scripts → GitHub Gist (.sh/.ps1)
7. Website clones/redesigns from URLs → deploy to Netlify
8. Games, tools, calculators → deploy to Netlify
9. Any code file → GitHub Gist

## DECISION FRAMEWORK — OUTPUT TYPE
Ask yourself: "Is this meant to be VISITED in a browser?"
- YES → write files + deploy_to_netlify
- NO  → write_file + create_gist

NEVER deploy VBA, Python, SQL, or shell scripts to Netlify.
ALWAYS use create_gist for non-web outputs.

## URL/WEBSITE HANDLING
When a URL is provided:
1. Use fetch_url tool (full_html for cloning, text_only for content)
2. Analyze: design, layout, colors, sections, features
3. Build a faithful clone or improved version
4. Always improve mobile responsiveness

## QUALITY STANDARDS
Web apps:
- Mobile-first, responsive design
- Beautiful UI: good typography, spacing, consistent color palette
- All features work — no console errors
- Handle empty states, error states, loading states
- LocalStorage for data persistence

3D & ADVANCED VISUAL EFFECTS (use when user asks for 3D, stunning, beautiful, parallax, modern, impressive):
- Three.js: cdn.jsdelivr.net/npm/three@latest/build/three.min.js
- CSS 3D transforms for card tilts and depth
- Intersection Observer for scroll animations
- Canvas particle systems
- Glassmorphism: backdrop-filter blur + semi-transparent backgrounds
- Parallax: background-attachment fixed or JS scroll
- Micro-animations with CSS @keyframes

ADVANCED UI PATTERNS:
- RequestAnimationFrame for animations (never setTimeout)
- CSS custom properties for theming
- CSS transforms instead of position changes
- Touch events + mouse events for mobile
- Keyboard navigation + aria-labels

Code files (VBA/Python/SQL):
- Production-ready with full error handling
- Comments explaining every section
- Usage instructions at top
- For VBA: Option Explicit + On Error GoTo handler
- Never deliver partial code

## WHEN FILE CONTENT IS PROVIDED
Use the actual column names, field names, and data from the file. Do not invent placeholder names.

## ITERATION MANAGEMENT — CRITICAL
You have a budget of 40 iterations. Use them wisely:

ITERATIONS 1-3 (PLANNING):
- Analyze the full requirement
- Write a brief HTML skeleton with ALL sections as empty divs
- This reserves structure so you never lose progress

ITERATIONS 4-20 (BUILDING):
- Fill in each section completely, one at a time
- Write complete CSS in ONE write_file call
- Write complete JS in sections — each feature complete before moving on
- Check file size: run_bash "wc -c index.html"
- If file > 300KB, simplify next feature before adding it

ITERATIONS 21-28 (POLISH + DEPLOY):
- Add final touches and animations
- DEPLOY by iteration 28 at the latest

ITERATIONS 29-35 (DEPLOY PHASE):
- Call deploy_to_netlify or create_gist
- If it fails, fix the specific error and retry
- Do NOT write more code during deploy phase

ITERATIONS 36-40 (EMERGENCY):
- If you reach here without deploying, something is wrong
- Deploy whatever you have RIGHT NOW
- An 80% complete app is infinitely better than nothing

## FILE SIZE MANAGEMENT
- Check size every 5 iterations: run_bash "wc -c index.html"
- If > 400KB: stop adding features, deploy immediately
- If > 200KB: simplify remaining features
- Sweet spot: 80-150KB for fast-loading beautiful app

## WRITE_FILE STRATEGY
- Write ALL CSS in one write_file call
- Write complete sections together
- Never rewrite the same file more than 3 times
- If file needs additions, rewrite it complete with additions included

## HANDLING COMPLEX REQUESTS (5+ features)
Priority order — build in this order, skip later ones if running low:
1. Core structure + background + text (MUST HAVE)
2. Primary visual effect (3D OR particles — pick ONE most impressive)
3. Typography and layout polish (MUST HAVE for Apple-like feel)
4. Secondary effects (glassmorphism cards)
5. Animations (nice to have)
6. Micro-interactions (if budget allows)

## SELF-MONITORING
At iteration 15, check with run_bash "ls -la":
- If index.html > 50KB → good, continue
- If index.html < 20KB → you're behind, write faster, skip minor features
- If no files → something wrong, restart with simpler approach

At iteration 25: if not deployed → start deploying NOW. No more features.

## CHECKPOINT DEPLOY
If you have written substantial code but aren't finished, call checkpoint_deploy to save a working version. This ensures the user always gets SOMETHING. You can continue building and call deploy_to_netlify at the end.

## CONTINUATION REQUESTS
If context shows EXISTING CODE, modify only what's needed. Preserve all working functionality.

## SITE NAMING
Pattern: {short-description}-{4 random digits} e.g. "expense-tracker-3847"

## IMPORTANT
- After deploy_to_netlify, checkpoint_deploy, or create_gist succeeds, confirm and summarize
- If an operation fails, analyze, fix, and retry up to 3 times

CRITICAL RULE: You MUST call deploy_to_netlify, checkpoint_deploy, OR create_gist before ending. Never call end_turn without completing the output step. This is mandatory every single time.

Today's date: ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
`;

// ── Tool executor ────────────────────────────────────────────
async function executeTool(toolName, toolInput, jobDir, jobId) {
  console.log(`[Job ${jobId}] 🔧 ${toolName}:`, JSON.stringify(toolInput).slice(0, 120));

  try {
    switch (toolName) {

      case 'write_file': {
        const fullPath = path.join(jobDir, toolInput.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, toolInput.content, 'utf8');
        return `Written: ${toolInput.path} (${toolInput.content.length} chars, ${toolInput.content.split('\n').length} lines)`;
      }

      case 'read_file': {
        const fullPath = path.join(jobDir, toolInput.path);
        if (!fs.existsSync(fullPath)) return `ERROR: File not found: ${toolInput.path}`;
        return fs.readFileSync(fullPath, 'utf8');
      }

      case 'run_bash': {
        try {
          const out = execSync(toolInput.command, { cwd: jobDir, timeout: 60000, encoding: 'utf8', stdio: 'pipe' });
          return out?.trim() || '(completed, no output)';
        } catch (err) {
          return `BASH_ERROR:\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || err.message}`;
        }
      }

      case 'list_files': {
        const files = getAllFiles(jobDir, jobDir);
        if (files.length === 0) return '(empty)';
        return files.map(f => {
          const stat = fs.statSync(path.join(jobDir, f));
          return `${f} (${stat.size} bytes)`;
        }).join('\n');
      }

      case 'fetch_url': {
        try {
          const res = await fetch(toolInput.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
            },
            signal: AbortSignal.timeout(15000)
          });
          if (!res.ok) return `FETCH_ERROR: HTTP ${res.status} ${res.statusText}`;
          const html = await res.text();
          if (toolInput.extract_type === 'text_only') {
            return html
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ').trim()
              .slice(0, 15000);
          }
          if (toolInput.extract_type === 'structure') {
            const headings = [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi)]
              .map(m => m[1].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
            const navLinks = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi)]
              .slice(0, 20).map(m => m[2].replace(/<[^>]*>/g, '').trim()).filter(Boolean);
            return JSON.stringify({ headings, navLinks, htmlLength: html.length });
          }
          return html.slice(0, 20000);
        } catch (err) {
          return `FETCH_ERROR: ${err.message}`;
        }
      }

      case 'checkpoint_deploy': {
        const siteName = (toolInput.site_name || `checkpoint-${Date.now()}`)
          .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 63);
        console.log(`[Job ${jobId}] 📍 Checkpoint deploy: ${siteName}`);
        try {
          const result = await deployToNetlify(jobDir, siteName, process.env.NETLIFY_AUTH_TOKEN);
          console.log(`[Job ${jobId}] 📍 Checkpoint live: ${result.url}`);
          return JSON.stringify({
            success: true,
            url: result.url,
            site_id: result.siteId,
            site_name: result.siteName,
            message: `Checkpoint saved at ${result.url}. ${toolInput.message || ''} You can continue building and call deploy_to_netlify with site_id="${result.siteId}" to update it.`
          });
        } catch (err) {
          console.error(`[Job ${jobId}] 📍 Checkpoint failed: ${err.message}`);
          return JSON.stringify({ success: false, error: err.message });
        }
      }

      case 'deploy_to_netlify': {
        const fullDeployDir = path.join(jobDir, toolInput.deploy_dir || '.');
        if (!fs.existsSync(fullDeployDir)) return `DEPLOY_ERROR: Directory not found: ${toolInput.deploy_dir}`;
        const siteName = toolInput.site_name
          .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 63);
        console.log(`[Job ${jobId}] 📦 Deploying "${siteName}" existing="${toolInput.site_id || 'none'}"`);
        try {
          const result = toolInput.site_id
            ? await deployToExistingSite(toolInput.site_id, fullDeployDir, process.env.NETLIFY_AUTH_TOKEN)
            : await deployToNetlify(fullDeployDir, siteName, process.env.NETLIFY_AUTH_TOKEN);
          console.log(`[Job ${jobId}] 🚀 Live: ${result.url}`);
          return JSON.stringify({ success: true, url: result.url, site_id: result.siteId, site_name: result.siteName });
        } catch (err) {
          console.error(`[Job ${jobId}] ❌ Deploy: ${err.message}`);
          return `DEPLOY_ERROR: ${err.message}`;
        }
      }

      case 'create_gist': {
        const token = process.env.GITHUB_TOKEN;
        if (!token) return JSON.stringify({ success: false, error: 'GITHUB_TOKEN not set in Render env vars' });
        console.log(`[Job ${jobId}] 📝 Creating Gist: ${toolInput.filename}`);
        try {
          const res = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28'
            },
            body: JSON.stringify({
              description: toolInput.description,
              public: false,
              files: { [toolInput.filename]: { content: toolInput.content } }
            })
          });
          if (!res.ok) {
            const text = await res.text();
            return JSON.stringify({ success: false, error: `GitHub API ${res.status}: ${text}` });
          }
          const gist = await res.json();
          const rawUrl = gist.files?.[toolInput.filename]?.raw_url || '';
          console.log(`[Job ${jobId}] 📝 Gist: ${gist.html_url}`);
          return JSON.stringify({ success: true, html_url: gist.html_url, raw_url: rawUrl, filename: toolInput.filename, gist_id: gist.id });
        } catch (err) {
          return JSON.stringify({ success: false, error: `Gist failed: ${err.message}` });
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `TOOL_ERROR: ${err.message}`;
  }
}

// ── Helpers ──────────────────────────────────────────────────
function getAllFiles(dir, baseDir) {
  const results = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      if (['node_modules', '.git', '.netlify'].includes(item)) continue;
      const full = path.join(dir, item);
      const rel  = path.relative(baseDir, full);
      if (fs.statSync(full).isDirectory()) results.push(...getAllFiles(full, baseDir));
      else results.push(rel);
    }
  } catch {}
  return results;
}

function buildFirstContent(requirement, imageData, imageDataArray) {
  if (imageDataArray && imageDataArray.length > 1) {
    return [
      ...imageDataArray.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
      })),
      { type: 'text', text: requirement }
    ];
  }
  if (imageData) {
    return [
      { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
      { type: 'text', text: requirement }
    ];
  }
  return requirement;
}

// Try to emergency-deploy whatever files exist in jobDir
async function emergencyDeploy(jobDir, jobId) {
  const files     = getAllFiles(jobDir, jobDir);
  const htmlFiles = files.filter(f => f.endsWith('.html'));
  const codeFiles = files.filter(f => /\.(py|bas|sql|sh|ps1)$/.test(f));
  const anyFiles  = files.filter(f => !f.endsWith('.md') && !f.endsWith('.plan'));

  console.log(`[Job ${jobId}] 🚨 Emergency deploy — files: ${files.join(', ') || 'none'}`);

  // Try 1: Deploy existing HTML files
  if (htmlFiles.length > 0) {
    const siteName = `recovery-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = await executeTool('deploy_to_netlify', { deploy_dir: '.', site_name: siteName }, jobDir, jobId);
    if (r.includes('"success":true')) {
      try {
        const p = JSON.parse(r);
        if (p.url) return { url: p.url, siteId: p.site_id, siteName: p.site_name, isGist: false };
      } catch {}
    }
  }

  // Try 2: Create Gist for code files
  if (codeFiles.length > 0) {
    for (const f of codeFiles) {
      try {
        const content = fs.readFileSync(path.join(jobDir, f), 'utf8');
        const r = await executeTool('create_gist', { filename: f, content, description: 'Auto-recovered code' }, jobDir, jobId);
        if (r.includes('"success":true')) {
          const p = JSON.parse(r);
          return { url: p.html_url, gistId: p.gist_id, rawUrl: p.raw_url, filename: f, isGist: true };
        }
      } catch {}
    }
  }

  // Try 3: Write a fallback page listing what was created, deploy it
  if (anyFiles.length > 0) {
    const fileList = anyFiles.map(f => `  <li>${f}</li>`).join('\n');
    const fallbackHtml =
      `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Partial Build</title>` +
      `<style>*{box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;` +
      `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem}` +
      `.card{max-width:480px;background:#111;border:1px solid #333;border-radius:16px;padding:2rem}` +
      `h1{color:#f59e0b;margin:0 0 1rem}ul{margin:.5rem 0 1.5rem;padding-left:1.2rem;color:#9ca3af}` +
      `p{color:#6b7280;margin:.5rem 0}</style></head>` +
      `<body><div class="card"><h1>⚠️ Partial Build</h1>` +
      `<p>The build ran out of time. Files created:</p><ul>${fileList}</ul>` +
      `<p>Send a simpler version of your request to get a complete build.</p>` +
      `</div></body></html>`;
    fs.writeFileSync(path.join(jobDir, 'index.html'), fallbackHtml, 'utf8');
    const siteName = `partial-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = await executeTool('deploy_to_netlify', { deploy_dir: '.', site_name: siteName }, jobDir, jobId);
    if (r.includes('"success":true')) {
      try {
        const p = JSON.parse(r);
        if (p.url) return { url: p.url, siteId: p.site_id, siteName: p.site_name, isGist: false, partial: true };
      } catch {}
    }
  }

  return null;
}

// ── Main agent function ──────────────────────────────────────
async function runAgent(requirement, jobId, imageData = null, existingSiteId = null, imageDataArray = null) {
  const jobDir = path.join(os.tmpdir(), `agent-job-${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[Job ${jobId}] 🚀 Starting | Task: ${requirement.slice(0, 100)}`);
  if (imageData)      console.log(`[Job ${jobId}] 🖼️ 1 image (${imageData.mediaType})`);
  if (imageDataArray) console.log(`[Job ${jobId}] 🖼️ ${imageDataArray.length} images`);
  if (existingSiteId) console.log(`[Job ${jobId}] 🔄 Update mode: ${existingSiteId}`);

  const messages = [{
    role: 'user',
    content: buildFirstContent(requirement, imageData, imageDataArray)
  }];

  let deployedUrl      = null;
  let deployedSiteId   = existingSiteId || null;
  let deployedSiteName = null;
  let deployedGistId   = null;
  let deployedRawUrl   = null;
  let deployedFilename = null;
  let isGist           = false;
  let finalSummary     = '';

  const MAX_ITERATIONS = 40;

  // Iteration phase boundaries
  const DEPLOY_NUDGE_AT    = 28; // inject a deploy-now message
  const EMERGENCY_DEPLOY_AT = 35; // force deploy whatever exists

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Determine phase label for logging
      const phase = i < 3 ? 'planning' : i < 28 ? 'building' : i < 36 ? 'deploying' : 'emergency';
      console.log(`[Job ${jobId}] 🔄 Iteration ${i + 1}/${MAX_ITERATIONS} [${phase}]`);

      // ── Inject deploy nudge at iteration 28 ─────────────────
      if (i === DEPLOY_NUDGE_AT && !deployedUrl) {
        console.log(`[Job ${jobId}] ⚡ Deploy nudge at iteration ${i + 1}`);
        messages.push({
          role: 'user',
          content: `SYSTEM NOTICE [Iteration ${i + 1}/40]: You have used ${i + 1} iterations and have NOT deployed yet. You MUST call deploy_to_netlify or create_gist RIGHT NOW. Stop writing new features. Deploy whatever files you have written so far — even if not 100% complete. Do not add anything else before deploying.`
        });
        // Loop continues — this message feeds into the next API call
        continue;
      }

      // ── Emergency: force-deploy files at iteration 35 ───────
      if (i === EMERGENCY_DEPLOY_AT && !deployedUrl) {
        console.log(`[Job ${jobId}] 🚨 Emergency deploy at iteration ${i + 1}`);
        const emergency = await emergencyDeploy(jobDir, jobId);
        if (emergency) {
          deployedUrl      = emergency.url;
          deployedSiteId   = emergency.siteId   || null;
          deployedSiteName = emergency.siteName  || null;
          deployedGistId   = emergency.gistId    || null;
          deployedRawUrl   = emergency.rawUrl    || null;
          deployedFilename = emergency.filename  || null;
          isGist           = emergency.isGist    || false;
          finalSummary     = emergency.partial
            ? `Emergency deployed at iteration ${i + 1}. The build ran out of iterations — core structure is live but some features may be incomplete.`
            : `Deployed at iteration ${i + 1} with all available files.`;
          console.log(`[Job ${jobId}] 🚨 Emergency success: ${deployedUrl}`);
          break;
        }
        // If emergency also failed, continue and let the loop exhaust
        console.log(`[Job ${jobId}] 🚨 Emergency deploy found nothing to deploy`);
        break;
      }

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages
      });

      console.log(`[Job ${jobId}] Stop: ${response.stop_reason}`);
      messages.push({ role: 'assistant', content: response.content });

      // ── end_turn — smart 3-attempt recovery ─────────────────
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(b => b.type === 'text');
        finalSummary = textBlock?.text || 'Built successfully.';

        if (!deployedUrl) {
          console.log(`[Job ${jobId}] ⚠️ end_turn with no deploy — smart recovery`);
          const files     = getAllFiles(jobDir, jobDir);
          const htmlFiles = files.filter(f => f.endsWith('.html'));
          const codeFiles = files.filter(f => /\.(py|bas|sql|sh|ps1)$/.test(f));
          const anyFiles  = files.filter(f => !f.endsWith('.md'));
          console.log(`[Job ${jobId}] ⚠️ Files: ${files.join(', ') || 'none'}`);

          // Attempt 1: Deploy HTML
          if (htmlFiles.length > 0) {
            const siteName = `recovery-${Math.floor(Math.random() * 9000 + 1000)}`;
            const r = await executeTool('deploy_to_netlify', { deploy_dir: '.', site_name: siteName }, jobDir, jobId);
            if (r.includes('"success":true')) {
              try { const p = JSON.parse(r); if (p.url) { deployedUrl = p.url; deployedSiteId = p.site_id; } } catch {}
            }
          }

          // Attempt 2: Gist for code files
          if (!deployedUrl && codeFiles.length > 0) {
            for (const f of codeFiles) {
              try {
                const content = fs.readFileSync(path.join(jobDir, f), 'utf8');
                const r = await executeTool('create_gist', { filename: f, content, description: 'Auto-recovered code' }, jobDir, jobId);
                if (r.includes('"success":true')) {
                  const p = JSON.parse(r);
                  deployedUrl = p.html_url; deployedGistId = p.gist_id;
                  deployedRawUrl = p.raw_url; deployedFilename = f; isGist = true;
                  break;
                }
              } catch {}
            }
          }

          // Attempt 3: Write a fallback page and deploy
          if (!deployedUrl && anyFiles.length > 0) {
            const fileList = anyFiles.map(f => `  <li>${f}</li>`).join('\n');
            const fallback =
              `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
              `<meta name="viewport" content="width=device-width,initial-scale=1">` +
              `<title>Partial Build</title>` +
              `<style>*{box-sizing:border-box}body{background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;` +
              `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem}` +
              `.card{max-width:480px;background:#111;border:1px solid #333;border-radius:16px;padding:2rem}` +
              `h1{color:#f59e0b;margin:0 0 1rem}ul{color:#9ca3af;margin:.5rem 0 1.5rem;padding-left:1.2rem}` +
              `p{color:#6b7280;margin:.5rem 0}</style></head>` +
              `<body><div class="card"><h1>⚠️ Partial Build</h1>` +
              `<p>Files created:</p><ul>${fileList}</ul>` +
              `<p>Try sending a simpler version for a complete build.</p>` +
              `</div></body></html>`;
            fs.writeFileSync(path.join(jobDir, 'index.html'), fallback, 'utf8');
            const siteName = `partial-${Math.floor(Math.random() * 9000 + 1000)}`;
            const r = await executeTool('deploy_to_netlify', { deploy_dir: '.', site_name: siteName }, jobDir, jobId);
            if (r.includes('"success":true')) {
              try { const p = JSON.parse(r); if (p.url) { deployedUrl = p.url; deployedSiteId = p.site_id; } } catch {}
            }
          }

          if (!deployedUrl) {
            return { success: false, error: 'Agent ended without creating any deployable files.' };
          }
        }
        break;
      }

      // ── tool_use ──────────────────────────────────────────────
      if (response.stop_reason === 'tool_use') {
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          const result = await executeTool(block.name, block.input, jobDir, jobId);

          // Capture URL from Netlify deploy
          if ((block.name === 'deploy_to_netlify' || block.name === 'checkpoint_deploy') && result.includes('"success":true')) {
            try {
              const p = JSON.parse(result);
              // Only overwrite if we don't have a final URL yet, or this is a final (non-checkpoint) deploy
              if (!deployedUrl || block.name === 'deploy_to_netlify') {
                if (p.url)       deployedUrl      = p.url;
                if (p.site_id)   deployedSiteId   = p.site_id;
                if (p.site_name) deployedSiteName = p.site_name;
                isGist = false;
              }
            } catch {}
          }

          // Capture URL from Gist
          if (block.name === 'create_gist' && result.includes('"success":true')) {
            try {
              const p = JSON.parse(result);
              if (p.html_url)  deployedUrl      = p.html_url;
              if (p.gist_id)   deployedGistId   = p.gist_id;
              if (p.raw_url)   deployedRawUrl   = p.raw_url;
              if (p.filename)  deployedFilename = p.filename;
              isGist = true;
            } catch {}
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      console.warn(`[Job ${jobId}] Unexpected stop: ${response.stop_reason}`);
      break;
    }

    // Final fallback if we exhausted all iterations
    if (!deployedUrl) {
      console.log(`[Job ${jobId}] 🆘 Exhausted iterations — last-chance emergency deploy`);
      const emergency = await emergencyDeploy(jobDir, jobId);
      if (emergency) {
        deployedUrl      = emergency.url;
        deployedSiteId   = emergency.siteId   || null;
        deployedSiteName = emergency.siteName  || null;
        deployedGistId   = emergency.gistId    || null;
        deployedRawUrl   = emergency.rawUrl    || null;
        deployedFilename = emergency.filename  || null;
        isGist           = emergency.isGist    || false;
        finalSummary     = 'Deployed after exhausting all iterations. Core files are live; some features may be incomplete.';
      } else {
        return { success: false, error: 'Agent exhausted all 40 iterations without creating deployable files. Try breaking the task into smaller steps.' };
      }
    }

    return {
      success: true,
      url:      deployedUrl,
      siteId:   deployedSiteId,
      siteName: deployedSiteName,
      gistId:   deployedGistId,
      rawUrl:   deployedRawUrl,
      filename: deployedFilename,
      isGist,
      summary:  finalSummary.slice(0, 500)
    };

  } catch (err) {
    console.error(`[Job ${jobId}] ❌ ${err.message}\n${err.stack}`);
    return { success: false, error: `Agent error: ${err.message}` };

  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    console.log(`[Job ${jobId}] 🗑️ Cleaned`);
  }
}

module.exports = { runAgent };
