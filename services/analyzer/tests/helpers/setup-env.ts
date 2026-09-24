import os from 'node:os';
import path from 'node:path';

/**
 * Bu modül, config.ts okunmadan ÖNCE yüklenmelidir.
 * Test dosyalarında ilk import satırı olarak yer alır.
 */
function setDefault(name: string, value: string): void {
  if (process.env[name] === undefined || process.env[name] === '') {
    process.env[name] = value;
  }
}

// Yerel fixture sunucusu 127.0.0.1'de çalışır. Bu bayrak SADECE loopback'i açar;
// 169.254.169.254 gibi link-local adresler bu bayrakla da engellidir.
setDefault('SSRF_ALLOW_LOOPBACK', '1');
setDefault('SSRF_PIN_DNS', '0');
setDefault('ANALYZER_API_KEY', 'test-key');
setDefault('PREVIEW_TOKEN_SECRET', 'test-only-preview-secret-at-least-32-characters');
setDefault(
  'DATABASE_URL',
  'postgres://pitchtrace:pitchtrace@127.0.0.1:5433/pitchtrace_test',
);
setDefault('ARTIFACT_ROOT', path.join(os.tmpdir(), 'pitchtrace-test-artifacts'));
setDefault('AUDIT_CONCURRENCY', '2');
setDefault('JOB_IDLE_POLL_MS', '100');
setDefault('NAV_TIMEOUT_MS', '15000');
setDefault('AUDIT_TIMEOUT_MS', '60000');
setDefault('PER_DOMAIN_MIN_INTERVAL_MS', '0');
// Performansa odaklanmayan testler ölçüm penceresini beklemesin.
setDefault('PERF_MEASURE_WINDOW_MS', '300');
setDefault('PERF_SETTLE_MS', '200');
setDefault('LOG_LEVEL', 'error');

export const TEST_ENV_READY = true;
