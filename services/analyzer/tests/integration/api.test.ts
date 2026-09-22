import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PAGE_LIMIT_CEILING } from '../../src/config.js';
import { closePool, query } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { ensureSchema, resetData } from '../helpers/db.js';

const KEY = process.env['ANALYZER_API_KEY'] ?? 'test-key';

describe('HTTP API', () => {
  let app: FastifyInstance;

  before(async () => {
    await ensureSchema();
    await resetData();
    app = await buildServer();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await closePool();
  });

  const auth = { 'x-api-key': KEY };

  async function createCampaign(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: auth,
      payload: { name: 'api-test', sector: 'dis', city: 'izmir' },
    });
    assert.equal(res.statusCode, 201);
    return res.json().id as string;
  }

  it('healthz kimlik doğrulaması istemez', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().db, 'up');
  });

  it('API anahtarı olmadan 401 döner', async () => {
    const res = await app.inject({ method: 'POST', url: '/campaigns', payload: {} });
    assert.equal(res.statusCode, 401);
  });

  it('kampanya ve firma oluşturulur, aynı domain ikinci kez eklenmez', async () => {
    const campaignId = await createCampaign();

    const first = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/companies`,
      headers: auth,
      payload: { name: 'Ornek', website: 'https://WWW.Ornek-Firma.test/iletisim' },
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().normalized_domain, 'ornek-firma.test');
    assert.equal(first.json().submitted_url, 'https://WWW.Ornek-Firma.test/iletisim');

    const duplicate = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/companies`,
      headers: auth,
      payload: { name: 'Ornek 2', website: 'http://ornek-firma.test' },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, 'DUPLICATE_DOMAIN');
  });

  it('geçersiz website 422 döner', async () => {
    const campaignId = await createCampaign();
    const res = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/companies`,
      headers: auth,
      payload: { name: 'Kotu', website: 'ftp://ornek.test' },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, 'INVALID_WEBSITE');
  });

  it('page_limit tavanı API seviyesinde kırpılır', async () => {
    const campaignId = await createCampaign();
    const company = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/companies`,
      headers: auth,
      payload: { name: 'Limit', website: 'https://limit-test.test' },
    });
    const companyId = company.json().company_id as string;

    const res = await app.inject({
      method: 'POST',
      url: '/audits',
      headers: auth,
      payload: { company_id: companyId, page_limit: 99 },
    });
    assert.equal(res.statusCode, 202);

    const stored = await query<{ page_limit: number }>(
      'SELECT page_limit FROM pitchtrace.audits WHERE id=$1',
      [res.json().audit_id],
    );
    assert.equal(stored.rows[0]!.page_limit, PAGE_LIMIT_CEILING);
  });

  it('aktif audit varken ikinci audit açılmaz (idempotent)', async () => {
    const campaignId = await createCampaign();
    const company = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/companies`,
      headers: auth,
      payload: { name: 'Idem', website: 'https://idem-test.test' },
    });
    const companyId = company.json().company_id as string;

    const first = await app.inject({
      method: 'POST',
      url: '/audits',
      headers: auth,
      payload: { company_id: companyId },
    });
    assert.equal(first.statusCode, 202);

    const second = await app.inject({
      method: 'POST',
      url: '/audits',
      headers: auth,
      payload: { company_id: companyId },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().idempotent, true);
    assert.equal(second.json().audit_id, first.json().audit_id);
  });

  it('bilinmeyen audit 404 döner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/audits/00000000-0000-4000-8000-000000000000',
      headers: auth,
    });
    assert.equal(res.statusCode, 404);
  });
});
