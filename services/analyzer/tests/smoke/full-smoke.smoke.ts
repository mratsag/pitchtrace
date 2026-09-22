import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { closePool, query } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { WorkerPool } from '../../src/worker.js';
import { startFixtureServer, sitemapXml, type FixtureServer } from '../helpers/fixture-server.js';

const key=process.env['ANALYZER_API_KEY']??'smoke-key';
const auth={'x-api-key':key};
let app:FastifyInstance; let fixture:FixtureServer; let workers:WorkerPool;

before(async()=>{
  await migrate();
  await query('TRUNCATE pitchtrace.suppression_list, pitchtrace.campaigns CASCADE');
  fixture=await startFixtureServer(); fixture.setSitemap(sitemapXml(fixture.origin,['/crawl-hizmetler.html','/crawl-blog.html']));
  app=await buildServer(); await app.ready(); workers=new WorkerPool(2); workers.start();
});
after(async()=>{await workers.stop();await app.close();await fixture.close();await closePool();});

async function waitCompleted(id:string):Promise<Record<string,unknown>>{
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline){
    const res=await app.inject({method:'GET',url:`/audits/${id}`,headers:auth}); const body=res.json();
    if(body.status==='completed')return body;
    if(body.status==='failed')throw new Error(`audit failed: ${JSON.stringify(body.error)}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('audit timeout');
}

test('Docker full smoke: audit → score → evidence draft → approval → eml',async()=>{
  const health=await app.inject({method:'GET',url:'/healthz'}); assert.equal(health.statusCode,200);
  const campaign=await app.inject({method:'POST',url:'/campaigns',headers:auth,payload:{name:'Kurgusal Smoke',sector:'demo',city:'Örnekşehir',min_score:0}});
  assert.equal(campaign.statusCode,201,campaign.body);
  const company=await app.inject({method:'POST',url:`/campaigns/${campaign.json().id}/companies`,headers:auth,payload:{name:'Kurgusal İşletme',website:`${fixture.origin}/crawl-home.html`}});
  assert.equal(company.statusCode,201,company.body); const companyId=company.json().company_id;
  const queued=await app.inject({method:'POST',url:'/audits',headers:auth,payload:{company_id:companyId,page_limit:5}});
  assert.equal(queued.statusCode,202,queued.body); const auditId=queued.json().audit_id;
  const audit=await waitCompleted(auditId);
  assert.ok(Number((audit.progress as {pages_fetched:number}).pages_fetched)>=1); assert.ok(Number((audit.progress as {pages_fetched:number}).pages_fetched)<=5);
  assert.ok(Number(audit.findings_count)>0); assert.ok(audit.score); assert.ok((audit.artifacts as unknown[]).length>0);

  const contact=await query<{id:string}>(`INSERT INTO pitchtrace.contacts(company_id,email,name,is_primary) VALUES ($1,'smoke@ornek.invalid','Örnek Kişi',true) RETURNING id`,[companyId]);
  const context=await app.inject({method:'GET',url:`/drafts/context?company_id=${companyId}`,headers:auth}); assert.equal(context.statusCode,200,context.body);
  const finding=context.json().findings.find((f:{confidence:string;outreach_eligible:boolean})=>f.confidence==='observed'&&f.outreach_eligible);
  assert.ok(finding,'outreach-eligible observed finding required');
  const output={language:'tr',subject:'Web siteniz hakkında kısa bir teknik gözlem',greeting:'Merhaba,',claims:[{text:'Kayıtlı web sitesi bulgusu tarafımızca doğrulandı.',claim_type:'assertion',confidence:'observed',finding_ids:[finding.id]},{text:'Bu bulguyu birlikte incelemek ister misiniz?',claim_type:'question',confidence:'observed',finding_ids:[]}],closing:'İyi çalışmalar.'};

  const fake=structuredClone(output); fake.claims[0]!.finding_ids=['00000000-0000-4000-8000-000000000099'];
  const rejected=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contact.rows[0]!.id,output:fake}}); assert.equal(rejected.statusCode,422); assert.ok(rejected.json().errors.some((x:string)=>x.startsWith('V4:')));

  const made=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contact.rows[0]!.id,output}}); assert.equal(made.statusCode,201,made.body);
  const approved=await app.inject({method:'POST',url:`/drafts/${made.json().draft_id}/approval`,headers:auth,payload:{decision:'approved',decided_by:'smoke-test'}}); assert.equal(approved.statusCode,200);
  const eml=await app.inject({method:'GET',url:`/drafts/${made.json().draft_id}/export?format=eml`,headers:auth}); assert.equal(eml.statusCode,200,eml.body); assert.match(String(eml.headers['content-type']),/message\/rfc822/); assert.match(eml.body,/Subject: =\?UTF-8\?B\?/); assert.match(eml.body,/=C4=B0yi =C3=A7al=C4=B1=C5=9Fmalar\./);
  const log=await query(`SELECT 1 FROM pitchtrace.outreach_log WHERE draft_id=$1 AND status='exported'`,[made.json().draft_id]); assert.equal(log.rowCount,1);

  const second=await app.inject({method:'POST',url:'/drafts',headers:auth,payload:{audit_id:auditId,contact_id:contact.rows[0]!.id,output}}); assert.equal(second.statusCode,201);
  await app.inject({method:'POST',url:`/drafts/${second.json().draft_id}/approval`,headers:auth,payload:{decision:'approved',decided_by:'smoke-test'}});
  await app.inject({method:'POST',url:'/suppression',headers:auth,payload:{scope:'email',value:'smoke@ornek.invalid',reason:'smoke negative case',created_by:'smoke-test'}});
  const blocked=await app.inject({method:'GET',url:`/drafts/${second.json().draft_id}/export`,headers:auth}); assert.equal(blocked.statusCode,409); assert.equal(blocked.json().error,'SUPPRESSED');
});
