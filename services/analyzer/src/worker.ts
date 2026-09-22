import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db/pool.js';
import { AuditFailure, runAudit } from './audit/run-audit.js';

export interface JobRow {
  id: string;
  audit_id: string;
  company_id: string;
  attempts: number;
  max_attempts: number;
}

const RETRY_DELAY_MS = 30_000;

function log(level: 'info' | 'warn' | 'error', msg: string, extra: object = {}): void {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Bir işi atomik olarak sahiplenir. Aynı iş iki worker'a verilmez. */
export async function claimJob(workerId: string): Promise<JobRow | null> {
  const result = await query<JobRow>(
    `UPDATE pitchtrace.audit_jobs j
        SET status='running', attempts=attempts+1, locked_at=now(), locked_by=$1
      WHERE j.id = (
        SELECT id FROM pitchtrace.audit_jobs
         WHERE status='queued' AND run_after <= now()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
    RETURNING j.id, j.audit_id, j.company_id, j.attempts, j.max_attempts`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

/** Çökme sonrası kilitli kalan işleri geri alır. */
export async function recoverStaleJobs(): Promise<number> {
  const result = await query(
    `UPDATE pitchtrace.audit_jobs
        SET status='queued', locked_at=NULL, locked_by=NULL,
            last_error='reclaimed after stale lock'
      WHERE status='running'
        AND locked_at < now() - make_interval(secs => $1)`,
    [config.staleLockMs / 1000],
  );
  return result.rowCount ?? 0;
}

async function completeJob(job: JobRow): Promise<void> {
  await query(
    `UPDATE pitchtrace.audit_jobs
        SET status='completed', locked_at=NULL, locked_by=NULL, last_error=NULL
      WHERE id=$1`,
    [job.id],
  );
}

/**
 * Tekrar denemenin sonucu değiştirmeyeceği kalıcı hatalar.
 * Bunlar hedef siteye gereksiz ikinci bir istek göndermeden başarısız olur.
 */
const NON_RETRYABLE = new Set([
  'INVALID_URL',
  'SCHEME_BLOCKED',
  'CREDENTIALS_IN_URL',
  'HOSTNAME_BLOCKED',
  'PRIVATE_ADDRESS',
  'ROBOTS_DISALLOWED',
  'TOO_MANY_REDIRECTS',
  'NOT_FOUND',
]);

async function failJob(job: JobRow, failure: AuditFailure): Promise<void> {
  const exhausted = job.attempts >= job.max_attempts || NON_RETRYABLE.has(failure.code);
  if (exhausted) {
    await query(
      `UPDATE pitchtrace.audit_jobs
          SET status='failed', locked_at=NULL, locked_by=NULL, last_error=$2
        WHERE id=$1`,
      [job.id, `${failure.code}: ${failure.message}`.slice(0, 2000)],
    );
    return;
  }
  await query(
    `UPDATE pitchtrace.audit_jobs
        SET status='queued', locked_at=NULL, locked_by=NULL, last_error=$2,
            run_after = now() + make_interval(secs => $3)
      WHERE id=$1`,
    [job.id, `${failure.code}: ${failure.message}`.slice(0, 2000), RETRY_DELAY_MS / 1000],
  );
  await query(
    `UPDATE pitchtrace.audits SET status='queued', error_code=NULL, error_message=NULL
      WHERE id=$1`,
    [job.audit_id],
  );
}

export class WorkerPool {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private sweeper: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<string>();

  constructor(private readonly concurrency = config.auditConcurrency) {}

  start(): void {
    if (this.loops.length > 0) throw new Error('worker pool already started');
    const runId = crypto.randomUUID().slice(0, 8);
    for (let i = 0; i < this.concurrency; i += 1) {
      this.loops.push(this.loop(`w${i}-${runId}`));
    }
    this.sweeper = setInterval(() => {
      void recoverStaleJobs()
        .then((n) => {
          if (n > 0) log('warn', 'reclaimed stale jobs', { count: n });
        })
        .catch((err) => log('error', 'stale sweep failed', { err: (err as Error).message }));
    }, 60_000);
    this.sweeper.unref();
    log('info', 'worker pool started', { concurrency: this.concurrency });
  }

  /** Yeni iş almayı durdurur ve çalışan audit'lerin bitmesini bekler. */
  async stop(graceMs = config.shutdownGraceMs): Promise<void> {
    this.stopping = true;
    if (this.sweeper) clearInterval(this.sweeper);

    const drained = Promise.all(this.loops);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), graceMs).unref(),
    );
    const result = await Promise.race([drained.then(() => 'drained' as const), timeout]);

    if (result === 'timeout' && this.inFlight.size > 0) {
      log('warn', 'shutdown grace expired, marking in-flight audits failed', {
        in_flight: [...this.inFlight],
      });
      for (const auditId of this.inFlight) {
        await query(
          `UPDATE pitchtrace.audits
              SET status='failed', finished_at=now(), error_code='SHUTDOWN',
                  error_message='analyzer shut down while audit was running'
            WHERE id=$1 AND status='running'`,
          [auditId],
        ).catch(() => undefined);
      }
    }
    log('info', 'worker pool stopped', { reason: result });
  }

  get runningCount(): number {
    return this.inFlight.size;
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.stopping) {
      let job: JobRow | null = null;
      try {
        job = await claimJob(workerId);
      } catch (err) {
        log('error', 'claim failed', { worker: workerId, err: (err as Error).message });
        await sleep(config.jobIdlePollMs);
        continue;
      }

      if (!job) {
        await sleep(config.jobIdlePollMs);
        continue;
      }

      this.inFlight.add(job.audit_id);
      try {
        const outcome = await runAudit(job.audit_id);
        await completeJob(job);
        log('info', 'audit completed', {
          worker: workerId,
          audit_id: job.audit_id,
          findings: outcome.findingCodes,
        });
      } catch (err) {
        const failure =
          err instanceof AuditFailure
            ? err
            : new AuditFailure('RENDER_CRASH', (err as Error).message);
        await failJob(job, failure).catch((e) =>
          log('error', 'failJob failed', { err: (e as Error).message }),
        );
        log('warn', 'audit failed', {
          worker: workerId,
          audit_id: job.audit_id,
          code: failure.code,
          attempts: job.attempts,
        });
      } finally {
        this.inFlight.delete(job.audit_id);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
