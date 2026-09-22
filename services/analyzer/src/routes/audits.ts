import type { FastifyInstance } from 'fastify';
import { PAGE_LIMIT_CEILING, config } from '../config.js';
import { query } from '../db/pool.js';
import { normalizeCompanyInput } from '../lib/domain.js';
import { ScoreError, computeAndStoreScore } from '../scoring/index.js';

interface CompanyRow {
  id: string;
  submitted_url: string;
  page_limit: number;
}

interface AuditRow {
  id: string;
  company_id: string;
  status: string;
  entry_url: string;
  final_url: string | null;
  robots_allowed: boolean | null;
  pages_planned: number;
  pages_fetched: number;
  bytes_transferred: string;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { company_id: string; page_limit?: number } }>(
    '/audits',
    {
      schema: {
        body: {
          type: 'object',
          required: ['company_id'],
          additionalProperties: false,
          properties: {
            company_id: { type: 'string', format: 'uuid' },
            page_limit: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const company = await query<CompanyRow>(
        `SELECT c.id, c.submitted_url, cam.page_limit
           FROM pitchtrace.companies c
           JOIN pitchtrace.campaigns cam ON cam.id = c.campaign_id
          WHERE c.id = $1`,
        [request.body.company_id],
      );
      const row = company.rows[0];
      if (!row) return reply.code(404).send({ error: 'COMPANY_NOT_FOUND' });

      // Idempotent: aktif bir audit varsa yenisi açılmaz.
      const active = await query<{ id: string; status: string }>(
        `SELECT id, status FROM pitchtrace.audits
          WHERE company_id=$1 AND status IN ('queued','running')
          ORDER BY created_at DESC LIMIT 1`,
        [row.id],
      );
      if (active.rows[0]) {
        return reply.code(200).send({
          audit_id: active.rows[0].id,
          status: active.rows[0].status,
          idempotent: true,
        });
      }

      // page_limit hard ceiling: kullanıcı yalnızca düşürebilir.
      const requested = request.body.page_limit ?? row.page_limit;
      const pageLimit = Math.min(requested, row.page_limit, PAGE_LIMIT_CEILING);

      const entryUrl = normalizeCompanyInput(row.submitted_url).entryUrl;

      const audit = await query<{ id: string }>(
        `INSERT INTO pitchtrace.audits (company_id, entry_url, page_limit, analyzer_version)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id) WHERE status IN ('queued','running') DO NOTHING
         RETURNING id`,
        [row.id, entryUrl, pageLimit, config.version],
      );
      const auditId = audit.rows[0]?.id;
      if (!auditId) {
        const concurrent = await query<{id:string;status:string}>(`SELECT id,status FROM pitchtrace.audits WHERE company_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,[row.id]);
        return reply.code(200).send({audit_id:concurrent.rows[0]!.id,status:concurrent.rows[0]!.status,idempotent:true});
      }

      await query(
        `INSERT INTO pitchtrace.audit_jobs (audit_id, company_id) VALUES ($1,$2)
         ON CONFLICT (audit_id) DO NOTHING`,
        [auditId, row.id],
      );

      return reply.code(202).send({ audit_id: auditId, status: 'queued' });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/audits/:id/score',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await computeAndStoreScore(request.params.id);
        return reply.send({
          audit_id: request.params.id,
          total: result.total,
          breakdown: result.breakdown,
          details: result.details,
          rule_version: result.ruleVersion,
        });
      } catch (err) {
        if (err instanceof ScoreError) {
          return reply.code(err.code === 'AUDIT_NOT_FOUND' ? 404 : 409).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/audits/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const audit = await query<AuditRow>(
        `SELECT id, company_id, status, entry_url, final_url, robots_allowed,
                pages_planned, pages_fetched, bytes_transferred,
                error_code, error_message, started_at, finished_at
           FROM pitchtrace.audits WHERE id=$1`,
        [request.params.id],
      );
      const row = audit.rows[0];
      if (!row) return reply.code(404).send({ error: 'AUDIT_NOT_FOUND' });

      const findings = await query(
        `SELECT id, code, category, severity, confidence, url, evidence,
                metric_name, metric_value, metric_unit, artifact_id, observed_at
           FROM pitchtrace.findings WHERE audit_id=$1 ORDER BY code`,
        [row.id],
      );

      const score = await query<{
        total: number;
        breakdown: Record<string, number>;
        details: Record<string, unknown>;
        rule_version: string;
        computed_at: string;
      }>(
        `SELECT total, breakdown, details, rule_version, computed_at
           FROM pitchtrace.scores WHERE audit_id=$1`,
        [row.id],
      );

      const artifacts = await query(
        `SELECT id, kind, mime, bytes FROM pitchtrace.artifacts
          WHERE audit_id=$1 AND deleted_at IS NULL`,
        [row.id],
      );

      return reply.send({
        audit_id: row.id,
        company_id: row.company_id,
        status: row.status,
        entry_url: row.entry_url,
        final_url: row.final_url,
        robots_allowed: row.robots_allowed,
        progress: { pages_planned: row.pages_planned, pages_fetched: row.pages_fetched },
        bytes_transferred: Number(row.bytes_transferred),
        error: row.error_code
          ? { code: row.error_code, message: row.error_message }
          : null,
        started_at: row.started_at,
        finished_at: row.finished_at,
        score: score.rows[0] ?? null,
        findings_count: findings.rowCount ?? 0,
        findings: findings.rows,
        artifacts: artifacts.rows,
      });
    },
  );
}
