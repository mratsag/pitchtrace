import assert from 'node:assert/strict';
import test from 'node:test';
import { PERF_DEFAULTS } from '../../src/config.js';
import {
  performanceChecks,
  type PerfThresholds,
} from '../../src/audit/checks/performance.js';
import type { PageMetrics } from '../../src/audit/metrics.js';

const URL_UNDER_TEST = 'https://ornek.test/';

const THRESHOLDS: PerfThresholds = {
  ttfbSlowMs: PERF_DEFAULTS.ttfbSlowMs,
  lcpSlowMs: PERF_DEFAULTS.lcpSlowMs,
  clsHigh: PERF_DEFAULTS.clsHigh,
  pageWeightHighBytes: PERF_DEFAULTS.pageWeightHighBytes,
};

function metrics(overrides: Partial<PageMetrics> = {}): PageMetrics {
  return {
    ttfbMs: 100,
    lcpMs: 900,
    cls: 0.01,
    transferBytes: 400_000,
    resourceCount: 8,
    measurementWindowMs: 5000,
    notes: [],
    ...overrides,
  };
}

function codes(m: PageMetrics): string[] {
  return performanceChecks({ url: URL_UNDER_TEST, metrics: m, thresholds: THRESHOLDS })
    .map((f) => f.code)
    .sort();
}

await test('üretim eşikleri tasarımdaki değerlerdir', () => {
  assert.equal(PERF_DEFAULTS.ttfbSlowMs, 800);
  assert.equal(PERF_DEFAULTS.lcpSlowMs, 4000);
  assert.equal(PERF_DEFAULTS.clsHigh, 0.25);
  assert.equal(PERF_DEFAULTS.pageWeightHighBytes, 3 * 1024 * 1024);
});

await test('negatif: hızlı sayfa hiçbir PERF bulgusu üretmez', () => {
  assert.deepEqual(codes(metrics()), []);
});

await test('pozitif/negatif: PERF_TTFB_SLOW', () => {
  assert.ok(codes(metrics({ ttfbMs: 1200 })).includes('PERF_TTFB_SLOW'));
  assert.ok(!codes(metrics({ ttfbMs: 800 })).includes('PERF_TTFB_SLOW'), 'tam eşikte üretilmemeli');
  assert.ok(codes(metrics({ ttfbMs: 801 })).includes('PERF_TTFB_SLOW'));
});

await test('pozitif/negatif: PERF_LCP_SLOW', () => {
  assert.ok(codes(metrics({ lcpMs: 5200 })).includes('PERF_LCP_SLOW'));
  assert.ok(!codes(metrics({ lcpMs: 4000 })).includes('PERF_LCP_SLOW'), 'tam eşikte üretilmemeli');
  assert.ok(codes(metrics({ lcpMs: 4001 })).includes('PERF_LCP_SLOW'));
});

await test('pozitif/negatif: PERF_CLS_HIGH', () => {
  assert.ok(codes(metrics({ cls: 0.4 })).includes('PERF_CLS_HIGH'));
  assert.ok(!codes(metrics({ cls: 0.25 })).includes('PERF_CLS_HIGH'), 'tam eşikte üretilmemeli');
  assert.ok(codes(metrics({ cls: 0.26 })).includes('PERF_CLS_HIGH'));
});

await test('pozitif/negatif: PERF_PAGE_WEIGHT_HIGH', () => {
  const mb = 1024 * 1024;
  assert.ok(codes(metrics({ transferBytes: 5 * mb })).includes('PERF_PAGE_WEIGHT_HIGH'));
  assert.ok(!codes(metrics({ transferBytes: 3 * mb })).includes('PERF_PAGE_WEIGHT_HIGH'));
});

await test('ölçülemeyen metrikler bulgu üretmez', () => {
  assert.deepEqual(
    codes(metrics({ ttfbMs: null, lcpMs: null, cls: null, transferBytes: null })),
    [],
  );
});

await test('metrik değeri ve birimi kanıta yazılır', () => {
  const findings = performanceChecks({
    url: URL_UNDER_TEST,
    metrics: metrics({ lcpMs: 5200 }),
    thresholds: THRESHOLDS,
  });
  const lcp = findings.find((f) => f.code === 'PERF_LCP_SLOW');
  assert.equal(lcp?.metricValue, 5200);
  assert.equal(lcp?.metricUnit, 'ms');
  assert.equal(lcp?.evidence['threshold_ms'], 4000);
  assert.equal(lcp?.evidence['measured_url'], URL_UNDER_TEST);
});

await test('ölçüm notları kanıta taşınır', () => {
  const findings = performanceChecks({
    url: URL_UNDER_TEST,
    metrics: metrics({ lcpMs: 9000, notes: ['bazı kaynakların boyutu okunamadı'] }),
    thresholds: THRESHOLDS,
  });
  assert.deepEqual(findings[0]!.evidence['measurement_notes'], [
    'bazı kaynakların boyutu okunamadı',
  ]);
});

await test('PSI verisi kanıta eklenir ama bulgu OLUŞTURMAZ', () => {
  const psi = { source: 'crux' as const, lcpMs: 9000, clsScore: 0.5, inpMs: 400, overallCategory: 'SLOW' };

  // Hızlı ölçüm + kötü PSI → yine de bulgu yok.
  const none = performanceChecks({
    url: URL_UNDER_TEST,
    metrics: metrics(),
    thresholds: THRESHOLDS,
    psi,
  });
  assert.deepEqual(none, []);

  // Yavaş ölçüm → bulgu var ve PSI kanıta eklenmiş.
  const withFinding = performanceChecks({
    url: URL_UNDER_TEST,
    metrics: metrics({ lcpMs: 6000 }),
    thresholds: THRESHOLDS,
    psi,
  });
  assert.equal(withFinding[0]!.code, 'PERF_LCP_SLOW');
  assert.deepEqual(withFinding[0]!.evidence['psi'], psi);
});

await test('PSI yoksa kanıtta psi alanı bulunmaz', () => {
  const findings = performanceChecks({
    url: URL_UNDER_TEST,
    metrics: metrics({ lcpMs: 6000 }),
    thresholds: THRESHOLDS,
    psi: null,
  });
  assert.ok(!('psi' in findings[0]!.evidence));
});
