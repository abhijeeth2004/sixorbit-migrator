'use strict';
const express = require('express');
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const app = express();
app.use(express.json());

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function baseUrl(url) {
  try { const u = new URL(url); return u.origin; } catch(e) { return url.replace(/\/+$/, ''); }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url, cookieStr, method='GET', postBody='') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/json,*/*',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (method === 'POST' && postBody) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(postBody);
    }
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method, headers, rejectUnauthorized: false
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (method === 'POST' && postBody) req.write(postBody);
    req.end();
  });
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function newPage(serverUrl, cookieStr) {
  const base = baseUrl(serverUrl);
  const hostname = new URL(base).hostname;
  const launchOpts = {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--incognito']
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const br = await puppeteer.launch(launchOpts);
  const ctx = await br.createBrowserContext();
  const page = await ctx.newPage();
  page._browser = br; page._ctx = ctx;
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  const cookieObjs = cookieStr.split(';').map(s => {
    const eq = s.indexOf('=');
    if (eq === -1) return null;
    return { name: s.slice(0,eq).trim(), value: s.slice(eq+1).trim(), domain: hostname, path: '/' };
  }).filter(Boolean);
  if (cookieObjs.length) await page.setCookie(...cookieObjs);
  return page;
}

async function closePage(page) {
  if (!page) return;
  await page._ctx?.close().catch(() => {});
  await page._browser?.close().catch(() => {});
}

// ── Switch company ────────────────────────────────────────────────────────────
async function switchCompany(page, base, companyValue, log) {
  if (!companyValue) return;
  log = log || (() => {});
  log('  Switching company to: ' + companyValue);
  await page.goto(base + '/?urlq=home', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(1000);
  const result = await page.evaluate(async (base, company) => {
    try {
      const userId = document.querySelector('a.switch-company[data-id]')?.getAttribute('data-id') || '';
      const body = new URLSearchParams({ user_hidden_id: userId, company, submit: 'switch-assign-company-submit' });
      const resp = await fetch(base + '/?urlq=home', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(), credentials: 'include', redirect: 'follow'
      });
      return 'status=' + resp.status;
    } catch(e) { return 'error: ' + e.message; }
  }, base, companyValue);
  log('  Switch result: ' + result);
  await page.goto(base + '/?urlq=home', { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(1500);
  const active = await page.evaluate(() => {
    const b = document.querySelector('.navbar-brand, .navbar a.navbar-brand');
    return b ? b.textContent.trim() : document.title;
  });
  log('  Now active: ' + active);
}

// ── VERIFY ────────────────────────────────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  try {
    const base = baseUrl(serverUrl);
    const resp = await httpGet(base + '/?urlq=home', cookies);
    if (resp.body.toLowerCase().includes('type="password"'))
      throw new Error('Cookies expired — copy fresh cookies');
    res.json({ success: true });
  } catch(e) { res.status(401).json({ success: false, error: e.message }); }
});

// ── GET COMPANIES ─────────────────────────────────────────────────────────────
app.post('/api/companies', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  let page;
  try {
    page = await newPage(serverUrl, cookies);
    const base = baseUrl(serverUrl);
    await page.goto(base + '/?urlq=home', { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(1500);
    if (await page.$('input[type="password"]')) return res.json({ success: false, error: 'Session expired' });

    const [ajaxResp] = await Promise.all([
      page.waitForResponse(r => r.url().includes('urlq=') && r.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
      page.evaluate(() => { document.querySelector('a.switch-company')?.click(); })
    ]);
    await wait(1500);

    let companies = [];
    if (ajaxResp) {
      try {
        const body = await ajaxResp.text().catch(() => '');
        let html = body;
        try { const j = JSON.parse(body); if (j.data) html = j.data; } catch(e) {}
        const matches = [...html.matchAll(/<option[^>]+value="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/gi)];
        companies = matches.map(m => ({ value: m[1], text: m[2].trim() })).filter(c => c.value && c.text);
      } catch(e) {}
    }
    if (!companies.length) {
      await page.waitForSelector('#system-modal-body select', { timeout: 5000 }).catch(() => {});
      companies = await page.evaluate(() => {
        const sel = document.querySelector('#system-modal-body select');
        if (!sel) return [];
        return Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() })).filter(o => o.value && o.text);
      });
    }
    res.json({ success: true, companies });
  } catch(e) { res.json({ success: false, error: e.message }); }
  finally { await closePage(page); }
});

// ── GET ROLES ─────────────────────────────────────────────────────────────────
app.post('/api/roles', async (req, res) => {
  const { serverUrl, cookies, company } = req.body;
  let page;
  try {
    page = await newPage(serverUrl, cookies);
    const base = baseUrl(serverUrl);
    if (company) await switchCompany(page, base, company);
    await page.goto(base + '/?urlq=admin_user/role', { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);
    const roles = await page.evaluate(() => {
      const roles = [];
      document.querySelectorAll('table tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const editLink = tr.querySelector('a[href*="edit"], a[href*="role/"]');
        const href = editLink?.getAttribute('href') || '';
        const idMatch = href.match(/\/(\d+)/) || href.match(/id=(\d+)/);
        // Also try data attributes
        const id = idMatch ? idMatch[1] : (tr.getAttribute('data-id') || '');
        const name = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim();
        if (name && id && name.toLowerCase() !== 'role') roles.push({ id, name });
      });
      return roles;
    });
    res.json({ success: true, roles });
  } catch(e) { res.json({ success: false, error: e.message }); }
  finally { await closePage(page); }
});

// ── MIGRATE PERMISSIONS ───────────────────────────────────────────────────────
app.post('/api/migrate', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const emit = (level, msg) => res.write('data: ' + JSON.stringify({ type: 'log', level, msg }) + '\n\n');
  const done = (ok, fail) => res.write('data: ' + JSON.stringify({ type: 'done', ok, fail }) + '\n\n');

  const { srcUrl, srcCookies, dstUrl, dstCookies, srcCompany, dstCompany, roleMappings } = req.body;

  (async () => {
    let srcPage, dstPage;
    try {
      const srcBase = baseUrl(srcUrl);
      const dstBase = baseUrl(dstUrl);

      // ── Phase 1: Read ALL permissions from source ──────────────────────────
      emit('info', '🔗 Opening source session...');
      srcPage = await newPage(srcUrl, srcCookies);
      if (srcCompany) await switchCompany(srcPage, srcBase, srcCompany, (m) => emit('info', m));
      await srcPage.goto(srcBase + '/?urlq=admin_user/permission/view', { waitUntil: 'networkidle2', timeout: 20000 });
      await wait(2000);
      emit('info', '  Reading permissions (intercepting save)...');

      // Intercept save without actually POSTing to server
      const captured = await srcPage.evaluate(() => {
        return new Promise((resolve) => {
          const origFetch = window.fetch;
          window.fetch = async function(url, opts) {
            if (url && url.toString().includes('admin_user/permission') && opts && opts.method === 'POST') {
              window.fetch = origFetch;
              resolve({ body: opts.body ? opts.body.toString() : '' });
              return new Response(JSON.stringify({ success: true, status: 'success' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return origFetch.call(window, url, opts);
          };
          if (window.$ && window.$.ajax) {
            const origAjax = window.$.ajax;
            window.$.ajax = function(opts2) {
              if (opts2 && opts2.url && opts2.url.includes('admin_user/permission') && opts2.type === 'POST') {
                window.$.ajax = origAjax;
                const body = opts2.data ? (typeof opts2.data === 'string' ? opts2.data : JSON.stringify(opts2.data)) : '';
                resolve({ body });
                if (opts2.success) opts2.success({ success: true });
                return;
              }
              return origAjax.apply(window.$, arguments);
            };
          }
          const btn = document.querySelector('button[type="submit"], button.btn-success, .btn-primary');
          if (btn) btn.click(); else resolve(null);
          setTimeout(() => resolve(null), 8000);
        });
      });

      let srcMapping = [];
      let srcPids = [];
      if (captured && captured.body) {
        emit('info', '  Captured ' + captured.body.length + ' bytes of permission data');
        try {
          const params = new URLSearchParams(captured.body);
          const mappingStr = params.get('mapping');
          if (mappingStr) srcMapping = JSON.parse(mappingStr);
          srcPids = params.getAll('pids[]');
        } catch(e) { emit('info', '  Parse error: ' + e.message); }
      }
      emit('info', '  Found ' + srcMapping.length + ' permission mappings across all modules');
      await closePage(srcPage); srcPage = null;

      // ── Phase 2: Write permissions to destination ──────────────────────────
      emit('info', '🔗 Opening destination session...');
      dstPage = await newPage(dstUrl, dstCookies);
      if (dstCompany) await switchCompany(dstPage, dstBase, dstCompany, (m) => emit('info', m));

      let ok = 0, fail = 0;

      for (const rm of roleMappings) {
        emit('info', '\n→ "' + rm.srcRoleName + '" → "' + rm.dstRoleName + '"');
        let dstRoleId = rm.dstRoleId;

        // Create role if needed
        if (rm.createNew) {
          emit('info', '  Creating role: "' + rm.dstRoleName + '"');
          const created = await dstPage.evaluate(async (base, name) => {
            try {
              const fd = new URLSearchParams({ role: name, submit: 'add-role-submit' });
              const r = await fetch(base + '/?urlq=admin_user/role/add', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: fd.toString(), credentials: 'include'
              });
              const t = await r.text();
              try { return JSON.parse(t); } catch(e) { return { raw: t.substring(0, 200) }; }
            } catch(e) { return { error: e.message }; }
          }, dstBase, rm.dstRoleName);
          emit('info', '  Create result: ' + JSON.stringify(created).substring(0, 150));
          if (created.id || created.role_id || created.data?.id) {
            dstRoleId = String(created.id || created.role_id || created.data?.id);
          }
        }

        if (!dstRoleId) { emit('error', '  No destination role ID — skipping'); fail++; continue; }

        // Filter mapping for this source role, remap to dst role ID
        const rolePairs = srcMapping.filter(m => String(m[1]) === String(rm.srcRoleId));
        const remapped = rolePairs.map(m => [m[0], dstRoleId]);
        const rolePids = [...new Set(rolePairs.map(m => String(m[0])))];
        emit('info', '  ' + rolePairs.length + ' permissions to copy');

        const result = await dstPage.evaluate(async (base, mapping, pids) => {
          try {
            const fd = new URLSearchParams();
            fd.append('mapping', JSON.stringify(mapping));
            pids.forEach(pid => fd.append('pids[]', pid));
            fd.append('submit', 'admin-user-permission-role-map-submit');
            const r = await fetch(base + '/?urlq=admin_user/permission', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: fd.toString(), credentials: 'include'
            });
            const t = await r.text();
            try { return JSON.parse(t); } catch(e) { return { raw: t.substring(0, 100) }; }
          } catch(e) { return { error: e.message }; }
        }, dstBase, remapped, rolePids);

        if (result.success || result.status === 'success' || result.status === 1) {
          emit('success', '  ✅ Done');
          ok++;
        } else {
          emit('error', '  ❌ Failed: ' + JSON.stringify(result).substring(0, 100));
          fail++;
        }
      }

      done(ok, fail);
    } catch(e) {
      emit('error', 'Fatal: ' + e.message);
      done(0, roleMappings?.length || 0);
    } finally {
      await closePage(srcPage);
      await closePage(dstPage);
      res.end();
    }
  })();
});

// ── HTML UI ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3737;
app.get('/', (req, res) => res.send(HTML));
app.listen(PORT, () => console.log('Sixorbit Permission Migrator → http://localhost:' + PORT));

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sixorbit Permission Migrator</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#f0f2f7;--surf:#fff;--bdr:#dde1ec;--txt:#1a1f2e;--mut:#7a84a0;--src:#0a7aff;--dst:#00b06b;--err:#ef4444;--r:10px;--sh:0 2px 12px rgba(0,0,0,.08)}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--txt);font-size:14px}
.wrap{max-width:1000px;margin:0 auto;padding:28px 18px 80px}
.topbar{display:flex;align-items:center;gap:12px;margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid var(--bdr)}
.logo{width:40px;height:40px;background:linear-gradient(135deg,#0a7aff,#0055cc);border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0}
.brand{font-size:19px;font-weight:600}.brand b{color:var(--src)}
.ver{font-size:11px;color:var(--mut);margin-left:auto;font-family:'DM Mono',monospace;background:#f0f2f7;padding:4px 10px;border-radius:20px;border:1px solid var(--bdr)}
.steps{display:flex;background:var(--surf);border:1px solid var(--bdr);border-radius:var(--r);padding:4px;width:fit-content;margin-bottom:24px;box-shadow:var(--sh)}
.st{display:flex;align-items:center;gap:7px;padding:9px 18px;border-radius:7px;border:none;background:transparent;cursor:pointer;font:500 13px 'DM Sans',sans-serif;color:var(--mut);white-space:nowrap;transition:all .2s}
.st.on{background:var(--txt);color:#fff}.st.done{color:var(--dst)}
.sn{width:20px;height:20px;border-radius:50%;border:1.5px solid currentColor;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0}
.st.done .sn{background:var(--dst);border-color:var(--dst);color:#fff}
.sdiv{width:1px;height:20px;background:var(--bdr)}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.g2{grid-template-columns:1fr}}
.card{background:var(--surf);border:1px solid var(--bdr);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
.ch{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--bdr)}
.chc{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.cht{font-weight:600;flex:1}.chb{font-family:'DM Mono',monospace;font-size:10px;padding:3px 10px;border-radius:20px;background:var(--bg);border:1px solid var(--bdr)}
.cb{padding:18px}
.f{margin-bottom:14px}.f:last-child{margin-bottom:0}
.f label{display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);margin-bottom:6px;font-family:'DM Mono',monospace}
.f input,.f textarea,.f select{width:100%;padding:9px 12px;border:1.5px solid var(--bdr);border-radius:8px;font:13px 'DM Sans',sans-serif;color:var(--txt);background:#fff;outline:none;transition:border .15s}
.f input:focus,.f textarea:focus,.f select:focus{border-color:var(--src)}
.f textarea{resize:vertical;min-height:70px;font-family:'DM Mono',monospace;font-size:11px;line-height:1.5}
.hint{font-size:11px;color:var(--mut);margin-top:5px;line-height:1.7}
.howto{background:#f0f6ff;border:1px solid #bfdbfe;border-radius:9px;padding:14px 18px;margin-bottom:20px;font-size:12px;color:#1e3a8a;line-height:1.9}
.howto strong{font-size:13px;display:block;margin-bottom:8px;color:#0a7aff}
.btn{display:inline-flex;align-items:center;gap:7px;padding:10px 20px;border-radius:8px;border:1.5px solid var(--bdr);background:#fff;cursor:pointer;font:500 13px 'DM Sans',sans-serif;color:var(--txt);transition:all .15s}
.btn:hover{border-color:var(--src);color:var(--src)}.btn:disabled{opacity:.5;cursor:default}
.bp{background:var(--src);color:#fff;border-color:var(--src)}.bp:hover{background:#0066dd;border-color:#0066dd;color:#fff}
.bg{background:var(--dst);color:#fff;border-color:var(--dst)}.bg:hover{background:#009959;border-color:#009959;color:#fff}
.bfull{width:100%;justify-content:center}
.ar{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.sd{width:10px;height:10px;border-radius:50%;background:var(--bdr);display:inline-block;margin-right:6px;transition:background .3s}
.sd.ok{background:var(--dst)}.sd.er{background:var(--err)}.sd.ld{background:#f59e0b}
.srow{display:flex;align-items:center;margin-top:10px;font-size:12px;color:var(--mut)}
.errbox{display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;font-size:12px;color:var(--err);margin-top:10px}
.spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.ll{padding:3px 0;line-height:1.6}
.ll.success{color:#4ade80}.ll.error{color:#f87171}.ll.info{color:#a0ffb0}
table{width:100%;border-collapse:collapse}
th{padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--mut);background:var(--bg);border-bottom:1px solid var(--bdr)}
td{padding:10px 12px;border-bottom:1px solid var(--bdr);font-size:13px}
td select{padding:6px 8px;border:1px solid var(--bdr);border-radius:6px;font-size:13px;width:100%}
td input[type=text]{padding:6px 8px;border:1px solid var(--bdr);border-radius:6px;font-size:13px;width:100%;margin-top:5px}
.rc{display:flex;align-items:center;gap:16px;padding:20px;border-radius:var(--r)}
.rc.ok{background:#f0fdf4;border:1px solid #bbf7d0}.rc.fl{background:#fef2f2;border:1px solid #fecaca}.rc.pw{background:#fffbeb;border:1px solid #fde68a}
.ri{font-size:32px}.rt h3{font-size:15px;font-weight:600}.rt p{font-size:12px;color:var(--mut);margin-top:4px}
</style>
</head>
<body>
<div class="wrap">
<div class="topbar">
  <div class="logo">&#128274;</div>
  <div class="brand"><b>Sixorbit</b> Permission Migrator</div>
  <div class="ver">v1.0</div>
</div>
<div class="steps">
  <button class="st on" id="s0"><span class="sn">1</span> Setup Sessions</button>
  <div class="sdiv"></div>
  <button class="st" id="s1"><span class="sn">2</span> Map Roles</button>
  <div class="sdiv"></div>
  <button class="st" id="s2"><span class="sn">3</span> Migrate</button>
</div>

<!-- STEP 0: Setup -->
<div id="p0">
  <div class="howto">
    <strong>&#128274; How to get your Cookie:</strong>
    <ol>
      <li>Log in to Sixorbit in Chrome</li>
      <li><code>F12</code> &rarr; <code>Network</code> tab &rarr; click any request</li>
      <li><code>Headers</code> &rarr; <b>Request Headers</b> &rarr; find <code>Cookie:</code></li>
      <li><b>Right-click &rarr; Copy value</b> &rarr; paste below</li>
    </ol>
  </div>
  <div class="g2">
    <div class="card">
      <div class="ch"><div class="chc" style="background:var(--src)"></div><div class="cht">Source Server</div><div class="chb" id="srcBadge">Not verified</div></div>
      <div class="cb">
        <div class="f"><label>Server URL</label><input id="srcUrl" type="url" placeholder="https://*.sixorbit.com"/></div>
        <div class="f"><label>Cookie</label><textarea id="srcCookie" placeholder="Paste full Cookie here"></textarea></div>
        <button class="btn bp bfull" onclick="doVerify('src')">&#10003; Verify Source</button>
        <div class="srow"><div class="sd" id="srcDot"></div><span id="srcStat">Not verified</span></div>
        <div id="srcCompanyWrap" style="display:none;margin-top:12px">
          <div class="f"><label>Company</label><select id="srcCompany"><option value="">-- Select Company --</option></select></div>
        </div>
        <div class="errbox" id="srcErr"></div>
      </div>
    </div>
    <div class="card">
      <div class="ch"><div class="chc" style="background:var(--dst)"></div><div class="cht">Destination Server</div><div class="chb" id="dstBadge">Not verified</div></div>
      <div class="cb">
        <div class="f"><label>Server URL</label><input id="dstUrl" type="url" placeholder="https://*.sixorbit.com"/></div>
        <div class="f"><label>Cookie</label><textarea id="dstCookie" placeholder="Paste full Cookie here"></textarea></div>
        <button class="btn bg bfull" onclick="doVerify('dst')">&#10003; Verify Destination</button>
        <div class="srow"><div class="sd" id="dstDot"></div><span id="dstStat">Not verified</span></div>
        <div id="dstCompanyWrap" style="display:none;margin-top:12px">
          <div class="f"><label>Company</label><select id="dstCompany"><option value="">-- Select Company --</option></select></div>
        </div>
        <div class="errbox" id="dstErr"></div>
      </div>
    </div>
  </div>
  <div class="ar">
    <button class="btn bp" id="btnLoad" onclick="loadRoles()">&#8594; Load Roles</button>
  </div>
</div>

<!-- STEP 1: Map Roles -->
<div id="p1" style="display:none">
  <div class="card" style="margin-bottom:16px">
    <div class="ch"><div class="cht">&#128101; Role Mapping</div></div>
    <div class="cb">
      <p style="font-size:12px;color:var(--mut);margin-bottom:16px">Map each source role to a destination role. Select "Create New" if the role does not exist in destination yet.</p>
      <div id="roleTable" style="overflow-x:auto"></div>
    </div>
  </div>
  <div class="ar">
    <button class="btn" onclick="goStep(0)">&larr; Back</button>
    <button class="btn bp" onclick="startMigrate()">&#8658; Migrate Permissions</button>
  </div>
</div>

<!-- STEP 2: Migrate -->
<div id="p2" style="display:none">
  <div class="card">
    <div class="ch" style="justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px"><div class="sd ok" id="migDot"></div><span id="migTitle" style="font-weight:600">Migrating...</span></div>
    </div>
    <div class="cb">
      <div id="logPanel" style="background:#0f1117;color:#a0ffb0;padding:16px;border-radius:8px;font:12px 'DM Mono',monospace;min-height:200px;max-height:450px;overflow-y:auto;white-space:pre-wrap;word-break:break-all"></div>
    </div>
  </div>
  <div id="resCard" style="display:none;margin-top:16px"></div>
  <div class="ar" style="margin-top:16px">
    <button class="btn" id="btnBack" onclick="goStep(1)" disabled>&larr; Back</button>
    <button class="btn bp" id="btnReset" onclick="location.reload()" style="display:none">&#8635; New Migration</button>
  </div>
</div>
</div>

<script>
window.onerror = function(msg, src, line, col, err) {
  document.body.innerHTML += '<div style="background:red;color:white;padding:20px;position:fixed;top:0;left:0;right:0;z-index:9999">JS Error: '+msg+' at line '+line+'</div>';
};
const S = { src:{url:'',cookie:'',company:''}, dst:{url:'',cookie:'',company:''}, srcRoles:[], dstRoles:[] };

function goStep(n) {
  [0,1,2].forEach(i => {
    document.getElementById('p'+i).style.display = i===n ? '' : 'none';
    const b = document.getElementById('s'+i);
    b.className = 'st'+(i===n?' on':i<n?' done':'');
    b.querySelector('.sn').textContent = i<n ? '\\u2713' : i+1;
  });
}

function setStat(side, state, msg) {
  document.getElementById(side+'Dot').className = 'sd '+state;
  document.getElementById(side+'Stat').textContent = msg;
  const b = document.getElementById(side+'Badge');
  b.textContent = state==='ok' ? '\\u2713 Verified' : state==='er' ? '\\u2717 Failed' : msg;
  b.style.color = state==='ok' ? 'var(--dst)' : state==='er' ? 'var(--err)' : '';
}

async function doVerify(side) {
  const url = document.getElementById(side+'Url').value.trim();
  const cookie = document.getElementById(side+'Cookie').value.trim();
  if (!url||!cookie) { alert('Enter URL and Cookie'); return; }
  S[side].url = url; S[side].cookie = cookie;
  setStat(side,'ld','Verifying...');
  document.getElementById(side+'Err').style.display = 'none';
  try {
    const r = await fetch('/api/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:url,cookies:cookie})});
    const d = await r.json();
    if (d.success) {
      setStat(side,'ok','Session active');
      try {
        const cr = await fetch('/api/companies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:url,cookies:cookie})});
        const cd = await cr.json();
        if (cd.success && cd.companies && cd.companies.length > 0) {
          const sel = document.getElementById(side+'Company');
          sel.innerHTML = '<option value="">-- Select Company --</option>' + cd.companies.map(c => '<option value="'+c.value+'">'+c.text+'</option>').join('');
          if (cd.companies.length === 1) sel.value = cd.companies[0].value;
          document.getElementById(side+'CompanyWrap').style.display = '';
        }
      } catch(e) {}
    } else {
      setStat(side,'er','Failed');
      const eb = document.getElementById(side+'Err');
      eb.style.display = ''; eb.textContent = '\\u26a0 '+(d.error||'Failed');
    }
  } catch(e) {
    setStat(side,'er','Error');
    const eb = document.getElementById(side+'Err');
    eb.style.display = ''; eb.textContent = 'Cannot reach server: '+e.message;
  }
}

async function loadRoles() {
  S.src.company = document.getElementById('srcCompany').value;
  S.dst.company = document.getElementById('dstCompany').value;
  const btn = document.getElementById('btnLoad');
  btn.innerHTML = '<span class="spinner"></span> Loading...'; btn.disabled = true;
  try {
    const [sr, dr] = await Promise.all([
      fetch('/api/roles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:S.src.url,cookies:S.src.cookie,company:S.src.company})}).then(r=>r.json()),
      fetch('/api/roles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:S.dst.url,cookies:S.dst.cookie,company:S.dst.company})}).then(r=>r.json())
    ]);
    if (!sr.success) throw new Error('Source roles: '+(sr.error||'failed'));
    if (!dr.success) throw new Error('Destination roles: '+(dr.error||'failed'));
    S.srcRoles = sr.roles || [];
    S.dstRoles = dr.roles || [];
    renderRoleTable();
    goStep(1);
  } catch(e) { alert('Error: '+e.message); }
  btn.innerHTML = '\\u2192 Load Roles'; btn.disabled = false;
}

function renderRoleTable() {
  const dstOpts = '<option value="">-- Skip --</option><option value="__new__">+ Create New</option>'
    + S.dstRoles.map(r => '<option value="'+r.id+'">'+r.name+'</option>').join('');
  const rows = S.srcRoles.map((r,i) => {
    // Auto-match by name
    const match = S.dstRoles.find(d => d.name.toLowerCase() === r.name.toLowerCase());
    const sel = '<select id="rm_'+i+'" data-src-id="'+r.id+'" onchange="rmChange('+i+')">'
      + dstOpts.replace('value="'+(match?match.id:'')+'">','value="'+(match?match.id:'')+'">'.replace('>',' selected>'))
      + '</select>';
    return '<tr><td style="font-weight:500">'+r.name+'</td><td>'
      + sel
      + '<input type="text" id="rm_new_'+i+'" placeholder="New role name" style="display:none" value="'+r.name+'"/>'
      + '</td></tr>';
  }).join('');
  document.getElementById('roleTable').innerHTML =
    '<table><thead><tr><th>Source Role</th><th>Destination Role</th></tr></thead><tbody>'+rows+'</tbody></table>';
  // Set selected values properly
  S.srcRoles.forEach((r,i) => {
    const match = S.dstRoles.find(d => d.name.toLowerCase() === r.name.toLowerCase());
    if (match) document.getElementById('rm_'+i).value = match.id;
  });
}

function rmChange(i) {
  const sel = document.getElementById('rm_'+i);
  document.getElementById('rm_new_'+i).style.display = sel.value === '__new__' ? '' : 'none';
}

async function startMigrate() {
  const mappings = [];
  S.srcRoles.forEach((r,i) => {
    const sel = document.getElementById('rm_'+i);
    if (!sel || !sel.value) return;
    const createNew = sel.value === '__new__';
    const dstRoleId = createNew ? null : sel.value;
    const dstRoleName = createNew
      ? (document.getElementById('rm_new_'+i)?.value || r.name)
      : (S.dstRoles.find(d => d.id === sel.value)?.name || '');
    mappings.push({ srcRoleId: r.id, srcRoleName: r.name, dstRoleId, dstRoleName, createNew });
  });
  if (!mappings.length) { alert('Please map at least one role'); return; }

  goStep(2);
  document.getElementById('logPanel').innerHTML = '';
  document.getElementById('resCard').style.display = 'none';
  document.getElementById('btnBack').disabled = true;
  document.getElementById('btnReset').style.display = 'none';
  document.getElementById('migTitle').textContent = 'Migrating permissions...';

  const resp = await fetch('/api/migrate',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({srcUrl:S.src.url,srcCookies:S.src.cookie,dstUrl:S.dst.url,dstCookies:S.dst.cookie,
      srcCompany:S.src.company,dstCompany:S.dst.company,roleMappings:mappings})});

  const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while(true) {
    const {done,value} = await reader.read(); if(done) break;
    buf += dec.decode(value,{stream:true});
    const lines = buf.split('\n'); buf = lines.pop();
    for(const line of lines) {
      if(!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if(ev.type === 'log') {
          const p = document.getElementById('logPanel');
          const d = document.createElement('div');
          d.className = 'll '+ev.level; d.textContent = ev.msg;
          p.appendChild(d); p.scrollTop = p.scrollHeight;
        } else if(ev.type === 'done') {
          document.getElementById('migTitle').textContent = 'Migration complete';
          document.getElementById('btnBack').disabled = false;
          document.getElementById('btnReset').style.display = '';
          const cls = ev.fail===0?'ok':ev.ok===0?'fl':'pw';
          const icon = ev.fail===0?'\\ud83c\\udf89':ev.ok===0?'\\u274c':'\\u26a0\\ufe0f';
          const msg = ev.fail===0?'All permissions copied!':ev.ok===0?'Migration failed':'Partially done';
          const rc = document.getElementById('resCard'); rc.style.display='';
          rc.innerHTML = '<div class="rc '+cls+'"><div class="ri">'+icon+'</div><div class="rt"><h3>'+msg+'</h3><p>'+ev.ok+' succeeded &middot; '+ev.fail+' failed</p></div></div>';
        }
      } catch(e) {}
    }
  }
}
</script>
</body></html>`;
