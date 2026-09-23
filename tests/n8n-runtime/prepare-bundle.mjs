// TEST-ONLY: builds the runtime import bundle inside the disposable stack.
// Reads the committed workflow exports read-only and writes patched copies to
// /bootstrap, a tmpfs of the one-off n8n-cli container. The repository files
// are never modified; credential IDs exist only in this throwaway instance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const out = '/bootstrap';
const credentialId = process.env.RT_N8N_CREDENTIAL_ID;
const apiKey = process.env.RT_ANALYZER_API_KEY;
const pollSeconds = Number(process.env.RT_TEST_POLL_SECONDS);
assert.match(credentialId ?? '', /^[A-Za-z0-9]{16}$/, 'RT_N8N_CREDENTIAL_ID must be 16 alphanumerics');
assert.ok(apiKey && apiKey.length >= 32, 'RT_ANALYZER_API_KEY missing');
assert.ok(Number.isInteger(pollSeconds) && pollSeconds >= 1 && pollSeconds < 30, 'RT_TEST_POLL_SECONDS must be a short test value');

const credentialRef = { httpHeaderAuth: { id: credentialId, name: 'PitchTrace Analyzer (runtime test)' } };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function bindCredential(workflow) {
  let bound = 0;
  for (const node of workflow.nodes) {
    assert.ok(!node.credentials, `${workflow.name}/${node.name} must not carry a committed credential`);
    if (node.type === 'n8n-nodes-base.httpRequest' && node.parameters.genericAuthType === 'httpHeaderAuth') {
      node.credentials = credentialRef;
      bound += 1;
    }
  }
  return bound;
}

const retry = read('/work/workflows/00-analyzer-http-retry.json');
const main = read('/work/workflows/01-campaign-audit-review.json');
const harness = read('/work/tests/n8n-runtime/fixtures/retry-harness.workflow.json');

const overrides = [];
overrides.push(`retry workflow: credential bound to ${bindCredential(retry)} HTTP node(s); backoff/timeout/max_attempts unchanged`);
overrides.push(`main workflow: credential bound to ${bindCredential(main)} HTTP node(s)`);
const config = main.nodes.find((n) => n.name === 'Workflow Config').parameters.assignments.assignments;
const poll = config.find((a) => a.name === 'pollSeconds');
assert.equal(poll.value, 30, 'committed production polling interval changed unexpectedly');
poll.value = pollSeconds;
overrides.push(`main workflow: pollSeconds 30 -> ${pollSeconds} (TEST ONLY; pollMaxAttempts unchanged)`);

fs.mkdirSync(path.join(out, 'workflows'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(out, 'workflows', '00-analyzer-http-retry.json'), JSON.stringify(retry));
fs.writeFileSync(path.join(out, 'workflows', '01-campaign-audit-review.json'), JSON.stringify(main));
fs.writeFileSync(path.join(out, 'workflows', '90-retry-harness.json'), JSON.stringify(harness));
fs.writeFileSync(path.join(out, 'credentials.json'), JSON.stringify([{
  id: credentialId,
  name: credentialRef.httpHeaderAuth.name,
  type: 'httpHeaderAuth',
  data: { name: 'X-API-Key', value: apiKey },
}]), { mode: 0o600 });
fs.writeFileSync(path.join(out, 'ids.env'), [
  `RETRY_WORKFLOW_ID=${retry.id}`, `MAIN_WORKFLOW_ID=${main.id}`, `HARNESS_WORKFLOW_ID=${harness.id}`, '',
].join('\n'));
console.log('TEST OVERRIDES ACTIVE (values hidden):');
for (const line of overrides) console.log(`  - ${line}`);
