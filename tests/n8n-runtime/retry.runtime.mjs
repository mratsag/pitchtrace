// TEST-ONLY: real n8n executions of the shared retry workflow.
//
// Each scenario arms a deterministic response script on the fault proxy for a
// path that contains a freshly created campaign UUID (per-scenario isolation),
// calls the published test harness webhook, then reads back:
//   - the proxy's per-scenario attempt log (what reached the "analyzer"),
//   - the n8n harness execution and the retry sub-execution it spawned.
import assert from 'node:assert/strict';
import { ids, N8N, nodeRuns, sleep, subExecutions } from './lib.mjs';

const UPSTREAM = 'http://analyzer-upstream:8080';

async function analyzer(apiKey, method, path, body) {
  const res = await fetch(`${UPSTREAM}${path}`, {
    method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

export async function createCampaign(apiKey, name, withCompany) {
  const campaign = await analyzer(apiKey, 'POST', '/campaigns', { name, sector: 'fixture', city: 'Test City', min_score: 50, max_companies: 20, page_limit: 1 });
  assert.equal(campaign.status, 201, `campaign setup failed: ${campaign.status}`);
  if (withCompany) {
    const company = await analyzer(apiKey, 'POST', `/campaigns/${campaign.body.id}/companies`, { name: 'Kurgusal Retry İşletmesi', website: 'http://site.pitchtrace.test:9000/opportunity.html' });
    assert.equal(company.status, 201, `company setup failed: ${company.status}`);
    return { id: campaign.body.id, companyId: company.body.company_id };
  }
  return { id: campaign.body.id };
}

const SCENARIOS = [
  { scenario: 'transient-500', method: 'POST', path: (c) => `/campaigns/${c.id}/audits`, withCompany: true,
    responses: [{ status: 500, forward: true }, { status: 500, forward: true }],
    expect: { attempts: 3, statuses: [500, 500, 202], ok: true } },
  { scenario: 'rate-limit-429', method: 'GET', path: (c) => `/campaigns/${c.id}/audit-progress`,
    responses: [{ status: 429, retry_after: 1 }], expect: { attempts: 2, statuses: [429, 200], ok: true, minGapMs: 950, maxGapMs: 5000 } },
  { scenario: 'timeout-then-success', method: 'GET', path: (c) => `/campaigns/${c.id}/audit-progress`,
    responses: [{ timeout_ms: 15000 }], expect: { attempts: 2, statuses: [0, 200], ok: true } },
  { scenario: 'max-retry-503', method: 'GET', path: (c) => `/campaigns/${c.id}/audit-progress`,
    responses: [{ status: 503 }, { status: 503 }, { status: 503 }], expect: { attempts: 3, statuses: [503, 503, 503], ok: false, error: 'ANALYZER_REQUEST_FAILED' } },
  ...[400, 401, 403, 422].map((status) => ({ scenario: `permanent-${status}`, method: 'GET', path: (c) => `/campaigns/${c.id}/audit-progress`,
    responses: [{ status }], expect: { attempts: 1, statuses: [status], ok: false, error: 'ANALYZER_REQUEST_FAILED' } })),
  { scenario: 'permanent-409-suppressed', method: 'GET', path: (c) => `/campaigns/${c.id}/audit-progress`,
    responses: [{ status: 409, error: 'SUPPRESSED' }], expect: { attempts: 1, statuses: [409], ok: false, error: 'SUPPRESSED' } },
  // retry_safe=false must never retry, even for a transient status.
  { scenario: 'retry-unsafe-503', method: 'GET', path: (c) => `/campaigns/${c.id}/audit-progress`, retrySafe: false,
    responses: [{ status: 503 }], expect: { attempts: 1, statuses: [503], ok: false, error: 'ANALYZER_REQUEST_FAILED' } },
];

export async function runRetryScenarios({ session, fault, apiKey, runId, secrets, db }) {
  const results = [];
  for (const def of SCENARIOS) {
    const id = `${runId}-${def.scenario}`.slice(0, 64);
    const campaign = await createCampaign(apiKey, `Runtime Retry ${def.scenario} ${runId}`, def.withCompany);
    const path = def.path(campaign);
    await fault.arm(id, def.method, path, def.responses);
    const started = Date.now();
    const res = await fetch(`${N8N}/webhook/pitchtrace-retry-harness`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: def.method, path, retry_safe: def.retrySafe ?? true, scenario: def.scenario }),
    });
    const text = await res.text();
    const elapsedMs = Date.now() - started;
    // A 4th call would arrive within the maximum backoff window if the loop were unbounded.
    if (!def.expect.ok) await sleep(2500);
    const record = await fault.scenario(id);
    const attempts = record.attempts;
    const failures = [];
    const check = (ok, message) => { if (!ok) failures.push(message); };

    let body = null;
    try { body = JSON.parse(text); } catch { failures.push('harness response is not JSON'); }
    check(res.status === 200, `harness HTTP ${res.status}`);
    const harnessExecutionId = String(body?.harness_execution_id ?? '');
    let subExecutionId = null;
    let n8nHttpRuns = null;
    if (harnessExecutionId) {
      const parent = await session.waitForExecution(harnessExecutionId, (e) => e.finished || e.status === 'success' || e.status === 'error');
      const subs = subExecutions(parent, 'Run Shared Retry Workflow');
      check(subs.length === 1 && subs[0].workflowId === ids.retry, 'harness did not call the shared retry workflow exactly once');
      subExecutionId = subs[0]?.executionId ?? null;
      if (subExecutionId) {
        const sub = await session.waitForExecution(subExecutionId, (e) => e.status === 'success' || e.status === 'error');
        n8nHttpRuns = nodeRuns(sub, 'Analyzer Request');
        check(sub.mode === 'integrated', `sub-execution mode ${sub.mode}`);
        check(sub.status === (def.expect.ok ? 'success' : 'error'), `sub-execution status ${sub.status}`);
      }
    } else failures.push('missing harness execution id');

    // Status seen by n8n per attempt; 0 = connection held until n8n's own timeout.
    const statuses = attempts.map((a) => a.status);
    check(attempts.length === def.expect.attempts, `expected ${def.expect.attempts} HTTP attempts, proxy saw ${attempts.length}`);
    check(n8nHttpRuns === def.expect.attempts, `n8n Analyzer Request ran ${n8nHttpRuns} times`);
    check(JSON.stringify(statuses) === JSON.stringify(def.expect.statuses), `statuses ${JSON.stringify(statuses)}`);
    check(attempts.every((a) => a.has_api_key), 'n8n did not attach the Header Auth credential on every attempt');
    for (let i = 1; i < attempts.length; i += 1) {
      const gap = attempts[i].t_ms - attempts[i - 1].t_ms;
      check(gap >= 300, `tight loop: attempt ${i + 1} only ${gap} ms after previous`);
      if (i === 1 && def.expect.minGapMs) check(gap >= def.expect.minGapMs && gap <= def.expect.maxGapMs, `Retry-After gap ${gap} ms outside bounds`);
    }
    const result = body?.result ?? {};
    if (def.expect.ok) {
      check(result.retry?.attempts === def.expect.attempts, `result retry.attempts=${result.retry?.attempts}`);
      check(!('error' in result), 'successful scenario returned an error');
    } else {
      check(typeof result.error === 'string' && result.error.startsWith(`${def.expect.error} (HTTP ${def.expect.statuses.at(-1)}, ${def.expect.attempts} deneme`), `sanitized error mismatch: ${String(result.error).slice(0, 160)}`);
    }
    for (const [label, secret] of Object.entries(secrets)) check(!text.includes(secret), `${label} leaked into harness response`);
    check(!/\bat [\w.<>]+ \(|node_modules|stack/i.test(text), 'stack trace leaked into harness response');

    let duplicates = null;
    if (def.withCompany) {
      const audits = await db.query('SELECT count(*)::int n FROM pitchtrace.audits WHERE company_id=$1', [campaign.companyId]);
      const jobs = await db.query('SELECT count(*)::int n FROM pitchtrace.audit_jobs WHERE company_id=$1', [campaign.companyId]);
      duplicates = { audits: audits.rows[0].n, audit_jobs: jobs.rows[0].n, forwarded_to_real_analyzer: attempts.length };
      check(audits.rows[0].n === 1 && jobs.rows[0].n === 1, `idempotency broken: ${JSON.stringify(duplicates)}`);
    }
    await fault.call('DELETE', `/scenarios/${id}`);
    results.push({
      scenario: def.scenario, n8n_execution_id: harnessExecutionId || null, n8n_retry_sub_execution_id: subExecutionId,
      method: def.method, route: path.replace(/[0-9a-f-]{36}/g, ':id'), retry_safe: def.retrySafe ?? true,
      attempts: attempts.length, n8n_http_node_runs: n8nHttpRuns, statuses,
      attempt_offsets_ms: attempts.map((a) => a.t_ms), elapsed_ms: elapsedMs,
      outcome: def.expect.ok ? 'success' : String(result.error ?? '').split(' ')[0], duplicates,
      result: failures.length ? 'failed' : 'passed', failures,
    });
    console.log(`${failures.length ? 'FAIL' : 'PASS'} retry ${def.scenario}: attempts=${attempts.length} statuses=${JSON.stringify(statuses)} exec=${harnessExecutionId}/${subExecutionId}${failures.length ? ` :: ${failures.join('; ')}` : ''}`);
  }
  return results;
}
