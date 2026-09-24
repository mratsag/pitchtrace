import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import { closePool, query } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { cleanupExpiredArtifacts } from '../../src/audit/artifact-cleanup.js';
import { runAudit } from '../../src/audit/run-audit.js';
import { chromium } from 'playwright';
import { createPreviewToken } from '../../src/security/preview-token.js';
import {
  createCampaign,
  createCompany,
  enqueueAudit,
  ensureSchema,
  resetData,
} from '../helpers/db.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const KEY = process.env['ANALYZER_API_KEY'] ?? 'test-key';

describe('artifact erişimi ve saklama süresi', () => {
  let app: FastifyInstance;
  let server: FixtureServer;

  before(async () => {
    await ensureSchema();
    await resetData();
    server = await startFixtureServer();
    app = await buildServer();
    await app.listen({host:'127.0.0.1',port:0});
  });

  after(async () => {
    await app.close();
    await server.close();
    await closePool();
  });

  const auth = { 'x-api-key': KEY };

  async function auditWithScreenshot(): Promise<{ auditId: string; artifactId: string }> {
    const campaignId = await createCampaign(`ar-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, `${server.origin}/f4-clean.html`);
    const auditId = await enqueueAudit(companyId, `${server.origin}/f4-clean.html`, 1);
    await runAudit(auditId);

    const artifact = await query<{ id: string }>(
      "SELECT id FROM pitchtrace.artifacts WHERE audit_id=$1 AND kind='screenshot'",
      [auditId],
    );
    return { auditId, artifactId: artifact.rows[0]!.id };
  }

  it('screenshot binary olarak indirilebilir', async () => {
    const { artifactId } = await auditWithScreenshot();

    const res = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}`, headers: auth });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.ok(res.rawPayload.byteLength > 1000);
    // PNG imzası
    assert.deepEqual([...res.rawPayload.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('API anahtarı olmadan artifact indirilemez', async () => {
    const { artifactId } = await auditWithScreenshot();
    const res = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}` });
    assert.equal(res.statusCode, 401);
  });

  it('kısa ömürlü preview URL API anahtarını açığa çıkarmadan güvenli headerlarla çalışır', async () => {
    const { artifactId } = await auditWithScreenshot();
    const grant = await app.inject({ method:'POST', url:`/artifacts/${artifactId}/preview-access`, headers:auth });
    assert.equal(grant.statusCode, 200);
    const body = grant.json();
    assert.equal(body.artifact_id, artifactId);
    assert.doesNotMatch(body.preview_url, /test-key|x-api-key/i);
    const preview = await app.inject({ method:'GET', url:body.preview_url });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.headers['cache-control'], 'private, no-store');
    assert.equal(preview.headers['referrer-policy'], 'no-referrer');
    assert.equal(preview.headers['x-content-type-options'], 'nosniff');
    assert.equal(preview.headers['content-type'], 'image/png');
    assert.match(body.refresh_url,/\/artifact-preview-refresh\//);
    const refreshed=await app.inject({method:'GET',url:body.refresh_url});
    assert.equal(refreshed.statusCode,302);
    assert.match(String(refreshed.headers.location),/\/artifact-previews\//);
    assert.notEqual(refreshed.headers.location,body.preview_url);
  });

  it('preview token başka artifact için yeniden kullanılamaz ve retention sonrası 404 verir', async () => {
    const { artifactId } = await auditWithScreenshot();
    const grant = await app.inject({ method:'POST', url:`/artifacts/${artifactId}/preview-access`, headers:auth });
    const previewUrl = grant.json().preview_url;
    const token = previewUrl.split('/').at(-1);
    assert.ok(token);
    const decoded = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    decoded.artifact_id = '00000000-0000-4000-8000-000000000000';
    const changed = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${token.split('.')[1]}`;
    assert.equal((await app.inject({method:'GET',url:`/artifact-previews/${changed}`})).statusCode, 401);
    await query("UPDATE pitchtrace.artifacts SET deleted_at=now() WHERE id=$1",[artifactId]);
    assert.equal((await app.inject({method:'GET',url:previewUrl})).statusCode, 404);
  });

  it('gerçek browser expired mesajını ve aynı artifact refresh akışını API key sızmadan işler',async()=>{
    const {artifactId}=await auditWithScreenshot();
    const grant=(await app.inject({method:'POST',url:`/artifacts/${artifactId}/preview-access`,headers:auth})).json();
    const address=app.server.address(); assert.ok(address&&typeof address==='object');
    const origin=`http://127.0.0.1:${address.port}`;
    const expired=createPreviewToken(artifactId,Date.now()-config.previewTokenTtlSeconds*2000).token;
    const browser=await chromium.launch({headless:true}); const page=await browser.newPage();
    const requests:string[]=[]; page.on('request',r=>requests.push(r.url()));
    try{
      await page.setContent(`<img alt="Audit screenshot" src="${origin}/artifact-previews/${expired}"><p>Önizleme bağlantısının süresi doldu</p><a rel="noreferrer" href="${origin}${grant.refresh_url}">Yeni güvenli önizleme</a>`);
      await page.getByText('Önizleme bağlantısının süresi doldu').waitFor();
      assert.equal(await page.getByAltText('Audit screenshot').evaluate((e:HTMLImageElement)=>e.naturalWidth),0);
      const response=await Promise.all([page.waitForResponse(r=>r.url().includes('/artifact-previews/')),page.getByRole('link',{name:'Yeni güvenli önizleme'}).click()]);
      assert.equal(response[0].status(),200); assert.equal(response[0].headers()['content-type'],'image/png');
      assert.ok(requests.every(u=>!u.includes(KEY))); assert.ok(requests.every(u=>!u.includes('/approval')));
    }finally{await browser.close();}
  });

  it('bilinmeyen artifact 404 döner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/artifacts/00000000-0000-4000-8000-000000000000',
      headers: auth,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'ARTIFACT_NOT_FOUND');
  });

  it('kök dışını gösteren rel_path 400 PATH_TRAVERSAL döner', async () => {
    const { auditId } = await auditWithScreenshot();
    // Kayıt bozulmuş gibi davran: yol kökün dışını gösteriyor.
    const malicious = await query<{ id: string }>(
      `INSERT INTO pitchtrace.artifacts (audit_id, kind, rel_path, mime, bytes, sha256)
       VALUES ($1,'screenshot','../../../etc/passwd','image/png',10,'x') RETURNING id`,
      [auditId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/artifacts/${malicious.rows[0]!.id}`,
      headers: auth,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'PATH_TRAVERSAL');
  });

  it('saklama süresi dolan artifact silinir ve 404 ARTIFACT_GONE döner', async () => {
    const { artifactId } = await auditWithScreenshot();

    const before = await query<{ rel_path: string }>(
      'SELECT rel_path FROM pitchtrace.artifacts WHERE id=$1',
      [artifactId],
    );
    const absolute = path.join(config.artifactRoot, before.rows[0]!.rel_path);
    await fs.access(absolute);

    // Kaydı saklama süresinin ötesine taşı.
    await query(
      "UPDATE pitchtrace.artifacts SET created_at = now() - interval '90 days' WHERE id=$1",
      [artifactId],
    );

    const result = await cleanupExpiredArtifacts(30);
    assert.ok(result.deleted >= 1, JSON.stringify(result));

    await assert.rejects(fs.access(absolute), 'dosya silinmemiş');

    const marked = await query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM pitchtrace.artifacts WHERE id=$1',
      [artifactId],
    );
    assert.ok(marked.rows[0]!.deleted_at, 'deleted_at işaretlenmemiş');

    const res = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}`, headers: auth });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'ARTIFACT_GONE');
  });

  it('saklama süresi dolmayan artifact silinmez', async () => {
    const { artifactId } = await auditWithScreenshot();
    const result = await cleanupExpiredArtifacts(30);

    const row = await query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM pitchtrace.artifacts WHERE id=$1',
      [artifactId],
    );
    assert.equal(row.rows[0]!.deleted_at, null, JSON.stringify(result));
  });

  it('bulgu kaydı artifact silinse de korunur', async () => {
    const { auditId, artifactId } = await auditWithScreenshot();
    await query(
      "UPDATE pitchtrace.artifacts SET created_at = now() - interval '90 days' WHERE id=$1",
      [artifactId],
    );
    await cleanupExpiredArtifacts(30);

    const pages = await query('SELECT 1 FROM pitchtrace.audit_pages WHERE audit_id=$1', [auditId]);
    assert.ok((pages.rowCount ?? 0) > 0, 'sayfa kaydı silinmiş');
  });
});
