import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Executes the campaign-review Code nodes with minimal $input / $() stubs.
const workflow = JSON.parse(fs.readFileSync(path.resolve('workflows/01-campaign-audit-review.json'), 'utf8'));
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
const wrap = (json, binary) => (binary ? { json, binary } : { json });

function run(name, input, upstream = {}) {
  const items = input.map((i) => (i.json ? i : wrap(i)));
  const $input = { all: () => items, first: () => items[0] };
  const $ = (node) => {
    const out = (upstream[node] ?? []).map((i) => (i.json ? i : wrap(i)));
    return { all: () => out, first: () => out[0] };
  };
  return new Function('$input', '$', nodes.get(name).parameters.jsCode)($input, $);
}

const finding = (id, extra = {}) => ({ id, outreach_eligible: true, confidence: 'observed', artifact_id: null, ...extra });
const context = (n, extra = {}) => ({
  company: { id: `c${n}`, name: `Firma <${n}>`, domain: `f${n}.invalid` }, contact: { id: `ct${n}`, email: `info@f${n}.invalid` },
  audit_id: `a${n}`, language: 'tr', score: 70, findings: [finding(`f${n}`)], screenshot_artifact_id: `art${n}`, ...extra,
});

test('draft builder keeps eligible companies and explains every skip', () => {
  const out = run('Build Deterministic Evidence Draft', [{
    contexts: [context(1), context(2, { findings: [finding('x', { outreach_eligible: false })] }), context(3, { screenshot_artifact_id: null })],
    skipped: [{ company_id: 'c4', name: 'D', domain: 'f4.invalid', reason: 'SCORE_BELOW_THRESHOLD', score: 10, min_score: 50 }],
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.artifact_id, 'art1');
  assert.deepEqual(out[0].json.output.claims[0].finding_ids, ['f1']);
  assert.deepEqual(out[0].json.skipped.map((s) => s.reason), ['SCORE_BELOW_THRESHOLD', 'NO_ELIGIBLE_FINDING', 'NO_SCREENSHOT']);
  assert.ok(out[0].json.skipped.every((s) => s.reason_text && s.reason_text !== s.reason));
});

test('draft builder emits a single no-candidate marker when nothing is reviewable', () => {
  const out = run('Build Deterministic Evidence Draft', [{ contexts: [], skipped: [{ company_id: 'c1', name: 'A', domain: 'a.invalid', reason: 'SUPPRESSED' }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.no_candidate, true);
  assert.equal(out[0].json.skipped[0].reason_text, 'alıcı veya domain bastırma listesinde');
});

const built = () => run('Build Deterministic Evidence Draft', [{ contexts: [context(1), context(2)], skipped: [] }]);

test('stored-draft collector skips validator rejections but keeps the rest', () => {
  const out = run('Collect Stored Drafts', [
    { statusCode: 201, body: { draft_id: 'd1', body: 'Merhaba' } },
    { statusCode: 422, body: { draft_id: 'd2', errors: ['V9: x'] } },
  ], { 'Build Deterministic Evidence Draft': built() });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.draft_id, 'd1');
  assert.equal(out[0].json.contact_email, 'info@f1.invalid');
  assert.deepEqual(out[0].json.skipped.map((s) => s.reason), ['VALIDATOR_REJECTED']);
});

test('stored-draft collector stops on any other status without retrying', () => {
  assert.throws(() => run('Collect Stored Drafts', [
    { statusCode: 201, body: { draft_id: 'd1', body: 'x' } }, { statusCode: 503, body: { error: 'secret detail' } },
  ], { 'Build Deterministic Evidence Draft': built() }), (err) => /HTTP 503, 1 deneme/.test(err.message) && !/secret detail/.test(err.message));
});

test('stored-draft collector reports no candidate when every draft was rejected by the validator', () => {
  const out = run('Collect Stored Drafts', [{ statusCode: 422, body: {} }, { statusCode: 422, body: {} }], { 'Build Deterministic Evidence Draft': built() });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.no_candidate, true);
  assert.equal(out[0].json.skipped.length, 2);
});

const stored = () => run('Collect Stored Drafts', [
  { statusCode: 201, body: { draft_id: 'd1', body: 'Gövde <script>1</script>' } }, { statusCode: 201, body: { draft_id: 'd2', body: 'İkinci' } },
], { 'Build Deterministic Evidence Draft': built() });
const previews = [1, 2].map((n) => ({ preview_url: `http://p/artifact-previews/t${n}`, refresh_url: `http://p/artifact-preview-refresh/r${n}` }));

test('review page pairs every draft with its own preview and an explicit required decision', () => {
  const [page] = run('Assemble Review Page', previews, { 'Collect Stored Drafts': stored() });
  const radios = page.json.review_fields.filter((f) => f.fieldType === 'radio');
  const blocks = page.json.review_fields.filter((f) => f.fieldType === 'html');
  assert.deepEqual(radios.map((f) => f.fieldName), ['decision_1', 'decision_2']);
  assert.ok(radios.every((f) => f.requiredField && f.fieldOptions.values.map((v) => v.option).join() === 'Onayla,Reddet'));
  assert.match(blocks[0].html, /t1/);
  assert.match(blocks[1].html, /r2/);
  assert.doesNotMatch(blocks[0].html, /<script>|Firma <1>/, 'CSV-supplied and draft text must be escaped');
  assert.match(page.json.description_html, /otomatik e-posta göndermez/);
  assert.deepEqual(page.json.review.map((r) => r.draft_id), ['d1', 'd2']);
});

test('review page refuses to render when previews and drafts are out of step', () => {
  assert.throws(() => run('Assemble Review Page', previews.slice(0, 1), { 'Collect Stored Drafts': stored() }), /eşleşmiyor/);
});

const review = () => run('Assemble Review Page', previews, { 'Collect Stored Drafts': stored() });

test('decisions map to drafts; only approved drafts continue', () => {
  const out = run('Resolve Review Decisions', [{ decision_1: 'Reddet', decision_2: 'Onayla' }], { 'Assemble Review Page': review() });
  assert.deepEqual(out.map((i) => i.json.draft_id), ['d2']);
  assert.equal(out[0].json.rejected_count, 1);
  const none = run('Resolve Review Decisions', [{ decision_1: 'Reddet', decision_2: 'Reddet' }], { 'Assemble Review Page': review() });
  assert.deepEqual(none.map((i) => i.json), [{ approved_count: 0, rejected_count: 2 }]);
  assert.throws(() => run('Resolve Review Decisions', [{ decision_1: 'Onayla' }], { 'Assemble Review Page': review() }), /karar eksik/);
});

test('one approval returns the .eml itself; several are zipped with readable names', () => {
  const eml = (n) => wrap({}, { eml: { id: `bin${n}`, fileName: `d${n}.eml`, mimeType: 'message/rfc822' } });
  const approved = (ids) => ids.map((n) => wrap({ draft_id: `d${n}`, domain: `f${n}.invalid`, rejected_count: 0 }));
  const [single] = run('Bundle Approved Exports', [eml(1)], { 'Resolve Review Decisions': approved([1]) });
  assert.equal(single.json.zip, false);
  assert.equal(single.binary.export.id, 'bin1');
  assert.equal(single.binary.export.fileName, '01-f1.invalid.eml');
  const [many] = run('Bundle Approved Exports', [eml(1), eml(2)], { 'Resolve Review Decisions': approved([1, 2]) });
  assert.equal(many.json.zip, true);
  assert.equal(many.json.binary_keys, 'eml_1,eml_2');
  assert.equal(many.binary.eml_2.fileName, '02-f2.invalid.eml');
  assert.equal(nodes.get('Zip Approved Exports').parameters.binaryPropertyOutput, nodes.get('Return Export Without Sending').parameters.inputDataFieldName);
});
