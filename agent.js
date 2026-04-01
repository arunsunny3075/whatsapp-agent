// ============================================================
//  agent.js  –  Claude Agentic Loop
//  Handles: web apps (Netlify), code files (GitHub Gist),
//  URL fetching, multi-image vision, VBA/Python/SQL, and more.
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
    description: 'Fetch the HTML content of any public URL for analysis, cloning, or reference. Use when the user provides a website link to clone, analyze, or reference. Also use to look up documentation or examples.',
    input_schema: {
      type: 'object',
      properties: {
        url:          { type: 'string', description: 'Full URL including https://' },
        extract_type: {
          type: 'string',
          enum: ['full_html', 'text_only', 'structure'],
          description: 'full_html: complete HTML (best for cloning), text_only: just readable text, structure: headings and layout only'
        }
      },
      required: ['url', 'extract_type']
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
    description: 'Create a GitHub Gist to share a code file. Use instead of deploy_to_netlify when output is a code file (VBA .bas, Python .py, SQL .sql, Shell .sh, PowerShell .ps1, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        filename:    { type: 'string', description: 'Filename with extension e.g. "macro.bas", "script.py"' },
        content:     { type: 'string', description: 'Full file content — production-ready with error handling and comments' },
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
8. Data analysis and reports → GitHub Gist (.md) or Netlify
9. Games, tools, calculators → deploy to Netlify
10. Any code file → GitHub Gist

## DECISION FRAMEWORK — OUTPUT TYPE
Ask yourself: "Is this meant to be VISITED in a browser?"
- YES → write files + deploy_to_netlify
- NO  → write_file + create_gist

Examples:
- "Build a todo app" → Netlify
- "Write VBA to split Excel" → Gist (.bas)
- "Python script to process CSV" → Gist (.py)
- "Clone this website" → fetch_url first, then Netlify
- "SQL query for monthly report" → Gist (.sql)
- "Build a game" → Netlify

NEVER deploy VBA, Python scripts, SQL, or shell scripts to Netlify.
ALWAYS use create_gist for non-web outputs.

## URL/WEBSITE HANDLING
When a URL is provided:
1. Use fetch_url tool to get the page content (use 'full_html' for cloning, 'text_only' for content extraction)
2. Analyze: design, layout, color scheme, sections, components, features
3. Build a faithful clone or improved version based on the instruction
4. If user says "clone" → replicate the design as closely as possible
5. If user says "similar" or "inspired by" → take the best ideas, improve on them
6. Always improve on mobile responsiveness and modern CSS practices

## QUALITY STANDARDS
Web apps:
- Mobile-first, responsive design
- Beautiful UI: good typography, spacing, consistent color palette
- All features must work — no console errors, no broken interactions
- Handle empty states, error states, and loading states
- Local storage for persistence where appropriate

3D & ADVANCED VISUAL EFFECTS (use when user asks for 3D, stunning, beautiful, parallax, modern, impressive):
- Three.js for 3D objects: cdn.jsdelivr.net/npm/three@latest/build/three.min.js
- CSS 3D transforms for card tilts and depth effects
- Intersection Observer API for scroll-triggered animations
- Particle systems using HTML canvas
- Glassmorphism: backdrop-filter blur + semi-transparent backgrounds
- Neumorphism: inset shadows for soft UI
- Parallax: background-attachment fixed or JS scroll handlers
- Smooth scroll + micro-animations with CSS @keyframes
- Skeleton loading placeholders for async content

ADVANCED UI PATTERNS:
- Debounce scroll/resize event handlers
- RequestAnimationFrame for smooth animations (never setTimeout for animations)
- CSS custom properties (variables) for consistent theming
- CSS transforms instead of position changes for performance
- Touch events alongside mouse events for mobile
- Keyboard navigation + aria-labels for accessibility

Code files (VBA/Python/SQL):
- Production-ready with full error handling
- Comprehensive comments explaining every section
- Usage instructions at the top of the file
- For VBA: use Option Explicit, On Error GoTo handler
- For Python: include imports and requirements in comments
- Never deliver partial code

## WHEN FILE CONTENT IS PROVIDED
If the context shows "USER PROVIDED FILE", use the actual column names, field names, and data structure from the file — don't invent placeholder names. Build exactly to what the file contains.

## CONTINUATION REQUESTS
If context shows EXISTING CODE, modify only what's needed. Preserve all working functionality.

## SITE NAMING
Pattern: {short-description}-{4 random digits} e.g. "expense-tracker-3847"

## COMPLEX TASK HANDLING
When a request has more than 4 distinct features or requirements:

1. PLAN first — write_file a plan.md listing all components
2. BUILD incrementally:
   - Write the complete HTML skeleton first
   - Add CSS for all sections
   - Add JavaScript features one by one
   - Each feature in its own clearly commented section
3. VALIDATE with run_bash after each major addition:
   - Check file size (should be under 500KB)
   - Check for syntax errors
4. NEVER try to write everything in one write_file call if it exceeds 800 lines — split into logical chunks and concatenate
5. If you hit an error on one feature, skip it and continue with the rest — partial is better than nothing
6. Always deploy what you have — an 80% complete awesome website beats a failed 100% attempt

## MAX ITERATIONS HANDLING
If you are on iteration 18+ and haven't deployed yet:
- STOP adding new features
- Deploy whatever is complete RIGHT NOW
- Note what was completed in the summary

## IMPORTANT
- After deploy_to_netlify or create_gist succeeds, confirm and summarize
- If an operation fails, analyze, fix, and retry up to 3 times

CRITICAL RULE: You MUST call either deploy_to_netlify OR create_gist before ending. Never call end_turn without completing the output step. This is mandatory every single time.

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
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: AbortSignal.timeout(15000)
          });
          if (!res.ok) return `FETCH_ERROR: HTTP ${res.status} ${res.statusText}`;
          const html = await res.text();

          if (toolInput.extract_type === 'text_only') {
            const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                             .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .trim();
            return text.slice(0, 15000);
          }
          if (toolInput.extract_type === 'structure') {
            const headings = [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi)]
              .map(m => m[1].replace(/<[^>]*>/g, '').trim())
              .filter(Boolean);
            const navLinks = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi)]
              .slice(0, 20)
              .map(m => m[2].replace(/<[^>]*>/g, '').trim())
              .filter(Boolean);
            return JSON.stringify({ headings, navLinks, htmlLength: html.length });
          }
          // full_html — truncated
          return html.slice(0, 20000);
        } catch (err) {
          return `FETCH_ERROR: ${err.message}`;
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

          const out = JSON.stringify({ success: true, url: result.url, site_id: result.siteId, site_name: result.siteName });
          console.log(`[Job ${jobId}] 🚀 Live: ${result.url}`);
          return out;
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
  for (const item of fs.readdirSync(dir)) {
    if (['node_modules', '.git', '.netlify'].includes(item)) continue;
    const full = path.join(dir, item);
    const rel  = path.relative(baseDir, full);
    if (fs.statSync(full).isDirectory()) results.push(...getAllFiles(full, baseDir));
    else results.push(rel);
  }
  return results;
}

// Build first message content — supports single image, multiple images, or plain text
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

// ── Main agent function ──────────────────────────────────────
// imageData     = { base64, mediaType } | null   (single image)
// existingSiteId = Netlify site ID for update jobs | null
// imageDataArray = [{ base64, mediaType }, ...] | null  (multiple images)
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
  const MAX_ITERATIONS = 25;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`[Job ${jobId}] 🔄 Iteration ${i + 1}`);

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages
      });

      console.log(`[Job ${jobId}] Stop: ${response.stop_reason}`);
      messages.push({ role: 'assistant', content: response.content });

      // ── end_turn ──────────────────────────────────────────
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(b => b.type === 'text');
        finalSummary = textBlock?.text || 'Built successfully.';

        if (!deployedUrl) {
          console.log(`[Job ${jobId}] ⚠️ end_turn no deploy — forcing`);
          const fallback = `auto-deploy-${Math.floor(Math.random() * 9000 + 1000)}`;
          const deployResult = await executeTool('deploy_to_netlify', { deploy_dir: '.', site_name: fallback }, jobDir, jobId);
          if (deployResult.includes('"success":true')) {
            try {
              const p = JSON.parse(deployResult);
              deployedUrl = p.url; deployedSiteId = p.site_id; deployedSiteName = p.site_name;
            } catch {}
          }
          if (!deployedUrl) return { success: false, error: `Agent ended without deploying. Forced deploy also failed: ${deployResult}` };
        }
        break;
      }

      // ── tool_use ──────────────────────────────────────────
      if (response.stop_reason === 'tool_use') {
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          const result = await executeTool(block.name, block.input, jobDir, jobId);

          if (block.name === 'deploy_to_netlify' && result.includes('"success":true')) {
            try {
              const p = JSON.parse(result);
              deployedUrl = p.url; deployedSiteId = p.site_id; deployedSiteName = p.site_name;
              isGist = false;
            } catch {}
          }

          if (block.name === 'create_gist' && result.includes('"success":true')) {
            try {
              const p = JSON.parse(result);
              deployedUrl = p.html_url; deployedGistId = p.gist_id;
              deployedRawUrl = p.raw_url; deployedFilename = p.filename;
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

    if (!deployedUrl) {
      return { success: false, error: 'Agent hit max iterations without deploying. Try breaking the task into smaller steps.' };
    }

    return {
      success: true, url: deployedUrl,
      siteId: deployedSiteId, siteName: deployedSiteName,
      gistId: deployedGistId, rawUrl: deployedRawUrl,
      filename: deployedFilename, isGist,
      summary: finalSummary.slice(0, 500)
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
