// Release version consistency check.
// The analyzer package.json is the single version authority; every other
// current-version reference must match it. Run: npm run version:check
// Optional: --expect <version|vversion> also pins the authority to a tag value.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const N8N_IMAGE_VERSION = '2.39.10';
export const USER_AGENT = 'PitchTraceBot/0.1 (+https://github.com/mratsag/pitchtrace)';

// Older PitchTrace versions may appear only in historical release records.
const HISTORICAL = [/^CHANGELOG\.md$/, /^docs\/releases\//];
// The checker's own tests hold deliberately wrong fixture values.
const SELF_TESTS = /^tests\/release\//;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'artifacts', 'backups']);
const TEXT_EXT = /\.(md|json|ya?ml|ts|mjs|js|sql|sh|ps1|html|csv|example|txt)$|^\.env\.example$|Dockerfile$|Caddyfile/;

function listFiles(root) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (path.resolve(top) === path.resolve(root)) {
      return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    }
  } catch { /* not a git checkout: walk the tree */ }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(rel); } else out.push(rel);
    }
  };
  walk('');
  return out;
}

export function checkVersions(root, { expect } = {}) {
  const problems = [];
  const read = (rel) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { problems.push(`${rel}: missing`); return null; }
  };
  const same = (label, actual, wanted) => { if (actual !== wanted) problems.push(`${label}: expected ${wanted}, found ${actual ?? 'nothing'}`); };

  const pkg = JSON.parse(read('services/analyzer/package.json') ?? '{}');
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? '')) {
    problems.push(`services/analyzer/package.json: invalid version ${version}`);
    return { version, problems };
  }
  if (expect) same('--expect', version, expect.replace(/^v/, ''));

  const lock = JSON.parse(read('services/analyzer/package-lock.json') ?? '{}');
  same('services/analyzer/package-lock.json version', lock.version, version);
  same('services/analyzer/package-lock.json packages[""].version', lock.packages?.['']?.version, version);

  const configTs = read('services/analyzer/src/config.ts') ?? '';
  same('services/analyzer/src/config.ts ANALYZER_VERSION', configTs.match(/str\('ANALYZER_VERSION', '([^']+)'\)/)?.[1], version);
  const agents = configTs.match(/'PitchTraceBot\/[^']*'/g) ?? [];
  if (agents.length === 0 || agents.some((ua) => ua !== `'${USER_AGENT}'`)) problems.push(`services/analyzer/src/config.ts: User-Agent must stay ${USER_AGENT}`);

  same('README.md current version', (read('README.md') ?? '').match(/^Current version: `([^`]+)`/m)?.[1], version);
  same('.github/ISSUE_TEMPLATE/bug_report.yml placeholder', (read('.github/ISSUE_TEMPLATE/bug_report.yml') ?? '').match(/placeholder: (\S+) \}/)?.[1], version);
  same('CHANGELOG.md latest release', (read('CHANGELOG.md') ?? '').match(/^## \[(?!Unreleased\])([^\]]+)\]/m)?.[1], version);
  const notesPath = `docs/releases/v${version}.md`;
  const notes = read(notesPath);
  if (notes !== null) same(`${notesPath} title`, notes.match(/^# PitchTrace v(\S+)/)?.[1], version);

  const escaped = version.split('-')[0].replaceAll('.', '\\.');
  for (const rel of listFiles(root)) {
    // Lockfiles list dependency versions; the analyzer lockfile is checked above.
    if (!TEXT_EXT.test(path.posix.basename(rel)) || rel.endsWith('package-lock.json') || SELF_TESTS.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (!HISTORICAL.some((re) => re.test(rel))) {
      for (const m of text.matchAll(new RegExp(`\\b${escaped}-[0-9A-Za-z.]*[0-9A-Za-z]`, 'g'))) {
        if (m[0] !== version) problems.push(`${rel}: stale version reference ${m[0]}`);
      }
    }
    for (const m of text.matchAll(/docker\.n8n\.io\/n8nio\/n8n:([^\s'"`]+)/g)) {
      if (m[1] !== N8N_IMAGE_VERSION) problems.push(`${rel}: n8n image must stay ${N8N_IMAGE_VERSION}, found ${m[1]}`);
    }
    if (/PitchTraceBot\/0\.1\.\d/.test(text)) problems.push(`${rel}: User-Agent must not embed the product version`);
  }
  return { version, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--expect');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version, problems } = checkVersions(root, { expect: i > 0 ? process.argv[i + 1] : undefined });
  if (problems.length) {
    console.error(`Version check failed for ${version}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`Version check passed: ${version} (n8n ${N8N_IMAGE_VERSION}, User-Agent unchanged)`);
  }
}
