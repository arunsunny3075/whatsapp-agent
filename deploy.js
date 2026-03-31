// ============================================================
//  deploy.js  –  Netlify REST API Deployment
//  Creates a new Netlify site and deploys a zip of the app.
//  No netlify-cli needed — pure API calls.
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');

const NETLIFY_API = 'https://api.netlify.com/api/v1';

// ── Zip a directory ─────────────────────────────────────────
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false); // false = no parent dir wrapper
    archive.finalize();
  });
}

// ── Create a new Netlify site ────────────────────────────────
async function createSite(siteName, authToken) {
  const res = await fetch(`${NETLIFY_API}/sites`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: siteName,
      custom_domain: null
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create site: ${res.status} ${text}`);
  }

  return res.json();
}

// ── Deploy a zip to a Netlify site ───────────────────────────
async function deployZip(siteId, zipPath, authToken) {
  const zipData = fs.readFileSync(zipPath);

  const res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/zip'
    },
    body: zipData
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deploy failed: ${res.status} ${text}`);
  }

  return res.json();
}

// ── Wait for deploy to become ready ─────────────────────────
async function waitForDeploy(deployId, authToken, maxWaitMs = 90000) {
  const startTime = Date.now();
  const pollInterval = 3000;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollInterval));

    const res = await fetch(`${NETLIFY_API}/deploys/${deployId}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });

    if (!res.ok) continue;

    const deploy = await res.json();
    console.log(`  [Deploy ${deployId}] state: ${deploy.state}`);

    if (deploy.state === 'ready') return deploy;
    if (deploy.state === 'error') throw new Error(`Deploy errored: ${deploy.error_message}`);
  }

  throw new Error('Deploy timed out after 90 seconds');
}

// ── Main export ──────────────────────────────────────────────
async function deployToNetlify(deployDir, siteName, authToken) {
  const zipPath = path.join(os.tmpdir(), `netlify-deploy-${Date.now()}.zip`);

  try {
    // Write Netlify config files for correct Content-Type headers
    const headersContent = `/*
  Content-Type: text/html; charset=utf-8

/*.html
  Content-Type: text/html; charset=utf-8

/*.js
  Content-Type: application/javascript

/*.css
  Content-Type: text/css
`;
    fs.writeFileSync(path.join(fullDeployDir, '_headers'), headersContent, 'utf8');

    const tomlContent = `[[headers]]
  for = "/*"
  [headers.values]
    Content-Type = "text/html; charset=utf-8"
`;
    fs.writeFileSync(path.join(fullDeployDir, 'netlify.toml'), tomlContent, 'utf8');

    console.log(`  [Netlify] Zipping: ${deployDir}`);
    await zipDirectory(deployDir, zipPath);

    const zipSize = fs.statSync(zipPath).size;
    console.log(`  [Netlify] Zip size: ${(zipSize / 1024).toFixed(1)} KB`);

    // Try to create site (might fail if name taken → append timestamp)
    let site;
    try {
      site = await createSite(siteName, authToken);
    } catch (err) {
      if (err.message.includes('422') || err.message.includes('taken')) {
        // Name taken — append random suffix
        const fallbackName = `${siteName.slice(0, 55)}-${Math.floor(Math.random() * 9000 + 1000)}`;
        console.log(`  [Netlify] Name taken, trying: ${fallbackName}`);
        site = await createSite(fallbackName, authToken);
      } else {
        throw err;
      }
    }

    console.log(`  [Netlify] Site created: ${site.name} (${site.id})`);

    const deploy = await deployZip(site.id, zipPath, authToken);
    console.log(`  [Netlify] Deploy started: ${deploy.id}`);

    const readyDeploy = await waitForDeploy(deploy.id, authToken);
    const liveUrl = readyDeploy.deploy_ssl_url || readyDeploy.url || `https://${site.name}.netlify.app`;

    console.log(`  [Netlify] ✅ Live at: ${liveUrl}`);
    return { url: liveUrl, siteId: site.id, siteName: site.name };

  } finally {
    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch {}
  }
}

module.exports = { deployToNetlify };
