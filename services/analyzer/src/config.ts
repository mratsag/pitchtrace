import path from 'node:path';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Sayfa başına hard ceiling. Kullanıcı yalnızca düşürebilir. */
export const PAGE_LIMIT_CEILING = 5;
/** Eşzamanlı audit hard ceiling. Config bunu aşamaz. */
export const AUDIT_CONCURRENCY_CEILING = 2;
/** Domain başına minimum istek aralığı (üretim varsayılanı). */
export const PER_DOMAIN_MIN_INTERVAL_DEFAULT_MS = 1_000;
export const PREVIEW_TTL_DEFAULT_SECONDS = 600;
export const PREVIEW_TTL_MAX_SECONDS = 900;
export const PREVIEW_REFRESH_TTL_DEFAULT_SECONDS = 3600;
export const PREVIEW_REFRESH_TTL_MAX_SECONDS = 7200;

/**
 * Performans eşiklerinin ÜRETİM varsayılanları (docs/design §7.3).
 * Testler bu değerleri ölçeklendirebilir; varsayılanlar ayrıca test edilir.
 */
export const PERF_DEFAULTS = {
  ttfbSlowMs: 800,
  lcpSlowMs: 4_000,
  clsHigh: 0.25,
  pageWeightHighBytes: 3 * 1024 * 1024,
} as const;

export const ANALYZER_VERSION = str('ANALYZER_VERSION', '0.1.0-alpha.7');

export const config = {
  version: ANALYZER_VERSION,
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8080),
  databaseUrl: str('DATABASE_URL', ''),
  apiKey: str('ANALYZER_API_KEY', ''),

  /** Tek process içindeki worker loop sayısı; ceiling 2. */
  auditConcurrency: Math.min(
    Math.max(int('AUDIT_CONCURRENCY', 2), 1),
    AUDIT_CONCURRENCY_CEILING,
  ),
  shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 30_000),
  staleLockMs: int('STALE_LOCK_MS', 10 * 60_000),
  jobIdlePollMs: int('JOB_IDLE_POLL_MS', 1_000),

  artifactRoot: path.resolve(str('ARTIFACT_ROOT', '/data')),
  artifactRetentionDays: int('ARTIFACT_RETENTION_DAYS', 30),
  previewTokenSecret: str('PREVIEW_TOKEN_SECRET', ''),
  previewTokenTtlSeconds: Math.min(
    Math.max(int('PREVIEW_TOKEN_TTL_SECONDS', PREVIEW_TTL_DEFAULT_SECONDS), 60),
    PREVIEW_TTL_MAX_SECONDS,
  ),
  previewRefreshTtlSeconds: Math.min(
    Math.max(int('PREVIEW_REFRESH_TTL_SECONDS', PREVIEW_REFRESH_TTL_DEFAULT_SECONDS), 300),
    PREVIEW_REFRESH_TTL_MAX_SECONDS,
  ),
  publicBaseUrl: str('PUBLIC_BASE_URL', ''),
  auditEnabled: bool('AUDIT_ENABLED', true),
  draftExportEnabled: bool('DRAFT_EXPORT_ENABLED', true),

  /** Güvenlik limitleri — docs/design §2.5 */
  navTimeoutMs: int('NAV_TIMEOUT_MS', 20_000),
  auditTimeoutMs: int('AUDIT_TIMEOUT_MS', 90_000),
  maxRedirects: int('MAX_REDIRECTS', 5),
  maxRobotsBytes: int('MAX_ROBOTS_BYTES', 512 * 1024),
  maxSitemapBytes: int('MAX_SITEMAP_BYTES', 2 * 1024 * 1024),
  maxHtmlBytes: int('MAX_HTML_BYTES', 3 * 1024 * 1024),
  maxAssetBytes: int('MAX_ASSET_BYTES', 5 * 1024 * 1024),
  maxTotalBytes: int('MAX_TOTAL_BYTES', 10 * 1024 * 1024),
  perDomainMinIntervalMs: int('PER_DOMAIN_MIN_INTERVAL_MS', PER_DOMAIN_MIN_INTERVAL_DEFAULT_MS),

  /** Performans eşikleri. */
  perfTtfbSlowMs: int('PERF_TTFB_SLOW_MS', PERF_DEFAULTS.ttfbSlowMs),
  perfLcpSlowMs: int('PERF_LCP_SLOW_MS', PERF_DEFAULTS.lcpSlowMs),
  perfClsHigh: num('PERF_CLS_HIGH', PERF_DEFAULTS.clsHigh),
  perfPageWeightHighBytes: int('PERF_PAGE_WEIGHT_HIGH_BYTES', PERF_DEFAULTS.pageWeightHighBytes),
  /** LCP/CLS'in oturması için load sonrası beklenen en az süre. */
  perfSettleMs: int('PERF_SETTLE_MS', 1_200),
  /**
   * Navigasyon başlangıcından itibaren ölçümün açık kaldığı toplam süre.
   * 0 ise `lcpSlowMs + 1000` kullanılır: pencere eşikten kısa olursa yavaş bir
   * sitenin LCP'si hiç görülmez ve PERF_LCP_SLOW sessizce kaçırılır.
   */
  perfMeasureWindowMs: int('PERF_MEASURE_WINDOW_MS', 0),
  /** Ölçüm yapılan sayfanın load durumunu bekleme süresi. */
  perfLoadWaitMs: int('PERF_LOAD_WAIT_MS', 8_000),

  /** Opsiyonel PageSpeed Insights zenginleştirmesi; anahtar yoksa atlanır. */
  psiApiKey: str('PSI_API_KEY', ''),
  psiTimeoutMs: int('PSI_TIMEOUT_MS', 20_000),

  /**
   * SADECE TEST İÇİN. Yalnızca 127.0.0.0/8 ve ::1 serbest bırakılır.
   * Link-local (169.254/16, metadata dahil), private ve reserved aralıklar
   * bu bayrakla da açılmaz.
   */
  ssrfAllowLoopback: bool('SSRF_ALLOW_LOOPBACK', false),
  /** DNS rebinding pini (--host-resolver-rules). */
  ssrfPinDns: bool('SSRF_PIN_DNS', true),

  userAgent: str(
    'CRAWLER_USER_AGENT',
    'PitchTraceBot/0.1 (+https://github.com/mratsag/pitchtrace)',
  ),
  /** Sayfa render'ında kullanılan mobil UA (375x812 emülasyonu ile tutarlı). */
  mobileUserAgent: str(
    'RENDER_USER_AGENT',
    'PitchTraceBot/0.1 (+https://github.com/mratsag/pitchtrace)',
  ),
  chromiumNoSandbox: bool('CHROMIUM_NO_SANDBOX', true),
  /**
   * Sertifika hataları render'ı durdurmaz. Gerekçe: süresi dolmuş sertifikası
   * olan bir site tam da tespit etmek istediğimiz durumdur; katı davranırsak
   * audit çöker ve TECH_TLS_EXPIRED bulgusu hiç üretilemez. Analyzer sayfaya
   * kimlik bilgisi göndermez, yalnızca ölçüm yapar. Sertifikanın kendisi
   * ayrıca tls.connect ile okunur ve bulguya dönüşür.
   */
  tlsIgnoreErrors: bool('TLS_IGNORE_ERRORS', true),
} as const;

export const MOBILE_VIEWPORT = { width: 375, height: 812 } as const;

export function assertRuntimeConfig(): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (!config.apiKey) throw new Error('ANALYZER_API_KEY is required');
  if (process.env.NODE_ENV === 'production') {
    if (config.apiKey.startsWith('change-me') || config.apiKey.length < 32) {
      throw new Error('ANALYZER_API_KEY must be a non-placeholder secret of at least 32 characters');
    }
    if (!config.previewTokenSecret || config.previewTokenSecret.startsWith('change-me') || config.previewTokenSecret.length < 32) {
      throw new Error('PREVIEW_TOKEN_SECRET must be a non-placeholder secret of at least 32 characters');
    }
  }
  if (config.ssrfAllowLoopback && process.env.NODE_ENV === 'production') {
    throw new Error('SSRF_ALLOW_LOOPBACK must not be enabled in production');
  }
}
