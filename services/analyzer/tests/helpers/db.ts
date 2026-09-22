import { config } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { query } from '../../src/db/pool.js';
import { normalizeCompanyInput } from '../../src/lib/domain.js';

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await migrate();
  migrated = true;
}

export async function resetData(): Promise<void> {
  await query('TRUNCATE pitchtrace.suppression_list, pitchtrace.campaigns CASCADE');
}

export async function createCampaign(name = 'test-campaign'): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO pitchtrace.campaigns (name, sector, city)
     VALUES ($1,'dis-klinigi','izmir') RETURNING id`,
    [name],
  );
  return result.rows[0]!.id;
}

export async function createCompany(campaignId: string, website: string): Promise<string> {
  const normalized = normalizeCompanyInput(website);
  const result = await query<{ id: string }>(
    `INSERT INTO pitchtrace.companies
       (campaign_id, name, submitted_url, normalized_domain, source)
     VALUES ($1,'Test Firma',$2,$3,'manual') RETURNING id`,
    [campaignId, normalized.submittedUrl, normalized.normalizedDomain],
  );
  return result.rows[0]!.id;
}

export async function enqueueAudit(
  companyId: string,
  entryUrl: string,
  pageLimit = 1,
): Promise<string> {
  const audit = await query<{ id: string }>(
    `INSERT INTO pitchtrace.audits (company_id, entry_url, page_limit, analyzer_version)
     VALUES ($1,$2,$4,$3) RETURNING id`,
    [companyId, entryUrl, config.version, pageLimit],
  );
  const auditId = audit.rows[0]!.id;
  await query('INSERT INTO pitchtrace.audit_jobs (audit_id, company_id) VALUES ($1,$2)', [
    auditId,
    companyId,
  ]);
  return auditId;
}

export interface AuditSnapshot {
  status: string;
  error_code: string | null;
  pages_fetched: number;
  robots_allowed: boolean | null;
  final_url: string | null;
}

export async function getAudit(auditId: string): Promise<AuditSnapshot> {
  const result = await query<AuditSnapshot>(
    `SELECT status, error_code, pages_fetched, robots_allowed, final_url
       FROM pitchtrace.audits WHERE id=$1`,
    [auditId],
  );
  return result.rows[0]!;
}

export async function getFindingCodes(auditId: string): Promise<string[]> {
  const result = await query<{ code: string }>(
    'SELECT code FROM pitchtrace.findings WHERE audit_id=$1 ORDER BY code',
    [auditId],
  );
  return result.rows.map((r) => r.code);
}
