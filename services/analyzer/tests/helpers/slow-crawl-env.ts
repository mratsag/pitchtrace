/**
 * Domain hız sınırının gerçek bir crawl'da uygulandığını ölçmek için
 * aralığı 400 ms'e çeker. Bu modül `setup-env.js`'ten ÖNCE import edilmelidir;
 * node --test her test dosyasını ayrı bir süreçte çalıştırdığı için bu ayar
 * diğer testleri etkilemez.
 *
 * Üretim varsayılanı (1000 ms) `tests/unit/rate-limiter.test.ts` içinde
 * ayrıca doğrulanır.
 */
process.env['PER_DOMAIN_MIN_INTERVAL_MS'] = '400';

export const SLOW_CRAWL_INTERVAL_MS = 400;
