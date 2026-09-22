import { config } from '../../config.js';
import type { RawFinding } from '../../findings/catalog.js';
import type { PageMetrics } from '../metrics.js';
import type { PsiFieldData } from '../psi.js';

export interface PerfThresholds {
  ttfbSlowMs: number;
  lcpSlowMs: number;
  clsHigh: number;
  pageWeightHighBytes: number;
}

export function thresholdsFromConfig(): PerfThresholds {
  return {
    ttfbSlowMs: config.perfTtfbSlowMs,
    lcpSlowMs: config.perfLcpSlowMs,
    clsHigh: config.perfClsHigh,
    pageWeightHighBytes: config.perfPageWeightHighBytes,
  };
}

export interface PerformanceCheckInput {
  /** Ölçümün yapıldığı sayfa (ana sayfa). */
  url: string;
  metrics: PageMetrics;
  thresholds?: PerfThresholds;
  /** Opsiyonel PageSpeed Insights alan verisi; yalnızca kanıtı zenginleştirir. */
  psi?: PsiFieldData | null;
}

/**
 * PERF bulguları site kapsamlıdır ve ana sayfada yapılan ölçümden üretilir.
 * PSI verisi bir bulgunun oluşup oluşmayacağını ASLA değiştirmez; yalnızca
 * kanıta gerçek kullanıcı verisi ekler.
 */
export function performanceChecks(input: PerformanceCheckInput): RawFinding[] {
  const { url, metrics } = input;
  const thresholds = input.thresholds ?? thresholdsFromConfig();
  const findings: RawFinding[] = [];

  const baseEvidence = {
    measured_url: url,
    resource_count: metrics.resourceCount,
    ...(metrics.measurementWindowMs !== null
      ? { measurement_window_ms: metrics.measurementWindowMs }
      : {}),
    ...(metrics.notes.length > 0 ? { measurement_notes: metrics.notes } : {}),
    ...(input.psi ? { psi: input.psi } : {}),
  };

  if (metrics.ttfbMs !== null && metrics.ttfbMs > thresholds.ttfbSlowMs) {
    findings.push({
      code: 'PERF_TTFB_SLOW',
      url,
      evidence: { ...baseEvidence, threshold_ms: thresholds.ttfbSlowMs },
      metricName: 'ttfb',
      metricValue: metrics.ttfbMs,
      metricUnit: 'ms',
    });
  }

  if (metrics.lcpMs !== null && metrics.lcpMs > thresholds.lcpSlowMs) {
    findings.push({
      code: 'PERF_LCP_SLOW',
      url,
      evidence: { ...baseEvidence, threshold_ms: thresholds.lcpSlowMs },
      metricName: 'lcp',
      metricValue: metrics.lcpMs,
      metricUnit: 'ms',
    });
  }

  if (metrics.cls !== null && metrics.cls > thresholds.clsHigh) {
    findings.push({
      code: 'PERF_CLS_HIGH',
      url,
      evidence: { ...baseEvidence, threshold: thresholds.clsHigh },
      metricName: 'cls',
      metricValue: metrics.cls,
      metricUnit: 'score',
    });
  }

  if (metrics.transferBytes !== null && metrics.transferBytes > thresholds.pageWeightHighBytes) {
    findings.push({
      code: 'PERF_PAGE_WEIGHT_HIGH',
      url,
      evidence: {
        ...baseEvidence,
        threshold_bytes: thresholds.pageWeightHighBytes,
        transfer_bytes: metrics.transferBytes,
      },
      metricName: 'page_weight',
      metricValue: Math.round((metrics.transferBytes / (1024 * 1024)) * 100) / 100,
      metricUnit: 'MB',
    });
  }

  return findings;
}
