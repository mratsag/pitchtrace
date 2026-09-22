import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, normalizeCompanyInput } from '../../src/lib/domain.js';

await test('şema yoksa https varsayılır', () => {
  const result = normalizeCompanyInput('ornek.com');
  assert.equal(result.normalizedDomain, 'ornek.com');
  assert.equal(result.entryUrl, 'https://ornek.com/');
  assert.equal(result.submittedUrl, 'ornek.com');
});

await test('www, büyük harf ve path varyantları aynı domaine indirgenir', () => {
  const variants = [
    'https://WWW.Ornek.com/iletisim',
    'http://ornek.com',
    'www.ornek.com/',
    'ORNEK.COM',
    'https://ornek.com.',
  ];
  for (const variant of variants) {
    assert.equal(normalizeCompanyInput(variant).normalizedDomain, 'ornek.com', variant);
  }
});

await test('submitted_url ham haliyle korunur', () => {
  const raw = '  https://WWW.Ornek.com/iletisim?utm=1  ';
  const result = normalizeCompanyInput(raw);
  assert.equal(result.submittedUrl, raw.trim());
  assert.equal(result.entryUrl, 'https://www.ornek.com/iletisim');
});

await test('IDN punycode\'a çevrilir', () => {
  assert.equal(normalizeCompanyInput('örnekklinik.com').normalizedDomain, 'xn--rnekklinik-dcb.com');
});

await test('desteklenmeyen şema ve kimlik bilgisi reddedilir', () => {
  assert.throws(() => normalizeCompanyInput('ftp://ornek.com'), DomainError);
  assert.throws(() => normalizeCompanyInput('javascript:alert(1)'), DomainError);
  assert.throws(() => normalizeCompanyInput('https://user:pw@ornek.com'), DomainError);
  assert.throws(() => normalizeCompanyInput('   '), DomainError);
});
