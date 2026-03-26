const express = require('express');
const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

const wait = ms => new Promise(r => setTimeout(r, ms));

function baseUrl(raw) {
  try { return new URL(raw.trim()).origin; }
  catch { return raw.trim().replace(/\/$/, '').split('?')[0]; }
}

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
      method,
      headers,
      rejectUnauthorized: false
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

// ── Verify ────────────────────────────────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  if (!serverUrl || !cookies) return res.status(400).json({ success: false, error: 'serverUrl and cookies required' });
  try {
    const base = baseUrl(serverUrl);
    const resp = await httpGet(`${base}/?urlq=home`, cookies);
    if (resp.body.toLowerCase().includes('type="password"'))
      throw new Error('Cookies are invalid or expired — please copy fresh cookies from the browser');
    return res.json({ success: true });
  } catch (e) {
    return res.status(401).json({ success: false, error: e.message });
  }
});

// ── Fetch company list ───────────────────────────────────────────────────────
app.post('/api/companies', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  const base = baseUrl(serverUrl);

  // Extract user-id from cookies (Sixorbit stores it as "user-id=XXXXXXX")
  const userIdMatch = cookies.match(/user-id=(\d+)/);
  const userId = userIdMatch ? userIdMatch[1] : '';

  // Strategy 1: Direct HTTP POST using exact Sixorbit switch-company endpoint
  if (userId) {
    try {
      const postBody = `user_hidden_id=${userId}&submit=switch-assign-company-submit&company=`;
      const resp = await httpGet(`${base}/?urlq=home`, cookies, 'POST', postBody);
      let html = resp.body;
      // Also try the admin_user/user endpoint
      const resp2 = await httpGet(`${base}/?urlq=admin_user/user`, cookies, 'POST', `submit=switch-company-form&user_id=${userId}`);
      let html2 = resp2.body;
      for (const html3 of [html2, html]) {
        let h = html3;
        try { const j = JSON.parse(h); if (j.data) h = j.data; } catch(e) {}
        const matches = [...h.matchAll(/<option[^>]+value="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/gi)];
        const companies = matches.map(m => ({ value: m[1], text: m[2].trim() })).filter(c => c.value && c.text);
        if (companies.length > 1) return res.json({ success: true, companies });
      }
    } catch(e) {}
  }

  // Strategy 2: Puppeteer — click button and intercept AJAX
  let browser, ctx;
  try {
    browser = await puppeteer.launch((() => { const o = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage','--disable-gpu'] }; if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH; return o; })());
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const cookieObjs = cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: new URL(base).hostname };
    }).filter(c => c.name);
    await page.setCookie(...cookieObjs);
    await page.goto(`${base}/?urlq=home`, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(1000);

    if (await page.$('input[type="password"]'))
      return res.json({ success: false, error: 'Session expired' });

    // Get userId and click button simultaneously
    const userId = await page.evaluate(() => {
      const el = document.querySelector('a.switch-company[data-id]');
      return el ? el.getAttribute('data-id') : '';
    }).catch(() => '');

    // Collect ALL POST responses after button click
    const responses = [];
    const listener = r => { if (r.request().method() === 'POST') responses.push(r); };
    page.on('response', listener);
    await page.evaluate(() => { document.querySelector('a.switch-company')?.click(); });
    await wait(3000);
    page.off('response', listener);

    let companies = [];

    for (const ajaxResp of responses) {
      try {
        const body = await ajaxResp.text().catch(() => '');
        let html = body;
        try { const j = JSON.parse(body); if (j.data) html = j.data; } catch(e) {}
        const matches = [...html.matchAll(/<option[^>]+value="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/gi)];
        const found = matches.map(m => ({ value: m[1], text: m[2].trim() })).filter(c => c.value && c.text);
        if (found.length > companies.length) companies = found;
      } catch(e) {}
    }

    // Fallback: read modal DOM
    if (!companies.length) {
      await page.waitForSelector('#system-modal-body select', { timeout: 5000 }).catch(() => {});
      companies = await page.evaluate(() => {
        const sel = document.querySelector('#system-modal-body select');
        if (!sel) return [];
        return Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() })).filter(o => o.value && o.text);
      });
    }

    // Strategy 3: Use fetch inside browser with credentials
    if (!companies.length && userId) {
      companies = await page.evaluate(async (base, uid) => {
        try {
          const fd = new URLSearchParams({ submit: 'switch-company-form', user_id: uid });
          const r = await fetch(`${base}/?urlq=admin_user/user`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: fd.toString()
          });
          const html = await r.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const sel = doc.querySelector('select');
          if (sel) return Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() })).filter(o => o.value && o.text);
        } catch(e) {}
        return [];
      }, base, userId);
    }

    res.json({ success: true, companies });
  } catch(e) {
    res.json({ success: false, error: e.message });
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

// ── Switch company (exact browser flow) ───────────────────────────────────────
async function switchCompany(page, base, companyValue, _log) {
  if (!companyValue) return;
  const log = _log || (() => {});
  log(`  ↳ Switching company to: ${companyValue}`);

  // Must be on home page first so jQuery and user_hidden_id are available
  await page.goto(`${base}/?urlq=home`, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(1000);

  // Submit the switch form FROM INSIDE the browser using fetch
  // This ensures the browser's own session cookie is updated by the server response
  const result = await page.evaluate(async (base, company) => {
    try {
      const userId = document.querySelector('a.switch-company[data-id]')?.getAttribute('data-id') || '';
      const body = new URLSearchParams({
        user_hidden_id: userId,
        company: company,
        submit: 'switch-assign-company-submit'
      });
      const resp = await fetch(`${base}/?urlq=home`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',  // Critical: includes and updates cookies
        redirect: 'follow'
      });
      return `status=${resp.status} url=${resp.url}`;
    } catch(e) {
      return `error: ${e.message}`;
    }
  }, base, companyValue);
  log(`  ↳ Switch result: ${result}`);

  // Navigate to home again — browser now has updated session with new company
  await page.goto(`${base}/?urlq=home`, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(1500);

  // Verify
  const active = await page.evaluate(() => {
    const brand = document.querySelector('.navbar-brand, .navbar a.navbar-brand');
    return brand ? brand.textContent?.trim() : document.title;
  });
  log(`  ↳ Now active: "${active}"`);
}


// ── Template list ─────────────────────────────────────────────────────────────
app.post('/api/templates/list', async (req, res) => {
  const { serverUrl, cookies, company } = req.body;
  let page;
  try {
    const base = baseUrl(serverUrl);
    page = await newPage(serverUrl, cookies);
    // Switch to the selected company first
    if (company) await switchCompany(page, base, company, () => {});

    const templates = [];
    const seen = new Set();
    let pageNum = 1;

    // Set DataTable to show 100 entries per page to minimise pagination
    await page.goto(`${base}/?urlq=print-template/view`, { waitUntil: 'networkidle2', timeout: 30000 });
    if (await page.$('input[type="password"]')) throw new Error('Session expired — please re-copy cookies');

    // Wait for the table to render
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {});
    await wait(1000);

    // Try to set "Show entries" to 100 so we get more per page
    await page.evaluate(() => {
      const sel = document.querySelector('select[name*="DataTables"], select[name*="length"], .dataTables_length select');
      if (sel) {
        const opt = Array.from(sel.options).find(o => o.value === '100' || o.value === '-1');
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }).catch(() => {});
    await wait(1500);

    while (true) {
      const rows = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('table tbody tr').forEach(tr => {
          const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
          if (cells.length < 3) return;

          // Extract ID from any link or button with edit/view in href or onclick
          let id = null;

          // Check all anchors and buttons in the row
          tr.querySelectorAll('a, button, [onclick]').forEach(el => {
            if (id) return;
            const href = el.getAttribute('href') || '';
            const onclick = el.getAttribute('onclick') || '';
            const dataId = el.getAttribute('data-id') || el.getAttribute('data-record') || '';

            const m = (href + onclick).match(/print.template.edit.(\d+)/i)
                   || (href + onclick).match(/[?&]id=(\d+)/i)
                   || (href + onclick).match(/edit[/=,\s('"]+(\d+)/i);
            if (m) id = m[1];
            if (!id && dataId && /^\d+$/.test(dataId)) id = dataId;
          });

          // Also check tr's own data attributes
          if (!id) {
            const trData = tr.getAttribute('data-id') || tr.getAttribute('id') || '';
            const m = trData.match(/\d+/);
            if (m) id = m[0];
          }

          // Also scan all text in the row for edit URLs
          if (!id) {
            const html = tr.innerHTML;
            const m = html.match(/print-template\/edit\/(\d+)/i)
                     || html.match(/urlq=print.template.edit.(\d+)/i)
                     || html.match(/edit_template\((\d+)/i)
                     || html.match(/editTemplate\((\d+)/i)
                     || html.match(/'id'\s*:\s*(\d+)/i)
                     || html.match(/\"id\"\s*:\s*(\d+)/i);
            if (m) id = m[1];
          }

          if (!id) return;

          // Determine column positions from table headers
          const headers = Array.from(document.querySelectorAll('table thead th')).map(th => th.innerText.trim().toLowerCase());
          const typeIdx  = headers.findIndex(h => h.includes('template type'));
          const nameIdx  = headers.findIndex(h => h.includes('template name'));
          const statIdx  = headers.findIndex(h => h.includes('status'));

          results.push({
            id,
            templateType: cells[typeIdx >= 0 ? typeIdx : 2] || '',
            templateName: cells[nameIdx >= 0 ? nameIdx : 3] || '',
            status:       cells[statIdx >= 0 ? statIdx : 4] || '',
          });
        });
        return results;
      });

      rows.forEach(r => { if (r.id && !seen.has(r.id)) { seen.add(r.id); templates.push(r); } });

      // Check for next page
      const hasNext = await page.evaluate(() => {
        const next = document.querySelector('.paginate_button.next:not(.disabled), #DataTables_Table_0_next:not(.disabled), [id*="next"]:not(.disabled)');
        return !!next;
      });
      if (!hasNext || pageNum >= 20) break;

      await page.evaluate(() => {
        const next = document.querySelector('.paginate_button.next:not(.disabled), #DataTables_Table_0_next:not(.disabled), [id*="next"]:not(.disabled)');
        if (next) next.click();
      });
      await wait(1500);
      pageNum++;
    }

    return res.json({ success: true, templates });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (page?._ctx) await page._ctx.close().catch(() => {}); if (page?._browser) await page._browser.close().catch(() => {});
  }
});

// ── Browser ───────────────────────────────────────────────────────────────────
// Each call launches a FRESH isolated browser instance (like incognito)
// This is critical for same-URL migrations where company switching must be independent
async function launchIsolatedBrowser() {
  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--incognito'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return await puppeteer.launch(launchOpts);
}

async function newPage(serverUrl, cookieStr) {
  const base = baseUrl(serverUrl);
  const hostname = new URL(base).hostname;
  // Always launch a fresh browser — never share between source and destination
  const br = await launchIsolatedBrowser();
  const ctx = await br.createBrowserContext();
  const page = await ctx.newPage();
  page._browser = br;  // Keep reference for cleanup
  page._ctx = ctx;
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  const cookieObjs = cookieStr.split(';').map(s => {
    const eq = s.indexOf('=');
    if (eq === -1) return null;
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    return name ? { name, value, domain: hostname, path: '/' } : null;
  }).filter(Boolean);
  if (cookieObjs.length) await page.setCookie(...cookieObjs);
  return page;
}


// ── READ template from source ─────────────────────────────────────────────────
async function readTemplate(page, base, id) {
  await page.goto(`${base}/?urlq=print-template/edit/${id}`, { waitUntil: 'networkidle2', timeout: 30000 });
  await wait(3000);
  if (await page.$('input[type="password"]')) throw new Error('Source session expired');

  return await page.evaluate(() => {
    const result = {
      templateType: { value:'', text:'' }, templateFormat: { value:'', text:'' },
      name:'', printTitle:'',
      attribute:[], customField:[], customItemField:[], groupBy:[], outlet:[], roles:[],
      itemRows:[], extraRows:[], docNames:[], checkboxes:{},
      _debug: []
    };

    // Read item rows using exact DOM structure:
    // div.row > [col(itemcolumn), col(name-inp), col(width-inp), col(size-inp), col(alignment)]
    const itemColSels = Array.from(document.querySelectorAll('[name="itemcolumn"]'));

    itemColSels.forEach((colSel, i) => {
      // Walk up to div.row
      let rowDiv = colSel.parentElement;
      while (rowDiv) {
        if (rowDiv.className && rowDiv.className.includes('row')) break;
        if (['BODY','FORM'].includes(rowDiv.tagName)) { rowDiv = null; break; }
        rowDiv = rowDiv.parentElement;
      }

      let nameVal = '', widthVal = '', sizeVal = '';
      let alignSel = null;

      if (rowDiv) {
        // Direct col-children: skip those with <select> → those have inputs
        const colDivs = Array.from(rowDiv.children).filter(el =>
          el.tagName === 'DIV' && (el.className || '').includes('col-')
        );
        const inputColDivs = colDivs.filter(div => !div.querySelector('select'));
        const selectColDivs = colDivs.filter(div => div.querySelector('select'));

        nameVal  = inputColDivs[0]?.querySelector('input')?.value || '';
        widthVal = inputColDivs[1]?.querySelector('input')?.value || '';
        sizeVal  = inputColDivs[2]?.querySelector('input')?.value || '';
        // Alignment is in the second select col-div
        alignSel = selectColDivs[1]?.querySelector('select') || null;
      }

      result.itemRows.push({
        column:    sv(colSel),
        name:      nameVal,
        width:     widthVal,
        fontSize:  sizeVal,
        alignment: sv(alignSel),
      });
    });

    const extraFieldSels = Array.from(document.querySelectorAll('[name="extrafield"]'));
    const extraNames     = Array.from(document.querySelectorAll('[name="extraname"]'));
    const extraFonts     = Array.from(document.querySelectorAll('[name="extrafont"]'));

    extraFieldSels.forEach((fieldSel, i) => {
      let tr = fieldSel.parentElement;
      while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
      const cb = tr ? tr.querySelector('input[type="checkbox"]') : null;

      const sv = (sel) => {
        if (!sel) return { value: '', text: '' };
        const o = sel.options[sel.selectedIndex];
        return { value: sel.value, text: o ? o.text.trim() : '' };
      };

      result.extraRows.push({
        field:    sv(fieldSel),
        name:     extraNames[i]?.value || '',
        fontSize: extraFonts[i]?.value || '',
        bold:     cb?.checked || false,
      });
    });

    const ITEM_OPTS  = ['serial','variation','hsn']; // kept for unused reference
    const EXTRA_OPTS = ['assignee','remark','customer name','customer address','customer mobile','customer email','prepared by','approved','salesperson','vehicle','delivery','reference','narration','terms','contact'];

    function sv(el) {
      if (!el) return { value:'', text:'' };
      const o = el.options[el.selectedIndex];
      return { value: el.value, text: o ? o.text.trim() : '' };
    }
    function matchKw(sel, kws) {
      return Array.from(sel.options).some(o => kws.some(k => o.text.trim().toLowerCase().includes(k)));
    }

    // Walk up to TR — simplest and most reliable row boundary in a table
    function getTR(el) {
      let cur = el.parentElement;
      while (cur) {
        if (cur.tagName === 'TR') return cur;
        if (['TBODY','TABLE','BODY','FORM','HTML'].includes(cur.tagName)) break;
        cur = cur.parentElement;
      }
      return null;
    }

    // Get all inputs in same TR, filtering out hidden/checkbox types
    function getTRInputs(tr) {
      return Array.from(tr.querySelectorAll('input'))
        .filter(i => !['hidden','checkbox','radio','button','submit'].includes(i.type));
    }

    const processedTRs = new Set();

    Array.from(document.querySelectorAll('select')).forEach(sel => {
      // Use THIS select for classification — not cs[0] of container
      const isItem  = matchKw(sel, ITEM_OPTS);
      const isExtra = matchKw(sel, EXTRA_OPTS);
      if (!isItem && !isExtra) return;

      const tr = getTR(sel);
      if (!tr || processedTRs.has(tr)) return;
      processedTRs.add(tr);

      // All selects in this TR
      const trSels = Array.from(tr.querySelectorAll('select'));
      // All visible inputs in this TR
      const trInps = getTRInputs(tr);
      // Checkboxes in this TR
      const trCbs  = Array.from(tr.querySelectorAll('input[type="checkbox"]'));

      result._debug.push({
        type: isItem ? 'item' : 'extra',
        selValue: sel.value,
        selText: sel.options[sel.selectedIndex]?.text?.trim(),
        trSelectCount: trSels.length,
        trInputCount: trInps.length,
        trInputValues: trInps.map(i => ({ name: i.name, id: i.id, type: i.type, value: i.value }))
      });

      if (isItem) {
        // In item row: [0]=col select, [1]=align select. Inputs: [0]=name, [1]=width, [2]=fontSize
        const colSel   = trSels[0];
        const alignSel = trSels.length > 1 ? trSels[trSels.length - 1] : null;
        result.itemRows.push({
          column:    sv(colSel),
          name:      trInps[0]?.value || '',
          width:     trInps[1]?.value || '',
          fontSize:  trInps[2]?.value || '',
          alignment: alignSel ? sv(alignSel) : { value:'LEFT', text:'LEFT' },
        });
      } else {
        // Extra row: [0]=field select. Inputs: [0]=name, [1]=fontSize
        const fieldSel = trSels[0];
        result.extraRows.push({
          field:    sv(fieldSel),
          name:     trInps[0]?.value || '',
          fontSize: trInps[1]?.value || '',
          bold:     trCbs[0]?.checked || false,
        });
      }
    });

    // Template Type & Format — use exact ids (template-type with hyphen!)
    const typeEl = document.getElementById('template-type') ||
                   document.querySelector('select[id*="template"][id*="type"],select[name*="template_type"]');
    if (typeEl && typeEl.value) result.templateType = sv(typeEl);

    const fmtEl = document.getElementById('template_format') ||
                  document.querySelector('select[id*="template_format"],select[name*="template_format"]');
    if (fmtEl && fmtEl.value) result.templateFormat = sv(fmtEl);

    // Name & title — exact ids confirmed from debug
    const nameEl = document.getElementById('name') || document.querySelector('[placeholder="Enter Template Name"]');
    if (nameEl) result.name = nameEl.value;
    const ptEl = document.getElementById('print_title') || document.querySelector('[placeholder="Enter Print Title"]');
    if (ptEl) result.printTitle = ptEl.value;

    // Multi-selects
    const MULTI = [['attribute','attribute'],['customField','custom_field'],['customItemField','custom_item_field'],['groupBy','group_by'],['outlet','outlet'],['roles','role']];
    Array.from(document.querySelectorAll('select')).forEach(sel => {
      const nm = (sel.name || sel.id || '').toLowerCase();
      for (const [key, pat] of MULTI) {
        if (nm.includes(pat)) {
          const vals = Array.from(sel.selectedOptions).map(o => ({ value: o.value, text: o.text.trim() }));
          if (vals.length) result[key] = vals;
        }
      }
    });

    document.querySelectorAll('input[type="checkbox"]').forEach(el => {
      const key = el.name || el.id;
      if (key) result.checkboxes[key] = el.checked;
    });

    // Capture text inputs in the attributes/company details section
    // These are inputs like font sizes, QR code, UPI id, padding, margin etc.
    // They have class "form-elem form-control" and id like "attribute_1_120"
    result.attrTextFields = {};
    document.querySelectorAll('input[type="text"][id^="attribute_"], input[type="text"][class*="form-elem"]')
      .forEach(el => {
        const key = el.id || el.name;
        // Skip the main template name and print title fields
        if (key && key !== 'name' && key !== 'print_title' && !key.includes('itemname') &&
            !key.includes('itemwidth') && !key.includes('itemsize') && !key.includes('extraname') &&
            !key.includes('extrafont') && !key.includes('rawitem') && !key.includes('navbar')) {
          result.attrTextFields[key] = el.value;
        }
      });

    return result;
  });
}

// ── WRITE template to destination ────────────────────────────────────────────
async function writeTemplate(page, base, data, log) {
  await page.goto(`${base}/?urlq=print-template/add`, { waitUntil: 'networkidle2', timeout: 30000 });
  if (await page.$('input[type="password"]')) throw new Error('Destination session expired');
  await wait(2000);

  // Bootstrap-select aware option setter
  async function setSelectValue(selector, value, text) {
    await page.evaluate((sel, v, t) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return false;
      const opt = Array.from(el.options).find(o => o.value === v) ||
                  Array.from(el.options).find(o => o.text.trim().toLowerCase() === (t||'').toLowerCase());
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Refresh bootstrap-select if available
      if (window.$ && $(el).data('selectpicker')) {
        $(el).selectpicker('val', opt.value);
        $(el).selectpicker('refresh');
      }
      return true;
    }, selector, value, text).catch(() => {});
  }

  // Set input value with native setter (works with all frameworks)
  async function setInputValue(selector, value) {
    await page.evaluate((sel, v) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el || !v) return;
      try {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (d && d.set) d.set.call(el, v); else el.value = v;
      } catch(e) { el.value = v; }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, value).catch(() => {});
  }

  // ── 1. Template Type ──────────────────────────────────────────────────────
  log(`  ↳ Setting type: ${data.templateType.text}`);
  await setSelectValue('#template-type', data.templateType.value, data.templateType.text);
  await wait(2500);
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
  await wait(1000);

  // ── 2. Format ─────────────────────────────────────────────────────────────
  log(`  ↳ Setting format: ${data.templateFormat.text}`);
  await setSelectValue('#template_format', data.templateFormat.value, data.templateFormat.text);
  await wait(500);

  // ── 3. Name & Print Title ─────────────────────────────────────────────────
  log(`  ↳ Setting name: "${data.name}"`);
  if (data.name) {
    await page.click('#name', { clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.type('#name', data.name, { delay: 20 }).catch(() => {
      setInputValue('#name', data.name);
    });
  }
  if (data.printTitle) {
    await page.click('#print_title', { clickCount: 3 }).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.type('#print_title', data.printTitle, { delay: 20 }).catch(() => {
      setInputValue('#print_title', data.printTitle);
    });
  }
  await wait(300);

  // ── 4. Add ALL item rows first, then ALL extra rows ───────────────────────
  const itemClicksNeeded  = Math.max(0, data.itemRows.length - 1);
  const extraClicksNeeded = Math.max(0, data.extraRows.length - 1);

  if (itemClicksNeeded > 0) {
    log(`  ↳ Adding ${itemClicksNeeded} more item rows...`);
    for (let i = 0; i < itemClicksNeeded; i++) {
      // Fresh handle every time - DOM changes after each click
      const btns = await page.$$('.item-column-group-btn');
      const plusBtns = [];
      for (const b of btns) {
        const cls = await b.evaluate(el => el.className || '').catch(() => '');
        if (cls.includes('btn-success') && !cls.includes('btn-danger')) plusBtns.push(b);
      }
      const btn = plusBtns[plusBtns.length - 1];
      if (btn) {
        await btn.scrollIntoView().catch(() => {});
        await btn.click();
        await wait(800);
      }
    }
    const rowCount = await page.evaluate(() => document.querySelectorAll('[name="itemcolumn"]').length);
    log(`    now ${rowCount} item rows on page`);
  }

  if (extraClicksNeeded > 0) {
    log(`  ↳ Adding ${extraClicksNeeded} more extra rows...`);
    for (let i = 0; i < extraClicksNeeded; i++) {
      const btns = await page.$$('.extra-field-group-btn');
      const plusBtns = [];
      for (const b of btns) {
        const cls = await b.evaluate(el => el.className || '').catch(() => '');
        if (cls.includes('btn-success') && !cls.includes('btn-danger')) plusBtns.push(b);
      }
      const btn = plusBtns[plusBtns.length - 1];
      if (btn) {
        await btn.scrollIntoView().catch(() => {});
        await btn.click();
        await wait(800);
      }
    }
    const rowCount = await page.evaluate(() => document.querySelectorAll('[name="extrafield"]').length);
    log(`    now ${rowCount} extra rows on page`);
  }

  await wait(1000); // final settle

  // ── 5. Fill item rows one by one using page.select() + page.type() ────────
  // Tag ALL item row inputs at once before filling — avoids re-render issues
  log(`  ↳ Filling ${data.itemRows.length} item rows...`);
  const itemColCount = await page.evaluate(() => document.querySelectorAll('[name="itemcolumn"]').length);
  log(`    (${itemColCount} itemcolumn selects found on page)`);

  // First pass: set ALL column dropdowns (triggers re-renders)
  for (let i = 0; i < data.itemRows.length; i++) {
    const rd = data.itemRows[i];
    await page.evaluate((i, v, t) => {
      const sel = document.querySelectorAll('[name="itemcolumn"]')[i];
      if (!sel) return;
      const opt = Array.from(sel.options).find(o => o.value === v) ||
                  Array.from(sel.options).find(o => o.text.trim().toLowerCase() === t.toLowerCase());
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.$ && $(sel).selectpicker) {
          try { $(sel).selectpicker('val', opt.value); $(sel).selectpicker('refresh'); } catch(e) {}
        }
      }
    }, i, rd.column.value, rd.column.text).catch(() => {});
    await wait(300); // wait per row for re-render
  }

  await wait(800); // final settle after all columns set

  // Second pass: tag inputs using exact DOM structure from DevTools:
  // div#itemcolumns > div.row > [div.col(itemcolumn), div.col(name), div.col(width), div.col(size), div.col(align), span(+), span(-)]
  const tagResult = await page.evaluate((count) => {
    const colSels = document.querySelectorAll('[name="itemcolumn"]');
    const results = [];

    for (let i = 0; i < count; i++) {
      const sel = colSels[i];
      if (!sel) { results.push(`row${i}: no colSel`); continue; }

      // Walk up to find the div.row (the row container)
      let rowDiv = sel.parentElement;
      while (rowDiv) {
        if (rowDiv.className && rowDiv.className.includes('row')) break;
        if (['BODY','FORM'].includes(rowDiv.tagName)) { rowDiv = null; break; }
        rowDiv = rowDiv.parentElement;
      }
      if (!rowDiv) { results.push(`row${i}: no div.row found`); continue; }

      // Get direct child col-divs of the row
      const colDivs = Array.from(rowDiv.children).filter(el =>
        el.tagName === 'DIV' && (el.className||'').includes('col-')
      );

      // Each col-div is: [0]=itemcolumn select, [1]=name input, [2]=width input, [3]=fontSize input, [4]=alignment select
      // Find inputs in col-divs that DON'T contain a <select>
      const inputColDivs = colDivs.filter(div => !div.querySelector('select'));
      const inps = inputColDivs.map(div =>
        div.querySelector('input[type="text"], input:not([type])')
      ).filter(Boolean);

      if (inps[0]) inps[0].setAttribute('data-fill', `iname-${i}`);
      if (inps[1]) inps[1].setAttribute('data-fill', `iwidth-${i}`);
      if (inps[2]) inps[2].setAttribute('data-fill', `isize-${i}`);

      results.push(`row${i}: rowDiv found, ${colDivs.length} col-divs, ${inputColDivs.length} input-cols, ${inps.length} inputs tagged`);
    }
    return results;
  }, data.itemRows.length).catch(e => [`tag error: ${e.message}`]);
  tagResult.forEach(r => log(`    ${r}`));

  // Third pass: fill name/width/fontSize + alignment using tagged inputs
  for (let i = 0; i < data.itemRows.length; i++) {
    const rd = data.itemRows[i];
    let nameSet = 'skip';

    if (rd.name) {
      try {
        await page.click(`[data-fill="iname-${i}"]`, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(`[data-fill="iname-${i}"]`, rd.name, { delay: 15 });
        nameSet = `"${rd.name}"`;
      } catch(e) {
        await page.evaluate((i, v) => {
          const el = document.querySelector(`[data-fill="iname-${i}"]`);
          if (el) { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
        }, i, rd.name).catch(() => {});
        nameSet = `eval:"${rd.name}"`;
      }
    }
    if (rd.width) {
      await page.evaluate((i,v) => {
        const el = document.querySelector(`[data-fill="iwidth-${i}"]`);
        if (el) { el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
      }, i, rd.width).catch(() => {});
    }
    if (rd.fontSize) {
      await page.evaluate((i,v) => {
        const el = document.querySelector(`[data-fill="isize-${i}"]`);
        if (el) { el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
      }, i, rd.fontSize).catch(() => {});
    }

    // Alignment
    const alignSet = await page.evaluate((i, v, t) => {
      const sel = document.querySelectorAll('[name="itemalignment"]')[i];
      if (!sel) return 'no sel';
      const opt = Array.from(sel.options).find(o => o.value === v) ||
                  Array.from(sel.options).find(o => o.text.trim().toLowerCase() === t.toLowerCase());
      if (!opt) return `not found: "${t}"`;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.$ && $(sel).selectpicker) {
        try { $(sel).selectpicker('val', opt.value); $(sel).selectpicker('refresh'); } catch(e) {} }
      return opt.text;
    }, i, rd.alignment.value, rd.alignment.text).catch(e => `err:${e.message}`);

    log(`    item[${i+1}] "${rd.column.text}" name=${nameSet} align=${alignSet}`);
  }

  // ── 6. Fill extra rows one by one ─────────────────────────────────────────
  log(`  ↳ Filling ${data.extraRows.length} extra rows...`);
  const extraFieldCount = await page.evaluate(() => document.querySelectorAll('[name="extrafield"]').length);
  log(`    (${extraFieldCount} extrafield selects found on page)`);

  for (let i = 0; i < data.extraRows.length; i++) {
    const rd = data.extraRows[i];

    const fieldSet = await page.evaluate((i, v, t) => {
      const sels = document.querySelectorAll('[name="extrafield"]');
      const sel  = sels[i];
      if (!sel) return `no sel at ${i}`;
      const opt = Array.from(sel.options).find(o => o.value === v) ||
                  Array.from(sel.options).find(o => o.text.trim().toLowerCase() === t.toLowerCase());
      if (!opt) return `opt not found: "${t}"`;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.$ && $(sel).selectpicker) {
        try { $(sel).selectpicker('val', opt.value); $(sel).selectpicker('refresh'); } catch(e) {}
      }
      return `set: ${opt.text}`;
    }, i, rd.field.value, rd.field.text).catch(e => `err: ${e.message}`);

    // Name — use page.type() after delay
    await wait(300);
    if (rd.name) {
      const extraNameSel = await page.evaluate((i) => {
        const inps = document.querySelectorAll('[name="extraname"]');
        const inp = inps[i];
        if (!inp) return null;
        inp.setAttribute('data-fill-target', `extra-name-${i}`);
        return `[data-fill-target="extra-name-${i}"]`;
      }, i).catch(() => null);
      if (extraNameSel) {
        await page.click(extraNameSel, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.type(extraNameSel, rd.name, { delay: 15 }).catch(async () => {
          await page.evaluate((i, v) => {
            const inps = document.querySelectorAll('[name="extraname"]');
            if (inps[i]) { inps[i].value = v; inps[i].dispatchEvent(new Event('input', { bubbles: true })); }
          }, i, rd.name).catch(() => {});
        });
      }
    }

    // Font size
    await page.evaluate((i, v) => {
      const inps = document.querySelectorAll('[name="extrafont"]');
      const inp  = inps[i];
      if (!inp) return;
      inp.value = v || '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, i, rd.fontSize || '').catch(() => {});

    // Bold checkbox
    await page.evaluate((i, bold) => {
      const sels = document.querySelectorAll('[name="extrafield"]');
      const sel  = sels[i];
      if (!sel) return;
      let tr = sel.parentElement;
      while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
      const cb = tr ? tr.querySelector('input[type="checkbox"]') : null;
      if (cb && cb.checked !== bold) cb.click();
    }, i, rd.bold || false).catch(() => {});

    log(`    extra[${i+1}] ${fieldSet} name="${rd.name}"`);
    await wait(100);
  }

  // ── 7. Multi-selects ──────────────────────────────────────────────────────
  for (const [sel, vals] of [
    ['#attr',             data.attribute || []],
    ['#custom_item_field',data.customItemField || []],
    ['#group_by',         data.groupBy || []],
    ['#outlet',           data.outlet || []],
    ['#role',             data.roles || []],
  ]) {
    if (!vals.length) continue;
    await page.evaluate((sel, vals) => {
      const el = document.querySelector(sel);
      if (!el) return;
      for (const o of el.options) o.selected = vals.some(v => v.value === o.value || v.text.trim() === o.text.trim());
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.$ && $(el).selectpicker) { try { $(el).selectpicker('refresh'); } catch(e) {} }
    }, sel, vals).catch(() => {});
  }

  // ── 8. Checkboxes ─────────────────────────────────────────────────────────
  await wait(300);
  await page.evaluate((cbs) => {
    for (const [key, checked] of Object.entries(cbs)) {
      const el = document.querySelector(`input[type="checkbox"][name="${key}"]`) ||
                 document.querySelector(`input[type="checkbox"][id="${key}"]`);
      if (el && el.checked !== checked) el.click();
    }
  }, data.checkboxes).catch(() => {});

  // ── 8b. Attribute text fields (font sizes, QR code, UPI id, padding etc.) ──
  if (data.attrTextFields && Object.keys(data.attrTextFields).length) {
    await page.evaluate((fields) => {
      for (const [key, value] of Object.entries(fields)) {
        if (!value) continue; // skip empty values
        const el = document.getElementById(key) ||
                   document.querySelector(`input[name="${key}"]`);
        if (!el) continue;
        try {
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (d && d.set) d.set.call(el, value); else el.value = value;
        } catch(e) { el.value = value; }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, data.attrTextFields).catch(() => {});
  }
  await wait(500);

  // ── 9. Submit ─────────────────────────────────────────────────────────────
  log(`  ↳ Submitting...`);
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[value="add-print-template-submit"]') ||
                document.querySelector('button[type="submit"].btn-success') ||
                document.querySelector('button[type="submit"]');
    if (btn) { btn.click(); return btn.textContent?.trim() || btn.value; }
    return null;
  }).catch(() => null);

  if (!clicked) throw new Error('Save button not found');
  log(`  ↳ Clicked: "${clicked}"`);
  await wait(5000);
}

// ── Migration SSE ─────────────────────────────────────────────────────────────
app.post('/api/migrate', async (req, res) => {
  const { srcUrl, srcCookies, dstUrl, dstCookies, templateIds, srcCompany, dstCompany } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const emit = (level, msg) => res.write(`data: ${JSON.stringify({ type: 'log', level, msg })}\n\n`);
  const progress = (current, total) => res.write(`data: ${JSON.stringify({ type: 'progress', current, total })}\n\n`);
  const done = (ok, fail, total) => res.write(`data: ${JSON.stringify({ type: 'done', ok, fail, total })}\n\n`);

  let srcPage, dstPage;
  try {
    const srcBase = baseUrl(srcUrl);
    const dstBase = baseUrl(dstUrl);

    // ── PHASE 1: Switch source company and read ALL templates ──────────────────
    // Must complete ALL reading before touching destination,
    // because both sessions share the same PHPSESSID on the server.
    emit('info', '🔗 Opening source session...');
    srcPage = await newPage(srcUrl, srcCookies);
    if (srcCompany) { await switchCompany(srcPage, srcBase, srcCompany, (m) => emit('info', m)); }
    emit('success', `✅ Source: ${srcBase}`);

    // Read ALL templates from source first
    const allTemplateData = [];
    for (let i = 0; i < templateIds.length; i++) {
      const { id, name } = templateIds[i];
      emit('info', `[${i+1}/${templateIds.length}] Reading: "${name}"`);
      try {
        const data = await readTemplate(srcPage, srcBase, id);
        emit('info', `  📋 Type: ${data.templateType.text} | Format: ${data.templateFormat.text}`);
        emit('info', `  📋 ${data.itemRows.length} item rows, ${data.extraRows.length} extra rows`);
        allTemplateData.push({ id, name, data, error: null });
      } catch(e) {
        emit('error', `  ❌ Read failed: "${name}" — ${e.message}`);
        allTemplateData.push({ id, name, data: null, error: e.message });
      }
    }

    // Close source browser — no longer needed
    if (srcPage?._ctx) await srcPage._ctx.close().catch(() => {});
    if (srcPage?._browser) await srcPage._browser.close().catch(() => {});
    srcPage = null;

    // ── PHASE 2: Switch destination company and write ALL templates ───────────
    emit('info', '🔗 Opening destination session...');
    dstPage = await newPage(dstUrl, dstCookies);
    if (dstCompany) { await switchCompany(dstPage, dstBase, dstCompany, (m) => emit('info', m)); }
    emit('success', `✅ Destination: ${dstBase}`);

    let ok = 0, fail = 0;

    for (let i = 0; i < allTemplateData.length; i++) {
      const { name, data, error } = allTemplateData[i];
      progress(i + 1, templateIds.length);

      if (error || !data) {
        emit('error', `  ❌ Skipping "${name}" — read failed: ${error}`);
        fail++;
        continue;
      }

      emit('info', `[${i+1}/${templateIds.length}] Writing: "${name}"`);
      try {
        await writeTemplate(dstPage, dstBase, data, (msg) => emit('info', msg));
        emit('success', `  ✅ Done: "${name}"`);
        ok++;
      } catch (e) {
        emit('error', `  ❌ Write failed: "${name}" — ${e.message}`);
        fail++;
      }
    }

    done(ok, fail, templateIds.length);
  } catch (e) {
    emit('error', `Fatal: ${e.message}`);
    done(0, templateIds?.length || 0, templateIds?.length || 0);
  } finally {
    if (srcPage?._ctx) await srcPage._ctx.close().catch(() => {});
    if (srcPage?._browser) await srcPage._browser.close().catch(() => {});
    if (dstPage?._ctx) await dstPage._ctx.close().catch(() => {});
    if (dstPage?._browser) await dstPage._browser.close().catch(() => {});
    res.end();
  }
});


// ── Debug endpoint ─────────────────────────────────────────────────────────────
// ── Screenshot endpoint ──────────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
  const { serverUrl, cookies, templateId } = req.body;
  let page;
  try {
    page = await newPage(serverUrl, cookies);
    const base = baseUrl(serverUrl);
    await page.goto(`${base}/?urlq=print-template/edit/${templateId}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(2500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await wait(500);
    const shot = await page.screenshot({ fullPage: true, encoding: 'base64' });
    res.setHeader('Content-Type', 'text/html');
    res.send('<img src="data:image/png;base64,' + shot + '" style="max-width:100%"/>');
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  } finally {
    if (page?._ctx) await page._ctx.close().catch(()=>{}); if (page?._browser) await page._browser.close().catch(()=>{});
  }
});

// ── Deep debug: dump ALL tr rows with selects ─────────────────────────────────
app.post('/api/debug', async (req, res) => {
  const { serverUrl, cookies, templateId } = req.body;
  let page;
  try {
    page = await newPage(serverUrl, cookies);
    const base = baseUrl(serverUrl);
    await page.goto(`${base}/?urlq=print-template/edit/${templateId}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(2500);
    const info = await page.evaluate(() => {
      // Scan ALL elements that contain selects - not just <tr>
      const CONTAINERS = ['tr','div','li','section','fieldset','[class*="row"]'];
      const seen = new Set();
      const allRows = [];

      // Get every select on the page and walk up to find its container
      Array.from(document.querySelectorAll('select')).forEach((sel, si) => {
        // Walk up max 5 levels to find a container with multiple selects/inputs
        let el = sel.parentElement;
        for (let depth = 0; depth < 6; depth++) {
          if (!el) break;
          const childSels = el.querySelectorAll('select');
          const childInps = el.querySelectorAll('input');
          // A "row container" has at least 1 select and is not the entire form
          if (childSels.length >= 1 && childSels.length <= 4 && !seen.has(el)) {
            const tag = el.tagName;
            // Skip body/form/section level containers
            if (['BODY','FORM','HTML','MAIN','SECTION'].includes(tag)) { el = el.parentElement; continue; }
            seen.add(el);
            allRows.push({
              tag: tag,
              class: el.className?.substring(0,60),
              id: el.id,
              depth: depth,
              sels: Array.from(childSels).map(s => ({
                name: s.name, id: s.id, value: s.value,
                selectedText: s.options[s.selectedIndex]?.text,
                optionCount: s.options.length,
                first8opts: Array.from(s.options).slice(0,8).map(o => o.text.trim())
              })),
              inps: Array.from(childInps).slice(0,5).map(i => ({
                name: i.name, id: i.id, type: i.type, value: i.value
              }))
            });
            break;
          }
          el = el.parentElement;
        }
      });

      // Also find all text nodes that say "item details" / "extra fields"
      const keyEls = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) {
        const t = node.textContent?.trim().toLowerCase();
        if (t === 'item details' || t === 'extra fields' || t === 'column details' || t === 'item columns') {
          const p = node.parentElement;
          keyEls.push({ tag: p?.tagName, class: p?.className, text: node.textContent.trim() });
        }
      }

      // Count all selects on page
      const totalSelects = document.querySelectorAll('select').length;
      const totalTrs = document.querySelectorAll('tr').length;
      const totalDivs = document.querySelectorAll('div').length;

      return { allRows, keyEls, totalSelects, totalTrs, totalDivs };
    });
    return res.json({ success: true, info });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    if (page?._ctx) await page._ctx.close().catch(()=>{}); if (page?._browser) await page._browser.close().catch(()=>{});
  }
});


// ── Debug page (GET) ──────────────────────────────────────────────────────────
app.get('/debug', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font:13px monospace;padding:20px">
<h2>Debug: Read Template Structure</h2>
<form id="f">
  <div>Server URL: <input id="url" size="50" value="https://maruthiceramics.sixorbit.com"/></div><br/>
  <div>Template ID: <input id="tid" size="10" value="4"/></div><br/>
  <div>Cookie: <textarea id="ck" rows="4" cols="80"></textarea></div><br/>
  <button type="submit">Run Debug</button>
</form>
<pre id="out" style="background:#111;color:#0f0;padding:16px;max-height:80vh;overflow:auto;white-space:pre-wrap;word-break:break-all"></pre>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  document.getElementById('out').textContent = 'Loading...';
  const r = await fetch('/api/debug', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({serverUrl: document.getElementById('url').value, cookies: document.getElementById('ck').value, templateId: document.getElementById('tid').value})});
  const d = await r.json();
  document.getElementById('out').textContent = JSON.stringify(d.info, null, 2);
};
</script>
</body></html>`);
});

// ── Debug destination add page ────────────────────────────────────────────────
app.post('/api/debug-dst', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  let browser, ctx;
  try {
    browser = await puppeteer.launch((() => { const o = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage','--disable-gpu'] }; if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH; return o; })());
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    const base = serverUrl.replace(/\/+$/, '');
    const cookieObjs = cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: new URL(base).hostname };
    }).filter(c => c.name);
    await page.setCookie(...cookieObjs);
    await page.goto(`${base}/?urlq=print-template/add`, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);

    const info = await page.evaluate(() => {
      // All inputs on page
      const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
        name: el.name, id: el.id, type: el.type, placeholder: el.placeholder,
        value: el.value, class: el.className?.substring(0,40)
      }));
      // All selects
      const selects = Array.from(document.querySelectorAll('select')).map(el => ({
        name: el.name, id: el.id, value: el.value,
        first5opts: Array.from(el.options).slice(0,5).map(o => o.text.trim())
      }));
      // All buttons
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).map(el => ({
        tag: el.tagName, text: el.textContent?.trim(), type: el.type, class: el.className?.substring(0,50), name: el.name, value: el.value
      }));
      // Page title / heading
      const heading = document.querySelector('h1,h2,h3,.page-title,.panel-title')?.textContent?.trim();
      return { inputs, selects, buttons, heading, url: window.location.href };
    });
    res.json({ ok: true, info });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  } finally {
    if (ctx) await ctx.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
});

// DOM structure debug
app.post('/api/debug-dom', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  let browser, ctx;
  try {
    browser = await puppeteer.launch((() => { const o = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage','--disable-gpu'] }; if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH; return o; })());
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    const base = serverUrl.replace(/\/+$/, '');
    const cookieObjs = cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: new URL(base).hostname };
    }).filter(c => c.name);
    await page.setCookie(...cookieObjs);
    await page.goto(`${base}/?urlq=print-template/add`, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);
    // Set template type first so item rows appear
    await page.evaluate(() => {
      const el = document.getElementById('template-type');
      if (el && el.options.length > 1) {
        el.value = el.options[1].value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await wait(2000);

    const info = await page.evaluate(() => {
      const sel = document.querySelector('[name="itemcolumn"]');
      if (!sel) return { error: 'no itemcolumn found' };
      // Walk up 10 levels and record each ancestor tag+class
      const ancestors = [];
      let el = sel.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!el) break;
        ancestors.push({ tag: el.tagName, cls: (el.className||'').substring(0,60), id: el.id||'' });
        el = el.parentElement;
      }
      // Also get the outerHTML of the immediate row container (3 levels up)
      let row = sel.parentElement?.parentElement?.parentElement;
      const rowHTML = row ? row.outerHTML.substring(0, 800) : 'n/a';
      return { ancestors, rowHTML };
    });
    res.json({ ok: true, info });
  } catch(e) { res.json({ ok: false, error: e.message }); }
  finally {
    if (ctx) await ctx.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
});

// Screenshot after adding rows — shows exact DOM state
app.post('/api/screenshot-rows', async (req, res) => {
  const { serverUrl, cookies, templateTypeValue } = req.body;
  let browser, ctx;
  try {
    browser = await puppeteer.launch((() => { const o = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage','--disable-gpu'] }; if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH; return o; })());
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    const base = serverUrl.replace(/\/+$/, '');
    const cookieObjs = cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: new URL(base).hostname };
    }).filter(c => c.name);
    await page.setCookie(...cookieObjs);
    await page.goto(`${base}/?urlq=print-template/add`, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);

    // Set template type
    await page.evaluate((v) => {
      const el = document.getElementById('template-type');
      if (el) {
        const opt = Array.from(el.options).find(o => o.value === v) || el.options[1];
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, templateTypeValue || '7');
    await wait(2500);

    // Add 2 more item rows
    for (let i = 0; i < 2; i++) {
      const btns = await page.$$('.item-column-group-btn');
      for (const b of btns) {
        const cls = await b.evaluate(el => el.className).catch(() => '');
        if (cls.includes('btn-success') && !cls.includes('btn-danger')) {
          await b.click(); await wait(800); break;
        }
      }
    }
    await wait(500);

    // Dump the HTML of just the item rows section + ancestor info
    const domInfo = await page.evaluate(() => {
      const colSels = document.querySelectorAll('[name="itemcolumn"]');
      const rows = [];
      colSels.forEach((sel, i) => {
        // Walk up 8 levels and record structure
        const ancestors = [];
        let el = sel;
        for (let j = 0; j < 8; j++) {
          el = el.parentElement;
          if (!el) break;
          ancestors.push(`${el.tagName}${el.id ? '#'+el.id : ''}.${(el.className||'').replace(/\s+/g,'.')}`);
        }
        // Get all inputs visible from 4 levels up
        let container = sel.parentElement?.parentElement?.parentElement?.parentElement;
        const inps = container ? Array.from(container.querySelectorAll('input')).map(inp => ({
          type: inp.type, name: inp.name, id: inp.id, cls: (inp.className||'').substring(0,30),
          inBootstrap: !!inp.closest('.bootstrap-select, .btn-group')
        })) : [];
        rows.push({ rowIndex: i, ancestors: ancestors.slice(0,5), inputsAt4up: inps });
      });
      return rows;
    });

    res.json({ ok: true, domInfo });
  } catch(e) { res.json({ ok: false, error: e.message }); }
  finally {
    if (ctx) await ctx.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
});

// Debug system-wizard/view page structure
app.post('/api/debug-company-page', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  let browser, ctx;
  try {
    browser = await puppeteer.launch((() => { const o = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage','--disable-gpu'] }; if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH; return o; })());
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const base = baseUrl(serverUrl);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const cookieObjs = cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: new URL(base).hostname };
    }).filter(c => c.name);
    await page.setCookie(...cookieObjs);
    await page.goto(`${base}/?urlq=system-wizard/view`, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);

    const dump = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        allSelects: Array.from(document.querySelectorAll('select')).map(sel => ({
          id: sel.id, name: sel.name,
          cls: sel.className,
          optionCount: sel.options.length,
          allOptions: Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() }))
        })),
        allButtons: Array.from(document.querySelectorAll('button, input[type=submit]')).map(b => ({
          tag: b.tagName, text: b.textContent?.trim().substring(0,50),
          type: b.type, cls: b.className?.substring(0,60), value: b.value
        })),
        allForms: Array.from(document.querySelectorAll('form')).map(f => ({
          id: f.id, action: f.action, cls: f.className?.substring(0,60)
        })),
        bodySnippet: document.body.innerHTML.substring(0, 3000)
      };
    });
    res.json({ success: true, dump });
  } catch(e) { res.json({ success: false, error: e.message }); }
  finally {
    if (ctx) await ctx.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
});

// Raw AJAX debug for switch company
app.post('/api/debug-switch-company', async (req, res) => {
  const { serverUrl, cookies } = req.body;
  let browser, ctx;
  try {
    browser = await puppeteer.launch((() => { const o = { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage','--disable-gpu'] }; if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH; return o; })());
    ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const base = baseUrl(serverUrl);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const cookieObjs = cookies.split(';').map(c => {
      const [name, ...rest] = c.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim(), domain: new URL(base).hostname };
    }).filter(c => c.name);
    await page.setCookie(...cookieObjs);
    await page.goto(`${base}/?urlq=home`, { waitUntil: 'networkidle2', timeout: 20000 });
    await wait(2000);

    // Capture ALL post requests after click
    const captured = [];
    page.on('response', async (response) => {
      if (response.request().method() === 'POST') {
        try {
          const text = await response.text().catch(() => '');
          captured.push({
            url: response.url(),
            status: response.status(),
            bodySnippet: text.substring(0, 2000)
          });
        } catch(e) {}
      }
    });

    // Get userId and click
    const userId = await page.evaluate(() => {
      const btn = document.querySelector('a.switch-company[data-id]');
      return btn ? btn.getAttribute('data-id') : null;
    });

    await page.evaluate(() => {
      const btn = document.querySelector('a.switch-company');
      if (btn) btn.click();
    });
    await wait(3000);

    // Also get full modal HTML
    const modalHtml = await page.evaluate(() => {
      const mb = document.getElementById('system-modal-body');
      return mb ? mb.innerHTML.substring(0, 3000) : 'empty';
    });

    // Also try direct fetch with different submit values
    const directResults = await page.evaluate(async (base, uid) => {
      const results = {};
      const submitValues = ['switch-company-form', 'get-company-list', 'company-list', 'switch_company'];
      for (const sv of submitValues) {
        try {
          const fd = new URLSearchParams();
          fd.append('submit', sv);
          if (uid) fd.append('user_id', uid);
          const r = await fetch(`${base}/?urlq=admin_user/user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: fd.toString(), credentials: 'include'
          });
          const t = await r.text();
          results[sv] = t.substring(0, 500);
        } catch(e) { results[sv] = 'error: ' + e.message; }
      }
      return results;
    }, base, userId);

    res.json({ success: true, userId, captured, modalHtml, directResults });
  } catch(e) { res.json({ success: false, error: e.message }); }
  finally {
    if (ctx) await ctx.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
});

app.get('/debug-company', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font:13px monospace;padding:20px">
<h2>Debug: Company Switcher</h2>
<form id="f">
  <div>Server URL: <input id="url" size="50" value="https://maruthiceramics.sixorbit.com"/></div><br/>
  <div>Cookie: <textarea id="ck" rows="4" cols="80"></textarea></div><br/>
  <button type="submit">Fetch Companies</button>
</form>
<div id="img" style="margin-top:12px"></div>
<pre id="out" style="background:#111;color:#0f0;padding:16px;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-all;margin-top:16px"></pre>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  document.getElementById('out').textContent = 'Loading...';
  const r = await fetch('/api/companies', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({serverUrl: document.getElementById('url').value, cookies: document.getElementById('ck').value})});
  const d = await r.json();
  if (d.screenshotB64) {
    document.getElementById('img').innerHTML = '<p>Page screenshot after clicking switch-company:</p><img src="data:image/png;base64,'+d.screenshotB64+'" style="max-width:100%;border:1px solid #ccc"/>';
  }
  document.getElementById('out').textContent = JSON.stringify({companies: d.companies, success: d.success, error: d.error}, null, 2);
};
</script></body></html>`);
});

app.get('/debug-dst', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font:13px monospace;padding:20px">
<h2>Debug: Destination Add Page Structure</h2>
<form id="f">
  <div>Server URL: <input id="url" size="50" value="https://tilerra.sixorbit.com"/></div><br/>
  <div>Cookie: <textarea id="ck" rows="4" cols="80"></textarea></div><br/>
  <button type="submit">Inspect Add Page</button>
</form>
<pre id="out" style="background:#111;color:#0f0;padding:16px;max-height:85vh;overflow:auto;white-space:pre-wrap;word-break:break-all;margin-top:16px"></pre>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  document.getElementById('out').textContent = 'Loading...';
  const r = await fetch('/api/debug-dst', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({serverUrl: document.getElementById('url').value, cookies: document.getElementById('ck').value})});
  const d = await r.json();
  document.getElementById('out').textContent = JSON.stringify(d.info, null, 2);
};
</script></body></html>`);
});

app.get('/', (req, res) => res.send(HTML));

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => console.log(`\n  Sixorbit Migrator v6.0 → http://localhost:${PORT}\n`));

// ── HTML UI ───────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sixorbit Template Migrator</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#f0f2f7;--surf:#fff;--bdr:#dde1ec;--txt:#1a1f2e;--mut:#7a84a0;--src:#0a7aff;--dst:#00b06b;--err:#ef4444;--wrn:#f59e0b;--r:10px;--sh:0 2px 12px rgba(0,0,0,.08)}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--txt);font-size:14px}
.wrap{max-width:1100px;margin:0 auto;padding:28px 18px 80px}
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
.f input,.f textarea{width:100%;padding:9px 12px;border:1.5px solid var(--bdr);border-radius:8px;font:13px 'DM Sans',sans-serif;color:var(--txt);background:#fff;outline:none;transition:border .15s}
.f input:focus,.f textarea:focus{border-color:var(--src)}
.f textarea{resize:vertical;min-height:70px;font-family:'DM Mono',monospace;font-size:11px;line-height:1.5}
.hint{font-size:11px;color:var(--mut);margin-top:5px;line-height:1.7}
.hint code{background:#f0f2f7;padding:1px 5px;border-radius:4px;font-family:'DM Mono',monospace}
.howto{background:#f0f6ff;border:1px solid #bfdbfe;border-radius:9px;padding:14px 18px;margin-bottom:20px;font-size:12px;color:#1e3a8a;line-height:1.9}
.howto strong{font-size:13px;display:block;margin-bottom:8px;color:#0a7aff}
.howto ol{padding-left:20px}
.howto code{background:#dbeafe;padding:1px 6px;border-radius:4px;font-family:'DM Mono',monospace;font-size:11px}
.srow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut);margin-top:12px;padding:8px 10px;background:var(--bg);border-radius:7px}
.sd{width:8px;height:8px;border-radius:50%;background:#ccc;flex-shrink:0;transition:all .3s}
.sd.ok{background:var(--dst)}.sd.er{background:var(--err)}.sd.ld{background:var(--wrn);animation:bl 1s infinite}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.errbox{display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 13px;margin-top:10px;font-size:12px;color:#991b1b;line-height:1.5}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 22px;border-radius:8px;border:none;font:500 13px 'DM Sans',sans-serif;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:disabled{opacity:.4;cursor:not-allowed}
.bp{background:var(--src);color:#fff}.bp:hover:not(:disabled){background:#0063d6}
.bg{background:var(--dst);color:#fff}.bg:hover:not(:disabled){background:#009a5e}
.bo{background:#fff;color:var(--txt);border:1.5px solid var(--bdr)}.bo:hover:not(:disabled){border-color:var(--src);color:var(--src)}
.bsm{padding:7px 14px;font-size:12px}.bfull{width:100%}
.ar{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:20px}
.ttb{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.tc{font-family:'DM Mono',monospace;font-size:12px;color:var(--mut)}.tc b{color:var(--txt)}
.si{padding:8px 12px;border:1.5px solid var(--bdr);border-radius:8px;font-size:13px;outline:none;width:200px}.si:focus{border-color:var(--src)}
.tlist{border:1px solid var(--bdr);border-radius:var(--r);overflow:hidden;max-height:420px;overflow-y:auto}
.ti{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--bdr);cursor:pointer;transition:background .1s;user-select:none}
.ti:last-child{border-bottom:none}.ti:hover{background:#f7f8fc}.ti.sel{background:#eef5ff}
.ti input[type=checkbox]{accent-color:var(--src);width:15px;height:15px;flex-shrink:0}
.tin{flex:1;min-width:0}.tn{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm{font-size:11px;color:var(--mut);font-family:'DM Mono',monospace;margin-top:2px}
.ba{background:#dcfce7;color:#15803d;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:500}
.bi{background:#fef3c7;color:#b45309;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:500}
.tempty{padding:24px;text-align:center;color:var(--mut)}
.pbar-wrap{background:#e5e7eb;border-radius:20px;height:6px;margin:12px 0;overflow:hidden}
.pbar{height:100%;background:linear-gradient(90deg,var(--src),var(--dst));border-radius:20px;transition:width .4s;width:0%}
.lw{background:#0d1117;border-radius:var(--r);padding:16px;max-height:440px;overflow-y:auto;font-family:'DM Mono',monospace;font-size:12px;line-height:1.7}
.ll{padding:2px 0;border-bottom:1px solid #161b22}.ll:last-child{border-bottom:none}
.ll.info{color:#8b949e}.ll.success{color:#3fb950}.ll.error{color:#f85149}.ll.warn{color:#d29922}
.rc{border-radius:var(--r);padding:20px;margin-top:14px;display:flex;align-items:center;gap:16px}
.rc.ok{background:#f0fdf4;border:1px solid #bbf7d0}.rc.pw{background:#fffbeb;border:1px solid #fde68a}.rc.fl{background:#fef2f2;border:1px solid #fecaca}
.ri{font-size:32px}.rt h3{font-size:16px;font-weight:600;margin-bottom:4px}.rt p{font-size:13px;color:var(--mut)}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
<div class="topbar">
  <div class="logo">&#8644;</div>
  <div class="brand"><b>Sixorbit</b> Template Migrator</div>
  <div class="ver">v6.0</div>
</div>
<div class="steps">
  <button class="st on" id="s0"><span class="sn">1</span> Setup Sessions</button>
  <div class="sdiv"></div>
  <button class="st" id="s1"><span class="sn">2</span> Select Templates</button>
  <div class="sdiv"></div>
  <button class="st" id="s2"><span class="sn">3</span> Migrate</button>
</div>

<!-- STEP 0 -->
<div id="p0">
  <div class="howto">
    <strong>&#128274; How to get your Cookie (do this for each server):</strong>
    <ol>
      <li>Log in to Sixorbit in Chrome</li>
      <li><code>F12</code> &rarr; <code>Network</code> tab &rarr; click any request in the list</li>
      <li><code>Headers</code> &rarr; scroll to <b>Request Headers</b> &rarr; find <code>Cookie:</code></li>
      <li><b>Right-click the value &rarr; Copy value</b> &rarr; paste below</li>
    </ol>
  </div>
  <div class="g2">
    <div class="card">
      <div class="ch"><div class="chc" style="background:var(--src)"></div><div class="cht">Source Server</div><div class="chb" id="srcBadge">Not verified</div></div>
      <div class="cb">
        <div class="f"><label>Server URL</label><input id="srcUrl" type="url" placeholder="https://*.sixorbit.com"/></div>
        <div class="f">
          <label>Cookie (from F12 &rarr; Network &rarr; Request Headers &rarr; Cookie row)</label>
          <textarea id="srcCookie" placeholder="Paste full Cookie here — e.g. _ga=GA1...; PHPSESSID=abc...; twk_uuid=..."></textarea>
          <div class="hint">Copy the <b>entire</b> value — it's a long string with many cookies separated by <code>;</code></div>
        </div>
        <button class="btn bp bfull" id="srcBtn" onclick="verify('src')">&#10003; Verify Source</button>
        <div class="srow"><div class="sd" id="srcDot"></div><span id="srcStat">Not verified</span></div>
        <div class="errbox" id="srcErr"></div>
        <div id="srcCompanyWrap" style="display:none;margin-top:10px">
          <div class="f"><label>Company</label>
            <select id="srcCompany" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px">
              <option value="">-- Select Company --</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="ch"><div class="chc" style="background:var(--dst)"></div><div class="cht">Destination Server</div><div class="chb" id="dstBadge">Not verified</div></div>
      <div class="cb">
        <div class="f"><label>Server URL</label><input id="dstUrl" type="url" placeholder="https://*.sixorbit.com"/></div>
        <div class="f">
          <label>Cookie (from F12 &rarr; Network &rarr; Request Headers &rarr; Cookie row)</label>
          <textarea id="dstCookie" placeholder="Paste full Cookie here — e.g. _ga=GA1...; PHPSESSID=xyz...; twk_uuid=..."></textarea>
          <div class="hint">Log in to the destination server in Chrome, then copy cookies the same way</div>
        </div>
        <button class="btn bg bfull" id="dstBtn" onclick="verify('dst')">&#10003; Verify Destination</button>
        <div class="srow"><div class="sd" id="dstDot"></div><span id="dstStat">Not verified</span></div>
        <div class="errbox" id="dstErr"></div>
        <div id="dstCompanyWrap" style="display:none;margin-top:10px">
          <div class="f"><label>Company</label>
            <select id="dstCompany" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px">
              <option value="">-- Select Company --</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="ar">
    <button class="btn bp" id="btnLoad" onclick="loadTemplates()">&#8594; Load Templates from Source</button>
  </div>
</div>

<!-- STEP 1 -->
<div id="p1" style="display:none">
  <div class="ttb">
    <div class="tc">Found <b id="tTotal">0</b> templates &nbsp;&middot;&nbsp; <b id="tSel">0</b> selected</div>
    <div style="display:flex;gap:8px;align-items:center">
      <input class="si" id="tsearch" placeholder="&#128269; Search..." oninput="filterT()"/>
      <button class="btn bo bsm" onclick="selAll()">Select All</button>
      <button class="btn bo bsm" onclick="deselAll()">Clear</button>
    </div>
  </div>
  <div class="tlist" id="tlist"><div class="tempty">Loading...</div></div>
  <div class="ar">
    <button class="btn bo" onclick="goStep(0)">&larr; Back</button>
    <button class="btn bg" id="btnMig" onclick="startMigrate()" disabled>&#8644; Copy to Destination</button>
  </div>
</div>

<!-- STEP 2 -->
<div id="p2" style="display:none">
  <div class="card">
    <div class="ch">
      <div class="chc" style="background:var(--dst)"></div>
      <div class="cht" id="migTitle">Migrating...</div>
      <div id="migProg" style="font-family:'DM Mono',monospace;font-size:12px;color:var(--mut)"></div>
    </div>
    <div class="cb">
      <div class="pbar-wrap"><div class="pbar" id="pbar"></div></div>
      <div class="lw" id="logPanel"></div>
      <div id="resCard" style="display:none"></div>
    </div>
  </div>
  <div class="ar">
    <button class="btn bo" id="btnBack2" onclick="goStep(1)" disabled>&larr; Back</button>
    <button class="btn bp" id="btnReset" style="display:none" onclick="goStep(0)">&#8635; New Migration</button>
  </div>
</div>
</div>

<script>
const S={src:{url:'',cookie:''},dst:{url:'',cookie:''},templates:[],sel:new Set()};
function goStep(n){[0,1,2].forEach(i=>{document.getElementById('p'+i).style.display=i===n?'':'none';const b=document.getElementById('s'+i);b.className='st'+(i===n?' on':i<n?' done':'');b.querySelector('.sn').textContent=i<n?'✓':i+1;});}
function setStat(side,state,msg){document.getElementById(side+'Dot').className='sd '+state;document.getElementById(side+'Stat').textContent=msg;const b=document.getElementById(side+'Badge');b.textContent=state==='ok'?'✓ Verified':state==='er'?'✗ Failed':msg;b.style.color=state==='ok'?'var(--dst)':state==='er'?'var(--err)':'';}
async function verify(side){
  const url=document.getElementById(side+'Url').value.trim();
  const cookie=document.getElementById(side+'Cookie').value.trim();
  if(!url||!cookie){alert('Enter both Server URL and Cookie');return;}
  S[side]={url,cookie};document.getElementById(side+'Err').style.display='none';
  const btn=document.getElementById(side+'Btn');btn.innerHTML='<span class="spinner"></span> Verifying...';btn.disabled=true;setStat(side,'ld','Verifying...');
  try{const r=await fetch('/api/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:url,cookies:cookie})});const d=await r.json();
    if(d.success){
      setStat(side,'ok','Session active ✓');
      // Fetch company list
      try {
        setStat(side,'ld','Loading companies...');
        const cr=await fetch('/api/companies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:url,cookies:cookie})});
        const cd=await cr.json();
        const wrap=document.getElementById(side+'CompanyWrap');
        const sel=document.getElementById(side+'Company');
        if(cd.success && cd.companies && cd.companies.length>0){
          sel.innerHTML='<option value="">-- Select Company --</option>'+cd.companies.map(c=>'<option value="'+c.value+'">'+c.text+'</option>').join('');
          // Auto-select if only one
          if(cd.companies.length===1){sel.value=cd.companies[0].value;}
          wrap.style.display='';
          setStat(side,'ok','Session active ✓');
        } else {
          wrap.style.display='none';
          setStat(side,'ok','Session active ✓ (single company)');
        }
      } catch(ce){ setStat(side,'ok','Session active ✓'); }
    }
    else{setStat(side,'er','Failed');const b=document.getElementById(side+'Err');b.style.display='';b.textContent='⚠ '+(d.error||'Failed');}
  }catch(e){setStat(side,'er','Error');const b=document.getElementById(side+'Err');b.style.display='';b.textContent='Cannot reach server: '+e.message;}
  btn.innerHTML=side==='src'?'&#10003; Verify Source':'&#10003; Verify Destination';btn.disabled=false;
}
async function loadTemplates(){
  const url=document.getElementById('srcUrl').value.trim(),cookie=document.getElementById('srcCookie').value.trim();
  if(!url||!cookie){alert('Enter Source URL and Cookie');return;}
  S.src={url,cookie,company:document.getElementById('srcCompany').value};
  S.dst={url:document.getElementById('dstUrl').value.trim(),cookie:document.getElementById('dstCookie').value.trim(),company:document.getElementById('dstCompany').value};
  if(!S.dst.url||!S.dst.cookie){alert('Enter Destination URL and Cookie too');return;}
  const btn=document.getElementById('btnLoad');btn.innerHTML='<span class="spinner"></span> Loading...';btn.disabled=true;
  try{const r=await fetch('/api/templates/list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serverUrl:url,cookies:cookie,company:S.src.company||''})});const d=await r.json();if(!d.success)throw new Error(d.error);S.templates=d.templates;renderT(d.templates);goStep(1);}
  catch(e){alert('Error: '+e.message);}
  btn.innerHTML='&#8594; Load Templates from Source';btn.disabled=false;
}
function renderT(list,q=''){
  const items=q?list.filter(t=>(t.templateName+t.templateType).toLowerCase().includes(q.toLowerCase())):list;
  document.getElementById('tTotal').textContent=list.length;updSel();
  const c=document.getElementById('tlist');
  if(!items.length){c.innerHTML='<div class="tempty">No templates found</div>';return;}
  c.innerHTML=items.map(t=>{const sel=S.sel.has(t.id);const active=(t.status||'').toLowerCase().includes('active');
    return \`<div class="ti\${sel?' sel':''}" onclick="togT('\${t.id}',this)"><input type="checkbox" \${sel?'checked':''} onclick="event.stopPropagation();togT('\${t.id}',this.closest('.ti'))"/><div class="tin"><div class="tn">\${t.templateName}</div><div class="tm">ID:\${t.id} · \${t.templateType}</div></div><div class="\${active?'ba':'bi'}">\${t.status||'?'}</div></div>\`;
  }).join('');
}
function togT(id,el){S.sel.has(id)?S.sel.delete(id):S.sel.add(id);el.classList.toggle('sel',S.sel.has(id));el.querySelector('input').checked=S.sel.has(id);updSel();}
function updSel(){document.getElementById('tSel').textContent=S.sel.size;const btn=document.getElementById('btnMig');btn.disabled=S.sel.size===0;btn.textContent=S.sel.size?\`⇄ Copy \${S.sel.size} template\${S.sel.size>1?'s':''} to Destination\`:'⇄ Copy to Destination';}
function selAll(){S.templates.forEach(t=>S.sel.add(t.id));renderT(S.templates,document.getElementById('tsearch').value);}
function deselAll(){S.sel.clear();renderT(S.templates,document.getElementById('tsearch').value);}
function filterT(){renderT(S.templates,document.getElementById('tsearch').value);}
function addLog(level,msg){const p=document.getElementById('logPanel');const d=document.createElement('div');d.className='ll '+level;d.textContent=msg;p.appendChild(d);p.scrollTop=p.scrollHeight;}
async function startMigrate(){
  const selected=S.templates.filter(t=>S.sel.has(t.id));
  goStep(2);document.getElementById('logPanel').innerHTML='';document.getElementById('resCard').style.display='none';
  document.getElementById('btnBack2').disabled=true;document.getElementById('btnReset').style.display='none';
  document.getElementById('migTitle').textContent='Migrating '+selected.length+' template(s)...';
  document.getElementById('migProg').textContent='0 / '+selected.length;document.getElementById('pbar').style.width='0%';
  const resp=await fetch('/api/migrate',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({srcUrl:S.src.url,srcCookies:S.src.cookie,dstUrl:S.dst.url,dstCookies:S.dst.cookie,srcCompany:S.src.company||'',dstCompany:S.dst.company||'',templateIds:selected.map(t=>({id:t.id,name:t.templateName}))})});
  const reader=resp.body.getReader();const dec=new TextDecoder();let buf='';
  while(true){const{done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split('\\n');buf=lines.pop();
    for(const line of lines){if(!line.startsWith('data: '))continue;try{const ev=JSON.parse(line.slice(6));
      if(ev.type==='log')addLog(ev.level,ev.msg);
      else if(ev.type==='progress'){document.getElementById('migProg').textContent=ev.current+' / '+ev.total;document.getElementById('pbar').style.width=Math.round(ev.current/ev.total*100)+'%';}
      else if(ev.type==='done'){document.getElementById('migTitle').textContent='Migration complete';document.getElementById('pbar').style.width='100%';document.getElementById('btnBack2').disabled=false;document.getElementById('btnReset').style.display='';
        const cls=ev.fail===0?'ok':ev.ok===0?'fl':'pw',icon=ev.fail===0?'🎉':ev.ok===0?'❌':'⚠️',msg=ev.fail===0?'All templates copied!':ev.ok===0?'Migration failed':'Partially done';
        const rc=document.getElementById('resCard');rc.style.display='';rc.innerHTML=\`<div class="rc \${cls}"><div class="ri">\${icon}</div><div class="rt"><h3>\${msg}</h3><p>\${ev.ok} succeeded · \${ev.fail} failed · \${ev.total} total</p></div></div>\`;}
    }catch(e){}}
  }
}
</script>
</body>
</html>`;
