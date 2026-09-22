/**
 * Performans ölçüm hattını gerçek tarayıcıda makul sürede doğrulayabilmek için
 * eşikleri ölçekler. Bu modül `setup-env.js`'ten ÖNCE import edilmelidir;
 * node --test her dosyayı ayrı süreçte çalıştırdığı için diğer testleri etkilemez.
 *
 * ÜRETİM varsayılanları (TTFB 800 ms, LCP 4000 ms, CLS 0.25, 3 MB)
 * `tests/unit/performance.test.ts` içinde ayrıca doğrulanır; ayrıca
 * `tests/integration/perf-defaults.test.ts` varsayılan eşiklerle gerçek bir
 * yavaş sayfayı ölçer.
 */
export const SCALED = {
  ttfbSlowMs: 300,
  lcpSlowMs: 700,
  clsHigh: 0.1,
  pageWeightHighBytes: 1_000_000,
} as const;

process.env['PERF_TTFB_SLOW_MS'] = String(SCALED.ttfbSlowMs);
process.env['PERF_LCP_SLOW_MS'] = String(SCALED.lcpSlowMs);
process.env['PERF_CLS_HIGH'] = String(SCALED.clsHigh);
process.env['PERF_PAGE_WEIGHT_HIGH_BYTES'] = String(SCALED.pageWeightHighBytes);
process.env['PERF_SETTLE_MS'] = '1500';
process.env['PERF_MEASURE_WINDOW_MS'] = '1700';
