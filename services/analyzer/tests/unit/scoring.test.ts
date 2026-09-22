import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPS,
  NO_CONTACT_TOTAL_CAP,
  RULE_VERSION,
  SEVERITY_POINTS,
  breakdownSum,
  scoreFindings,
} from '../../src/scoring/rules.v1.js';
import { FINDING_CATALOG, listFindingCodes } from '../../src/findings/catalog.js';

const CONTACT = 'CONTACT_ROLE_EMAIL_FOUND';

await test('bileşen tavanları 100 eder', () => {
  const sum = CAPS.technical + CAPS.mobile + CAPS.conversion + CAPS.serviceFit + CAPS.contact;
  assert.equal(sum, 100);
});

await test('bulgu yoksa yalnızca iletişim bileşeni puan verir', () => {
  const withContact = scoreFindings({ codes: [CONTACT] });
  assert.equal(withContact.total, CAPS.contact);
  assert.equal(withContact.breakdown.technical, 0);
  assert.equal(withContact.breakdown.no_contact_penalty, 0);

  const empty = scoreFindings({ codes: [] });
  assert.equal(empty.total, 0);
});

await test('toplam her zaman 0–100 aralığındadır', () => {
  const everything = listFindingCodes();
  const serviceFit = Object.fromEntries(everything.map((c) => [c, 20]));
  const result = scoreFindings({ codes: everything, serviceFit });
  assert.ok(result.total >= 0 && result.total <= 100, `total=${result.total}`);
  for (const value of Object.values(result.breakdown)) {
    assert.ok(Number.isInteger(value), 'bileşenler tamsayı olmalı');
  }
});

await test('bileşenlerin toplamı her zaman total’a eşittir', () => {
  const cases: string[][] = [
    [],
    [CONTACT],
    ['MOB_NO_VIEWPORT'],
    ['MOB_NO_VIEWPORT', 'TECH_NO_HTTPS', 'CONV_NO_CONTACT_FORM'],
    listFindingCodes(),
    ['CONTACT_NO_EMAIL_FOUND', ...listFindingCodes().filter((c) => c !== CONTACT)],
  ];
  for (const codes of cases) {
    const result = scoreFindings({ codes, serviceFit: { MOB_NO_VIEWPORT: 10 } });
    assert.equal(
      breakdownSum(result.breakdown),
      result.total,
      `breakdown toplamı uyuşmuyor: ${JSON.stringify(result.breakdown)}`,
    );
  }
});

await test('deterministik: aynı girdi aynı sonucu verir, sıralama etkilemez', () => {
  const a = scoreFindings({ codes: ['MOB_NO_VIEWPORT', 'TECH_NO_HTTPS', CONTACT] });
  const b = scoreFindings({ codes: [CONTACT, 'TECH_NO_HTTPS', 'MOB_NO_VIEWPORT'] });
  assert.deepEqual(a, b);
  assert.equal(a.ruleVersion, RULE_VERSION);
});

await test('tekilleştirme: bir kod kaç sayfada görülürse görülsün bir kez sayılır', () => {
  const once = scoreFindings({ codes: ['MOB_NO_VIEWPORT', CONTACT] });
  const fiveTimes = scoreFindings({
    codes: ['MOB_NO_VIEWPORT', 'MOB_NO_VIEWPORT', 'MOB_NO_VIEWPORT', 'MOB_NO_VIEWPORT', 'MOB_NO_VIEWPORT', CONTACT],
  });
  assert.deepEqual(once, fiveTimes);
  assert.equal(once.breakdown.mobile, SEVERITY_POINTS.high);
});

await test('experimental kodlar puana katkı vermez', () => {
  // PERF_CLS_HIGH experimental olduğu için puanı değiştirmemeli.
  assert.equal(FINDING_CATALOG['PERF_CLS_HIGH']?.status, 'experimental');
  const without = scoreFindings({ codes: [CONTACT, 'TECH_NO_HTTPS'] });
  const withExperimental = scoreFindings({ codes: [CONTACT, 'TECH_NO_HTTPS', 'PERF_CLS_HIGH'] });
  assert.equal(withExperimental.total, without.total);
  assert.ok(
    withExperimental.details.excluded.some((e) => e.code === 'PERF_CLS_HIGH'),
    'dışlama gerekçesi kaydedilmemiş',
  );
});

await test('inferred bulgular puana katkı vermez (çifte sayım engellenir)', () => {
  const observedOnly = scoreFindings({
    codes: [CONTACT, 'CONV_NO_BOOKING_LINK', 'CONV_NO_CONTACT_FORM'],
  });
  const withInferred = scoreFindings({
    codes: [CONTACT, 'CONV_NO_BOOKING_LINK', 'CONV_NO_CONTACT_FORM', 'INF_NO_ONLINE_APPOINTMENT'],
  });
  assert.equal(withInferred.total, observedOnly.total);
  assert.ok(
    withInferred.details.excluded.some((e) => e.code === 'INF_NO_ONLINE_APPOINTMENT'),
  );
});

await test('bilinmeyen kod sayılmaz ve gerekçesi kaydedilir', () => {
  const result = scoreFindings({ codes: [CONTACT, 'UYDURMA_KOD'] });
  assert.equal(result.total, CAPS.contact);
  assert.deepEqual(
    result.details.excluded.map((e) => e.code),
    ['UYDURMA_KOD'],
  );
});

await test('iletişim adresi yoksa bileşen 0 ve toplam eşiğin altında kalır', () => {
  const codes = listFindingCodes().filter((c) => c !== CONTACT);
  const result = scoreFindings({
    codes,
    serviceFit: Object.fromEntries(codes.map((c) => [c, 20])),
  });

  assert.equal(result.breakdown.contact, 0);
  assert.equal(result.details.has_contact, false);
  assert.ok(result.total <= NO_CONTACT_TOTAL_CAP, `total=${result.total}`);
  // Kampanya varsayılan eşiği 70.
  assert.ok(result.total < 70, 'iletişimsiz fırsat eşiği geçmemeli');
  assert.ok(result.breakdown.no_contact_penalty < 0, 'ceza bileşeni yazılmamış');
});

await test('iletişim adresi varsa tavan uygulanmaz', () => {
  const result = scoreFindings({ codes: [CONTACT, 'MOB_NO_VIEWPORT', 'TECH_NO_HTTPS'] });
  assert.equal(result.breakdown.no_contact_penalty, 0);
  assert.equal(result.breakdown.contact, CAPS.contact);
});

await test('bileşenler kendi tavanlarını aşamaz', () => {
  const mobileCodes = listFindingCodes().filter((c) => c.startsWith('MOB_'));
  const result = scoreFindings({ codes: [...mobileCodes, CONTACT] });
  assert.equal(result.breakdown.mobile, CAPS.mobile);
});

await test('service_fit yalnızca mevcut ve sayılan kodlara uygulanır', () => {
  const present = scoreFindings({
    codes: [CONTACT, 'MOB_NO_VIEWPORT'],
    serviceFit: { MOB_NO_VIEWPORT: 12, TECH_NO_HTTPS: 20 },
  });
  assert.equal(present.breakdown.service_fit, 12);
  assert.deepEqual(present.details.service_fit_matches, [{ code: 'MOB_NO_VIEWPORT', points: 12 }]);

  // Bulunmayan kod için ağırlık verilse de puan eklenmez.
  const absent = scoreFindings({ codes: [CONTACT], serviceFit: { MOB_NO_VIEWPORT: 12 } });
  assert.equal(absent.breakdown.service_fit, 0);
});

await test('service_fit experimental koda uygulanmaz ve tavanı aşamaz', () => {
  const experimental = scoreFindings({
    codes: [CONTACT, 'PERF_CLS_HIGH'],
    serviceFit: { PERF_CLS_HIGH: 20 },
  });
  assert.equal(experimental.breakdown.service_fit, 0);

  const overflow = scoreFindings({
    codes: [CONTACT, 'MOB_NO_VIEWPORT', 'TECH_NO_HTTPS'],
    serviceFit: { MOB_NO_VIEWPORT: 20, TECH_NO_HTTPS: 20 },
  });
  assert.equal(overflow.breakdown.service_fit, CAPS.serviceFit);
});

await test('service_fit’te geçersiz değerler yok sayılır', () => {
  const result = scoreFindings({
    codes: [CONTACT, 'MOB_NO_VIEWPORT', 'TECH_NO_HTTPS', 'SEO_MISSING_H1'],
    serviceFit: {
      MOB_NO_VIEWPORT: Number.NaN,
      TECH_NO_HTTPS: -5,
      SEO_MISSING_H1: 3,
    } as Record<string, number>,
  });
  assert.equal(result.breakdown.service_fit, 3);
});

await test('SEO ve PERF bulguları teknik bileşene yazılır', () => {
  const seo = scoreFindings({ codes: ['SEO_MISSING_TITLE'] });
  assert.equal(seo.breakdown.technical, SEVERITY_POINTS.high);
  assert.equal(seo.breakdown.mobile, 0);

  const perf = scoreFindings({ codes: ['PERF_LCP_SLOW'] });
  assert.equal(perf.breakdown.technical, SEVERITY_POINTS.high);
});

await test('gerçekçi senaryo: eski, mobil uyumsuz, iletişimi olan klinik sitesi', () => {
  const result = scoreFindings({
    codes: [
      'MOB_NO_VIEWPORT',
      'MOB_HORIZONTAL_OVERFLOW',
      'TECH_NO_HTTPS',
      'SEO_MISSING_DESCRIPTION',
      'CONV_NO_CONTACT_FORM',
      'CONV_NO_BOOKING_LINK',
      'INF_NO_ONLINE_APPOINTMENT',
      CONTACT,
    ],
    serviceFit: { MOB_NO_VIEWPORT: 8, CONV_NO_CONTACT_FORM: 6 },
  });

  // mobile: 8+8=16 · technical: 8+5=13 · conversion: 8+5=13 (INF sayılmaz)
  // service_fit: 8+6=14 · contact: 15  → toplam 71
  assert.equal(result.breakdown.mobile, 2 * SEVERITY_POINTS.high);
  assert.equal(result.breakdown.technical, SEVERITY_POINTS.high + SEVERITY_POINTS.medium);
  assert.equal(result.breakdown.conversion, SEVERITY_POINTS.high + SEVERITY_POINTS.medium);
  assert.equal(result.breakdown.service_fit, 14);
  assert.equal(result.breakdown.contact, CAPS.contact);
  assert.equal(result.total, 71);
  assert.equal(breakdownSum(result.breakdown), result.total);
  assert.ok(result.total >= 70, `eşiği geçmeliydi: ${result.total}`);
  assert.ok(!result.details.counted_codes.includes('INF_NO_ONLINE_APPOINTMENT'));
});
