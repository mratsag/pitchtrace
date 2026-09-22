import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireDomainSlot, resetRateLimiter } from '../../src/lib/rate-limiter.js';

await test('aynı domaine ardışık istekler arasında en az verilen süre geçer', async () => {
  resetRateLimiter();
  const interval = 150;
  const started = Date.now();

  await acquireDomainSlot('ornek.test', interval);
  await acquireDomainSlot('ornek.test', interval);
  await acquireDomainSlot('ornek.test', interval);

  const elapsed = Date.now() - started;
  // İlk istek beklemez; kalan iki istek için 2 x interval.
  assert.ok(
    elapsed >= interval * 2 - 20,
    `üç istek en az ${interval * 2} ms sürmeliydi, ${elapsed} ms sürdü`,
  );
});

await test('farklı domainler birbirini beklemez', async () => {
  resetRateLimiter();
  const interval = 300;
  const started = Date.now();

  await Promise.all([
    acquireDomainSlot('a.test', interval),
    acquireDomainSlot('b.test', interval),
    acquireDomainSlot('c.test', interval),
  ]);

  assert.ok(Date.now() - started < interval, 'farklı domainler paralel ilerlemeliydi');
});

await test('üretim varsayılanı domain başına 1 istek/saniyedir', async () => {
  const { PER_DOMAIN_MIN_INTERVAL_DEFAULT_MS } = await import('../../src/config.js');
  assert.equal(PER_DOMAIN_MIN_INTERVAL_DEFAULT_MS, 1000);
});
