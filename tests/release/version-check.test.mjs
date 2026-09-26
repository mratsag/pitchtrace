import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkVersions, N8N_IMAGE_VERSION, USER_AGENT } from '../../scripts/version-check.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('repository versions are consistent', () => {
  const { version, problems } = checkVersions(root);
  assert.deepEqual(problems, []);
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
});

test('--expect accepts the tag form and rejects another version', () => {
  const { version } = checkVersions(root);
  assert.deepEqual(checkVersions(root, { expect: `v${version}` }).problems, []);
  assert.ok(checkVersions(root, { expect: 'v9.9.9' }).problems.some((p) => p.startsWith('--expect')));
});

// Fixture versions are independent of the real release so this file never needs bumping.
const V = '1.2.3-alpha.2';
const OLD = '1.2.3-alpha.1';

// Minimal non-git fixture so every rule can be broken in isolation.
function fixture(version, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtrace-version-'));
  const files = {
    'services/analyzer/package.json': JSON.stringify({ name: 'a', version }),
    'services/analyzer/package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'services/analyzer/src/config.ts': `str('ANALYZER_VERSION', '${version}');\nstr('USER_AGENT', '${USER_AGENT}');\n`,
    'README.md': `Current version: \`${version}\` · Status: public alpha\n`,
    '.github/ISSUE_TEMPLATE/bug_report.yml': `attributes: { label: Version, placeholder: ${version} }\n`,
    'CHANGELOG.md': `## [${version}] - 2026-09-26\nEarlier ${OLD} markers were never tagged.\n`,
    [`docs/releases/v${version}.md`]: `# PitchTrace v${version}\n`,
    'docker-compose.yml': `image: docker.n8n.io/n8nio/n8n:${N8N_IMAGE_VERSION}\n`,
    ...overrides,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('fixture passes and allows older versions only in historical records', () => {
  assert.deepEqual(checkVersions(fixture(V)).problems, []);
});

for (const [name, overrides, pattern] of [
  ['stale active reference', { 'docs/guide.md': `Install ${OLD} first.\n` }, /docs\/guide\.md: stale version reference 1\.2\.3-alpha\.1/],
  ['lockfile drift', { 'services/analyzer/package-lock.json': JSON.stringify({ version: V, packages: { '': { version: OLD } } }) }, /package-lock\.json packages/],
  ['runtime version drift', { 'services/analyzer/src/config.ts': `str('ANALYZER_VERSION', '${OLD}');\nstr('USER_AGENT', '${USER_AGENT}');\n` }, /ANALYZER_VERSION/],
  ['README drift', { 'README.md': `Current version: \`${OLD}\`\n` }, /README\.md current version/],
  ['changelog drift', { 'CHANGELOG.md': `## [${OLD}] - 2026-09-01\n` }, /CHANGELOG\.md latest release/],
  ['release notes drift', { [`docs/releases/v${V}.md`]: `# PitchTrace v${OLD}\n` }, /title: expected/],
  ['n8n image change', { 'docker-compose.yml': 'image: docker.n8n.io/n8nio/n8n:2.40.0\n' }, /n8n image must stay/],
  ['User-Agent change', { 'services/analyzer/src/config.ts': `str('ANALYZER_VERSION', '${V}');\nstr('USER_AGENT', 'PitchTraceBot/${V} (+https://github.com/mratsag/pitchtrace)');\n` }, /User-Agent must stay/],
]) {
  test(`detects ${name}`, () => {
    const { problems } = checkVersions(fixture(V, overrides));
    assert.ok(problems.some((p) => pattern.test(p)), problems.join('\n'));
  });
}
