// TEST-ONLY: drives the real, published n8n Form of 01-campaign-audit-review
// with Chromium inside the disposable network, through import, audit start,
// draft review, preview expiry, same-artifact refresh and final decision.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { appRequire, ids, N8N, nodeRuns, OWNER_EMAIL, sleep, subExecutions } from './lib.mjs';

const { chromium } = appRequire('playwright');
const FORM_URL = `${N8N}/form/pitchtrace-campaign-review`;
const CSV = '/work/tests/n8n-runtime/fixtures/companies.csv';
const PREVIEW_ORIGIN = 'http://preview.pitchtrace.test:8080';
const RETRY_NODES = ['Queue Campaign Audits', 'Get Audit Progress', 'Get Draft Context', 'Request Short-Lived Preview Access'];

const decodeClaims = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
const tokenOf = (url) => new URL(url).pathname.split('/').pop();

export async function campaignCounts(db, name) {
  const { rows } = await db.query(`
    WITH c AS (SELECT id FROM pitchtrace.campaigns WHERE name=$1),
         co AS (SELECT id FROM pitchtrace.companies WHERE campaign_id IN (SELECT id FROM c)),
         d AS (SELECT id, status FROM pitchtrace.email_drafts WHERE company_id IN (SELECT id FROM co))
    SELECT (SELECT count(*) FROM c)::int campaigns,
           (SELECT count(*) FROM co)::int companies,
           (SELECT count(*) FROM pitchtrace.audits WHERE company_id IN (SELECT id FROM co))::int audits,
           (SELECT count(*) FROM pitchtrace.audits WHERE company_id IN (SELECT id FROM co) AND status='completed')::int completed_audits,
           (SELECT count(*) FROM d)::int drafts,
           (SELECT string_agg(status, ',') FROM d) draft_status,
           (SELECT count(*) FROM pitchtrace.approvals WHERE draft_id IN (SELECT id FROM d))::int approvals,
           (SELECT count(*) FROM pitchtrace.outreach_log WHERE draft_id IN (SELECT id FROM d))::int outreach_log`, [name]);
  return rows[0];
}

class Browser {
  requests = [];
  pageErrors = [];
  consoleErrors = [];

  static async open(ownerPassword) {
    const self = new Browser();
    self.browser = await chromium.launch({ headless: true });
    self.context = await self.browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1600 } });
    self.context.on('request', (request) => {
      self.requests.push({ url: request.url(), method: request.method(), headers: request.headers(), postData: request.postDataBuffer()?.toString('latin1') ?? '', entry: null });
    });
    self.context.on('response', async (response) => {
      const entry = self.requests.findLast((r) => r.url === response.url() && r.entry === null);
      if (!entry) return;
      // Record the status synchronously; headers arrive asynchronously.
      entry.entry = { status: response.status(), headers: {} };
      entry.entry.headers = await response.allHeaders().catch(() => ({}));
    });
    // e.g. Chromium's ORB blocking a cross-origin JSON 401 served for an <img>.
    self.context.on('requestfailed', (request) => {
      const entry = self.requests.findLast((r) => r.url === request.url() && r.entry === null && !r.failure);
      if (entry) entry.failure = request.failure()?.errorText ?? 'failed';
    });
    self.context.on('page', (page) => self.watch(page));
    const login = await self.context.request.post(`${N8N}/rest/login`, { data: { emailOrLdapLoginId: OWNER_EMAIL, password: ownerPassword } });
    assert.ok(login.ok(), `n8n browser login failed: ${login.status()}`);
    self.page = await self.context.newPage();
    return self;
  }

  watch(page) {
    page.on('pageerror', (error) => this.pageErrors.push(`${page.url().split('?')[0]} :: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') this.consoleErrors.push({ url: page.url(), text: message.text() }); });
  }

  async close() { await this.browser?.close(); }
}

async function openForm(page) {
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/oauth\/(?:authorize|consent)|form\/pitchtrace-campaign-review/, { timeout: 15_000 });
  if (page.url().includes('/oauth/')) {
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /allow|authorize|continue|grant/i }).first().click();
    await page.waitForURL(/form\/pitchtrace-campaign-review/, { timeout: 15_000 });
  }
  await page.getByLabel('campaign_name').waitFor({ timeout: 15_000 });
}

async function submitIntake(page, campaignName) {
  await openForm(page);
  await page.getByLabel('campaign_name').fill(campaignName);
  await page.getByLabel('sector').fill('fixture');
  await page.getByLabel('city').fill('Test City');
  await page.getByLabel('csv').setInputFiles(CSV);
  await page.getByRole('button', { name: /CSV'yi doğrula/i }).click();
}

async function latestExecutionAfter(session, knownIds) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const list = await session.executions(ids.main, 20);
    const fresh = list.map((e) => String(e.id)).filter((id) => !knownIds.has(id));
    if (fresh.length) return fresh.sort((a, b) => Number(b) - Number(a))[0];
    if (Date.now() > deadline) throw new Error('no new main-workflow execution appeared');
    await sleep(500);
  }
}

async function knownExecutions(session) {
  return new Set((await session.executions(ids.main, 100)).map((e) => String(e.id)));
}

/** Fails fast with n8n's (sanitized) error if the execution stops before `text` shows. */
async function waitForPage(page, session, executionId, text, timeoutMs) {
  const shown = page.getByText(text).first().waitFor({ timeout: timeoutMs });
  let stop = false;
  const failed = (async () => {
    while (!stop && executionId) {
      const e = await session.execution(executionId).catch(() => null);
      if (e && ['error', 'crashed'].includes(e.status)) {
        throw new Error(`execution ${executionId} ended ${e.status}: ${String(e.data?.resultData?.error?.message ?? '').slice(0, 200)}`);
      }
      await sleep(1000);
    }
  })();
  try { await Promise.race([shown, failed]); } finally { stop = true; failed.catch(() => undefined); shown.catch(() => undefined); }
}

async function reachReview(page, session, executionId) {
  await page.getByText(/Import tamamlandı/i).waitFor({ timeout: 30_000 });
  await page.getByLabel('Başlat').check();
  await page.getByRole('button', { name: /Kararı uygula/i }).click();
  await waitForPage(page, session, executionId, /Kanıta bağlı taslak incelemesi/i, 180_000);
}

/** Main happy path: retry injection on all retry-safe calls + preview expiry/refresh. */
export async function runFormFlow({ session, fault, db, runId, secrets, ownerPassword, outDir, credentialId }) {
  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const steps = [];
  const step = (name, detail = {}) => { steps.push({ step: name, at: new Date().toISOString(), ...detail }); console.log(`  form: ${name}`); };
  const campaignName = `Runtime Form ${runId}`;
  const browser = await Browser.open(ownerPassword);
  const { page } = browser;
  const report = { campaign: 'fictional', steps, failures };
  try {
    // Transient faults on every retry-safe call made by the MAIN workflow.
    const scenarioIds = {
      queue: `${runId}-main-queue`, progress: `${runId}-main-progress`, context: `${runId}-main-context`, preview: `${runId}-main-preview`,
    };
    await fault.arm(scenarioIds.queue, 'POST', '/campaigns/:uuid/audits', [{ status: 500, forward: true }]);
    await fault.arm(scenarioIds.progress, 'GET', '/campaigns/:uuid/audit-progress', [{ status: 503 }]);
    await fault.arm(scenarioIds.context, 'GET', '/drafts/context?company_id=:uuid', [{ status: 502 }]);
    await fault.arm(scenarioIds.preview, 'POST', '/artifacts/:uuid/preview-access', [{ status: 429, retry_after: 1 }]);
    const since = (await fault.requests()).seq;
    const known = await knownExecutions(session);

    await submitIntake(page, campaignName);
    step('intake submitted in Chromium', { form_url: FORM_URL.replace(N8N, '') });
    await page.getByText(/Import tamamlandı/i).waitFor({ timeout: 30_000 });
    const summary = await page.locator('body').innerText();
    check(/Eklenen: 1/.test(summary), 'import summary did not report one imported company');
    step('import summary shown', { imported: 1 });
    const executionId = await latestExecutionAfter(session, known);
    report.n8n_execution_id = executionId;

    await reachReview(page, session, executionId);
    step('audit start decided by human; draft review page reached');
    check(/otomatik e-posta göndermez/i.test(await page.locator('body').innerText()), 'review page lacks the no-auto-send statement');

    const image = page.locator('img[alt^="Audit screenshot"]');
    assert.equal(await image.count(), 1, 'review form did not render the screenshot element');
    await image.evaluate((img) => img.complete || new Promise((r) => { img.onload = r; img.onerror = r; }));
    const previewUrl = await image.getAttribute('src');
    const refreshUrl = await page.locator('a', { hasText: /yeni güvenli önizleme/i }).getAttribute('href');
    check(previewUrl?.startsWith(`${PREVIEW_ORIGIN}/artifact-previews/`), 'preview URL is not on the preview origin');
    check(refreshUrl?.startsWith(`${PREVIEW_ORIGIN}/artifact-preview-refresh/`), 'refresh URL is not on the preview origin');
    const firstWidth = await image.evaluate((img) => img.naturalWidth);
    check(firstWidth > 0, 'initial screenshot did not decode');
    const oldToken = tokenOf(previewUrl);
    const claims = decodeClaims(oldToken);
    const refreshClaims = decodeClaims(tokenOf(refreshUrl));
    check(claims.artifact_id === refreshClaims.artifact_id, 'refresh handle bound to a different artifact');
    report.preview = { artifact_bound: true, first_natural_width: firstWidth, token_ttl_s: claims.exp - Math.floor(Date.now() / 1000) };
    report.refresh_url = refreshUrl;
    report.refresh_expires_at_ms = refreshClaims.exp * 1000;
    step('short-lived preview decoded inside the Form', { naturalWidth: firstWidth });
    await page.screenshot({ path: `${outDir}/form-review-initial.png`, fullPage: true });

    const before = await campaignCounts(db, campaignName);
    const beforeRequests = (await fault.requests()).seq;

    // Let the real token expire (TEST-ONLY TTL = analyzer minimum 60 s).
    const waitMs = claims.exp * 1000 - Date.now() + 1500;
    step('waiting for real token expiry', { wait_ms: Math.max(waitMs, 0) });
    if (waitMs > 0) await sleep(waitMs);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(/Kanıta bağlı taslak incelemesi/i).waitFor({ timeout: 30_000 });
    const expiredImage = page.locator('img[alt^="Audit screenshot"]');
    await expiredImage.evaluate((img) => img.complete || new Promise((r) => { img.onload = r; img.onerror = r; }));
    check((await expiredImage.getAttribute('src')) === previewUrl, 'form re-rendered with a different token (unexpected mint)');
    check((await expiredImage.evaluate((img) => img.naturalWidth)) === 0, 'expired preview still decoded');
    // The reload must really re-request the old URL (no-store: no cache hit).
    const imageRequests = browser.requests.filter((r) => r.url === previewUrl);
    check(imageRequests.length >= 2, `expired preview was not re-requested (${imageRequests.length} request)`);
    const reloaded = imageRequests.at(-1);
    // Chromium may block the cross-origin JSON 401 for an <img> (ORB) before a
    // response event; the server status is then read by a real navigation.
    const imageOutcome = reloaded?.entry ? `HTTP ${reloaded.entry.status}` : `blocked (${reloaded?.failure ?? 'no response'})`;
    check(reloaded?.entry ? reloaded.entry.status === 401 : Boolean(reloaded?.failure), `expired <img> outcome: ${imageOutcome}`);
    const statusPage = await browser.context.newPage();
    const expiredStatus = (await statusPage.goto(previewUrl, { waitUntil: 'load' }))?.status();
    await statusPage.close();
    check(expiredStatus === 401, `expired preview URL returned ${expiredStatus}`);
    const expiryText = await page.getByText(/Önizleme bağlantısının süresi dolduysa/i).isVisible();
    check(expiryText, 'expiry message not visible in the Form');
    step('old preview rejected; expiry message visible in Form', { img: imageOutcome, navigation_status: expiredStatus });
    await page.screenshot({ path: `${outDir}/form-review-expired.png`, fullPage: true });

    // Real user refresh action (link opens a new tab).
    const [previewPage] = await Promise.all([
      browser.context.waitForEvent('page'),
      page.locator('a', { hasText: /yeni güvenli önizleme/i }).click(),
    ]);
    await previewPage.waitForLoadState('load');
    const newUrl = previewPage.url();
    check(newUrl.startsWith(`${PREVIEW_ORIGIN}/artifact-previews/`), `refresh landed on ${newUrl.split('/').slice(0, 4).join('/')}`);
    const newToken = tokenOf(newUrl);
    check(newToken !== oldToken, 'refresh reused the expired token');
    check(decodeClaims(newToken).artifact_id === claims.artifact_id, 'refresh minted a token for another artifact');
    const refreshedWidth = await previewPage.evaluate(() => document.images[0]?.naturalWidth ?? 0);
    check(refreshedWidth > 0, 'refreshed screenshot did not decode');
    step('refresh minted a new token for the same artifact; screenshot decoded again', { naturalWidth: refreshedWidth });
    await previewPage.screenshot({ path: `${outDir}/preview-refreshed.png` });

    // Negative probes sent by Chromium itself. Preview responses carry
    // `default-src 'none'`, so scripts on that origin cannot fetch: GET probes
    // are real navigations, the POST probe is a no-cors request from a blank
    // page whose status is read from the browser's own network log.
    const probe = async (path, init) => {
      const p = await browser.context.newPage();
      try {
        if (!init?.method) return { status: (await p.goto(`${PREVIEW_ORIGIN}${path}`, { waitUntil: 'load' }))?.status() };
        const url = `${PREVIEW_ORIGIN}${path}`;
        await p.evaluate(([u, m]) => fetch(u, { method: m, mode: 'no-cors' }).catch(() => null), [url, init.method]);
        for (let i = 0; i < 20; i += 1) {
          const seen = browser.requests.findLast((r) => r.url === url && r.method === init.method && r.entry);
          if (seen) return { status: seen.entry.status };
          await sleep(100);
        }
        return { status: null };
      } finally { await p.close(); }
    };
    const other = crypto.randomUUID();
    const handle = tokenOf(refreshUrl);
    const forgedPayload = (token, artifactId) => {
      const [payload, sig] = token.split('.');
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return `${Buffer.from(JSON.stringify({ ...body, artifact_id: artifactId })).toString('base64url')}.${sig}`;
    };
    const tamperedSig = `${handle.slice(0, -2)}${handle.endsWith('AA') ? 'BB' : 'AA'}`;
    const probes = {
      old_token_still_rejected: await probe(`/artifact-previews/${oldToken}`),
      refresh_handle_tampered: await probe(`/artifact-preview-refresh/${tamperedSig}`),
      refresh_handle_other_artifact: await probe(`/artifact-preview-refresh/${forgedPayload(handle, other)}`),
      preview_token_other_artifact: await probe(`/artifact-previews/${forgedPayload(newToken, other)}`),
      refresh_handle_used_as_preview: await probe(`/artifact-previews/${handle}`),
      preview_token_used_as_refresh: await probe(`/artifact-preview-refresh/${newToken}`),
      raw_artifact_without_key: await probe(`/artifacts/${claims.artifact_id}`),
      mint_without_key: await probe(`/artifacts/${other}/preview-access`, { method: 'POST' }),
    };
    for (const [name, result] of Object.entries(probes)) check(result.status === 401, `${name} returned ${result.status}`);
    // A browser-supplied artifact id is ignored: the handle alone decides.
    const [queryPage] = [await browser.context.newPage()];
    await queryPage.goto(`${refreshUrl}?artifact_id=${other}`, { waitUntil: 'load' });
    check(decodeClaims(tokenOf(queryPage.url())).artifact_id === claims.artifact_id, 'query-supplied artifact id changed the minted artifact');
    await queryPage.close();
    report.probes = Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.status]));
    report.probes.refresh_with_foreign_artifact_query = 'same artifact';
    step('tampered/foreign/expired handles rejected; arbitrary artifact id ignored');
    await previewPage.close();

    const after = await campaignCounts(db, campaignName);
    check(JSON.stringify(after) === JSON.stringify(before), `expiry/refresh changed business state: ${JSON.stringify({ before, after })}`);
    const during = (await fault.requests(beforeRequests)).requests;
    check(!during.some((r) => /\/approval$|\/export/.test(r.route)), 'approval/export called during expiry/refresh');
    check(!during.some((r) => /\/audits$|^\/drafts$/.test(r.route) && r.method === 'POST'), 'audit/draft created during expiry/refresh');
    report.state_unchanged_during_refresh = { before, after };
    step('draft status unchanged; no approval/export/audit/draft during refresh', { draft_status: after.draft_status });

    // Human approval exports .eml only (no email is sent).
    await page.getByLabel('Onayla').check();
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /İnceleme kararını kaydet/i }).click();
    const download = await downloadPromise;
    check(/\.eml$/.test(download.suggestedFilename()), 'approval did not return an .eml download');
    const emlPath = await download.path();
    check(fs.readFileSync(emlPath, 'utf8').includes('pitchtrace.invalid'), 'eml does not target the reserved test contact');
    await download.delete();
    step('human approval returned .eml download (deleted after check; nothing sent)');

    const execution = await session.waitForExecution(executionId, (e) => e.status === 'success' || e.status === 'error' || e.status === 'crashed', 60_000);
    check(execution.status === 'success', `main execution status ${execution.status}`);
    const retryCalls = {};
    for (const node of RETRY_NODES) {
      const subs = subExecutions(execution, node);
      check(subs.length >= 1 && subs.every((s) => s.workflowId === ids.retry), `${node} did not execute the shared retry workflow`);
      const httpRuns = [];
      for (const sub of subs) httpRuns.push(nodeRuns(await session.execution(sub.executionId), 'Analyzer Request'));
      retryCalls[node] = { sub_executions: subs.map((s) => s.executionId), analyzer_request_runs: httpRuns };
    }
    for (const [key, node] of [['queue', 'Queue Campaign Audits'], ['progress', 'Get Audit Progress'], ['context', 'Get Draft Context'], ['preview', 'Request Short-Lived Preview Access']]) {
      const s = await fault.scenario(scenarioIds[key]);
      retryCalls[node].injected = s.attempts.map((a) => a.status);
      check(s.attempts.length >= 2 && s.attempts[1].status >= 200 && s.attempts[1].status < 300, `${node} did not recover after injected ${s.attempts[0]?.status}`);
      check(retryCalls[node].analyzer_request_runs[0] === 2, `${node} first sub-execution made ${retryCalls[node].analyzer_request_runs[0]} HTTP attempts`);
      await fault.call('DELETE', `/scenarios/${scenarioIds[key]}`);
    }
    report.main_workflow_retry_calls = retryCalls;
    step('execution graph shows all four retry-safe calls in the shared retry workflow');

    const routes = {};
    for (const r of (await fault.requests(since)).requests) routes[`${r.method} ${r.route}`] = (routes[`${r.method} ${r.route}`] ?? 0) + 1;
    report.analyzer_calls = routes;
    for (const route of ['POST /campaigns', 'POST /campaigns/:id/companies/import', 'POST /drafts', 'POST /drafts/:id/approval', 'GET /drafts/:id/export?format=eml']) {
      check(routes[route] === 1, `${route} called ${routes[route] ?? 0} times (expected exactly 1)`);
    }
    const final = await campaignCounts(db, campaignName);
    report.duplicates = final;
    check(final.campaigns === 1 && final.companies === 1 && final.audits === 1 && final.completed_audits === 1 && final.drafts === 1 && final.approvals === 1 && final.outreach_log === 1,
      `unexpected business record counts ${JSON.stringify(final)}`);

    // Browser-side secret and endpoint checks over everything Chromium sent.
    report.browser = scanBrowser(browser, secrets, credentialId, check);
    report.browser.page_errors = browser.pageErrors;
    check(browser.pageErrors.length === 0, `uncaught page errors: ${browser.pageErrors.join(' | ')}`);
  } catch (err) {
    await browser.close();
    throw err;
  }
  report.result = failures.length ? 'failed' : 'passed';
  report._browser = browser;
  return report;
}

function scanBrowser(browser, secrets, credentialId, check) {
  const all = browser.requests;
  let secretsFound = 0;
  for (const [label, secret] of Object.entries({ ...secrets, n8n_credential_id: credentialId })) {
    const leak = all.find((r) => r.url.includes(secret) || r.postData.includes(secret) || Object.values(r.headers).some((v) => String(v).includes(secret)));
    if (leak) secretsFound += 1;
    check(!leak, `${label} appeared in a browser request`);
  }
  const apiKeyHeader = all.some((r) => Object.keys(r.headers).some((h) => h.toLowerCase() === 'x-api-key'));
  check(!apiKeyHeader, 'browser sent an X-API-Key header');
  // Analyzer decision routes on any origin (n8n UI asset names are irrelevant).
  const decisionCalls = all.filter((r) => /^\/drafts\/[^/]+\/(approval|export)/.test(new URL(r.url).pathname));
  check(decisionCalls.length === 0, 'browser called approval/export directly');
  check(!all.some((r) => /\/\/(analyzer|analyzer-upstream)[:/]/.test(r.url)), 'browser reached the internal analyzer API origin');
  // Signed preview/refresh routes only; key-less /artifacts/* probes are
  // rejected earlier by the global API-key hook.
  const previewResponses = all.filter((r) => r.entry && r.url.startsWith(PREVIEW_ORIGIN)
    && /^\/artifact-preview(s|-refresh)\//.test(new URL(r.url).pathname));
  for (const r of previewResponses) {
    const h = r.entry.headers;
    check(/no-store/.test(h['cache-control'] ?? ''), `missing no-store on ${r.entry.status} preview response`);
    check(h['referrer-policy'] === 'no-referrer', `missing Referrer-Policy on ${r.entry.status} preview response`);
    check(h['x-content-type-options'] === 'nosniff', `missing nosniff on ${r.entry.status} preview response`);
  }
  const expectedConsole = browser.consoleErrors.filter((c) => /status of 401/.test(c.text));
  return {
    requests_observed: all.length,
    preview_responses_checked: previewResponses.map((r) => r.entry.status),
    secrets_found: secretsFound,
    x_api_key_header_seen: apiKeyHeader,
    approval_or_export_called_by_browser: decisionCalls.length > 0,
    // Non-analyzer paths that merely contain the words (e.g. n8n UI chunks).
    unrelated_paths_mentioning_approval_or_export: [...new Set(all.map((r) => new URL(r.url).pathname)
      .filter((p) => /approval|export/i.test(p) && !/^\/drafts\//.test(p)))].slice(0, 5),
    expected_console_errors: expectedConsole.length,
    other_console_errors: browser.consoleErrors.length - expectedConsole.length,
    other_console_samples: browser.consoleErrors.filter((c) => !/status of 401/.test(c.text)).slice(0, 5)
      .map((c) => `${new URL(c.url).pathname.split('/').slice(0, 2).join('/')} :: ${c.text.slice(0, 140)}`),
  };
}

/** Non-retry endpoints: a transient failure must stop after exactly one call. */
export async function runNoRetryFlows({ session, fault, db, runId, ownerPassword }) {
  const cases = [
    { name: 'create-campaign-503', method: 'POST', path: '/campaigns', route: 'POST /campaigns', stage: 'intake', forward: false },
    { name: 'csv-import-503', method: 'POST', path: '/campaigns/:uuid/companies/import', route: 'POST /campaigns/:id/companies/import', stage: 'intake', forward: true },
    { name: 'draft-create-503', method: 'POST', path: '/drafts', route: 'POST /drafts', stage: 'audit', forward: true },
    { name: 'approval-503', method: 'POST', path: '/drafts/:uuid/approval', route: 'POST /drafts/:id/approval', stage: 'approve', forward: true },
    { name: 'eml-export-503', method: 'GET', path: '/drafts/:uuid/export?format=eml', route: 'GET /drafts/:id/export?format=eml', stage: 'approve', forward: true },
  ];
  const results = [];
  for (const c of cases) {
    const browser = await Browser.open(ownerPassword);
    const failures = [];
    const check = (ok, message) => { if (!ok) failures.push(message); };
    const campaignName = `Runtime NoRetry ${c.name} ${runId}`;
    const scenario = `${runId}-noretry-${c.name}`.slice(0, 64);
    let executionId = null;
    try {
      await fault.arm(scenario, c.method, c.path, [{ status: 503, forward: c.forward }]);
      const known = await knownExecutions(session);
      await submitIntake(browser.page, campaignName);
      executionId = await latestExecutionAfter(session, known);
      // 'audit': the scripted draft-create failure ends the execution before review.
      if (c.stage === 'audit') await reachReview(browser.page, session, executionId).catch(() => undefined);
      if (c.stage === 'approve') await reachReview(browser.page, session, executionId);
      if (c.stage === 'approve') {
        await browser.page.getByLabel('Onayla').check();
        await browser.page.getByRole('button', { name: /İnceleme kararını kaydet/i }).click();
      }
      const execution = await session.waitForExecution(executionId, (e) => ['success', 'error', 'crashed'].includes(e.status), 240_000);
      check(execution.status === 'error', `execution ended ${execution.status}, expected controlled error`);
      await sleep(2500);
      const s = await fault.scenario(scenario);
      check(s.attempts.length === 1, `${c.route} called ${s.attempts.length} times`);
      const counts = await campaignCounts(db, campaignName);
      if (c.name === 'create-campaign-503') check(counts.campaigns === 0, 'campaign created despite synthetic failure');
      if (c.name === 'csv-import-503') check(counts.companies === 1 && counts.audits === 0, `import retried or continued: ${JSON.stringify(counts)}`);
      if (c.name === 'draft-create-503') check(counts.drafts === 1 && counts.approvals === 0, `draft duplicated: ${JSON.stringify(counts)}`);
      if (c.name === 'approval-503') check(counts.approvals === 1 && counts.outreach_log === 0, `approval duplicated or export ran: ${JSON.stringify(counts)}`);
      if (c.name === 'eml-export-503') check(counts.approvals === 1 && counts.outreach_log === 1, `export duplicated: ${JSON.stringify(counts)}`);
      const text = await browser.page.locator('body').innerText().catch(() => '');
      check(!/node_modules|\bat [\w.<>]+ \(/.test(text), 'stack trace shown to the user');
      results.push({ scenario: c.name, n8n_execution_id: executionId, endpoint: c.route, attempts: s.attempts.length, statuses: s.attempts.map((a) => a.status),
        forwarded_to_real_analyzer: c.forward, execution_status: execution.status, records: counts, result: failures.length ? 'failed' : 'passed', failures });
    } catch (err) {
      results.push({ scenario: c.name, n8n_execution_id: executionId, endpoint: c.route, result: 'failed', failures: [...failures, String(err.message).slice(0, 300)] });
    } finally {
      await fault.call('DELETE', `/scenarios/${scenario}`);
      await browser.close();
    }
    const r = results.at(-1);
    console.log(`${r.result === 'passed' ? 'PASS' : 'FAIL'} no-retry ${c.name}: attempts=${r.attempts} exec=${executionId}${r.failures.length ? ` :: ${r.failures.join('; ')}` : ''}`);
  }
  return results;
}

/** Runs last: the refresh handle minted in the Form flow must expire for real. */
export async function checkRefreshHandleExpiry(formReport) {
  const browser = formReport._browser;
  const waitMs = formReport.refresh_expires_at_ms - Date.now() + 1500;
  if (waitMs > 0) { console.log(`  form: waiting ${Math.ceil(waitMs / 1000)} s for real refresh-handle expiry`); await sleep(waitMs); }
  const page = await browser.context.newPage();
  const response = await page.goto(formReport.refresh_url, { waitUntil: 'load' });
  const status = response?.status();
  const headers = await response?.allHeaders();
  await page.close();
  const ok = status === 401 && /no-store/.test(headers?.['cache-control'] ?? '') && headers?.['referrer-policy'] === 'no-referrer';
  console.log(`${ok ? 'PASS' : 'FAIL'} expired refresh handle rejected (${status})`);
  return { status, result: ok ? 'passed' : 'failed' };
}
