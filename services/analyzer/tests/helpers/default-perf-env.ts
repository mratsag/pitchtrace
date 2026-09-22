/**
 * Üretim davranışına yakın bir ölçüm penceresi kurar (varsayılan formül:
 * lcpSlowMs + 1000 = 5000 ms). `setup-env.js` diğer testlerde pencereyi kısa
 * tuttuğu için bu modül ondan ÖNCE import edilmelidir.
 */
process.env['PERF_MEASURE_WINDOW_MS'] = '5500';
export const DEFAULT_PERF_WINDOW_MS = 5500;
