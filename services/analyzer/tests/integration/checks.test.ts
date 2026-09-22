import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { renderPage } from '../../src/audit/browser.js';
import { mobileChecks } from '../../src/audit/checks/mobile.js';
import { seoChecks } from '../../src/audit/checks/seo.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('check’ler — yerel fixture sunucusu (ağ erişimi yok)', () => {
  let server: FixtureServer;

  before(async () => {
    server = await startFixtureServer();
  });

  after(async () => {
    await server.close();
  });

  async function codesFor(pageName: string): Promise<string[]> {
    const result = await renderPage({
      entryUrl: `${server.origin}/${pageName}`,
      allowLoopback: true,
    });
    const findings = [
      ...mobileChecks(result.finalUrl, result.observations),
      ...seoChecks(result.finalUrl, result.observations),
    ];
    return findings.map((f) => f.code).sort();
  }

  it('negatif: sağlıklı sayfa hiçbir bulgu üretmez', async () => {
    assert.deepEqual(await codesFor('good.html'), []);
  });

  it('pozitif: viewport meta yoksa MOB_NO_VIEWPORT üretilir', async () => {
    const codes = await codesFor('no-viewport.html');
    assert.ok(codes.includes('MOB_NO_VIEWPORT'), `beklenen kod yok: ${codes.join(',')}`);
  });

  it('pozitif: yatay taşmada MOB_HORIZONTAL_OVERFLOW üretilir', async () => {
    const codes = await codesFor('overflow.html');
    assert.ok(codes.includes('MOB_HORIZONTAL_OVERFLOW'), `beklenen kod yok: ${codes.join(',')}`);
  });

  it('negatif: taşma olmayan sayfada MOB_HORIZONTAL_OVERFLOW üretilmez', async () => {
    const codes = await codesFor('short-title.html');
    assert.ok(!codes.includes('MOB_HORIZONTAL_OVERFLOW'), codes.join(','));
  });

  it('pozitif: kısa başlıkta SEO_MISSING_TITLE üretilir', async () => {
    const codes = await codesFor('short-title.html');
    assert.ok(codes.includes('SEO_MISSING_TITLE'), `beklenen kod yok: ${codes.join(',')}`);
  });

  it('negatif: yeterli uzunluktaki başlıkta SEO_MISSING_TITLE üretilmez', async () => {
    const codes = await codesFor('overflow.html');
    assert.ok(!codes.includes('SEO_MISSING_TITLE'), codes.join(','));
  });

  it('negatif: viewport meta varken MOB_NO_VIEWPORT üretilmez', async () => {
    const codes = await codesFor('overflow.html');
    assert.ok(!codes.includes('MOB_NO_VIEWPORT'), codes.join(','));
  });

  it('bulgularda kanıt ve metrik alanları dolu', async () => {
    const result = await renderPage({
      entryUrl: `${server.origin}/overflow.html`,
      allowLoopback: true,
    });
    const [overflow] = mobileChecks(result.finalUrl, result.observations);
    assert.ok(overflow);
    assert.equal(overflow.code, 'MOB_HORIZONTAL_OVERFLOW');
    assert.equal(overflow.metricUnit, 'px');
    assert.ok((overflow.metricValue ?? 0) > 4);
    assert.equal(overflow.evidence['viewport_width'], 375);
    assert.ok(Array.isArray(overflow.evidence['offending_selectors']));
  });

  it('mobil viewport screenshot üretilir', async () => {
    const result = await renderPage({
      entryUrl: `${server.origin}/good.html`,
      allowLoopback: true,
    });
    assert.ok(result.screenshot.byteLength > 1000, 'screenshot boş görünüyor');
    assert.deepEqual([...result.screenshot.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('redirect ile link-local (metadata) adrese geçiş engellenir', async () => {
    await assert.rejects(
      renderPage({ entryUrl: `${server.origin}/redirect-to-metadata`, allowLoopback: true }),
      (err: Error & { code?: string }) => {
        assert.equal(err.name, 'RenderError');
        assert.equal(err.code, 'PRIVATE_ADDRESS');
        return true;
      },
    );
  });

  it('maksimum redirect sayısı aşılırsa istek durdurulur', async () => {
    await assert.rejects(
      renderPage({ entryUrl: `${server.origin}/loop/0`, allowLoopback: true }),
      (err: Error & { code?: string }) => {
        assert.equal(err.name, 'RenderError');
        assert.ok(
          err.code === 'TOO_MANY_REDIRECTS' || err.code === 'RENDER_CRASH',
          `beklenmeyen kod: ${err.code}`,
        );
        return true;
      },
    );
  });
});
