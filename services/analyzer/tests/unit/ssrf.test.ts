import assert from 'node:assert/strict';
import test from 'node:test';
import { checkUrl } from '../../src/security/ssrf.js';
import { checkIp } from '../../src/security/ip-ranges.js';

/** Testler ağa çıkmaz: DNS çözümü enjekte edilir. */
const resolverFor = (addresses: string[]) => async () => addresses;

await test('sadece http ve https kabul edilir', async () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'data:text/html,<h1>x</h1>',
    'javascript:alert(1)',
    'gopher://example.com',
    'ws://example.com',
  ]) {
    const result = await checkUrl(url, { resolver: resolverFor(['93.184.216.34']) });
    assert.equal(result.ok, false, `${url} kabul edilmemeliydi`);
    if (!result.ok) assert.equal(result.code, 'SCHEME_BLOCKED');
  }
});

await test('http ve https kabul edilir', async () => {
  for (const url of ['http://example.com/', 'https://example.com/path?q=1']) {
    const result = await checkUrl(url, { resolver: resolverFor(['93.184.216.34']) });
    assert.equal(result.ok, true, `${url} kabul edilmeliydi`);
  }
});

await test('URL içinde kimlik bilgisi reddedilir', async () => {
  const result = await checkUrl('https://user:pass@example.com/', {
    resolver: resolverFor(['93.184.216.34']),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'CREDENTIALS_IN_URL');
});

await test('engelli hostname ekleri reddedilir', async () => {
  for (const host of [
    'localhost',
    'app.localhost',
    'printer.local',
    'db.internal',
    'metadata.google.internal',
    'x.home.arpa',
  ]) {
    const result = await checkUrl(`http://${host}/`, { resolver: resolverFor(['93.184.216.34']) });
    assert.equal(result.ok, false, `${host} kabul edilmemeliydi`);
    if (!result.ok) assert.equal(result.code, 'HOSTNAME_BLOCKED');
  }
});

await test('private, loopback ve reserved IP literalleri reddedilir', async () => {
  const blocked = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.1.1.1',
    '169.254.1.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.5',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.9',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ];
  for (const ip of blocked) {
    const result = await checkUrl(`http://${ip}/`);
    assert.equal(result.ok, false, `${ip} kabul edilmemeliydi`);
    if (!result.ok) assert.equal(result.code, 'PRIVATE_ADDRESS');
  }
});

await test('IPv6 loopback, ULA, link-local ve gömülü IPv4 biçimleri reddedilir', async () => {
  const blocked = [
    '[::1]',
    '[::]',
    '[fc00::1]',
    '[fd12:3456::1]',
    '[fe80::1]',
    '[ff02::1]',
    '[::ffff:127.0.0.1]', // IPv4-mapped loopback
    '[::ffff:169.254.169.254]', // IPv4-mapped metadata
    '[64:ff9b::a00:1]', // NAT64 → 10.0.0.1
    '[2002:7f00:1::]', // 6to4 → 127.0.0.1
    '[2001:db8::1]',
  ];
  for (const ip of blocked) {
    const result = await checkUrl(`http://${ip}/`);
    assert.equal(result.ok, false, `${ip} kabul edilmemeliydi`);
    if (!result.ok) assert.equal(result.code, 'PRIVATE_ADDRESS');
  }
});

await test('public IP literalleri kabul edilir', async () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '[2606:4700:4700::1111]']) {
    const result = await checkUrl(`https://${ip}/`);
    assert.equal(result.ok, true, `${ip} kabul edilmeliydi`);
  }
});

await test('DNS ile private adrese çözülen hostname reddedilir', async () => {
  const result = await checkUrl('https://evil.example/', {
    resolver: resolverFor(['169.254.169.254']),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'PRIVATE_ADDRESS');
    assert.match(result.reason, /169\.254\.169\.254/);
  }
});

await test('çoklu A kaydında BİR adres bile engelliyse istek reddedilir', async () => {
  const result = await checkUrl('https://mixed.example/', {
    resolver: resolverFor(['93.184.216.34', '10.0.0.5']),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /10\.0\.0\.5/);
});

await test('DNS hatası DNS_FAILURE üretir', async () => {
  const result = await checkUrl('https://broken.example/', {
    resolver: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'DNS_FAILURE');
});

await test('allowLoopback YALNIZCA loopback açar, metadata ve private kapalı kalır', async () => {
  const loopback = await checkUrl('http://127.0.0.1:8080/', { allowLoopback: true });
  assert.equal(loopback.ok, true, '127.0.0.1 test bayrağıyla açılmalı');

  const v6 = await checkUrl('http://[::1]:8080/', { allowLoopback: true });
  assert.equal(v6.ok, true, '::1 test bayrağıyla açılmalı');

  for (const ip of ['169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1']) {
    const result = await checkUrl(`http://${ip}/`, { allowLoopback: true });
    assert.equal(result.ok, false, `${ip} allowLoopback ile de engelli kalmalı`);
  }
});

await test('checkIp: sınır değerleri', () => {
  assert.equal(checkIp('9.255.255.255').blockedReason, null);
  assert.notEqual(checkIp('10.0.0.0').blockedReason, null);
  assert.notEqual(checkIp('10.255.255.255').blockedReason, null);
  assert.equal(checkIp('11.0.0.0').blockedReason, null);
  assert.notEqual(checkIp('172.16.0.0').blockedReason, null);
  assert.notEqual(checkIp('172.31.255.255').blockedReason, null);
  assert.equal(checkIp('172.32.0.0').blockedReason, null);
  assert.equal(checkIp('172.15.255.255').blockedReason, null);
  assert.equal(checkIp('126.255.255.255').blockedReason, null);
  assert.equal(checkIp('128.0.0.0').blockedReason, null);
});
