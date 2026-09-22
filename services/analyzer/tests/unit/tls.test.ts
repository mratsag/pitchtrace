import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TLS_EXPIRY_WARNING_DAYS,
  evaluateCertificate,
  type CertificateInfo,
} from '../../src/audit/tls.js';

const NOW = new Date('2026-09-22T12:00:00Z');
const DAY = 86_400_000;

function cert(daysUntilExpiry: number): CertificateInfo {
  return {
    validFrom: new Date(NOW.getTime() - 200 * DAY),
    validTo: new Date(NOW.getTime() + daysUntilExpiry * DAY),
    issuer: 'Test CA',
    subject: 'ornek.test',
  };
}

const URL_UNDER_TEST = 'https://ornek.test/';

await test('pozitif: süresi dolmuş sertifika TECH_TLS_EXPIRED üretir', () => {
  const findings = evaluateCertificate(URL_UNDER_TEST, cert(-3), NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, 'TECH_TLS_EXPIRED');
  assert.equal(findings[0]!.evidence['days_overdue'], 3);
  assert.ok((findings[0]!.metricValue ?? 0) < 0);
});

await test('pozitif: yakında dolacak sertifika TECH_TLS_EXPIRING_SOON üretir', () => {
  const findings = evaluateCertificate(URL_UNDER_TEST, cert(10), NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, 'TECH_TLS_EXPIRING_SOON');
  assert.equal(findings[0]!.metricValue, 10);
  assert.equal(findings[0]!.metricUnit, 'days');
});

await test('negatif: geçerli sertifika bulgu üretmez', () => {
  assert.deepEqual(evaluateCertificate(URL_UNDER_TEST, cert(200), NOW), []);
});

await test('eşik sınırı: tam eşikte uyarı yok, bir gün altında var', () => {
  assert.deepEqual(evaluateCertificate(URL_UNDER_TEST, cert(TLS_EXPIRY_WARNING_DAYS), NOW), []);
  const justUnder = evaluateCertificate(URL_UNDER_TEST, cert(TLS_EXPIRY_WARNING_DAYS - 1), NOW);
  assert.equal(justUnder[0]?.code, 'TECH_TLS_EXPIRING_SOON');
});

await test('kanıtta sertifika alanları bulunur', () => {
  const findings = evaluateCertificate(URL_UNDER_TEST, cert(-1), NOW);
  assert.equal(findings[0]!.evidence['issuer'], 'Test CA');
  assert.equal(findings[0]!.evidence['subject'], 'ornek.test');
  assert.ok(typeof findings[0]!.evidence['valid_to'] === 'string');
});
