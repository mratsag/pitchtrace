import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { runAudit } from '../../src/audit/run-audit.js';
import { RULE_VERSION, breakdownSum, computeAndStoreScore } from '../../src/scoring/index.js';
import {
  createCampaign,
  createCompany,
  enqueueAudit,
  ensureSchema,
  getFindingCodes,
  resetData,
} from '../helpers/db.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const KEY = process.env['ANALYZER_API_KEY'] ?? 'test-key';

interface ScoreRow {
  total: number;
  breakdown: Record<string, number>;
  details: Record<string, unknown>;
  rule_version: string;
}

describe('fırsat puanlama', () => {
  let app: FastifyInstance;
  let server: FixtureServer;

  before(async () => {
    await ensureSchema();
    await resetData();
    server = await startFixtureServer();
    app = await buildServer();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await server.close();
    await closePool();
  });

  const auth = { 'x-api-key': KEY };

  async function auditPage(
    page: string,
    options: { serviceFit?: Record<string, number>; pageLimit?: number } = {},
  ): Promise<string> {
    const campaign = await query<{ id: string }>(
      `INSERT INTO pitchtrace.campaigns (name, sector, city, service_fit)
       VALUES ($1,'dis','izmir',$2::jsonb) RETURNING id`,
      [`sc-${Math.random().toString(36).slice(2, 10)}`, JSON.stringify(options.serviceFit ?? {})],
    );
    const companyId = await createCompany(campaign.rows[0]!.id, `${server.origin}/${page}`);
    const auditId = await enqueueAudit(
      companyId,
      `${server.origin}/${page}`,
      options.pageLimit ?? 1,
    );
    await runAudit(auditId);
    return auditId;
  }

  async function scoreOf(auditId: string): Promise<ScoreRow> {
    const result = await query<ScoreRow>(
      'SELECT total, breakdown, details, rule_version FROM pitchtrace.scores WHERE audit_id=$1',
      [auditId],
    );
    const row = result.rows[0];
    assert.ok(row, 'puan kaydı yok');
    return row;
  }

  it('audit tamamlanınca puan otomatik hesaplanır ve kaydedilir', async () => {
    const auditId = await auditPage('f4-clean.html');
    const score = await scoreOf(auditId);

    assert.ok(score.total >= 0 && score.total <= 100);
    assert.equal(score.rule_version, RULE_VERSION);
    assert.equal(breakdownSum(score.breakdown as never), score.total);
  });

  it('breakdown toplamı gerçek audit’te de total’a eşit', async () => {
    for (const page of ['good.html', 'f4-clean.html', 'f4-mobile-issues.html']) {
      const auditId = await auditPage(page);
      const score = await scoreOf(auditId);
      assert.equal(
        breakdownSum(score.breakdown as never),
        score.total,
        `${page}: ${JSON.stringify(score.breakdown)}`,
      );
    }
  });

  it('aynı audit iki kez puanlanınca sonuç değişmez', async () => {
    const auditId = await auditPage('f4-mobile-issues.html');
    const first = await scoreOf(auditId);

    const recomputed = await computeAndStoreScore(auditId);
    const second = await scoreOf(auditId);

    assert.equal(recomputed.total, first.total);
    assert.deepEqual(second.breakdown, first.breakdown);
    assert.deepEqual(second.details, first.details);
  });

  it('kurumsal e-posta yoksa iletişim bileşeni 0 ve toplam eşiğin altında', async () => {
    const auditId = await auditPage('f4-no-contact.html');
    const codes = await getFindingCodes(auditId);
    assert.ok(codes.includes('CONTACT_NO_EMAIL_FOUND'), codes.join(','));

    const score = await scoreOf(auditId);
    assert.equal(score.breakdown['contact'], 0);
    assert.ok(score.total < 70, `varsayılan eşiğin altında olmalı: ${score.total}`);
    assert.equal(score.details['has_contact'], false);
  });

  it('kurumsal e-posta varsa iletişim bileşeni dolar', async () => {
    const auditId = await auditPage('f4-clean.html');
    const codes = await getFindingCodes(auditId);
    assert.ok(codes.includes('CONTACT_ROLE_EMAIL_FOUND'), codes.join(','));

    const score = await scoreOf(auditId);
    assert.equal(score.breakdown['contact'], 15);
    assert.equal(score.breakdown['no_contact_penalty'], 0);
  });

  it('birden çok sayfada tekrarlanan bulgu puanı şişirmez', async () => {
    // dup-* fixture'larının üçünde de aynı MOB_TAP_TARGET_SMALL sorunu var.
    const onePage = await auditPage('dup-home.html', { pageLimit: 1 });
    const multiPage = await auditPage('dup-home.html', { pageLimit: 5 });

    const oneRows = await getFindingCodes(onePage);
    const multiRows = await getFindingCodes(multiPage);
    const tapOnce = oneRows.filter((c) => c === 'MOB_TAP_TARGET_SMALL').length;
    const tapMulti = multiRows.filter((c) => c === 'MOB_TAP_TARGET_SMALL').length;

    assert.equal(tapOnce, 1, 'tek sayfada bir kez görülmeli');
    assert.ok(tapMulti > 1, `birden çok sayfada tekrarlanmalıydı: ${tapMulti}`);

    const oneScore = await scoreOf(onePage);
    const multiScore = await scoreOf(multiPage);
    assert.equal(
      multiScore.breakdown['mobile'],
      oneScore.breakdown['mobile'],
      'aynı mobil sorunu sayfa sayısıyla çarpılmamalı',
    );
  });

  it('kampanya service_fit ağırlıkları puana yansır', async () => {
    // f4-mobile-issues.html kurumsal e-posta içerir; iletişim tavanı devrede değil.
    const withoutFit = await auditPage('f4-mobile-issues.html');
    const withFit = await auditPage('f4-mobile-issues.html', {
      serviceFit: { MOB_TAP_TARGET_SMALL: 10 },
    });

    const a = await scoreOf(withoutFit);
    const b = await scoreOf(withFit);
    assert.equal(a.details['has_contact'], true, 'fixture kurumsal e-posta içermeli');
    assert.equal(a.breakdown['service_fit'], 0);
    assert.equal(b.breakdown['service_fit'], 10);
    assert.equal(b.total, a.total + 10);
  });

  it('iletişim yoksa service_fit puanı da tavanı aşamaz', async () => {
    const auditId = await auditPage('f4-no-contact.html', {
      serviceFit: { CONV_NO_CONTACT_FORM: 20, CONV_NO_TEL_LINK: 20 },
    });
    const score = await scoreOf(auditId);
    assert.equal(score.details['has_contact'], false);
    assert.ok(score.total <= 49, `iletişimsiz tavan aşıldı: ${score.total}`);
    assert.equal(breakdownSum(score.breakdown as never), score.total);
  });

  it('POST /audits/{id}/score puanı yeniden hesaplar', async () => {
    const auditId = await auditPage('f4-mobile-issues.html');

    const res = await app.inject({
      method: 'POST',
      url: `/audits/${auditId}/score`,
      headers: auth,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.rule_version, RULE_VERSION);
    assert.equal(breakdownSum(body.breakdown), body.total);
    assert.ok(Array.isArray(body.details.counted_codes));
  });

  it('GET /audits/{id} puanı birlikte döndürür', async () => {
    const auditId = await auditPage('f4-clean.html');
    const res = await app.inject({ method: 'GET', url: `/audits/${auditId}`, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().score, 'yanıtta puan yok');
    assert.equal(res.json().score.rule_version, RULE_VERSION);
  });

  it('tamamlanmamış audit puanlanamaz', async () => {
    const campaignId = await createCampaign(`nc-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/good.html`);
    const auditId = await enqueueAudit(companyId, `${server.origin}/good.html`, 1);

    const res = await app.inject({
      method: 'POST',
      url: `/audits/${auditId}/score`,
      headers: auth,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'AUDIT_NOT_COMPLETED');
  });

  it('bilinmeyen audit puanlanamaz', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/audits/00000000-0000-4000-8000-000000000000/score',
      headers: auth,
    });
    assert.equal(res.statusCode, 404);
  });

  it('puanlama hatası audit’i düşürmez', async () => {
    // Başarısız audit'te puan kaydı oluşmaz ama audit durumu korunur.
    const campaignId = await createCampaign(`fa-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, 'http://127.0.0.1:9');
    const auditId = await enqueueAudit(companyId, 'http://127.0.0.1:9/', 1);

    await assert.rejects(runAudit(auditId));
    const score = await query('SELECT 1 FROM pitchtrace.scores WHERE audit_id=$1', [auditId]);
    assert.equal(score.rowCount, 0);
  });
});
