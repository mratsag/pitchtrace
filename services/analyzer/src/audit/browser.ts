import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { MOBILE_VIEWPORT, config } from '../config.js';
import { SsrfGuard } from '../security/ssrf.js';
import { pinnedRequest, PinnedRequestError } from '../security/pinned-request.js';
import { collectObservations, type PageObservations } from './observe.js';
import { EMPTY_METRICS, VITALS_INIT_SCRIPT, readMetrics, type PageMetrics } from './metrics.js';

export type { PageObservations, PageLink } from './observe.js';
export type { PageMetrics } from './metrics.js';

export class RenderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface RenderResult {
  finalUrl: string;
  httpStatus: number | null;
  loadMs: number;
  /** Oturum başlangıcından bu yana toplam transfer (audit bütçesi). */
  bytesTransferred: number;
  observations: PageObservations;
  /** Yalnızca measurePerformance ile istendiğinde doldurulur. */
  metrics: PageMetrics;
  screenshot: Buffer;
  /** Bu sayfa render edilirken yapılan alt kaynak istekleri (mixed content kontrolü). */
  subresourceUrls: string[];
  /** Güvenlik nedeniyle engellenen alt kaynaklar; audit'i düşürmez. */
  blockedResources: BlockedResource[];
}

export interface BlockedResource { url: string; code: string; resourceType: string; }

export interface SessionOptions {
  /** Doğrulanmış hostname → IP pini (DNS rebinding savunması). */
  pinnedHost?: { hostname: string; address: string };
  allowLoopback: boolean;
  /** Varsayılan config.tlsIgnoreErrors; bkz. config.ts'teki gerekçe. */
  ignoreHttpsErrors?: boolean;
}

export interface RenderOptions extends SessionOptions {
  entryUrl: string;
}

export interface RenderPageOptions {
  /**
   * LCP/CLS'in oturması için ek bekleme yapıp performans ölçümlerini okur.
   * Maliyetli olduğu için yalnızca ana sayfada kullanılır (PERF bulguları
   * site kapsamlıdır ve ana sayfa üzerinden üretilir).
   */
  measurePerformance?: boolean;
}

interface RenderState {
  abortCode: string | null;
  navigationError: string | null;
  mainFinalUrl: string | null;
  subresourceUrls: string[];
  blockedResources: BlockedResource[];
}

function freshState(): RenderState {
  return { abortCode: null, navigationError: null, mainFinalUrl: null, subresourceUrls: [], blockedResources: [] };
}

function chromiumArgs(options: SessionOptions): string[] {
  const args = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
  ];
  if (config.chromiumNoSandbox) {
    // docs/design §2.6 — container non-root çalıştığı için kayıtlı taviz.
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  if (config.ssrfPinDns && options.pinnedHost) {
    args.push(
      `--host-resolver-rules=MAP ${options.pinnedHost.hostname} ${options.pinnedHost.address}`,
    );
  }
  return args;
}

/**
 * Tek audit boyunca yaşayan sertleştirilmiş tarayıcı oturumu.
 * Sayfa başına yeni tarayıcı açmak yerine aynı context yeniden kullanılır;
 * toplam transfer bütçesi oturum genelinde uygulanır.
 */
export class AuditSession {
  private state: RenderState = freshState();
  private totalBytes = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly guard: SsrfGuard,
  ) {}

  static async open(options: SessionOptions): Promise<AuditSession> {
    const guard = new SsrfGuard({ allowLoopback: options.allowLoopback });
    const browser = await chromium.launch({ args: chromiumArgs(options) });
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        viewport: { ...MOBILE_VIEWPORT },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: config.mobileUserAgent,
      serviceWorkers: 'block',
        acceptDownloads: false,
        javaScriptEnabled: true,
        ignoreHTTPSErrors: options.ignoreHttpsErrors ?? config.tlsIgnoreErrors,
      });
      const page = await context.newPage();
      const session = new AuditSession(browser, context, page, guard);
      await session.install();
      return session;
    } catch (err) {
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw err;
    }
  }

  get bytesTransferred(): number {
    return this.totalBytes;
  }

  private async install(): Promise<void> {
    const { page, context, guard } = this;

    // Web Vitals gözlemcileri sayfadaki her script'ten önce kurulmalıdır.
    await context.addInitScript(VITALS_INIT_SCRIPT);

    // Popup'lar anında kapatılır (docs/design §2.6).
    // 'page' olayı newPage() için de tetiklendiğinden ana sayfa hariç tutulur.
    context.on('page', (extra: Page) => {
      if (extra === page) return;
      void extra.close().catch(() => undefined);
    });

    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('download', (download) => void download.cancel().catch(() => undefined));

    // WebSocket v0.1'de desteklenmez. HTTP route katmanını atlayabilen ayrı
    // bir bağlantı türü olduğundan ağ bağlantısı kurulmadan kapatılır.
    await context.routeWebSocket(/.*/, (webSocket) => webSocket.close());

    page.on('response', (response) => {
      const length = Number.parseInt(response.headers()['content-length'] ?? '', 10);
      if (!Number.isFinite(length)) return;
      if (length > config.maxAssetBytes) {
        this.state.abortCode ??= 'RESPONSE_TOO_LARGE';
        return;
      }
      this.totalBytes += length;
      if (this.totalBytes > config.maxTotalBytes) {
        this.state.abortCode ??= 'RESPONSE_TOO_LARGE';
      }
    });

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();

      if (this.state.abortCode !== null) return route.abort('blockedbyclient');
      if (!/^https?:/i.test(url)) {
        if (!['about:blank', 'data:'].some((scheme) => url.startsWith(scheme))) {
          this.state.blockedResources.push({ url, code: 'SCHEME_BLOCKED', resourceType: request.resourceType() });
        }
        return route.abort('blockedbyclient');
      }

      let isMainNavigation = false;
      if (request.isNavigationRequest()) {
        // Popup'ın ilk isteği frame oluşturulmadan gelebilir. Böyle bir istek
        // ana audit navigasyonu değildir ve alt kaynak politikasına tabidir.
        try { isMainNavigation = request.frame() === page.mainFrame(); } catch { isMainNavigation = false; }
      }

      if (!isMainNavigation && this.state.subresourceUrls.length < 200) this.state.subresourceUrls.push(url);
      try {
        const response = await pinnedRequest(url, {
          guard, maxRedirects: config.maxRedirects, maxBytes: config.maxAssetBytes,
          timeoutMs: config.navTimeoutMs, ignoreHttpsErrors: config.tlsIgnoreErrors,
          method: request.method(), headers: request.headers(), body: request.postDataBuffer(),
        });
        if (isMainNavigation) this.state.mainFinalUrl = response.finalUrl;
        return route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      } catch (err) {
        const failure = err instanceof PinnedRequestError ? err : new PinnedRequestError('HTTP_ERROR', url, (err as Error).message);
        if (isMainNavigation) {
          this.state.abortCode = failure.code;
          this.state.navigationError = failure.message;
          return route.abort('blockedbyclient');
        }
        if (this.state.blockedResources.length < 200) {
          this.state.blockedResources.push({ url: failure.url, code: failure.code, resourceType: request.resourceType() });
        }
        return route.abort('blockedbyclient');
      }
    });
  }

  /** Tek bir sayfayı açar, gözlemleri ve viewport screenshot'ını döndürür. */
  async render(url: string, options: RenderPageOptions = {}): Promise<RenderResult> {
    this.state = freshState();
    const { page } = this;
    this.guard.allowLoopbackOrigin(url);

    const startedAt = Date.now();
    let status: number | null = null;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.navTimeoutMs,
      });
      status = response?.status() ?? null;
    } catch (err) {
      throw classifyNavigationError(err as Error, this.state);
    }
    if (this.state.abortCode !== null) {
      throw new RenderError(this.state.abortCode, `navigation blocked: ${this.state.abortCode}`);
    }

    // Yerleşimin oturması için bekleme; başarısız olursa devam edilir.
    const loadTimeout = options.measurePerformance ? config.perfLoadWaitMs : 5_000;
    await page.waitForLoadState('load', { timeout: loadTimeout }).catch(() => undefined);
    const loadMs = Date.now() - startedAt;

    let metrics = EMPTY_METRICS;
    if (options.measurePerformance) {
      // Ölçüm penceresi LCP eşiğinden KISA olmamalı; aksi halde gerçekten
      // yavaş bir sayfanın LCP'si hiç boyanmadan ölçüm kapanır ve bulgu
      // sessizce kaçırılır.
      const windowMs =
        config.perfMeasureWindowMs > 0
          ? config.perfMeasureWindowMs
          : config.perfLcpSlowMs + 1_000;
      const waitUntil = startedAt + Math.max(config.perfSettleMs, windowMs);
      const remaining = waitUntil - Date.now();
      if (remaining > 0) await page.waitForTimeout(remaining);

      metrics = await readMetrics(page, windowMs).catch(() => ({
        ...EMPTY_METRICS,
        notes: ['performans ölçümü okunamadı'],
      }));
    }

    const observations = await collectObservations(page);
    if (observations.htmlBytes > config.maxHtmlBytes) {
      throw new RenderError(
        'RESPONSE_TOO_LARGE',
        `html ${observations.htmlBytes} bytes exceeds ${config.maxHtmlBytes}`,
      );
    }

    // Yalnızca viewport; fullPage screenshot yasaktır (docs/design §2.6).
    const screenshot = await page.screenshot({ fullPage: false, type: 'png' });

    return {
      // Redirect zinciri route katmanında çözüldüğü için page.url() giriş
      // adresinde kalır; gerçek son adres mainFinalUrl'dir.
      finalUrl: this.state.mainFinalUrl ?? page.url(),
      httpStatus: status,
      loadMs,
      bytesTransferred: this.totalBytes,
      observations,
      metrics,
      screenshot,
      subresourceUrls: [...this.state.subresourceUrls],
      blockedResources: [...this.state.blockedResources],
    };
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
    this.guard.clear();
  }
}

/** Tek sayfalık kısayol: oturum aç, render et, kapat. */
export async function renderPage(
  options: RenderOptions & RenderPageOptions,
): Promise<RenderResult> {
  const session = await AuditSession.open(options);
  try {
    return await session.render(options.entryUrl, {
      measurePerformance: options.measurePerformance ?? false,
    });
  } finally {
    await session.close();
  }
}

function classifyNavigationError(err: Error, state: RenderState): RenderError {
  if (state.abortCode) return new RenderError(state.abortCode, state.navigationError ?? err.message);
  const message = err.message;
  if (/Timeout .* exceeded/i.test(message)) return new RenderError('TIMEOUT', message);
  if (/ERR_TOO_MANY_REDIRECTS/.test(message)) return new RenderError('TOO_MANY_REDIRECTS', message);
  if (/ERR_CERT|SSL|ERR_TLS/i.test(message)) return new RenderError('TLS_FAILURE', message);
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return new RenderError('DNS_FAILURE', message);
  if (/ERR_CONNECTION|ERR_EMPTY_RESPONSE|ERR_ADDRESS/i.test(message)) {
    return new RenderError('HTTP_ERROR', message);
  }
  return new RenderError('RENDER_CRASH', message);
}
