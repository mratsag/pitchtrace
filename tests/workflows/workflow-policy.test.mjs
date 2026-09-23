import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflowPath = path.resolve('workflows/01-campaign-audit-review.json');
const source = fs.readFileSync(workflowPath, 'utf8');
const workflow = JSON.parse(source);
const retryWorkflow = JSON.parse(fs.readFileSync(path.resolve('workflows/00-analyzer-http-retry.json'),'utf8'));
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));

function outputs(name, branch) {
  const lists = workflow.connections[name]?.main ?? [];
  const selected = branch === undefined ? lists : [lists[branch] ?? []];
  return selected.flat().map((edge) => edge.node);
}

function reachable(start, branch) {
  const seen = new Set();
  const queue = outputs(start, branch);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...outputs(name));
  }
  return seen;
}

test('workflow export parses and every connection points to a real node', () => {
  assert.equal(workflow.active, false);
  assert.match(workflow.id, /^[0-9a-f-]{36}$/i, 'n8n 2.39 import requires a portable source id');
  assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, workflow.nodes.length);
  for (const [sourceName, channels] of Object.entries(workflow.connections)) {
    assert.ok(nodes.has(sourceName), `unknown connection source: ${sourceName}`);
    for (const edge of channels.main.flat()) assert.ok(nodes.has(edge.node), `unknown target: ${edge.node}`);
  }
});

test('export contains no credential id, embedded secret, personal path, or email sender node', () => {
  assert.ok(workflow.nodes.every((node) => !Object.hasOwn(node, 'credentials')));
  assert.doesNotMatch(source, /C:\\Users\\|\/Users\/|\/home\/(?!node\/\.n8n)/i);
  assert.doesNotMatch(source, /ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/i);
  const forbidden = /(gmail|outlook|smtp|sendgrid|mailgun|postmark|resend)/i;
  assert.ok(workflow.nodes.every((node) => !forbidden.test(`${node.type} ${node.name}`)));
});

test('critical analyzer endpoints are real and use only the internal analyzer origin', () => {
  const config = nodes.get('Workflow Config');
  const values = config.parameters.assignments.assignments;
  assert.equal(values.find((x) => x.name === 'analyzerBaseUrl').value, 'http://analyzer:8080');
  for (const endpoint of ['/campaigns', '/companies/import', '/audits', '/audit-progress', '/drafts/context', '/drafts', '/approval', '/export?format=eml', '/preview-access']) {
    assert.ok(source.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  assert.equal(source.match(/http:\/\/analyzer:8080/g)?.length, 1, 'only the central internal analyzer origin is allowed');
});

test('production polling is bounded at 30 seconds and 120 attempts', () => {
  const values = nodes.get('Workflow Config').parameters.assignments.assignments;
  assert.equal(values.find((x) => x.name === 'pollSeconds').value, 30);
  assert.equal(values.find((x) => x.name === 'pollMaxAttempts').value, 120);
  assert.equal(nodes.get('Wait Before Next Poll').type, 'n8n-nodes-base.wait');
  assert.ok(nodes.has('Polling Budget Exhausted?'));
  assert.ok(nodes.has('Audit Timeout Result'));
});

test('human gates dominate queueing and approval; rejection never calls approval', () => {
  assert.ok(reachable('Audit Explicitly Approved?', 0).has('Queue Campaign Audits'));
  assert.ok(!reachable('Audit Explicitly Approved?', 1).has('Queue Campaign Audits'));
  assert.ok(reachable('Human Approved Draft?', 0).has('Record Explicit Approval'));
  assert.ok(reachable('Human Approved Draft?', 0).has('Export Approved EML'));
  assert.ok(!reachable('Human Approved Draft?', 1).has('Record Explicit Approval'));
  assert.ok(!reachable('Human Approved Draft?', 1).has('Export Approved EML'));
  assert.ok(reachable('Record Explicit Approval').has('Export Approved EML'));
});

test('screenshot preview uses an artifact-bound short-lived URL without exposing the API key', () => {
  const fetch = nodes.get('Request Short-Lived Preview Access');
  assert.match(fetch.parameters.workflowInputs.value.url, /\/artifacts\/.*\/preview-access/);
  assert.equal(fetch.parameters.workflowInputs.value.method, 'POST');
  const review = nodes.get('Human Draft Review');
  assert.match(review.parameters.options.formDescription, /preview_url/);
  assert.match(review.parameters.options.formDescription, /referrerpolicy=/);
  assert.match(review.parameters.options.formDescription, /refresh_url/);
  assert.match(review.parameters.options.formDescription, /süresi dolduysa/);
  assert.ok(!nodes.has('Controlled Screenshot Preview'));
  assert.ok(!nodes.has('Fetch Preview Artifact'));
  assert.doesNotMatch(source, /data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]{100}/);
});

test('retry-safe analyzer calls use the shared retry workflow',()=>{
  const retryId=retryWorkflow.id;
  for(const name of ['Queue Campaign Audits','Get Audit Progress','Get Draft Context','Request Short-Lived Preview Access']){
    const node=nodes.get(name);
    assert.equal(node.type,'n8n-nodes-base.executeWorkflow',name);
    assert.equal(node.parameters.workflowId.value,retryId,name);
    assert.equal(node.parameters.workflowInputs.value.retry_safe,true,name);
  }
  for(const name of ['Create Campaign','Import CSV','Validate and Store Draft','Record Explicit Approval','Export Approved EML']){
    assert.notEqual(nodes.get(name).type,'n8n-nodes-base.executeWorkflow',`${name} must not auto-retry`);
  }
  const retrySource=JSON.stringify(retryWorkflow);
  for(const status of [408,425,429,500,502,503,504]) assert.match(retrySource,new RegExp(String(status)));
  assert.match(retrySource,/attempt<Number\(init\.max_attempts\)/);
  assert.doesNotMatch(retrySource,/x-api-key|response\.body|console\./i);
});

test('deterministic draft still goes through analyzer V1–V16 endpoint', () => {
  assert.equal(nodes.get('Build Deterministic Evidence Draft').type, 'n8n-nodes-base.code');
  assert.match(nodes.get('Validate and Store Draft').parameters.url, /\/drafts/);
  assert.ok(reachable('Build Deterministic Evidence Draft').has('Validate and Store Draft'));
  assert.ok(reachable('Validate and Store Draft').has('Human Draft Review'));
});
