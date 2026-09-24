// TEST-ONLY orchestrator for the disposable n8n runtime suite.
// Invoked by scripts/test-n8n-runtime.sh inside the `runner` container.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { appRequire, env, FaultControl, ids, N8nSession } from './lib.mjs';
import { runRetryScenarios } from './retry.runtime.mjs';
import { checkRefreshHandleExpiry, runFormFlow, runNoRetryFlows } from './form.runtime.mjs';

const pg = appRequire('pg');
const outDir = '/out';
const runId = crypto.randomBytes(4).toString('hex');
const ownerPassword = env('RT_N8N_OWNER_PASSWORD');
const credentialId = env('RT_N8N_CREDENTIAL_ID');
const secrets = {
  analyzer_api_key: env('RT_ANALYZER_API_KEY'),
  preview_token_secret: env('RT_PREVIEW_TOKEN_SECRET'),
  n8n_encryption_key: env('RT_N8N_ENCRYPTION_KEY'),
  n8n_db_password: env('RT_N8N_DB_PASSWORD'),
  fault_control_token: env('RT_FAULT_CONTROL_TOKEN'),
};
const EMAIL_NODE = /(emailSend|gmail|microsoftOutlook|smtp|sendGrid|mailgun|postmark|resend|mailchimp|mailjet|sendInBlue|brevo)/i;

const report = {
  suite: 'pitchtrace-n8n-runtime', run_id: runId, started_at: new Date().toISOString(),
  test_overrides: [
    'PREVIEW_TOKEN_TTL_SECONDS=60 (analyzer minimum; production default 600)',
    'PREVIEW_REFRESH_TTL_SECONDS=300 (analyzer minimum; production default 3600)',
    'Workflow Config.pollSeconds=3 in the runtime copy only (committed value 30)',
    'SSRF_ALLOW_LOOPBACK=1 with NODE_ENV=test for the loopback-only fictional site',
    'retry backoff, Retry-After cap, HTTP timeout and max attempts: production values, unchanged',
  ],
  checks: [],
};
const check = (name, ok, detail) => { report.checks.push({ name, result: ok ? 'passed' : 'failed', ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ''}`); };

const db = new pg.Pool({ connectionString: env('RT_ANALYZER_DB_URL'), max: 2 });
const fault = new FaultControl(secrets.fault_control_token);
const session = new N8nSession();
let formReport = null;
try {
  console.log('TEST OVERRIDES ACTIVE:');
  for (const line of report.test_overrides) console.log(`  - ${line}`);
  await session.setupOwner(ownerPassword);
  await session.login(ownerPassword);
  const settings = await session.get('/rest/settings');
  report.n8n_version = settings.versionCli;
  check('n8n is the pinned 2.39.10 release', settings.versionCli === '2.39.10', settings.versionCli);

  const workflows = {};
  for (const [key, id] of Object.entries(ids)) {
    const wf = await session.get(`/rest/workflows/${id}`);
    workflows[key] = { id: wf.id, name: wf.name, active: wf.active, active_version: Boolean(wf.activeVersionId ?? wf.activeVersion) };
    check(`${key} workflow imported and published`, wf.id === id && wf.active === true, workflows[key]);
    check(`${key} workflow has no email sender node`, wf.nodes.every((n) => !EMAIL_NODE.test(n.type)));
    const bound = wf.nodes.filter((n) => n.credentials);
    check(`${key} workflow credentials bound only at runtime`, bound.every((n) => n.credentials.httpHeaderAuth?.id === credentialId));
    if (key === 'main') {
      const refs = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow').map((n) => n.parameters.workflowId.value);
      check('main workflow sub-workflow references resolve to the imported retry workflow', refs.length === 4 && refs.every((r) => r === ids.retry), refs);
    }
  }
  report.import = { method: 'n8n CLI import:credentials + import:workflow --separate + publish:workflow', workflows };

  report.retry = await runRetryScenarios({ session, fault, apiKey: secrets.analyzer_api_key, runId, secrets, db });
  check('shared retry workflow scenarios', report.retry.every((r) => r.result === 'passed'));

  formReport = await runFormFlow({ session, fault, db, runId, secrets, ownerPassword, outDir, credentialId });
  check('main workflow Form + preview expiry/refresh flow', formReport.result === 'passed', formReport.failures);

  report.no_retry = await runNoRetryFlows({ session, fault, db, runId, ownerPassword });
  check('non-retry endpoints stop after one call', report.no_retry.every((r) => r.result === 'passed'));

  report.refresh_handle_expiry = await checkRefreshHandleExpiry(formReport);
  check('expired refresh handle rejected in Chromium', report.refresh_handle_expiry.result === 'passed');
} catch (err) {
  check('suite completed without an unexpected error', false, String(err?.stack ?? err).split('\n').slice(0, 4).join(' | '));
} finally {
  if (formReport) {
    const { _browser, refresh_url, refresh_expires_at_ms, ...rest } = formReport;
    report.main_workflow = rest;
    await _browser?.close().catch(() => undefined);
  }
  await db.end().catch(() => undefined);
  report.finished_at = new Date().toISOString();
  // Defence in depth: the report must never carry a runtime secret.
  const sensitive = Object.entries({ ...secrets, owner_password: ownerPassword, n8n_credential_id: credentialId });
  const leaked = sensitive.filter(([, secret]) => JSON.stringify(report).includes(secret)).map(([label]) => label);
  check('report contains no runtime secret or credential id', leaked.length === 0, leaked);
  report.result = report.checks.every((c) => c.result === 'passed') ? 'passed' : 'failed';
  let text = JSON.stringify(report, null, 2);
  for (const [label, secret] of sensitive) text = text.split(secret).join(`[redacted:${label}]`);
  fs.writeFileSync(`${outDir}/report.json`, `${text}\n`);
  console.log(`\nn8n runtime suite: ${report.result.toUpperCase()} (${report.checks.filter((c) => c.result === 'passed').length}/${report.checks.length} checks)`);
  // Exit explicitly so a stray browser/socket handle can never hang cleanup.
  process.exit(report.result === 'passed' ? 0 : 1);
}
