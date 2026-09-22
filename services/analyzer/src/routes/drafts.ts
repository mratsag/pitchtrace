import type { FastifyInstance } from 'fastify';
import { getPool, query } from '../db/pool.js';
import { presentFinding, type ContextFinding } from '../draft/context.js';
import { buildEml } from '../draft/eml.js';
import type { DraftOutput } from '../draft/schema.js';
import { validateDraft, type ValidationContext, type ValidationFinding } from '../draft/validator.js';

interface DraftBase {
  audit_id: string; company_id: string; contact_id: string; email: string; company_name: string;
  normalized_domain: string; final_url: string | null; language: 'tr' | 'en';
}

async function isSuppressed(email: string, domain: string): Promise<boolean> {
  const found = await query(
    `SELECT 1 FROM pitchtrace.suppression_list
      WHERE (scope='email' AND value=$1) OR (scope='domain' AND value=$2) LIMIT 1`,
    [email, domain],
  );
  return (found.rowCount ?? 0) > 0;
}

async function baseFor(auditId: string, contactId: string): Promise<DraftBase | null> {
  const result = await query<DraftBase>(
    `SELECT a.id audit_id, a.company_id, ct.id contact_id, ct.email::text, c.name company_name,
            c.normalized_domain::text, a.final_url, cam.language
       FROM pitchtrace.audits a JOIN pitchtrace.companies c ON c.id=a.company_id
       JOIN pitchtrace.campaigns cam ON cam.id=c.campaign_id
       JOIN pitchtrace.contacts ct ON ct.company_id=c.id AND ct.id=$2
      WHERE a.id=$1 AND a.status='completed'`, [auditId, contactId]);
  return result.rows[0] ?? null;
}

async function validationContext(base: DraftBase, ids: string[]): Promise<ValidationContext> {
  const findings = ids.length ? await query<ValidationFinding>(
    `SELECT id, audit_id, company_id, code, confidence, url, metric_value, metric_unit
       FROM pitchtrace.findings WHERE id=ANY($1::uuid[])`, [ids]) : { rows: [] } as { rows: ValidationFinding[] };
  return {
    auditId: base.audit_id, companyId: base.company_id, normalizedDomain: base.normalized_domain,
    auditFinalUrl: base.final_url, campaignLanguage: base.language, contactEmail: base.email,
    companyName: base.company_name, suppressed: await isSuppressed(base.email, base.normalized_domain),
    findings: findings.rows,
  };
}

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { company_id: string } }>('/drafts/context', {
    schema: { querystring: { type: 'object', required: ['company_id'], properties: { company_id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const base = await query<DraftBase & { score: number; min_score: number }>(
      `SELECT a.id audit_id, a.company_id, ct.id contact_id, ct.email::text, c.name company_name,
              c.normalized_domain::text, a.final_url, cam.language, s.total score, cam.min_score
         FROM pitchtrace.companies c JOIN pitchtrace.campaigns cam ON cam.id=c.campaign_id
         JOIN LATERAL (SELECT * FROM pitchtrace.audits WHERE company_id=c.id AND status='completed' ORDER BY finished_at DESC NULLS LAST LIMIT 1) a ON true
         JOIN pitchtrace.scores s ON s.audit_id=a.id
         JOIN LATERAL (SELECT * FROM pitchtrace.contacts WHERE company_id=c.id ORDER BY is_primary DESC, created_at LIMIT 1) ct ON true
        WHERE c.id=$1`, [request.query.company_id]);
    const row = base.rows[0];
    if (!row) return reply.code(404).send({ error: 'DRAFT_CONTEXT_NOT_FOUND' });
    if (await isSuppressed(row.email, row.normalized_domain)) return reply.code(409).send({ error: 'SUPPRESSED' });
    if (row.score < row.min_score) return reply.code(412).send({ error: 'SCORE_BELOW_THRESHOLD', score: row.score, min_score: row.min_score });
    const findings = await query<ContextFinding>(
      `SELECT id, code, severity, confidence, url, evidence, metric_name, metric_value,
              metric_unit, artifact_id FROM pitchtrace.findings WHERE audit_id=$1 ORDER BY severity DESC, code`, [row.audit_id]);
    return {
      company: { id: row.company_id, name: row.company_name, domain: row.normalized_domain },
      contact: { id: row.contact_id, email: row.email }, audit_id: row.audit_id, language: row.language,
      score: row.score, findings: findings.rows.map(presentFinding),
      instructions: ['Yalnızca finding_ids ile desteklenen iddiaları kullan.', 'PERF_LCP_SLOW değerini kesin değer değil “en az” alt sınırı olarak yaz.'],
    };
  });

  app.post<{ Body: { audit_id: string; contact_id: string; output: unknown } }>('/drafts', {
    schema: { body: { type: 'object', required: ['audit_id','contact_id','output'], additionalProperties: false,
      properties: { audit_id: { type: 'string', format: 'uuid' }, contact_id: { type: 'string', format: 'uuid' }, output: {} } } },
  }, async (request, reply) => {
    const base = await baseFor(request.body.audit_id, request.body.contact_id);
    if (!base) return reply.code(404).send({ error: 'DRAFT_TARGET_NOT_FOUND' });
    const output = request.body.output as Partial<DraftOutput>;
    const ids = Array.isArray(output?.claims) ? [...new Set(output.claims.flatMap((c) => Array.isArray(c?.finding_ids) ? c.finding_ids : []))] : [];
    const ctx = await validationContext(base, ids);
    const validation = validateDraft(request.body.output, ctx);
    const safe = request.body.output && typeof request.body.output === 'object' ? request.body.output as Partial<DraftOutput> : {};
    const storedLanguage = safe.language === 'en' || safe.language === 'tr' ? safe.language : base.language;
    const storedSubject = typeof safe.subject === 'string' ? safe.subject : '';
    const storedGreeting = typeof safe.greeting === 'string' ? safe.greeting : '';
    const storedClosing = typeof safe.closing === 'string' ? safe.closing : '';
    const client = await getPool().connect();
    let draftId = '';
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO pitchtrace.email_drafts
           (company_id,audit_id,contact_id,language,subject,greeting,closing,body,status,validation_errors,validation_warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) RETURNING id`,
        [base.company_id,base.audit_id,base.contact_id, storedLanguage, storedSubject, storedGreeting, storedClosing, validation.body,
         validation.valid ? 'pending_review' : 'rejected_by_validator', JSON.stringify(validation.errors), JSON.stringify(validation.warnings)]);
      draftId = inserted.rows[0]!.id;
      if (Array.isArray(safe.claims)) for (const [position, claim] of safe.claims.entries()) {
        if (!claim || typeof claim.text !== 'string' || !['assertion','question','neutral'].includes(claim.claim_type) || !['observed','inferred'].includes(claim.confidence)) continue;
        const cr = await client.query<{ id: string }>(`INSERT INTO pitchtrace.draft_claims (draft_id,position,text,claim_type,confidence) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [draftId,position,claim.text,claim.claim_type,claim.confidence]);
        for (const id of Array.isArray(claim.finding_ids) ? claim.finding_ids : []) if (ctx.findings.some((f) => f.id === id)) await client.query(`INSERT INTO pitchtrace.draft_claim_findings (claim_id,finding_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cr.rows[0]!.id,id]);
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    return reply.code(validation.valid ? 201 : 422).send({ draft_id: draftId, status: validation.valid ? 'pending_review' : 'rejected_by_validator', errors: validation.errors, warnings: validation.warnings, body: validation.body });
  });

  app.post<{ Params: { id: string }; Body: { decision: 'approved'|'rejected'; decided_by: string; note?: string } }>('/drafts/:id/approval', {
    schema: { params: { type:'object', required:['id'], properties:{id:{type:'string',format:'uuid'}} }, body:{type:'object',required:['decision','decided_by'],additionalProperties:false,properties:{decision:{enum:['approved','rejected']},decided_by:{type:'string',minLength:1},note:{type:'string',maxLength:1000}}} },
  }, async (request, reply) => {
    const draft = await query<{ validation_errors: unknown[] }>('SELECT validation_errors FROM pitchtrace.email_drafts WHERE id=$1',[request.params.id]);
    if (!draft.rows[0]) return reply.code(404).send({error:'DRAFT_NOT_FOUND'});
    if (request.body.decision === 'approved' && draft.rows[0].validation_errors.length) return reply.code(409).send({error:'INVALID_CLAIMS'});
    await query(`INSERT INTO pitchtrace.approvals (draft_id,decision,decided_by,note) VALUES ($1,$2,$3,$4)`,[request.params.id,request.body.decision,request.body.decided_by,request.body.note ?? null]);
    const status=request.body.decision==='approved'?'approved':'rejected_by_human';
    await query('UPDATE pitchtrace.email_drafts SET status=$2,updated_at=now() WHERE id=$1',[request.params.id,status]);
    return {draft_id:request.params.id,status};
  });

  app.get<{ Params:{id:string}; Querystring:{format?:string} }>('/drafts/:id/export', async (request, reply) => {
    if (request.query.format && request.query.format !== 'eml') return reply.code(400).send({error:'UNSUPPORTED_FORMAT'});
    const result=await query<{company_id:string;email:string;normalized_domain:string;subject:string;body:string;status:string}>(
      `SELECT d.company_id,ct.email::text,c.normalized_domain::text,d.subject,d.body,d.status FROM pitchtrace.email_drafts d JOIN pitchtrace.contacts ct ON ct.id=d.contact_id JOIN pitchtrace.companies c ON c.id=d.company_id WHERE d.id=$1`,[request.params.id]);
    const row=result.rows[0]; if(!row)return reply.code(404).send({error:'DRAFT_NOT_FOUND'});
    if(row.status!=='approved')return reply.code(409).send({error:'DRAFT_NOT_APPROVED'});
    if(await isSuppressed(row.email,row.normalized_domain))return reply.code(409).send({error:'SUPPRESSED'});
    const eml=buildEml({to:row.email,subject:row.subject,body:row.body});
    await query(`INSERT INTO pitchtrace.outreach_log (draft_id,company_id,status,marked_by) VALUES ($1,$2,'exported','api')`,[request.params.id,row.company_id]);
    return reply.header('content-type','message/rfc822').header('content-disposition',`attachment; filename="${request.params.id}.eml"`).send(eml);
  });
}
