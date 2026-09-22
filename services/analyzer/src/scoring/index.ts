import { query } from '../db/pool.js';
import { scoreFindings, type ScoreResult } from './rules.v1.js';

export * from './rules.v1.js';

export class ScoreError extends Error {
  constructor(
    readonly code: 'AUDIT_NOT_FOUND' | 'AUDIT_NOT_COMPLETED',
    message: string,
  ) {
    super(message);
    this.name = 'ScoreError';
  }
}

interface AuditContext {
  company_id: string;
  status: string;
  service_fit: Record<string, number>;
}

/**
 * Audit'in bulgularından puanı hesaplar ve `scores` tablosuna yazar.
 * Aynı audit için tekrar çağrılabilir; sonuç deterministiktir ve kayıt
 * üzerine yazılır.
 */
export async function computeAndStoreScore(auditId: string): Promise<ScoreResult> {
  const context = await query<AuditContext>(
    `SELECT a.company_id, a.status, cam.service_fit
       FROM pitchtrace.audits a
       JOIN pitchtrace.companies c   ON c.id = a.company_id
       JOIN pitchtrace.campaigns cam ON cam.id = c.campaign_id
      WHERE a.id = $1`,
    [auditId],
  );
  const row = context.rows[0];
  if (!row) throw new ScoreError('AUDIT_NOT_FOUND', `audit ${auditId} not found`);
  if (row.status !== 'completed') {
    throw new ScoreError(
      'AUDIT_NOT_COMPLETED',
      `audit ${auditId} is ${row.status}; only completed audits can be scored`,
    );
  }

  const findings = await query<{ code: string }>(
    'SELECT code FROM pitchtrace.findings WHERE audit_id = $1',
    [auditId],
  );

  const result = scoreFindings({
    codes: findings.rows.map((f) => f.code),
    serviceFit: row.service_fit ?? {},
  });

  await query(
    `INSERT INTO pitchtrace.scores
       (audit_id, company_id, total, breakdown, details, rule_version, computed_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6, now())
     ON CONFLICT (audit_id) DO UPDATE
       SET total = EXCLUDED.total,
           breakdown = EXCLUDED.breakdown,
           details = EXCLUDED.details,
           rule_version = EXCLUDED.rule_version,
           computed_at = now()`,
    [
      auditId,
      row.company_id,
      result.total,
      JSON.stringify(result.breakdown),
      JSON.stringify(result.details),
      result.ruleVersion,
    ],
  );

  return result;
}
