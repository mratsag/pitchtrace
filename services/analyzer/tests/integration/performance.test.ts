import { SCALED } from '../helpers/scaled-perf-env.js';
import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { config } from '../../src/config.js';
import { AuditSession } from '../../src/audit/browser.js';
import { performanceChecks } from '../../src/audit/checks/performance.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('performans ölçümü (gerçek tarayıcı, ölçeklenmiş eşikler)', () => {
  let server: FixtureServer;
  let session: AuditSession;

  before(async () => {
    server = await startFixtureServer();
    session = await AuditSession.open({ allowLoopback: true });
  });

  after(async () => {
    await session.close();
    await server.close();
  });

  async function measure(pathname: string): Promise<{
    codes: string[];
    metrics: Awaited<ReturnType<AuditSession['render']>>['metrics'];
  }> {
    const rendered = await session.render(`${server.origin}${pathname}`, {
      measurePerformance: true,
    });
    const findings = performanceChecks({ url: rendered.finalUrl, metrics: rendered.metrics });
    return { codes: findings.map((f) => f.code).sort(), metrics: rendered.metrics };
  }

  it('ölçeklenmiş eşikler yüklendi', () => {
    assert.equal(config.perfLcpSlowMs, SCALED.lcpSlowMs);
    assert.equal(config.perfTtfbSlowMs, SCALED.ttfbSlowMs);
  });

  it('negatif: hızlı sayfa hiçbir PERF bulgusu üretmez', async () => {
    const { codes, metrics } = await measure('/good.html');
    assert.deepEqual(codes, [], JSON.stringify(metrics));
    assert.ok(metrics.lcpMs !== null, 'LCP ölçülemedi');
    assert.ok(metrics.ttfbMs !== null, 'TTFB ölçülemedi');
  });

  it('pozitif: geç boyanan ana içerik PERF_LCP_SLOW üretir', async () => {
    const { codes, metrics } = await measure('/perf-slow-lcp.html?delay=1000');
    assert.ok(codes.includes('PERF_LCP_SLOW'), `${codes.join(',')} | ${JSON.stringify(metrics)}`);
    assert.ok((metrics.lcpMs ?? 0) >= 900, `LCP beklenenden küçük: ${metrics.lcpMs}`);
  });

  it('pozitif: geciken sunucu yanıtı PERF_TTFB_SLOW üretir', async () => {
    const { codes, metrics } = await measure('/delay/600/good.html');
    assert.ok(codes.includes('PERF_TTFB_SLOW'), `${codes.join(',')} | ${JSON.stringify(metrics)}`);
    assert.ok((metrics.ttfbMs ?? 0) >= 500, `TTFB beklenenden küçük: ${metrics.ttfbMs}`);
  });

  /**
   * BİLİNEN SINIR: Chromium bu çalışma ortamında layout-shift girdisi
   * raporlamıyor (headless shell ve tam binary, Windows ve Linux container —
   * hepsinde 0). Aynı PerformanceObserver üzerinden LCP çalıştığı için kurulum
   * doğrudur. Bu yüzden PERF_CLS_HIGH `experimental` işaretlidir ve outreach
   * taslağında iddia olarak kullanılamaz.
   *
   * Bu test mevcut davranışı sabitler: ortam CLS raporlamaya başlarsa test
   * kırılır ve kodu `stable`a çekme kararı bilinçli olarak alınır.
   */
  it('bilinen sınır: belirgin bir kayma bile CLS olarak ölçülemiyor', async () => {
    const { metrics } = await measure('/perf-shift.html?delay=300');
    assert.equal(
      metrics.cls,
      0,
      `CLS artık ölçülebiliyor (${metrics.cls}) — PERF_CLS_HIGH stable yapılabilir mi değerlendirin`,
    );
  });

  it('PERF_CLS_HIGH outreach’te kullanılamaz (experimental)', async () => {
    const { getFindingDefinition } = await import('../../src/findings/catalog.js');
    const def = getFindingDefinition('PERF_CLS_HIGH');
    assert.equal(def.status, 'experimental');
    assert.equal(def.outreachEligible, false);
  });

  it('pozitif: büyük kaynak PERF_PAGE_WEIGHT_HIGH üretir', async () => {
    const { codes, metrics } = await measure('/perf-heavy.html?bytes=1500000');
    assert.ok(
      codes.includes('PERF_PAGE_WEIGHT_HIGH'),
      `${codes.join(',')} | ${JSON.stringify(metrics)}`,
    );
    assert.ok((metrics.transferBytes ?? 0) >= 1_500_000);
  });

  it('ölçüm istenmezse metrikler toplanmaz (maliyet kontrolü)', async () => {
    const rendered = await session.render(`${server.origin}/good.html`);
    assert.equal(rendered.metrics.lcpMs, null);
    assert.equal(rendered.metrics.ttfbMs, null);
    assert.deepEqual(performanceChecks({ url: rendered.finalUrl, metrics: rendered.metrics }), []);
  });
});
