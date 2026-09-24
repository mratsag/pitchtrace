import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { compilePattern, createFaultProxy, templateOf, validateResponses } from '../n8n-runtime/fault-proxy.mjs';

const read = (file) => fs.readFileSync(file, 'utf8');
const retry = JSON.parse(read('workflows/00-analyzer-http-retry.json'));
const main = JSON.parse(read('workflows/01-campaign-audit-review.json'));

// Regressions found only by real n8n 2.39.10 executions (tests/n8n-runtime).
test('Set v3.3+ nodes keep includeOtherFields at the top level, where n8n reads it', () => {
  for (const wf of [retry, main]) {
    for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.set')) {
      assert.ok(!Object.hasOwn(node.parameters.options ?? {}, 'includeOtherFields'), `${wf.name}/${node.name}: options.includeOtherFields is ignored by n8n`);
    }
  }
  assert.equal(retry.nodes.find((n) => n.name === 'Increment Attempt').parameters.includeOtherFields, true);
});

test('retry workflow ends in a single-output node so the parent receives output 0', () => {
  const byName = new Map(retry.nodes.map((n) => [n.name, n]));
  for (const node of retry.nodes.filter((n) => n.type === 'n8n-nodes-base.if')) {
    const branches = retry.connections[node.name]?.main ?? [];
    assert.equal(branches.length, 2, `${node.name} must connect both branches`);
    assert.ok(branches.every((b) => b.length === 1), `${node.name} has a dangling branch; its last output would be returned to the parent`);
  }
  const terminals = retry.nodes.filter((n) => !retry.connections[n.name]);
  assert.deepEqual(terminals.map((n) => n.type).sort(), ['n8n-nodes-base.noOp', 'n8n-nodes-base.stopAndError']);
  const stop = byName.get('Stop With Sanitized Error');
  assert.doesNotMatch(stop.parameters.errorMessage, /body|headers|stack|url/i, 'error message must stay sanitized');
});

test('retry-safe POST calls send the JSON object the analyzer schema requires; GET sends no body', () => {
  const request = retry.nodes.find((n) => n.name === 'Analyzer Request').parameters;
  // n8n 2.39 hides body parameters when sendBody is an expression, so it must be static.
  assert.equal(request.sendBody, true);
  assert.equal(request.contentType, 'raw');
  assert.equal(request.rawContentType, 'application/json');
  const body = new Function('$json', `return (${request.body.replace(/^=\{\{|\}\}$/g, '')});`);
  assert.equal(body({ method: 'POST' }), '{}');
  assert.equal(body({ method: 'GET' }), undefined);
});

test('permanent failures stop the parent and 409 SUPPRESSED is reported as a business outcome', () => {
  const classify = retry.nodes.find((n) => n.name === 'Classify Retry').parameters.jsCode;
  assert.match(classify, /status===409&&\$json\.body\?\.error==='SUPPRESSED'/);
  assert.match(classify, /code=suppressed\?'SUPPRESSED'/);
  assert.equal(retry.connections['Analyzer Call Succeeded?'].main[1][0].node, 'Stop With Sanitized Error');
});

test('runtime test stack is disposable, private and never part of production compose', () => {
  const compose = read('tests/n8n-runtime/compose.yml');
  assert.doesNotMatch(compose, /^\s*ports:/m, 'test stack must not publish host ports');
  assert.doesNotMatch(compose, /docker\.sock|container_name:|^\s+name:\s/m);
  assert.match(compose, /networks:\n {2}rt:\n {4}internal: true/);
  assert.match(compose, /image: docker\.n8n\.io\/n8nio\/n8n:2\.39\.10/);
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.smoke.yml', 'deploy/compose.production.yml']) {
    assert.doesNotMatch(read(file), /fault-proxy|n8n-runtime|FAULT_CONTROL/i, `${file} must not reference the test fault injector`);
  }
  assert.doesNotMatch(read('services/analyzer/Dockerfile'), /n8n-runtime|fault-proxy/);
});

test('production preview, retry and polling defaults are unchanged by the runtime test', () => {
  const config = read('services/analyzer/src/config.ts');
  assert.match(config, /PREVIEW_TTL_DEFAULT_SECONDS = 600;/);
  assert.match(config, /PREVIEW_REFRESH_TTL_DEFAULT_SECONDS = 3600;/);
  assert.match(read('docker-compose.yml'), /PREVIEW_TOKEN_TTL_SECONDS: \$\{PREVIEW_TOKEN_TTL_SECONDS:-600\}/);
  const init = retry.nodes.find((n) => n.name === 'Initialize Retry State').parameters.assignments.assignments;
  assert.equal(init.find((a) => a.name === 'max_attempts').value, 3);
  assert.equal(retry.nodes.find((n) => n.name === 'Analyzer Request').parameters.options.timeout, 10000);
  const poll = main.nodes.find((n) => n.name === 'Workflow Config').parameters.assignments.assignments;
  assert.equal(poll.find((a) => a.name === 'pollSeconds').value, 30);
});

test('fault proxy accepts only path patterns and bounded scripted responses', () => {
  for (const bad of ['http://evil.example/', '//evil.example/x', 'evil', '/a b', '/x?u=http://y', '/%2f%2fevil']) {
    assert.throws(() => compilePattern(bad), /INVALID_PATTERN/, bad);
  }
  assert.ok(compilePattern('/campaigns/:uuid/audits').test('/campaigns/0b7f8f3a-51a2-4c38-9c55-6c2b86f1d101/audits'));
  assert.ok(!compilePattern('/campaigns/:uuid/audits').test('/campaigns/x/audits'));
  assert.equal(templateOf('/drafts/context?company_id=0b7f8f3a-51a2-4c38-9c55-6c2b86f1d101'), '/drafts/context?company_id=:id');
  assert.throws(() => validateResponses([]), /INVALID_RESPONSES/);
  assert.throws(() => validateResponses([{ status: 700 }]), /INVALID_STATUS/);
  assert.throws(() => validateResponses([{ status: 429, retry_after: 3600 }]), /INVALID_RETRY_AFTER/);
  assert.throws(() => validateResponses([{ timeout_ms: 600000 }]), /INVALID_TIMEOUT/);
  assert.throws(() => validateResponses([{ status: 409, error: 'x<script>' }]), /INVALID_ERROR_CODE/);
  assert.throws(() => createFaultProxy({ controlToken: 'short' }), /at least 32/);
  assert.match(read('tests/n8n-runtime/fault-proxy.mjs'), /const UPSTREAM = Object\.freeze\(\{ host: 'analyzer-upstream', port: 8080 \}\);/);
});

test('fault proxy scripts deterministic sequences, refuses proxy abuse and never logs header values', async (t) => {
  const upstream = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url })));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const token = 'x'.repeat(40);
  const { data, control } = createFaultProxy({ controlToken: token, upstream: { host: '127.0.0.1', port: upstream.address().port } });
  await Promise.all([new Promise((r) => data.listen(0, '127.0.0.1', r)), new Promise((r) => control.listen(0, '127.0.0.1', r))]);
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  t.after(() => { console.log = original; data.close(); control.close(); upstream.close(); });
  const dataUrl = `http://127.0.0.1:${data.address().port}`;
  const controlUrl = `http://127.0.0.1:${control.address().port}`;
  const ctl = (method, path, body, auth = token) => fetch(`${controlUrl}${path}`, { method, headers: { 'x-fault-control-token': auth, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

  assert.equal((await ctl('PUT', '/scenarios/s1', { method: 'GET', path: '/x' }, 'wrong'.repeat(8))).status, 401);
  assert.equal((await ctl('PUT', '/scenarios/s1', { method: 'GET', path: '/x', responses: [{ status: 503 }, { status: 429, retry_after: 1 }] })).status, 201);
  const secretHeader = 'super-secret-header-value-1234567890';
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await fetch(`${dataUrl}/x`, { headers: { 'x-api-key': secretHeader, authorization: `Bearer ${secretHeader}` } })).status);
  assert.deepEqual(statuses, [503, 429, 200]);
  const scenario = await (await ctl('GET', '/scenarios/s1')).json();
  assert.deepEqual(scenario.attempts.map((a) => a.status), [503, 429, 200]);
  assert.ok(scenario.attempts.every((a) => a.has_api_key === true));
  assert.ok(!JSON.stringify(scenario).includes(secretHeader));
  assert.ok(!logged.join('\n').includes(secretHeader), 'header values must never be logged');

  const absolute = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: data.address().port, path: 'http://evil.example/steal' }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(absolute, 400, 'absolute-form targets must be refused');
  assert.equal((await ctl('DELETE', '/state')).status, 204);
  assert.equal((await (await ctl('GET', '/requests')).json()).requests.length, 0);
});
