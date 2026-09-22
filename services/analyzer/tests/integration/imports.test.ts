import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import {after,before,beforeEach,describe,it} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildServer} from '../../src/server.js';
import {closePool,query} from '../../src/db/pool.js';
import {createCampaign,ensureSchema,resetData} from '../helpers/db.js';

const auth={'x-api-key':process.env['ANALYZER_API_KEY']??'test-key'};
function multipart(csv:Buffer|string,boundary='pitchtrace-boundary'):{payload:Buffer;headers:Record<string,string>}{
  const content=Buffer.isBuffer(csv)?csv:Buffer.from(csv,'utf8');
  return {headers:{...auth,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="companies.csv"\r\nContent-Type: text/csv\r\n\r\n`),content,Buffer.from(`\r\n--${boundary}--\r\n`)])};
}

describe('F2 CSV import',()=>{
  let app:FastifyInstance;let campaignId:string;
  before(async()=>{await ensureSchema();app=await buildServer();await app.ready();});
  beforeEach(async()=>{await resetData();campaignId=await createCampaign(`csv-${Math.random()}`);});
  after(async()=>{await app.close();await closePool();});
  async function send(csv:Buffer|string,id=campaignId){const m=multipart(csv);return app.inject({method:'POST',url:`/campaigns/${id}/companies/import`,headers:m.headers,payload:m.payload});}
  const header='company_name,website,contact_name,contact_email\n';

  it('geçerli CSV şirket ve primary contact oluşturur',async()=>{const r=await send(header+'Örnek,https://ornek.invalid,Test Kişi,info@ornek.invalid\n');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().imported,1);const c=await query(`SELECT 1 FROM pitchtrace.contacts WHERE email='info@ornek.invalid' AND is_primary`);assert.equal(c.rowCount,1);});
  it('UTF-8 BOM ve farklı kolon sırası desteklenir',async()=>{const csv=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('website,contact_email,company_name,contact_name\nhttps://bom.invalid,info@bom.invalid,BÖM Şirketi,İsim\n')]);const r=await send(csv);assert.equal(r.json().imported,1,r.body);});
  it('opsiyonel kolonlar veya değerler olmadan import eder',async()=>{const a=await send('website,company_name\nhttps://opsiyonel.invalid,Opsiyonel\n');assert.equal(a.json().imported,1);});
  it('eksik zorunlu ve bilinmeyen header kararlı 422 döner',async()=>{const a=await send('company_name,contact_email\nA,a@a.invalid\n');assert.equal(a.statusCode,422);assert.equal(a.json().error,'CSV_MISSING_HEADER');const b=await send('company_name,website,notes\nA,https://a.invalid,x\n');assert.equal(b.statusCode,422);assert.equal(b.json().error,'CSV_UNKNOWN_HEADER');});
  it('eksik hücre, geçersiz URL/e-posta ve güvenli satırda kısmi başarı sağlar',async()=>{const r=await send(header+'Eksik,,,\nURL,ftp://x.invalid,,\nEmail,https://email.invalid,,bozuk\nPrivate,http://127.0.0.1,,\nMetadata,http://169.254.169.254,,\nGeçerli,https://gecerli.invalid,,\n');assert.equal(r.statusCode,200);assert.equal(r.json().imported,1);assert.equal(r.json().invalid,5);assert.ok(r.json().results.some((x:{code:string})=>x.code==='UNSAFE_URL'));});
  it('aynı dosyadaki ve veritabanındaki duplicate domainleri ayırır',async()=>{const first=await send(header+'A,https://dup.invalid,,\nB,http://www.dup.invalid/path,,\n');assert.equal(first.json().imported,1);assert.equal(first.json().duplicates,1);assert.equal(first.json().results[1].code,'DUPLICATE_IN_FILE');const second=await send(header+'A,https://dup.invalid,,\n');assert.equal(second.json().results[0].code,'DUPLICATE_EXISTING');});
  it('suppressed email ve domain nedenini kodla raporlar',async()=>{await query(`INSERT INTO pitchtrace.suppression_list(scope,value,reason,created_by) VALUES('email','blocked@e.invalid','test','test'),('domain','d.invalid','test','test')`);const r=await send(header+'E,https://e.invalid,,blocked@e.invalid\nD,https://d.invalid,,\n');assert.equal(r.json().suppressed,2);assert.deepEqual(r.json().results.map((x:{code:string})=>x.code),['EMAIL_SUPPRESSED','DOMAIN_SUPPRESSED']);});
  it('50 satırı kabul eder, 51 satırı istek seviyesinde reddeder',async()=>{const rows=(n:number)=>Array.from({length:n},(_,i)=>`Şirket ${i},https://s${i}.invalid,,`).join('\n');const ok=await send(header+rows(50));assert.equal(ok.json().imported,50,ok.body);await resetData();campaignId=await createCampaign('csv-51');const bad=await send(header+rows(51));assert.equal(bad.statusCode,422);assert.equal(bad.json().error,'CSV_TOO_MANY_ROWS');});
  it('büyük dosya ve çok uzun alanı kontrollü reddeder',async()=>{const huge=await send(header+`A,https://a.invalid,,${'x'.repeat(130*1024)}`);assert.equal(huge.statusCode,413);assert.equal(huge.json().error,'CSV_FILE_TOO_LARGE');const long=await send(header+`${'x'.repeat(201)},https://a.invalid,,`);assert.equal(long.statusCode,200);assert.equal(long.json().results[0].code,'FIELD_TOO_LONG');});
  it('bozuk quoting reddedilir, boş satırlar atlanır',async()=>{const bad=await send(header+'"A,https://a.invalid,,\n');assert.equal(bad.statusCode,422);assert.equal(bad.json().error,'CSV_MALFORMED_QUOTING');const ok=await send(header+'\nA,https://a.invalid,,\n\n');assert.equal(ok.json().total_rows,1);assert.equal(ok.json().imported,1);});
  it('formül enjeksiyonu satırını reddeder',async()=>{const r=await send(header+'=SUM(1),https://formula.invalid,,\n');assert.equal(r.json().results[0].code,'FORMULA_CELL');});
  it('aynı dosyanın tekrar yüklenmesi idempotent sonuç verir',async()=>{const csv=header+'A,https://again.invalid,,\n';assert.equal((await send(csv)).json().imported,1);const again=await send(csv);assert.equal(again.json().duplicates,1);assert.equal(again.json().imported,0);});
  it('eşzamanlı importta yalnızca bir kayıt oluşur',async()=>{const csv=header+'A,https://race.invalid,,\n';const [a,b]=await Promise.all([send(csv),send(csv)]);assert.equal(a.json().imported+b.json().imported,1);assert.equal(a.json().duplicates+b.json().duplicates,1);const count=await query<{n:string}>('SELECT count(*)::text n FROM pitchtrace.companies WHERE campaign_id=$1',[campaignId]);assert.equal(Number(count.rows[0]!.n),1);});
  it('bilinmeyen kampanya 404 döner',async()=>{const r=await send(header+'A,https://a.invalid,,\n','00000000-0000-4000-8000-000000000099');assert.equal(r.statusCode,404);assert.equal(r.json().error,'CAMPAIGN_NOT_FOUND');});
});
