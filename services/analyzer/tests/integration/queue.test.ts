import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AUDIT_CONCURRENCY_CEILING, config } from '../../src/config.js';
import { closePool, query } from '../../src/db/pool.js';
import { WorkerPool, claimJob, recoverStaleJobs } from '../../src/worker.js';
import {
  createCampaign,
  createCompany,
  enqueueAudit,
  ensureSchema,
  getAudit,
  resetData,
} from '../helpers/db.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('iş kuyruğu ve worker havuzu', () => {
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

  /** Kampanya içi UNIQUE(campaign_id, domain) nedeniyle her firma kendi kampanyasında. */
  async function seedJobs(count: number, page = 'good.html'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const campaignId = await createCampaign(`q-${i}-${Math.random().toString(36).slice(2, 10)}`);
      const companyId = await createCompany(campaignId, `${server.origin}/${page}`);
      ids.push(await enqueueAudit(companyId, `${server.origin}/${page}`));
    }
    return ids;
  }

  it('eşzamanlılık üst sınırı config ile aşılamaz', () => {
    assert.ok(config.auditConcurrency <= AUDIT_CONCURRENCY_CEILING);
  });

  it('bir iş yalnızca bir kez claim edilir', async () => {
    await resetData();
    await seedJobs(3);

    const claims = await Promise.all([claimJob('a'), claimJob('b'), claimJob('c'), claimJob('d')]);
    const jobs = claims.filter((j) => j !== null);
    const auditIds = jobs.map((j) => j!.audit_id);

    assert.equal(jobs.length, 3, 'tam olarak 3 iş claim edilmeliydi');
    assert.equal(new Set(auditIds).size, 3, 'aynı iş birden fazla worker’a verilmiş');

    const running = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pitchtrace.audit_jobs WHERE status='running'",
    );
    assert.equal(Number(running.rows[0]!.count), 3);
  });

  it('stale lock süre dolunca geri alınır', async () => {
    await resetData();
    const [auditId] = await seedJobs(1);
    await claimJob('dead-worker');

    await query(
      "UPDATE pitchtrace.audit_jobs SET locked_at = now() - interval '30 minutes' WHERE audit_id=$1",
      [auditId],
    );
    assert.equal(await recoverStaleJobs(), 1);

    const job = await query<{ status: string }>(
      'SELECT status FROM pitchtrace.audit_jobs WHERE audit_id=$1',
      [auditId],
    );
    assert.equal(job.rows[0]!.status, 'queued');
  });

  it('kalıcı hatada audit failed olur ve iş yeniden denenmez', async () => {
    await resetData();
    const campaignId = await createCampaign(`nr-${Math.random().toString(36).slice(2, 10)}`);
    const companyId = await createCompany(campaignId, 'http://169.254.169.254/');
    const auditId = await enqueueAudit(companyId, 'http://169.254.169.254/latest/meta-data/');

    const pool = new WorkerPool(1);
    pool.start();
    try {
      await waitFor(async () => (await getAudit(auditId)).status === 'failed', 30_000);
    } finally {
      await pool.stop(10_000);
    }

    const audit = await getAudit(auditId);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.error_code, 'PRIVATE_ADDRESS');

    const job = await query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM pitchtrace.audit_jobs WHERE audit_id=$1',
      [auditId],
    );
    assert.equal(job.rows[0]!.status, 'failed', 'kalıcı hata yeniden kuyruğa alınmamalı');
    assert.equal(job.rows[0]!.attempts, 1, 'tek deneme yapılmalıydı');
  });

  it('worker havuzu aynı anda en fazla iki audit çalıştırır', async () => {
    await resetData();
    const auditIds = await seedJobs(6);

    const pool = new WorkerPool(2);
    const samples: number[] = [];
    const sampler = setInterval(() => samples.push(pool.runningCount), 20);

    pool.start();
    try {
      await waitFor(async () => {
        const remaining = await query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pitchtrace.audit_jobs
            WHERE status IN ('queued','running')`,
        );
        return Number(remaining.rows[0]!.count) === 0;
      }, 180_000);
    } finally {
      clearInterval(sampler);
      await pool.stop(10_000);
    }

    const max = Math.max(0, ...samples);
    assert.ok(max <= 2, `eşzamanlı audit sayısı 2’yi aştı: ${max}`);
    assert.equal(max, 2, `paralellik gözlenmedi (max=${max}, örnek=${samples.length})`);

    for (const auditId of auditIds) {
      assert.equal((await getAudit(auditId)).status, 'completed');
    }
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
