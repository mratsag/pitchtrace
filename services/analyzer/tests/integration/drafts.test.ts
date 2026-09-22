import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after,before,describe,it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { closePool,query } from '../../src/db/pool.js';
import { buildServer } from '../../src/server.js';
import { ensureSchema,resetData } from '../helpers/db.js';

const auth={'x-api-key':process.env['ANALYZER_API_KEY']??'test-key'};
describe('F7 evidence-linked outreach',()=>{
  let app:FastifyInstance; let companyId:string; let auditId:string; let contactId:string; let findingId:string;
  before(async()=>{
    await ensureSchema(); await resetData(); app=await buildServer(); await app.ready();
    const cam=await query<{id:string}>(`INSERT INTO pitchtrace.campaigns(name,sector,city,min_score) VALUES ('F7','demo','izmir',50) RETURNING id`);
    const co=await query<{id:string}>(`INSERT INTO pitchtrace.companies(campaign_id,name,submitted_url,normalized_domain) VALUES ($1,'Örnek Klinik','https://klinik.invalid','klinik.invalid') RETURNING id`,[cam.rows[0]!.id]); companyId=co.rows[0]!.id;
    const ct=await query<{id:string}>(`INSERT INTO pitchtrace.contacts(company_id,email,is_primary) VALUES ($1,'info@klinik.invalid',true) RETURNING id`,[companyId]); contactId=ct.rows[0]!.id;
    const au=await query<{id:string}>(`INSERT INTO pitchtrace.audits(company_id,status,page_limit,entry_url,final_url,analyzer_version,finished_at) VALUES ($1,'completed',1,'https://klinik.invalid','https://klinik.invalid/','test',now()) RETURNING id`,[companyId]); auditId=au.rows[0]!.id;
    await query(`INSERT INTO pitchtrace.scores(audit_id,company_id,total,breakdown,rule_version) VALUES ($1,$2,75,'{}','test')`,[auditId,companyId]);
    const f=await query<{id:string}>(`INSERT INTO pitchtrace.findings(audit_id,company_id,code,category,severity,confidence,url,evidence,metric_name,metric_value,metric_unit) VALUES ($1,$2,'PERF_LCP_SLOW','PERF','high','observed','https://klinik.invalid/','{}','lcp',4500,'ms') RETURNING id`,[auditId,companyId]); findingId=f.rows[0]!.id;
  });
  after(async()=>{await app.close();await closePool();});
  const output=()=>({language:'tr',subject:'Mobil hız hakkında kısa bir gözlem',greeting:'Merhaba,',claims:[{text:'Ana içerik mobilde en az 4500 ms sonra görünüyor.',claim_type:'assertion',confidence:'observed',finding_ids:[findingId]},{text:'Bu ölçümü birlikte incelemek ister misiniz?',claim_type:'question',confidence:'observed',finding_ids:[]}],closing:'İyi çalışmalar.'});

  it('context LCP değerini alt sınır olarak prompt girdisine koyar',async()=>{
    const res=await app.inject({method:'GET',url:`/drafts/context?company_id=${companyId}`,headers:auth}); assert.equal(res.statusCode,200);
    const lcp=res.json().findings.find((f:{code:string})=>f.code==='PERF_LCP_SLOW'); assert.equal(lcp.metric.wording,'en az 4500 ms'); assert.match(res.json().instructions.join(' '),/“en az”/);
  });
  it('geçerli taslağı claimlerden derler, onaylar ve eml üretir',async()=>{
    const made=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contactId,output:output()}}); assert.equal(made.statusCode,201,made.body); const id=made.json().draft_id;
    assert.match(made.json().body,/en az 4500 ms/);
    const approved=await app.inject({method:'POST',url:`/drafts/${id}/approval`,headers:auth,payload:{decision:'approved',decided_by:'tester'}}); assert.equal(approved.statusCode,200);
    const eml=await app.inject({method:'GET',url:`/drafts/${id}/export?format=eml`,headers:auth}); assert.equal(eml.statusCode,200); assert.match(String(eml.headers['content-type']),/message\/rfc822/); assert.match(eml.body,/info@klinik.invalid/);
  });
  it('geçersiz claim saklanır ve onay kapısı 409 döner',async()=>{
    const bad=output(); bad.claims[0]!.text='Sonuçlarınız yüzde 40 kesin artacaktır.';
    const made=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contactId,output:bad}}); assert.equal(made.statusCode,422); assert.ok(made.json().errors.some((e:string)=>e.startsWith('V9:')));
    const approval=await app.inject({method:'POST',url:`/drafts/${made.json().draft_id}/approval`,headers:auth,payload:{decision:'approved',decided_by:'tester'}}); assert.equal(approval.statusCode,409);
  });
  it('şemaya uymayan çıktı V1 ile 422 döner ve denetim kaydı korunur',async()=>{
    const made=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contactId,output:{language:'xx',claims:[]}}});
    assert.equal(made.statusCode,422,made.body); assert.ok(made.json().errors.some((e:string)=>e.startsWith('V1:')));
    const stored=await query<{status:string}>('SELECT status FROM pitchtrace.email_drafts WHERE id=$1',[made.json().draft_id]); assert.equal(stored.rows[0]!.status,'rejected_by_validator');
  });
  it('onaydan sonra suppression eklenirse export tekrar 409 verir',async()=>{
    const made=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contactId,output:output()}}); const id=made.json().draft_id;
    await app.inject({method:'POST',url:`/drafts/${id}/approval`,headers:auth,payload:{decision:'approved',decided_by:'tester'}});
    await app.inject({method:'POST',url:'/suppression',headers:auth,payload:{scope:'email',value:'info@klinik.invalid',reason:'test',created_by:'tester'}});
    const eml=await app.inject({method:'GET',url:`/drafts/${id}/export`,headers:auth}); assert.equal(eml.statusCode,409); assert.equal(eml.json().error,'SUPPRESSED');
  });
});
