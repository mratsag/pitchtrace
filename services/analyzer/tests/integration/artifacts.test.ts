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
    await app.ready();
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
