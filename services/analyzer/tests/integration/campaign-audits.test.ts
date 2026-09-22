import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import {after,before,beforeEach,describe,it} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildServer} from '../../src/server.js';
import {closePool,query} from '../../src/db/pool.js';
import {createCampaign,createCompany,ensureSchema,resetData} from '../helpers/db.js';

const auth={'x-api-key':process.env['ANALYZER_API_KEY']??'test-key'};
describe('F2 kampanya audit orkestrasyonu',()=>{
  let app:FastifyInstance;let campaignId:string;
  before(async()=>{await ensureSchema();app=await buildServer();await app.ready();});
  beforeEach(async()=>{await resetData();campaignId=await createCampaign(`orch-${Math.random()}`);});
  after(async()=>{await app.close();await closePool();});
  async function company(i:number){return createCompany(campaignId,`https://firma-${i}.invalid`);}
  async function start(){return app.inject({method:'POST',url:`/campaigns/${campaignId}/audits`,headers:auth,payload:{}});}
  async function progress(){return app.inject({method:'GET',url:`/campaigns/${campaignId}/audit-progress`,headers:auth});}

  it('kampanyadaki firmaları asenkron kuyruğa alır',async()=>{await company(1);await company(2);const r=await start();assert.equal(r.statusCode,202);assert.equal(r.json().eligible,2);assert.equal(r.json().queued,2);const jobs=await query('SELECT 1 FROM pitchtrace.audit_jobs');assert.equal(jobs.rowCount,2);});
  it('boş kampanya anlaşılır sıfır cevabı ve terminal progress verir',async()=>{const r=await start();assert.equal(r.json().queued,0);const p=await progress();assert.deepEqual(p.json(),{campaign_id:campaignId,total:0,queued:0,running:0,completed:0,failed:0,skipped:0,terminal:true});});
  it('bilinmeyen kampanya iki endpointte de kararlı 404 verir',async()=>{campaignId='00000000-0000-4000-8000-000000000099';for(const r of [await start(),await progress()]){assert.equal(r.statusCode,404);assert.equal(r.json().error,'CAMPAIGN_NOT_FOUND');}});
  it('tekrar ve eşzamanlı başlatma duplicate audit üretmez',async()=>{await company(1);const [a,b]=await Promise.all([start(),start()]);assert.equal(a.json().queued+b.json().queued,1);assert.equal(a.json().already_queued+b.json().already_queued,1);const again=await start();assert.equal(again.json().already_queued,1);const audits=await query('SELECT 1 FROM pitchtrace.audits');assert.equal(audits.rowCount,1);});
  it('tamamlanmış audit tekrar kuyruğa alınmaz',async()=>{const id=await company(1);await query(`INSERT INTO pitchtrace.audits(company_id,status,page_limit,entry_url,analyzer_version,finished_at) VALUES($1,'completed',1,'https://firma-1.invalid','test',now())`,[id]);const r=await start();assert.equal(r.json().already_completed,1);assert.equal(r.json().queued,0);});
  it('running/failed sayaçlarını ve terminal hesabını doğru verir',async()=>{const a=await company(1),b=await company(2),c=await company(3);for(const [id,status]of [[a,'running'],[b,'failed'],[c,'completed']]as const)await query(`INSERT INTO pitchtrace.audits(company_id,status,page_limit,entry_url,analyzer_version,finished_at) VALUES($1,$2,1,'https://x.invalid','test',CASE WHEN $2 IN('failed','completed') THEN now() END)`,[id,status]);let p=(await progress()).json();assert.equal(p.running,1);assert.equal(p.failed,1);assert.equal(p.completed,1);assert.equal(p.terminal,false);await query(`UPDATE pitchtrace.audits SET status='failed',finished_at=now() WHERE status='running'`);p=(await progress()).json();assert.equal(p.failed,2);assert.equal(p.terminal,true);});
  it('API yeniden kurulduğunda kuyruk durumu veritabanında korunur',async()=>{await company(1);await start();const second=await buildServer();await second.ready();const r=await second.inject({method:'GET',url:`/campaigns/${campaignId}/audit-progress`,headers:auth});assert.equal(r.json().queued,1);await second.close();});
  it('50 firma sınırında tam ve tekil kuyruk oluşturur',async()=>{for(let i=0;i<50;i+=1)await company(i);const r=await start();assert.equal(r.json().queued,50);const jobs=await query<{n:string}>('SELECT count(*)::text n FROM pitchtrace.audit_jobs');assert.equal(Number(jobs.rows[0]!.n),50);});
  it('domain suppression audit’i atlar; email suppression audit’i engellemez',async()=>{const d=await company(1),e=await company(2);await query(`INSERT INTO pitchtrace.contacts(company_id,email,is_primary) VALUES($1,'blocked@firma-2.invalid',true)`,[e]);await query(`INSERT INTO pitchtrace.suppression_list(scope,value,reason,created_by) VALUES('domain','firma-1.invalid','test','test'),('email','blocked@firma-2.invalid','test','test')`);const r=await start();assert.equal(r.json().skipped,1);assert.equal(r.json().queued,1);const queued=await query<{company_id:string}>('SELECT company_id FROM pitchtrace.audits');assert.equal(queued.rows[0]!.company_id,e);assert.notEqual(queued.rows[0]!.company_id,d);});
});
