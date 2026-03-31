// ============================================================
//  agent.js  –  Claude Agentic Loop
//  Receives a requirement, writes code, deploys to Netlify,
//  retries on errors. Returns { success, url, summary }.
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const { deployToNetlify } = require('./deploy');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tool definitions (what Claude can do) ───────────────────
const TOOLS = [
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories automatically. Use for HTML, CSS, JS, JSON files.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Relative file path, e.g. 'index.html' or 'src/app.js'"
        },
        content: {
          type: 'string',
          description: 'Full file content to write'
        }
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
    description: 'Run a shell command in the job directory. Use to validate HTML, check JSON syntax, run a build, or inspect output. Timeout: 60 seconds.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run (e.g. "node -c app.js", "cat index.html", "ls -la")'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'list_files',
    description: 'List all files in the current job directory recursively.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'deploy_to_netlify',
    description: 'Deploy the app to Netlify and get a live HTTPS URL. Call this ONLY when all files are complete and error-free. Returns the live URL on success.',
    input_schema: {
      type: 'object',
      properties: {
        deploy_dir: {
          type: 'string',
          description: "Directory to deploy, relative to job root. Use '.' for root, 'dist' for build output."
        },
        site_name: {
          type: 'string',
          description: 'Netlify site name: lowercase letters, numbers, hyphens only. Max 63 chars. Example: "expense-tracker-8472"'
        }
      },
      required: ['deploy_dir', 'site_name']
    }
  }
];

// ── System prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are an elite full-stack developer agent. Users send you app requirements via WhatsApp and you build + deploy them to Netlify — completely autonomously.

## YOUR WORKFLOW
1. **Analyze** the requirement carefully
2. **Decide** the best tech: single HTML file (preferred) vs multi-file
3. **Write** all necessary files using write_file
4. **Validate** using run_bash (check for syntax errors if needed)
5. **Deploy** using deploy_to_netlify
6. **Retry** automatically if deploy fails — read the error, fix it, redeploy
7. **Summarize** what you built in 2-3 sentences

## TECH PREFERENCES (in order)
1. **Single-file HTML** (inline CSS + JS) — fastest, zero build step, works great for most apps
2. **HTML + separate CSS/JS files** — for more organized code
3. **React via CDN** (unpkg/esm.sh) — no npm build needed, for interactive UIs
4. **Node/npm build** — only if truly necessary

## QUALITY STANDARDS
- Mobile-first, responsive design
- Beautiful UI (good typography, colors, spacing)
- All features from the requirement must work
- No console errors, no broken links
- Test edge cases (empty states, error states)

## SITE NAMING
Generate unique site names: lowercase, hyphens only, end with 4 random digits
Pattern: {short-app-description}-{4digits}
Examples: "todo-app-3847", "weather-dash-9201", "recipe-finder-5512"

## IMPORTANT
- After deploy_to_netlify returns a URL, confirm it worked and output the URL prominently
- If deploy fails, analyze the error, fix the root cause, and retry — up to 3 times
- Never give up without trying at least 2 deploy attempts

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
        const lines = toolInput.content.split('\n').length;
        return `✓ Written: ${toolInput.path} (${toolInput.content.length} chars, ${lines} lines)`;
      }

      case 'read_file': {
        const fullPath = path.join(jobDir, toolInput.path);
        if (!fs.existsSync(fullPath)) return `ERROR: File not found: ${toolInput.path}`;
        return fs.readFileSync(fullPath, 'utf8');
      }

      case 'run_bash': {
        try {
          const output = execSync(toolInput.command, {
            cwd: jobDir,
            timeout: 60000,
            encoding: 'utf8',
            stdio: 'pipe'
          });
          return output?.trim() || '(command completed, no output)';
        } catch (err) {
          return `BASH_ERROR:\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || err.message}`;
        }
      }

      case 'list_files': {
        const files = getAllFiles(jobDir, jobDir);
        if (files.length === 0) return '(directory is empty)';
        const sizes = files.map(f => {
          const stat = fs.statSync(path.join(jobDir, f));
          return `${f} (${stat.size} bytes)`;
        });
        return sizes.join('\n');
      }

      case 'deploy_to_netlify': {
        const fullDeployDir = path.join(jobDir, toolInput.deploy_dir || '.');
        if (!fs.existsSync(fullDeployDir)) {
          return `DEPLOY_ERROR: Directory not found: ${toolInput.deploy_dir}`;
        }

        // Sanitize site name
        const siteName = toolInput.site_name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .slice(0, 63);

        try {
          const result = await deployToNetlify(
            fullDeployDir,
            siteName,
            process.env.NETLIFY_AUTH_TOKEN
          );
          console.log(`[Job ${jobId}] 🚀 Deployed: ${result.url}`);
          return JSON.stringify({ success: true, url: result.url, site_id: result.siteId });
        } catch (err) {
          return `DEPLOY_ERROR: ${err.message}`;
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `TOOL_ERROR: ${err.message}`;
  }
}

// ── Helper: get all files recursively ───────────────────────
function getAllFiles(dir, baseDir) {
  const results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (['node_modules', '.git', '.netlify'].includes(item)) continue;
    const fullPath = path.join(dir, item);
    const relPath = path.relative(baseDir, fullPath);
    if (fs.statSync(fullPath).isDirectory()) {
      results.push(...getAllFiles(fullPath, baseDir));
    } else {
      results.push(relPath);
    }
  }
  return results;
}

// ── Main agent function ──────────────────────────────────────
async function runAgent(requirement, jobId) {
  const jobDir = path.join(os.tmpdir(), `agent-job-${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[Job ${jobId}] 🚀 Starting agent`);
  console.log(`[Job ${jobId}] 📋 Task: ${requirement}`);

  const messages = [
    { role: 'user', content: requirement }
  ];

  let deployedUrl = null;
  let finalSummary = '';
  const MAX_ITERATIONS = 25; // Safety limit

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`[Job ${jobId}] 🔄 Iteration ${i + 1}/${MAX_ITERATIONS}`);

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages
      });

      console.log(`[Job ${jobId}] Stop reason: ${response.stop_reason}`);

      // Add assistant's response to conversation history
      messages.push({ role: 'assistant', content: response.content });

      // ── Agent finished (no more tool calls) ──────────────
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(b => b.type === 'text');
        finalSummary = textBlock?.text || 'App built and deployed successfully.';

        if (!deployedUrl) {
          // Edge case: agent said it's done but no URL captured
          return {
            success: false,
            error: 'Agent finished but no deployment URL was found. The app may not have been deployed.'
          };
        }
        break;
      }

      // ── Agent wants to use tools ──────────────────────────
      if (response.stop_reason === 'tool_use') {
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          const result = await executeTool(block.name, block.input, jobDir, jobId);

          // Extract deployed URL when deploy succeeds
          if (block.name === 'deploy_to_netlify' && result.includes('"success":true')) {
            try {
              const parsed = JSON.parse(result);
              if (parsed.url) deployedUrl = parsed.url;
            } catch {}
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: String(result)
          });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      console.warn(`[Job ${jobId}] Unexpected stop_reason: ${response.stop_reason}`);
      break;
    }

    if (!deployedUrl) {
      return {
        success: false,
        error: 'Agent hit max iterations without deploying. The task may be too complex — try breaking it into smaller steps.'
      };
    }

    return {
      success: true,
      url: deployedUrl,
      summary: finalSummary.slice(0, 500) // Keep WhatsApp message reasonable
    };

  } catch (err) {
    console.error(`[Job ${jobId}] ❌ Agent error:`, err.message);
    return { success: false, error: `Agent error: ${err.message}` };

  } finally {
    // Clean up temp files
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      console.log(`[Job ${jobId}] 🗑️ Cleaned up job dir`);
    } catch {}
  }
}

module.exports = { runAgent };
