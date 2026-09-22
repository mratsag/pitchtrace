import '../helpers/default-perf-env.js';
import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PERF_DEFAULTS, config } from '../../src/config.js';
import { closePool, query } from '../../src/db/pool.js';
import { AuditSession } from '../../src/audit/browser.js';
import { performanceChecks } from '../../src/audit/checks/performance.js';
import { runAudit } from '../../src/audit/run-audit.js';
import {
  createCampaign,
  createCompany,
  enqueueAudit,
  ensureSchema,
  getAudit,
  getFindingCodes,
  resetData,
} from '../helpers/db.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Bu dosya eşikleri ÖLÇEKLEMEZ: üretim varsayılanlarıyla (LCP 4000 ms) gerçek
 * bir yavaş sayfa ölçülür. `performance.test.ts` ise ölçeklenmiş eşiklerle
 * TTFB / sayfa ağırlığı hattını doğrular.
 */
describe('performans — üretim varsayılan eşikleriyle', () => {
  let server: FixtureServer;

  before(async () => {
    await ensureSchema();
    await resetData();
    server = await startFixtureServer();
  });

  after(async () => {
    await server.close();
    await closePool();
  });

  it('üretim eşikleri yüklü', () => {
    assert.equal(config.perfLcpSlowMs, PERF_DEFAULTS.lcpSlowMs);
    assert.equal(config.perfTtfbSlowMs, PERF_DEFAULTS.ttfbSlowMs);
  });

  it('pozitif: 4,5 saniyede boyanan içerik varsayılan eşikte PERF_LCP_SLOW üretir', async () => {
    const session = await AuditSession.open({ allowLoopback: true });
    try {
      const rendered = await session.render(`${server.origin}/perf-slow-lcp.html?delay=4500`, {
        measurePerformance: true,
      });
      const codes = performanceChecks({
        url: rendered.finalUrl,
        metrics: rendered.metrics,
      }).map((f) => f.code);

      assert.ok(
        (rendered.metrics.lcpMs ?? 0) > PERF_DEFAULTS.lcpSlowMs,
        `LCP ölçümü beklenenden küçük: ${rendered.metrics.lcpMs}`,
      );
      assert.ok(codes.includes('PERF_LCP_SLOW'), codes.join(','));
    } finally {
      await session.close();
    }
  });

  it('negatif: hızlı sayfa varsayılan eşiklerde PERF bulgusu üretmez', async () => {
    const session = await AuditSession.open({ allowLoopback: true });
    try {
      const rendered = await session.render(`${server.origin}/good.html`, {
        measurePerformance: true,
      });
      const codes = performanceChecks({ url: rendered.finalUrl, metrics: rendered.metrics });
      assert.deepEqual(codes, [], JSON.stringify(rendered.metrics));
    } finally {
      await session.close();
    }
  });

  it('PSI anahtarı yokken audit sorunsuz tamamlanır', async () => {
    assert.equal(config.psiApiKey, '', 'testlerde PSI anahtarı tanımlı olmamalı');

    const campaignId = await createCampaign(`pd-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/good.html`);
    const auditId = await enqueueAudit(companyId, `${server.origin}/good.html`, 1);
    await runAudit(auditId);

    assert.equal((await getAudit(auditId)).status, 'completed');

    // PSI verisi hiçbir kanıta yazılmamış olmalı.
    const withPsi = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pitchtrace.findings
        WHERE audit_id=$1 AND evidence ? 'psi'`,
      [auditId],
    );
    assert.equal(Number(withPsi.rows[0]!.count), 0);
  });

  it('performans ölçümü yalnızca ana sayfada yapılır', async () => {
    const campaignId = await createCampaign(`pm-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/crawl-home.html`);
    const auditId = await enqueueAudit(companyId, `${server.origin}/crawl-home.html`, 5);
    await runAudit(auditId);

    const codes = await getFindingCodes(auditId);
    const perf = codes.filter((c) => c.startsWith('PERF_'));
    // Hızlı fixture olduğu için PERF bulgusu beklenmez; önemli olan çoğalmaması.
    assert.equal(new Set(perf).size, perf.length, 'PERF bulgusu birden fazla kez yazılmış');
  });
});
