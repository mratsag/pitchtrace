import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRobots, userAgentToken } from '../../src/audit/robots.js';

const AGENT = 'pitchtracebot';

await test('User-Agent token üretimi', () => {
  assert.equal(userAgentToken('PitchTraceBot/0.1 (+https://x)'), 'pitchtracebot');
});

await test('Disallow: / her şeyi engeller', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /\n', AGENT);
  assert.equal(policy.isAllowed('/'), false);
  assert.equal(policy.isAllowed('/iletisim'), false);
});

await test('boş Disallow hiçbir şeyi engellemez', () => {
  const policy = parseRobots('User-agent: *\nDisallow:\n', AGENT);
  assert.equal(policy.isAllowed('/'), true);
});

await test('robots.txt yoksa her şey serbesttir', () => {
  const policy = parseRobots('', AGENT);
  assert.equal(policy.isAllowed('/'), true);
});

await test('en uzun eşleşen kural kazanır', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /admin\nAllow: /admin/public\n', AGENT);
  assert.equal(policy.isAllowed('/admin/secret'), false);
  assert.equal(policy.isAllowed('/admin/public/x'), true);
});

await test('eşit uzunlukta Allow kazanır', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x\n', AGENT);
  assert.equal(policy.isAllowed('/x'), true);
});

await test('bize özel grup, wildcard grubu geçersiz kılar', () => {
  const body = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: PitchTraceBot',
    'Disallow: /gizli',
    '',
  ].join('\n');
  const policy = parseRobots(body, AGENT);
  assert.equal(policy.isAllowed('/'), true, 'bize özel grup uygulanmalı');
  assert.equal(policy.isAllowed('/gizli'), false);
});

await test('aynı gruba ait birden çok User-agent satırı', () => {
  const body = ['User-agent: Googlebot', 'User-agent: PitchTraceBot', 'Disallow: /x', ''].join('\n');
  const policy = parseRobots(body, AGENT);
  assert.equal(policy.isAllowed('/x'), false);
  assert.equal(policy.isAllowed('/y'), true);
});

await test('joker ve satır sonu çapası', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /*.pdf$\n', AGENT);
  assert.equal(policy.isAllowed('/dosya.pdf'), false);
  assert.equal(policy.isAllowed('/dosya.pdf?x=1'), true);
  assert.equal(policy.isAllowed('/dosya.html'), true);
});

await test('yorum satırları yok sayılır', () => {
  const policy = parseRobots('# yorum\nUser-agent: *  # burada da\nDisallow: /a\n', AGENT);
  assert.equal(policy.isAllowed('/a'), false);
  assert.equal(policy.isAllowed('/b'), true);
});
