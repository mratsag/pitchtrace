import type { Page } from 'playwright';

export interface PageMetrics {
  /** Time to first byte (ms). Ölçülemezse null. */
  ttfbMs: number | null;
  /** Largest Contentful Paint (ms). */
  lcpMs: number | null;
  /** Cumulative Layout Shift (birimsiz). */
  cls: number | null;
  /** Sayfanın toplam transfer boyutu (bayt). */
  transferBytes: number | null;
  resourceCount: number;
  /** Ölçümün açık kaldığı süre; LCP bu pencerenin ötesinde büyüyebilir. */
  measurementWindowMs: number | null;
  /** Ölçüm sırasında karşılaşılan sorunlar (kanıta yazılır). */
  notes: string[];
}

export const EMPTY_METRICS: PageMetrics = {
  ttfbMs: null,
  lcpMs: null,
  cls: null,
  transferBytes: null,
  resourceCount: 0,
  measurementWindowMs: null,
  notes: ['ölçüm yapılmadı'],
};

/**
 * LCP ve CLS gözlemcilerini sayfadaki HER script'ten önce kurar.
 * `AuditSession` bunu `addInitScript` ile bir kez kaydeder; her navigasyonda
 * yeniden çalışır, böylece ölçüm sayfa yüklenmeye başlarken devreye girer.
 */
export const VITALS_INIT_SCRIPT = `
(() => {
  const state = { lcp: 0, cls: 0, shifts: 0 };
  Object.defineProperty(window, '__pitchtraceVitals', {
    value: state,
    configurable: true,
    writable: false,
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime > state.lcp) state.lcp = entry.startTime;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { state.lcpError = String(e); }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          state.cls += entry.value;
          state.shifts += 1;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { state.clsError = String(e); }
})();
`;

interface RawVitals {
  lcp: number;
  cls: number;
  shifts: number;
  lcpError?: string;
  clsError?: string;
  ttfb: number | null;
  transferBytes: number | null;
  resourceCount: number;
  transferIncomplete: boolean;
}

/** Sayfa oturduktan sonra performans ölçümlerini okur. */
export async function readMetrics(page: Page, measurementWindowMs: number): Promise<PageMetrics> {
  const raw = await page.evaluate((): RawVitals => {
    const state = (window as unknown as { __pitchtraceVitals?: Record<string, number | string> })
      .__pitchtraceVitals;

    const navEntries = performance.getEntriesByType('navigation');
    const nav = navEntries[0] as PerformanceNavigationTiming | undefined;
    const ttfb = nav && nav.responseStart > 0 ? nav.responseStart : null;

    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    let transferBytes = nav ? (nav.transferSize ?? 0) : 0;
    let transferIncomplete = false;
    for (const resource of resources) {
      const size = resource.transferSize || resource.encodedBodySize || 0;
      if (size === 0) transferIncomplete = true;
      transferBytes += size;
    }

    return {
      lcp: typeof state?.['lcp'] === 'number' ? (state['lcp'] as number) : 0,
      cls: typeof state?.['cls'] === 'number' ? (state['cls'] as number) : 0,
      shifts: typeof state?.['shifts'] === 'number' ? (state['shifts'] as number) : 0,
      ...(typeof state?.['lcpError'] === 'string' ? { lcpError: state['lcpError'] } : {}),
      ...(typeof state?.['clsError'] === 'string' ? { clsError: state['clsError'] } : {}),
      ttfb,
      transferBytes,
      resourceCount: resources.length,
      transferIncomplete,
    };
  });

  const notes: string[] = [];
  if (raw.lcpError) notes.push(`LCP gözlemcisi kurulamadı: ${raw.lcpError}`);
  if (raw.clsError) notes.push(`CLS gözlemcisi kurulamadı: ${raw.clsError}`);
  if (raw.transferIncomplete) {
    // Cross-origin kaynaklar Timing-Allow-Origin yoksa 0 raporlar.
    notes.push('bazı kaynakların boyutu okunamadı; toplam transfer eksik olabilir');
  }

  return {
    ttfbMs: raw.ttfb === null ? null : Math.round(raw.ttfb),
    lcpMs: raw.lcp > 0 ? Math.round(raw.lcp) : null,
    cls: Math.round(raw.cls * 1000) / 1000,
    transferBytes: raw.transferBytes,
    resourceCount: raw.resourceCount,
    measurementWindowMs,
    notes,
  };
}
