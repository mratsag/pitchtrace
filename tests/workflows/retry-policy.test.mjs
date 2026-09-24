import assert from 'node:assert/strict';
import test from 'node:test';
import { retryDelayMs, RETRYABLE_STATUS } from '../../scripts/retry-policy.mjs';
import fs from 'node:fs';

test('only transient statuses retry and attempts are bounded',()=>{
  for(const code of [408,425,429,500,502,503,504]) assert.ok(RETRYABLE_STATUS.has(code));
  for(const code of [400,401,403,404,409,422]) assert.equal(retryDelayMs({attempt:1,status:code}),null);
  assert.equal(retryDelayMs({attempt:3,status:503}),null);
});
test('backoff, jitter and Retry-After are capped',()=>{
  assert.equal(retryDelayMs({attempt:1,status:500,random:()=>0}),500);
  assert.equal(retryDelayMs({attempt:2,status:500,random:()=>1}),1250);
  assert.equal(retryDelayMs({attempt:1,status:429,retryAfter:'30'}),10000);
});
test('network errors without a status may retry',()=>assert.equal(retryDelayMs({attempt:1,random:()=>0}),500));
test('main workflow reaches the shared retry state machine',()=>{
  const main=JSON.parse(fs.readFileSync('workflows/01-campaign-audit-review.json','utf8'));
  const helper=JSON.parse(fs.readFileSync('workflows/00-analyzer-http-retry.json','utf8'));
  assert.ok(main.nodes.some(n=>n.type==='n8n-nodes-base.executeWorkflow'&&n.parameters.workflowId.value===helper.id));
  assert.ok(helper.nodes.some(n=>n.name==='Analyzer Request'));
  assert.ok(helper.nodes.some(n=>n.name==='Bounded Backoff'));
});
