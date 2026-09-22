import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateDraft, type ValidationContext } from '../../src/draft/validator.js';

const A='10000000-0000-4000-8000-000000000001';
const C='10000000-0000-4000-8000-000000000002';
const F='10000000-0000-4000-8000-000000000003';
const base:ValidationContext={auditId:A,companyId:C,normalizedDomain:'ornek.invalid',auditFinalUrl:'https://ornek.invalid/',campaignLanguage:'tr',contactEmail:'info@ornek.invalid',companyName:'Örnek',suppressed:false,findings:[{id:F,audit_id:A,company_id:C,code:'MOB_NO_VIEWPORT',confidence:'observed',url:'https://ornek.invalid/',metric_value:null,metric_unit:null}]};
const valid={language:'tr',subject:'Mobil görünüm hakkında kısa not',greeting:'Merhaba,',claims:[{text:'Mobil sayfanızda viewport etiketi görünmüyor.',claim_type:'assertion',confidence:'observed',finding_ids:[F]},{text:'Bunu birlikte incelemek ister misiniz?',claim_type:'question',confidence:'observed',finding_ids:[]}],closing:'İyi çalışmalar.'};

describe('draft validator',()=>{
  it('geçerli claim listesini kabul eder',()=>assert.equal(validateDraft(valid,base).valid,true));
  it('uydurma finding id V4 ile reddedilir',()=>{
    const value=structuredClone(valid); value.claims[0]!.finding_ids=['10000000-0000-4000-8000-000000000099'];
    assert.ok(validateDraft(value,base).errors.some(e=>e.startsWith('V4:')));
  });
  it('desteksiz yüzde V9 ile reddedilir',()=>{
    const value=structuredClone(valid); value.claims[0]!.text='Mobil dönüşümünüz yüzde 40 artabilir görünüyor.';
    assert.ok(validateDraft(value,base).errors.some(e=>e.startsWith('V9:')));
  });
  it('experimental finding V16 ile reddedilir',()=>{
    const ctx=structuredClone(base); ctx.findings[0]!.code='PERF_CLS_HIGH';
    assert.ok(validateDraft(valid,ctx).errors.some(e=>e.startsWith('V16:')));
  });
});
