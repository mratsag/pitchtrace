import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AuditSession } from '../../src/audit/browser.js';
import { mobileChecks } from '../../src/audit/checks/mobile.js';
import { seoChecks } from '../../src/audit/checks/seo.js';
import { technicalChecks } from '../../src/audit/checks/technical.js';
import type { RawFinding } from '../../src/findings/catalog.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('F4 sayfa kapsamlı check’ler (gerçek tarayıcı, yerel fixture)', () => {
  let server: FixtureServer;
  let session: AuditSession;
  const cache = new Map<string, RawFinding[]>();

  before(async () => {
    server = await startFixtureServer();
    session = await AuditSession.open({ allowLoopback: true });
  });

  after(async () => {
    await session.close();
    await server.close();
  });

  async function findingsFor(page: string): Promise<RawFinding[]> {
    const cached = cache.get(page);
    if (cached) return cached;
    const rendered = await session.render(`${server.origin}/${page}`);
    const findings = [
      ...mobileChecks(rendered.finalUrl, rendered.observations),
      ...seoChecks(rendered.finalUrl, rendered.observations),
      ...technicalChecks({
        url: rendered.finalUrl,
        observations: rendered.observations,
        subresourceUrls: rendered.subresourceUrls,
      }),
    ];
    cache.set(page, findings);
    return findings;
  }

  async function codesFor(page: string): Promise<string[]> {
    return (await findingsFor(page)).map((f) => f.code).sort();
  }

  it('negatif: temiz sayfa sayfa-kapsamlı hiçbir bulgu üretmez', async () => {
    assert.deepEqual(await codesFor('f4-clean.html'), []);
  });

  // ── MOBILE ──────────────────────────────────────────────────────────────

  it('pozitif/negatif: MOB_TAP_TARGET_SMALL', async () => {
    const codes = await codesFor('f4-mobile-issues.html');
    assert.ok(codes.includes('MOB_TAP_TARGET_SMALL'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('MOB_TAP_TARGET_SMALL'));
  });

  it('pozitif/negatif: MOB_FORM_FIELD_OVERFLOW', async () => {
    const codes = await codesFor('f4-mobile-issues.html');
    assert.ok(codes.includes('MOB_FORM_FIELD_OVERFLOW'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('MOB_FORM_FIELD_OVERFLOW'));
  });

  it('pozitif/negatif: MOB_TEXT_TOO_SMALL', async () => {
    const codes = await codesFor('f4-mobile-issues.html');
    assert.ok(codes.includes('MOB_TEXT_TOO_SMALL'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('MOB_TEXT_TOO_SMALL'));
  });

  it('pozitif/negatif: MOB_FIXED_WIDTH_LAYOUT', async () => {
    const codes = await codesFor('f4-mobile-issues.html');
    assert.ok(codes.includes('MOB_FIXED_WIDTH_LAYOUT'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('MOB_FIXED_WIDTH_LAYOUT'));
  });

  // ── SEO ─────────────────────────────────────────────────────────────────

  it('pozitif/negatif: SEO_MISSING_DESCRIPTION', async () => {
    const codes = await codesFor('f4-seo-issues.html');
    assert.ok(codes.includes('SEO_MISSING_DESCRIPTION'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('SEO_MISSING_DESCRIPTION'));
  });

  it('pozitif/negatif: SEO_MISSING_H1', async () => {
    const codes = await codesFor('f4-seo-issues.html');
    assert.ok(codes.includes('SEO_MISSING_H1'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('SEO_MISSING_H1'));
  });

  it('negatif: yeterli başlıkta SEO_MISSING_TITLE üretilmez', async () => {
    assert.ok(!(await codesFor('f4-seo-issues.html')).includes('SEO_MISSING_TITLE'));
  });

  // ── TECH ────────────────────────────────────────────────────────────────

  it('pozitif/negatif: TECH_DOCUMENT_WRITE', async () => {
    const codes = await codesFor('f4-tech-issues.html');
    assert.ok(codes.includes('TECH_DOCUMENT_WRITE'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('TECH_DOCUMENT_WRITE'));
  });

  it('pozitif/negatif: TECH_JQUERY_OUTDATED', async () => {
    const codes = await codesFor('f4-tech-issues.html');
    assert.ok(codes.includes('TECH_JQUERY_OUTDATED'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('TECH_JQUERY_OUTDATED'));

    const finding = (await findingsFor('f4-tech-issues.html')).find(
      (f) => f.code === 'TECH_JQUERY_OUTDATED',
    );
    assert.equal(finding?.evidence['version'], '1.12.4');
    assert.equal(finding?.metricValue, 1);
  });

  it('pozitif/negatif: TECH_TABLE_LAYOUT', async () => {
    const codes = await codesFor('f4-tech-issues.html');
    assert.ok(codes.includes('TECH_TABLE_LAYOUT'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('TECH_TABLE_LAYOUT'));
  });

  it('pozitif/negatif: TECH_LEGACY_PLUGIN', async () => {
    const codes = await codesFor('f4-tech-issues.html');
    assert.ok(codes.includes('TECH_LEGACY_PLUGIN'), codes.join(','));
    assert.ok(!(await codesFor('f4-clean.html')).includes('TECH_LEGACY_PLUGIN'));
  });

  it('negatif: http sayfada TECH_MIXED_CONTENT üretilmez', async () => {
    // Mixed content yalnızca https sayfalar için anlamlıdır; fixture http'dir.
    for (const page of ['f4-clean.html', 'f4-tech-issues.html']) {
      assert.ok(!(await codesFor(page)).includes('TECH_MIXED_CONTENT'), page);
    }
  });

  // ── Kanıt alanları ──────────────────────────────────────────────────────

  it('her bulguda kanıt dolu ve metrikler tutarlı', async () => {
    const findings = await findingsFor('f4-mobile-issues.html');
    assert.ok(findings.length > 0);
    for (const finding of findings) {
      assert.ok(Object.keys(finding.evidence).length > 0, `${finding.code} kanıtsız`);
      assert.ok(finding.url.startsWith(server.origin), `${finding.code} url eksik`);
      if (finding.metricValue !== undefined) {
        assert.ok(Number.isFinite(finding.metricValue), `${finding.code} metrik sayı değil`);
        assert.ok(finding.metricUnit, `${finding.code} metrik birimi yok`);
      }
    }
  });
});
