import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { config } from '../../src/config.js';
import { getFindingDefinition } from '../../src/findings/catalog.js';
import { closePool, query } from '../../src/db/pool.js';
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

describe('audit akışı — uçtan uca', () => {
  let allowServer: FixtureServer;

  before(async () => {
    await ensureSchema();
    await resetData();
    allowServer = await startFixtureServer();
  });

  after(async () => {
    await allowServer.close();
    await closePool();
  });

  async function prepare(server: FixtureServer, page: string): Promise<string> {
    const campaignId = await createCampaign(`c-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/${page}`);
    return enqueueAudit(companyId, `${server.origin}/${page}`);
  }

  it('güvenli fixture sayfası analiz edilir ve bulgular kaydedilir', async () => {
    const auditId = await prepare(allowServer, 'overflow.html');
    await runAudit(auditId);

    const audit = await getAudit(auditId);
    assert.equal(audit.status, 'completed');
    assert.equal(audit.error_code, null);
    assert.equal(audit.pages_fetched, 1);
    assert.equal(audit.robots_allowed, true);
    assert.ok(audit.final_url?.endsWith('/overflow.html'));

    const codes = await getFindingCodes(auditId);
    assert.ok(codes.includes('MOB_HORIZONTAL_OVERFLOW'), codes.join(','));

    const rows = await query<{
      code: string;
      audit_id: string;
      company_id: string;
      url: string;
      evidence: Record<string, unknown>;
      observed_at: Date;
      artifact_id: string | null;
    }>(
      `SELECT code, audit_id, company_id, url, evidence, observed_at, artifact_id
         FROM pitchtrace.findings WHERE audit_id=$1`,
      [auditId],
    );
    assert.ok((rows.rowCount ?? 0) > 0, 'hiç bulgu kaydedilmemiş');
    for (const row of rows.rows) {
      assert.equal(row.audit_id, auditId);
      assert.ok(row.company_id, 'company_id boş');
      assert.ok(row.url.startsWith(allowServer.origin), 'url kaydedilmemiş');
      assert.ok(Object.keys(row.evidence).length > 0, 'evidence boş');
      assert.ok(row.observed_at instanceof Date, 'observed_at boş');
      // Screenshot yalnızca sayfa kapsamlı bulgulara bağlanır; site kapsamlı
      // bulgular tek bir sayfaya ait olmadığı için artifact taşımaz.
      if (getFindingDefinition(row.code).scope === 'page') {
        assert.ok(row.artifact_id, `${row.code} için screenshot bağlanmamış`);
      } else {
        assert.equal(row.artifact_id, null, `${row.code} site kapsamlı olmalı`);
      }
    }
  });

  it('screenshot dosyası ARTIFACT_ROOT altına yazılır', async () => {
    const auditId = await prepare(allowServer, 'good.html');
    await runAudit(auditId);

    const artifact = await query<{ rel_path: string; bytes: number; mime: string }>(
      'SELECT rel_path, bytes, mime FROM pitchtrace.artifacts WHERE audit_id=$1',
      [auditId],
    );
    const row = artifact.rows[0];
    assert.ok(row, 'artifact kaydı yok');
    assert.equal(row.mime, 'image/png');
    assert.ok(!path.isAbsolute(row.rel_path), 'rel_path mutlak olmamalı');

    const stat = await fs.stat(path.join(config.artifactRoot, row.rel_path));
    assert.equal(stat.size, row.bytes);
  });

  it('sağlıklı sayfada sayfa kapsamlı bulgu üretilmez', async () => {
    const auditId = await prepare(allowServer, 'good.html');
    await runAudit(auditId);
    assert.equal((await getAudit(auditId)).status, 'completed');

    const codes = await getFindingCodes(auditId);
    const pageScoped = codes.filter((c) => getFindingDefinition(c).scope === 'page');
    assert.deepEqual(pageScoped, [], `beklenmeyen sayfa bulgusu: ${pageScoped.join(',')}`);

    // Fixture http üzerinden sunulur ve hiçbir iletişim unsuru taşımaz;
    // site kapsamlı yokluk bulguları bu yüzden BEKLENEN sonuçtur.
    const siteScoped = codes.filter((c) => getFindingDefinition(c).scope === 'site').sort();
    assert.deepEqual(siteScoped, [
      'CONTACT_NO_EMAIL_FOUND',
      'CONV_NO_BOOKING_LINK',
      'CONV_NO_CONTACT_FORM',
      'CONV_NO_TEL_LINK',
      'CONV_NO_WHATSAPP_LINK',
      'INF_NO_ONLINE_APPOINTMENT',
      'TECH_NO_HTTPS',
    ]);
  });

  it('robots.txt Disallow: / iken hiçbir sayfa açılmaz', async () => {
    const denyServer = await startFixtureServer({ robots: 'User-agent: *\nDisallow: /\n' });
    try {
      const auditId = await prepare(denyServer, 'good.html');
      await assert.rejects(runAudit(auditId), (err: Error & { code?: string }) => {
        assert.equal(err.code, 'ROBOTS_DISALLOWED');
        return true;
      });

      const audit = await getAudit(auditId);
      assert.equal(audit.status, 'failed');
      assert.equal(audit.error_code, 'ROBOTS_DISALLOWED');
      assert.equal(audit.robots_allowed, false);
      assert.equal(audit.pages_fetched, 0);
      assert.deepEqual(
        denyServer.pageRequests(),
        [],
        `robots.txt dışında istek yapılmamalıydı: ${denyServer.requests.join(',')}`,
      );
    } finally {
      await denyServer.close();
    }
  });

  it('redirect ile link-local (metadata) adrese geçiş audit’i durdurur', async () => {
    const auditId = await prepare(allowServer, 'redirect-to-metadata');
    await assert.rejects(runAudit(auditId), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'PRIVATE_ADDRESS');
      return true;
    });
    const audit = await getAudit(auditId);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.error_code, 'PRIVATE_ADDRESS');
  });

  it('private IP hedefi doğrudan reddedilir', async () => {
    const campaignId = await createCampaign(`p-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, 'http://169.254.169.254/');
    const auditId = await enqueueAudit(companyId, 'http://169.254.169.254/latest/meta-data/');

    await assert.rejects(runAudit(auditId), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'PRIVATE_ADDRESS');
      return true;
    });
    assert.equal((await getAudit(auditId)).error_code, 'PRIVATE_ADDRESS');
  });

  it('ulaşılamayan hedefte audit kontrollü biçimde failed olur', async () => {
    const campaignId = await createCampaign(`d-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, 'http://127.0.0.1:9');
    const auditId = await enqueueAudit(companyId, 'http://127.0.0.1:9/');

    await assert.rejects(runAudit(auditId));
    const audit = await getAudit(auditId);
    assert.equal(audit.status, 'failed');
    assert.ok(audit.error_code, 'error_code yazılmamış');
  });

  it('redirect sonucu submitted_url’i ezmez', async () => {
    const campaignId = await createCampaign(`r-${Math.random().toString(36).slice(2, 10)}`);
    const submitted = `${allowServer.origin}/overflow.html`;
    const companyId = await createCompany(campaignId, submitted);
    const auditId = await enqueueAudit(companyId, submitted);
    await runAudit(auditId);

    const company = await query<{ submitted_url: string; resolved_url: string | null }>(
      'SELECT submitted_url, resolved_url FROM pitchtrace.companies WHERE id=$1',
      [companyId],
    );
    assert.equal(company.rows[0]!.submitted_url, submitted);
    assert.ok(company.rows[0]!.resolved_url);
  });
});
