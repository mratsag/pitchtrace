import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closePool, query } from '../../src/db/pool.js';
import { getFindingDefinition } from '../../src/findings/catalog.js';
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

describe('5 sayfalık crawler', () => {
  let server: FixtureServer;

  before(async () => {
    await ensureSchema();
    await resetData();
    server = await startFixtureServer();
    server.setSitemap(
      sitemapXml(server.origin, [
        '/crawl-blog.html',
        '/crawl-hizmetler.html',
        '/sepet.html',
        '/login.html',
        '/crawl-home.html',
      ]),
    );
  });

  after(async () => {
    await server.close();
    await closePool();
  });

  async function crawl(pageLimit: number, target = '/crawl-home.html'): Promise<string> {
    const campaignId = await createCampaign(`cr-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}${target}`);
    const auditId = await enqueueAudit(companyId, `${server.origin}${target}`, pageLimit);
    await runAudit(auditId);
    return auditId;
  }

  async function pagesOf(auditId: string): Promise<Array<{ url: string; role: string }>> {
    const result = await query<{ url: string; role: string }>(
      'SELECT url, role FROM pitchtrace.audit_pages WHERE audit_id=$1 AND error IS NULL ORDER BY role',
      [auditId],
    );
    return result.rows;
  }

  it('ana sayfa, iletişim, hakkımızda ve sitemap’ten iki sayfa taranır', async () => {
    const auditId = await crawl(5);
    const audit = await getAudit(auditId);

    assert.equal(audit.status, 'completed');
    assert.equal(audit.pages_fetched, 5);

    const pages = await pagesOf(auditId);
    assert.equal(pages.length, 5);

    const roles = pages.map((p) => p.role).sort();
    assert.deepEqual(roles, ['about', 'contact', 'home', 'sitemap_pick', 'sitemap_pick']);

    const paths = pages.map((p) => new URL(p.url).pathname).sort();
    assert.deepEqual(paths, [
      '/crawl-about.html',
      '/crawl-blog.html',
      '/crawl-contact.html',
      '/crawl-hizmetler.html',
      '/crawl-home.html',
    ]);
  });

  it('login ve sepet sayfaları sitemap’te olsa da hiç istenmez', async () => {
    const before = server.requests.length;
    await crawl(5);
    const during = server.requests.slice(before);

    assert.ok(!during.includes('/login.html'), `login istendi: ${during.join(',')}`);
    assert.ok(!during.includes('/sepet.html'), `sepet istendi: ${during.join(',')}`);
  });

  it('page_limit tavanı veritabanı kısıtıyla da korunur', async () => {
    const campaignId = await createCampaign(`cl-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/crawl-home.html`);

    // 5'ten büyük bir page_limit audits tablosuna hiç yazılamaz.
    await assert.rejects(
      enqueueAudit(companyId, `${server.origin}/crawl-home.html`, 6),
      /audits_page_limit_check/,
    );
  });

  it('kullanıcı limiti düşürebilir: page_limit=2 iki sayfa tarar', async () => {
    const auditId = await crawl(2);
    const audit = await getAudit(auditId);
    assert.equal(audit.pages_fetched, 2);

    const roles = (await pagesOf(auditId)).map((p) => p.role).sort();
    assert.deepEqual(roles, ['contact', 'home']);
  });

  it('site kapsamlı bulgular bir kez, sayfa kapsamlı bulgular sayfa başına üretilir', async () => {
    const auditId = await crawl(5, '/crawl-home.html');
    const findings = await query<{ code: string; url: string }>(
      'SELECT code, url FROM pitchtrace.findings WHERE audit_id=$1',
      [auditId],
    );

    const site = findings.rows.filter((f) => getFindingDefinition(f.code).scope === 'site');
    const siteUrls = new Set(site.map((f) => f.url));
    assert.equal(siteUrls.size, 1, 'site bulguları tek adrese bağlanmalı');
    assert.equal(
      new Set(site.map((f) => f.code)).size,
      site.length,
      'site bulgusu birden fazla kez yazılmış',
    );

    // crawl-home.html küçük dokunma hedefleri içerir; yalnızca o sayfada beklenir.
    const tapTargets = findings.rows.filter((f) => f.code === 'MOB_TAP_TARGET_SMALL');
    assert.equal(tapTargets.length, 1);
    assert.ok(tapTargets[0]!.url.endsWith('/crawl-home.html'));

    const pages = await pagesOf(auditId);
    assert.equal(new Set(pages.map((p) => p.url)).size, pages.length, 'aynı URL iki kez taranmış');
  });

  it('robots ile engellenen alt sayfa taranmaz, audit yine tamamlanır', async () => {
    const denyServer = await startFixtureServer({
      robots: 'User-agent: *\nDisallow: /crawl-about.html\n',
    });
    denyServer.setSitemap(sitemapXml(denyServer.origin, ['/crawl-blog.html']));
    try {
      const campaignId = await createCampaign(`rb-${Math.random().toString(36).slice(2, 10)}`);
      const companyId = await createCompany(campaignId, `${denyServer.origin}/crawl-home.html`);
      const auditId = await enqueueAudit(companyId, `${denyServer.origin}/crawl-home.html`, 5);
      await runAudit(auditId);

      assert.equal((await getAudit(auditId)).status, 'completed');
      const paths = (await pagesOf(auditId)).map((p) => new URL(p.url).pathname);
      assert.ok(!paths.includes('/crawl-about.html'), paths.join(','));
      assert.ok(!denyServer.requests.includes('/crawl-about.html'), 'engelli sayfa istendi');
    } finally {
      await denyServer.close();
    }
  });

  it('sitemap yoksa audit ana sayfa ve bağlantılarla devam eder', async () => {
    const noSitemap = await startFixtureServer();
    try {
      const campaignId = await createCampaign(`ns-${Math.random().toString(36).slice(2, 10)}`);
      const companyId = await createCompany(campaignId, `${noSitemap.origin}/crawl-home.html`);
      const auditId = await enqueueAudit(companyId, `${noSitemap.origin}/crawl-home.html`, 5);
      await runAudit(auditId);

      assert.equal((await getAudit(auditId)).status, 'completed');
      const roles = (await pagesOf(auditId)).map((p) => p.role).sort();
      assert.deepEqual(roles, ['about', 'contact', 'home']);
    } finally {
      await noSitemap.close();
    }
  });
});
