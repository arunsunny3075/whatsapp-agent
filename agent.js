// ============================================================
//  agent.js  –  Claude Agentic Loop
//  Handles: web apps (Netlify), code files (GitHub Gist),
//  scripts, macros, SQL, Python, VBA, and more.
//  Returns { success, url, summary, isGist, rawUrl, filename, gistId }
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const { deployToNetlify, deployToExistingSite } = require('./deploy');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tool definitions ────────────────────────────────────────
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
    description: 'Deploy a web app to Netlify and get a live HTTPS URL. Use ONLY for apps meant to be visited in a browser. For NEW apps: provide deploy_dir and site_name. For UPDATES: also provide site_id.',
    input_schema: {
      type: 'object',
      properties: {
        deploy_dir: {
          type: 'string',
          description: "Directory to deploy, relative to job root. Use '.' for root, 'dist' for build output."
        },
        site_name: {
          type: 'string',
          description: 'Netlify site name: lowercase letters, numbers, hyphens only. Max 63 chars.'
        },
        site_id: {
          type: 'string',
          description: 'Optional. Existing Netlify site ID for updates.'
        }
      },
      required: ['deploy_dir', 'site_name']
    }
  },
  {
    name: 'create_gist',
    description: 'Create a GitHub Gist to share a code file. Use this instead of deploy_to_netlify when the output is a code file (VBA .bas, Python .py, SQL .sql, shell .sh, PowerShell .ps1, etc.) rather than a deployable web app.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename with correct extension e.g. "AlertDistributor.bas", "process_csv.py", "monthly_report.sql"'
        },
        content: {
          type: 'string',
          description: 'Full file content — production-ready, fully commented, with error handling'
        },
        description: {
          type: 'string',
          description: 'Brief one-line description of what the code does'
        }
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
7. Data analysis and reports → GitHub Gist (.md) or Netlify
8. API integrations → deploy to Netlify or GitHub Gist
9. Algorithms and data structures → GitHub Gist
10. Excel formulas with explanations → GitHub Gist (.md)

## DECISION FRAMEWORK — OUTPUT TYPE
Ask yourself: "Is this meant to be VISITED in a browser?"
- YES → write files + deploy_to_netlify
- NO  → write_file + create_gist

Examples:
- "Build a todo app" → Netlify (visited in browser)
- "Write VBA to split Excel by branch" → Gist (.bas)
- "Create Python script to process CSV" → Gist (.py)
- "Build a dashboard showing sales" → Netlify
- "Write SQL query for monthly report" → Gist (.sql)
- "Build a calculator" → Netlify
- "Write a PowerShell script to backup files" → Gist (.ps1)

NEVER deploy a VBA macro, Python script, SQL query, or shell script to Netlify.
ALWAYS use create_gist for non-web outputs.

## QUALITY STANDARDS
Web apps:
- Mobile-first, responsive, beautiful UI (good typography, colors, spacing)
- All features must work, no console errors
- Handle empty states and errors gracefully
- Test edge cases

Code files (VBA/Python/SQL/scripts):
- Production-ready, fully commented
- Include error handling (On Error GoTo for VBA, try/except for Python)
- Include usage instructions as comments at top of file
- For VBA: use Option Explicit, include Sub/Function declarations
- For Python: include required imports and requirements as comments at top
- For SQL: include sample data comments if helpful
- Never deliver partial or incomplete code

## COMPLEXITY HANDLING
For complex multi-part tasks:
1. Break into logical components
2. Build each component completely
3. Test/validate with run_bash if needed
4. Combine into final output
5. Never deliver partial/incomplete work

## VBA SPECIFIC RULES
- Always use Option Explicit at top
- Include error handling: On Error GoTo ErrorHandler with cleanup label
- Add progress indicators for long operations (Application.StatusBar)
- Comment every major section with '---' separator lines
- Include a clear description comment block at the very top

## SITE NAMING (Netlify only)
Generate unique site names: lowercase, hyphens only, end with 4 random digits
Pattern: {short-app-description}-{4digits}
Examples: "todo-app-3847", "weather-dash-9201"

## CONTINUATION REQUESTS
If the context shows EXISTING CODE, modify only what's needed.
Keep everything that works, change only what's requested.
Preserve all existing functionality.

## IMPORTANT
- After deploy_to_netlify or create_gist succeeds, confirm and summarize what was built
- If an operation fails, analyze the error, fix it, and retry — up to 3 times
- Never give up without trying at least 2 attempts

CRITICAL RULE: You MUST call either deploy_to_netlify OR create_gist before ending. Never call end_turn without having successfully deployed or created a gist. The final output step is mandatory every time.

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

        const siteName = toolInput.site_name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .slice(0, 63);

        console.log(`[Job ${jobId}] 📦 Deploying dir="${fullDeployDir}" site="${siteName}" existing_id="${toolInput.site_id || 'none'}"`);
        try {
          const result = toolInput.site_id
            ? await deployToExistingSite(toolInput.site_id, fullDeployDir, process.env.NETLIFY_AUTH_TOKEN)
            : await deployToNetlify(fullDeployDir, siteName, process.env.NETLIFY_AUTH_TOKEN);

          const resultStr = JSON.stringify({ success: true, url: result.url, site_id: result.siteId, site_name: result.siteName });
          console.log(`[Job ${jobId}] 🚀 Deployed: ${result.url}`);
          return resultStr;
        } catch (err) {
          const errMsg = `DEPLOY_ERROR: ${err.message}`;
          console.error(`[Job ${jobId}] ❌ Deploy failed: ${err.message}`);
          console.error(`[Job ${jobId}] ❌ Deploy stack: ${err.stack}`);
          return errMsg;
        }
      }

      case 'create_gist': {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          return JSON.stringify({ success: false, error: 'GITHUB_TOKEN not set in environment — add it to Render env vars' });
        }

        const body = {
          description: toolInput.description,
          public: false,
          files: {
            [toolInput.filename]: {
              content: toolInput.content
            }
          }
        };

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
            body: JSON.stringify(body)
          });

          if (!res.ok) {
            const text = await res.text();
            return JSON.stringify({ success: false, error: `GitHub API error: ${res.status} ${text}` });
          }

          const gist = await res.json();
          const rawUrl = gist.files?.[toolInput.filename]?.raw_url || '';
          const result = JSON.stringify({
            success: true,
            html_url: gist.html_url,
            raw_url: rawUrl,
            filename: toolInput.filename,
            gist_id: gist.id
          });
          console.log(`[Job ${jobId}] 📝 Gist created: ${gist.html_url}`);
          return result;
        } catch (err) {
          console.error(`[Job ${jobId}] ❌ Gist failed: ${err.message}`);
          return JSON.stringify({ success: false, error: `Gist creation failed: ${err.message}` });
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
// imageData = { base64: '...', mediaType: 'image/jpeg' } | null
// existingSiteId = Netlify site ID string for update jobs | null
async function runAgent(requirement, jobId, imageData = null, existingSiteId = null) {
  const jobDir = path.join(os.tmpdir(), `agent-job-${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`[Job ${jobId}] 🚀 Starting agent`);
  console.log(`[Job ${jobId}] 📋 Task: ${requirement.slice(0, 120)}`);
  if (imageData) console.log(`[Job ${jobId}] 🖼️ Image attached (${imageData.mediaType})`);
  if (existingSiteId) console.log(`[Job ${jobId}] 🔄 Update mode: site ${existingSiteId}`);

  const firstUserContent = imageData
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
        { type: 'text', text: requirement }
      ]
    : requirement;

  const messages = [
    { role: 'user', content: firstUserContent }
  ];

  let deployedUrl       = null;
  let deployedSiteId    = existingSiteId || null;
  let deployedSiteName  = null;
  let deployedGistId    = null;
  let deployedRawUrl    = null;
  let deployedFilename  = null;
  let isGist            = false;
  let finalSummary      = '';
  const MAX_ITERATIONS  = 25;

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
      messages.push({ role: 'assistant', content: response.content });

      // ── Agent finished ────────────────────────────────────
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(b => b.type === 'text');
        finalSummary = textBlock?.text || 'Built and delivered successfully.';

        if (!deployedUrl) {
          // Force a Netlify deploy as last resort (web apps only)
          console.log(`[Job ${jobId}] ⚠️ end_turn with no deploy — forcing deploy_to_netlify`);
          console.log(`[Job ${jobId}] ⚠️ jobDir contents: ${fs.readdirSync(jobDir).join(', ')}`);
          const fallbackSiteName = `auto-deploy-${Math.floor(Math.random() * 9000 + 1000)}`;
          const deployResult = await executeTool(
            'deploy_to_netlify',
            { deploy_dir: '.', site_name: fallbackSiteName },
            jobDir,
            jobId
          );
          console.log(`[Job ${jobId}] ⚠️ Forced deploy result: ${deployResult}`);
          if (deployResult.includes('"success":true')) {
            try {
              const parsed = JSON.parse(deployResult);
              if (parsed.url) deployedUrl = parsed.url;
              if (parsed.site_id) deployedSiteId = parsed.site_id;
              if (parsed.site_name) deployedSiteName = parsed.site_name;
            } catch {}
          }
          if (!deployedUrl) {
            return { success: false, error: `Agent ended without deploying and forced deploy also failed: ${deployResult}` };
          }
        }
        break;
      }

      // ── Tool use ──────────────────────────────────────────
      if (response.stop_reason === 'tool_use') {
        const toolResults = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;

          const result = await executeTool(block.name, block.input, jobDir, jobId);

          // Capture deployed URL from Netlify
          if (block.name === 'deploy_to_netlify' && result.includes('"success":true')) {
            try {
              const parsed = JSON.parse(result);
              if (parsed.url)       deployedUrl      = parsed.url;
              if (parsed.site_id)   deployedSiteId   = parsed.site_id;
              if (parsed.site_name) deployedSiteName = parsed.site_name;
              isGist = false;
            } catch {}
          }

          // Capture Gist URL from create_gist
          if (block.name === 'create_gist' && result.includes('"success":true')) {
            try {
              const parsed = JSON.parse(result);
              if (parsed.html_url)  deployedUrl      = parsed.html_url;
              if (parsed.gist_id)   deployedGistId   = parsed.gist_id;
              if (parsed.raw_url)   deployedRawUrl   = parsed.raw_url;
              if (parsed.filename)  deployedFilename = parsed.filename;
              isGist = true;
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

      console.warn(`[Job ${jobId}] Unexpected stop_reason: ${response.stop_reason}`);
      break;
    }

    if (!deployedUrl) {
      return {
        success: false,
        error: 'Agent hit max iterations without deploying. Try breaking the task into smaller steps.'
      };
    }

    return {
      success:  true,
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
    console.error(`[Job ${jobId}] ❌ Agent error: ${err.message}`);
    console.error(`[Job ${jobId}] ❌ Agent stack: ${err.stack}`);
    return { success: false, error: `Agent error: ${err.message}` };

  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
      console.log(`[Job ${jobId}] 🗑️ Cleaned up job dir`);
    } catch {}
  }
}

module.exports = { runAgent };
