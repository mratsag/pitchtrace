import type {FastifyInstance} from 'fastify';
import {config,PAGE_LIMIT_CEILING} from '../config.js';
import {getPool,query} from '../db/pool.js';
import {normalizeCompanyInput} from '../lib/domain.js';

interface CompanyState{id:string;submitted_url:string;campaign_page_limit:number;active:boolean;completed:boolean;suppressed:boolean;}

export async function campaignAuditRoutes(app:FastifyInstance):Promise<void>{
  app.post<{Params:{id:string};Body?:{page_limit?:number}}>('/campaigns/:id/audits',{
    schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},body:{type:'object',additionalProperties:false,properties:{page_limit:{type:'integer',minimum:1,maximum:5}}}},
  },async(request,reply)=>{
    if(!config.auditEnabled)return reply.code(503).send({error:'AUDIT_DISABLED'});
    const client=await getPool().connect();
    try{
      await client.query('BEGIN');
      const campaign=await client.query<{id:string;page_limit:number}>('SELECT id,page_limit FROM pitchtrace.campaigns WHERE id=$1 FOR UPDATE',[request.params.id]);
      if(!campaign.rows[0]){await client.query('ROLLBACK');return reply.code(404).send({error:'CAMPAIGN_NOT_FOUND'});}
      const companies=await client.query<CompanyState>(`SELECT c.id,c.submitted_url,$2::int campaign_page_limit,
        EXISTS(SELECT 1 FROM pitchtrace.audits a WHERE a.company_id=c.id AND a.status IN('queued','running')) active,
        EXISTS(SELECT 1 FROM pitchtrace.audits a WHERE a.company_id=c.id AND a.status='completed') completed,
        EXISTS(SELECT 1 FROM pitchtrace.suppression_list s WHERE s.scope='domain' AND s.value=c.normalized_domain) suppressed
        FROM pitchtrace.companies c WHERE c.campaign_id=$1 ORDER BY c.created_at,c.id LIMIT 50`,[request.params.id,campaign.rows[0].page_limit]);
      const response={campaign_id:request.params.id,eligible:0,queued:0,already_queued:0,already_completed:0,skipped:0};
      for(const company of companies.rows){
        if(company.suppressed){response.skipped+=1;continue;}
        response.eligible+=1;
        if(company.active){response.already_queued+=1;continue;}
        if(company.completed){response.already_completed+=1;continue;}
        const requested=request.body?.page_limit??company.campaign_page_limit;
        const pageLimit=Math.min(requested,company.campaign_page_limit,PAGE_LIMIT_CEILING);
        const entryUrl=normalizeCompanyInput(company.submitted_url).entryUrl;
        const audit=await client.query<{id:string}>(`INSERT INTO pitchtrace.audits(company_id,entry_url,page_limit,analyzer_version)
          VALUES($1,$2,$3,$4) ON CONFLICT(company_id) WHERE status IN('queued','running') DO NOTHING RETURNING id`,[company.id,entryUrl,pageLimit,config.version]);
        const auditId=audit.rows[0]?.id;
        if(!auditId){response.already_queued+=1;continue;}
        await client.query('INSERT INTO pitchtrace.audit_jobs(audit_id,company_id) VALUES($1,$2)',[auditId,company.id]);
        response.queued+=1;
      }
      await client.query('COMMIT');
      return reply.code(202).send(response);
    }catch(err){await client.query('ROLLBACK').catch(()=>undefined);throw err;}finally{client.release();}
  });

  app.get<{Params:{id:string}}>('/campaigns/:id/audit-progress',{
    schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}}},
  },async(request,reply)=>{
    const campaign=await query('SELECT 1 FROM pitchtrace.campaigns WHERE id=$1',[request.params.id]);
    if(!campaign.rowCount)return reply.code(404).send({error:'CAMPAIGN_NOT_FOUND'});
    const result=await query<{total:string;queued:string;running:string;completed:string;failed:string;skipped:string}>(`WITH latest AS (
      SELECT c.id company_id,a.status FROM pitchtrace.companies c
      LEFT JOIN LATERAL(SELECT status FROM pitchtrace.audits WHERE company_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)a ON true
      WHERE c.campaign_id=$1
    ) SELECT count(*)::text total,
      count(*) FILTER(WHERE status='queued')::text queued,
      count(*) FILTER(WHERE status='running')::text running,
      count(*) FILTER(WHERE status='completed')::text completed,
      count(*) FILTER(WHERE status='failed')::text failed,
      count(*) FILTER(WHERE status IS NULL)::text skipped FROM latest`,[request.params.id]);
    const row=result.rows[0]!;const body={campaign_id:request.params.id,total:Number(row.total),queued:Number(row.queued),running:Number(row.running),completed:Number(row.completed),failed:Number(row.failed),skipped:Number(row.skipped),terminal:Number(row.queued)+Number(row.running)===0};
    return reply.send(body);
  });
}
