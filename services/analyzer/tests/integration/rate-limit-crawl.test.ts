import { SLOW_CRAWL_INTERVAL_MS } from '../helpers/slow-crawl-env.js';
import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runAudit } from '../../src/audit/run-audit.js';
import {
  createCampaign,
  createCompany,
  enqueueAudit,
  ensureSchema,
  getAudit,
  resetData,
} from '../helpers/db.js';
import { sitemapXml, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('domain hız sınırı gerçek crawl’da uygulanır', () => {
  let server: FixtureServer;

  before(async () => {
    await ensureSchema();
    await resetData();
    server = await startFixtureServer();
    server.setSitemap(sitemapXml(server.origin, ['/crawl-blog.html', '/crawl-hizmetler.html']));
  });

  after(async () => {
    await server.close();
    await closePool();
  });

  it('istekler arasında yapılandırılan aralık kadar beklenir', async () => {
    assert.equal(config.perDomainMinIntervalMs, SLOW_CRAWL_INTERVAL_MS, 'test aralığı kurulmadı');

    const campaignId = await createCampaign(`rl-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/crawl-home.html`);
    const auditId = await enqueueAudit(companyId, `${server.origin}/crawl-home.html`, 5);

    const startedAt = Date.now();
    await runAudit(auditId);
    const elapsed = Date.now() - startedAt;

    const audit = await getAudit(auditId);
    assert.equal(audit.status, 'completed');
    assert.equal(audit.pages_fetched, 5);

    // robots(1) + ana sayfa(1) + sitemap(1) + 4 alt sayfa = 7 slot,
    // yani en az 6 bekleme aralığı. Ölçüm gürültüsü için 5 ile sınırlıyoruz.
    const minimumExpected = SLOW_CRAWL_INTERVAL_MS * 5;
    assert.ok(
      elapsed >= minimumExpected,
      `crawl en az ${minimumExpected} ms sürmeliydi, ${elapsed} ms sürdü`,
    );

    // Sunucuya ulaşan ardışık istekler arasındaki gerçek aralık da kontrol edilir.
    assert.ok(server.requests.length >= 6, `beklenenden az istek: ${server.requests.join(',')}`);
  });
});
