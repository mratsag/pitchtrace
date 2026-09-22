import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { FINDING_CATALOG, listFindingCodes } from '../../src/findings/catalog.js';
import { findingCodesDocPath } from '../../src/findings/docs-path.js';
import { renderFindingCodesDoc } from '../../src/findings/docs.js';

/**
 * Katalog kilidi: yeni bir kod eklemek bu listeyi güncellemeyi ZORUNLU kılar,
 * böylece testsiz kod eklenmesi fark edilir.
 */
const EXPECTED_CODES = [
  'MOB_NO_VIEWPORT',
  'MOB_HORIZONTAL_OVERFLOW',
  'MOB_TAP_TARGET_SMALL',
  'MOB_FORM_FIELD_OVERFLOW',
  'MOB_TEXT_TOO_SMALL',
  'MOB_FIXED_WIDTH_LAYOUT',
  'TECH_NO_HTTPS',
  'TECH_TLS_EXPIRED',
  'TECH_TLS_EXPIRING_SOON',
  'TECH_MIXED_CONTENT',
  'TECH_DOCUMENT_WRITE',
  'TECH_JQUERY_OUTDATED',
  'TECH_TABLE_LAYOUT',
  'TECH_LEGACY_PLUGIN',
  'PERF_TTFB_SLOW',
  'PERF_LCP_SLOW',
  'PERF_CLS_HIGH',
  'PERF_PAGE_WEIGHT_HIGH',
  'SEO_MISSING_TITLE',
  'SEO_MISSING_DESCRIPTION',
  'SEO_MISSING_H1',
  'CONV_NO_CONTACT_FORM',
  'CONV_NO_TEL_LINK',
  'CONV_NO_WHATSAPP_LINK',
  'CONV_NO_BOOKING_LINK',
  'CONTACT_ROLE_EMAIL_FOUND',
  'CONTACT_NO_EMAIL_FOUND',
  'INF_NO_ONLINE_APPOINTMENT',
];

await test('katalog beklenen kodları içerir', () => {
  assert.deepEqual(listFindingCodes().sort(), [...EXPECTED_CODES].sort());
});

await test('v0.1 dışı bırakılan kodlar katalogda YOKTUR', () => {
  for (const removed of [
    'SEO_NO_HREFLANG',
    'INF_SINGLE_LANGUAGE_ONLY',
    'TECH_STALE_COPYRIGHT',
    'CONV_FORM_NO_ACTION',
    'CONTACT_PERSONAL_EMAIL_SKIPPED',
    'SEO_NO_SITEMAP',
    'TECH_SOFT_404',
  ]) {
    assert.equal(FINDING_CATALOG[removed], undefined, `${removed} katalogda olmamalı`);
  }
});

await test('outreach uygunluğu yalnızca stable kodlara verilir', () => {
  for (const def of Object.values(FINDING_CATALOG)) {
    assert.equal(
      def.outreachEligible,
      def.status === 'stable',
      `${def.code} outreach uygunluğu durumla tutarsız`,
    );
  }
});

await test('INF kodları çıkarım ve site kapsamlıdır', () => {
  for (const def of Object.values(FINDING_CATALOG)) {
    if (!def.code.startsWith('INF_')) continue;
    assert.equal(def.confidence, 'inferred', `${def.code} confidence yanlış`);
    assert.equal(def.scope, 'site', `${def.code} kapsamı yanlış`);
  }
});

await test('yokluk bulguları (NO_/MISSING_) doğru kapsamdadır', () => {
  // "X yok" bulguları site genelinde değerlendirilmeli; SEO eksikleri ise
  // sayfa başına anlamlıdır.
  for (const def of Object.values(FINDING_CATALOG)) {
    if (def.category === 'CONV' || def.category === 'CONTACT') {
      assert.equal(def.scope, 'site', `${def.code} site kapsamlı olmalı`);
    }
    if (def.category === 'SEO' || def.category === 'MOBILE') {
      assert.equal(def.scope, 'page', `${def.code} sayfa kapsamlı olmalı`);
    }
    // PERF ölçümü yalnızca ana sayfada yapılır; bulgular site kapsamlıdır.
    if (def.category === 'PERF') {
      assert.equal(def.scope, 'site', `${def.code} site kapsamlı olmalı`);
    }
  }
});

await test('ölçümü doğrulanamayan kodlar experimental işaretlidir', () => {
  // CLS bu çalışma ortamında ölçülemiyor (bkz. docs/security-notes.md).
  assert.equal(FINDING_CATALOG['PERF_CLS_HIGH']?.status, 'experimental');
  assert.equal(FINDING_CATALOG['PERF_CLS_HIGH']?.outreachEligible, false);
  // Ölçümü doğrulanmış PERF kodları stable kalmalı.
  for (const code of ['PERF_TTFB_SLOW', 'PERF_LCP_SLOW', 'PERF_PAGE_WEIGHT_HIGH']) {
    assert.equal(FINDING_CATALOG[code]?.status, 'stable', code);
  }
});

await test('kapatılmış Mobile-Friendly Test API’sine hiçbir referans yok', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const srcRoot = fileURLToPath(new URL('../../../src', import.meta.url));
  const banned = /searchconsole\.googleapis\.com|mobile-?friendly-?test|runMobileFriendlyTest/i;

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
    return files;
  }

  for (const file of await walk(srcRoot)) {
    const body = await readFile(file, 'utf8');
    assert.ok(!banned.test(body), `${file} kapatılmış API'ye referans veriyor`);
  }
});

await test('docs/finding-codes.md katalogla güncel', async () => {
  const expected = renderFindingCodesDoc();
  let actual: string;
  try {
    actual = await fs.readFile(findingCodesDocPath(), 'utf8');
  } catch {
    assert.fail('docs/finding-codes.md yok — `npm run docs:findings` çalıştırın');
  }
  assert.equal(
    actual.replace(/\r\n/g, '\n'),
    expected,
    'docs/finding-codes.md güncel değil — `npm run docs:findings` çalıştırın',
  );
});
