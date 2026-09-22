import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { normalizeCompanyInput } from '../lib/domain.js';
import { checkUrl } from '../security/ssrf.js';
import { CsvContractError, parseCompanyCsv } from '../imports/csv.js';
import { extractCsvFile, MultipartCsvError } from '../imports/multipart.js';
import { IMPORT_CODES, IMPORT_LIMITS, type ImportRowResult } from '../imports/codes.js';

const SAFE_IMPORT_RESOLVER = async ():Promise<string[]>=>['93.184.216.34'];
const FORMULA_PREFIX=/^[=+\-@]/;
const EMAIL=/^[^\s@]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$/i;

function invalid(row:number,code:string,message:string):ImportRowResult{return{row,status:'invalid',company_id:null,code,message};}

export async function importRoutes(app:FastifyInstance):Promise<void>{
  app.post<{Params:{id:string}}>('/campaigns/:id/companies/import',{
    schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}}},
  },async(request,reply)=>{
    let parsed;
    try{
      const file=extractCsvFile(request.headers['content-type'],request.body as Buffer);
      parsed=parseCompanyCsv(file);
    }catch(err){
      if(err instanceof MultipartCsvError||err instanceof CsvContractError)return reply.code(err.statusCode).send({error:err.code,message:err.message});
      throw err;
    }

    const prepared:Array<{row:number;name:string;website:string;contactName:string;email:string;submittedUrl:string;domain:string;entryUrl:string}|ImportRowResult>=[];
    const domains=new Set<string>();
    for(const row of parsed.rows){
      if(row.raw.length!==parsed.headers.length){prepared.push(invalid(row.row,IMPORT_CODES.columnCountMismatch,'row has a different number of columns'));continue;}
      const values=Object.fromEntries(Object.entries(row.values).map(([k,v])=>[k,v.trim()]));
      if(Object.values(values).some((v)=>FORMULA_PREFIX.test(v))){prepared.push(invalid(row.row,IMPORT_CODES.formulaCell,'formula-like cells are not accepted'));continue;}
      if(Object.values(values).some((v)=>v.length>IMPORT_LIMITS.maxFieldChars)||values.company_name!.length>IMPORT_LIMITS.maxCompanyNameChars||values.website!.length>IMPORT_LIMITS.maxWebsiteChars||(values.contact_name??'').length>IMPORT_LIMITS.maxContactNameChars||(values.contact_email??'').length>IMPORT_LIMITS.maxEmailChars){prepared.push(invalid(row.row,IMPORT_CODES.fieldTooLong,'one or more fields exceed the documented limit'));continue;}
      if(!values.company_name||!values.website){prepared.push(invalid(row.row,IMPORT_CODES.missingRequiredValue,'company_name and website are required'));continue;}
      const email=(values.contact_email??'').toLowerCase();
      if(email&&!EMAIL.test(email)){prepared.push(invalid(row.row,IMPORT_CODES.invalidEmail,'contact_email is invalid'));continue;}
      let normalized;
      try{normalized=normalizeCompanyInput(values.website);}catch{prepared.push(invalid(row.row,IMPORT_CODES.invalidUrl,'website is invalid'));continue;}
      const safety=await checkUrl(normalized.entryUrl,{resolver:SAFE_IMPORT_RESOLVER});
      if(!safety.ok){prepared.push(invalid(row.row,IMPORT_CODES.unsafeUrl,`website is not allowed (${safety.code})`));continue;}
      if(domains.has(normalized.normalizedDomain)){prepared.push({row:row.row,status:'duplicate',company_id:null,code:IMPORT_CODES.duplicateInFile,message:'domain already appeared in this CSV'});continue;}
      domains.add(normalized.normalizedDomain);
      prepared.push({row:row.row,name:values.company_name,website:values.website,contactName:values.contact_name??'',email,submittedUrl:normalized.submittedUrl,domain:normalized.normalizedDomain,entryUrl:normalized.entryUrl});
    }

    const client=await getPool().connect(); const results:ImportRowResult[]=[];
    try{
      await client.query('BEGIN');
      const campaign=await client.query<{id:string;max_companies:number}>('SELECT id,max_companies FROM pitchtrace.campaigns WHERE id=$1 FOR UPDATE',[request.params.id]);
      if(!campaign.rows[0]){await client.query('ROLLBACK');return reply.code(404).send({error:'CAMPAIGN_NOT_FOUND'});}
      let count=Number((await client.query<{count:string}>('SELECT count(*)::text count FROM pitchtrace.companies WHERE campaign_id=$1',[request.params.id])).rows[0]!.count);
      for(const item of prepared){
        if('status'in item){results.push(item);continue;}
        const suppressed=await client.query<{scope:string}>(`SELECT scope FROM pitchtrace.suppression_list WHERE (scope='domain' AND value=$1) OR (scope='email' AND value=$2) ORDER BY CASE scope WHEN 'domain' THEN 0 ELSE 1 END LIMIT 1`,[item.domain,item.email||'']);
        if(suppressed.rows[0]){const domain=suppressed.rows[0].scope==='domain';results.push({row:item.row,status:'suppressed',company_id:null,code:domain?IMPORT_CODES.domainSuppressed:IMPORT_CODES.emailSuppressed,message:domain?'domain is suppressed':'contact email is suppressed'});continue;}
        if(count>=campaign.rows[0].max_companies){results.push(invalid(item.row,IMPORT_CODES.campaignLimit,'campaign company limit reached'));continue;}
        await client.query('SAVEPOINT import_row');
        try{
          const inserted=await client.query<{id:string}>(`INSERT INTO pitchtrace.companies(campaign_id,name,submitted_url,normalized_domain,source) VALUES($1,$2,$3,$4,'csv') ON CONFLICT(campaign_id,normalized_domain) DO NOTHING RETURNING id`,[request.params.id,item.name,item.submittedUrl,item.domain]);
          const companyId=inserted.rows[0]?.id;
          if(!companyId){results.push({row:item.row,status:'duplicate',company_id:null,code:IMPORT_CODES.duplicateExisting,message:'domain already exists in this campaign'});await client.query('RELEASE SAVEPOINT import_row');continue;}
          if(item.email)await client.query(`INSERT INTO pitchtrace.contacts(company_id,email,name,is_primary,source_url) VALUES($1,$2,$3,true,$4)`,[companyId,item.email,item.contactName||null,item.entryUrl]);
          count+=1;results.push({row:item.row,status:'imported',company_id:companyId,code:null,message:null});await client.query('RELEASE SAVEPOINT import_row');
        }catch{await client.query('ROLLBACK TO SAVEPOINT import_row');results.push(invalid(item.row,IMPORT_CODES.rowWriteFailed,'row could not be stored'));await client.query('RELEASE SAVEPOINT import_row');}
      }
      await client.query('COMMIT');
    }catch(err){await client.query('ROLLBACK').catch(()=>undefined);throw err;}finally{client.release();}
    const tally=(status:string)=>results.filter((r)=>r.status===status).length;
    return reply.send({campaign_id:request.params.id,total_rows:parsed.rows.length,imported:tally('imported'),duplicates:tally('duplicate'),suppressed:tally('suppressed'),invalid:tally('invalid'),results});
  });
}
