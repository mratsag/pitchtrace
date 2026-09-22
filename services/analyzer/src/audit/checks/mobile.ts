import { OBSERVE_THRESHOLDS, type PageObservations } from '../observe.js';
import type { RawFinding } from '../../findings/catalog.js';

/** MOB_TAP_TARGET_SMALL için gereken en az ihlal sayısı. */
export const MIN_SMALL_TAP_TARGETS = 3;
/** MOB_TEXT_TOO_SMALL için küçük metin oranı eşiği. */
export const SMALL_TEXT_RATIO_THRESHOLD = 0.2;
/** Oran hesabının anlamlı olması için gereken en az metin düğümü. */
export const MIN_TEXT_NODES_FOR_RATIO = 5;

export function mobileChecks(url: string, obs: PageObservations): RawFinding[] {
  const findings: RawFinding[] = [];

  // ── MOB_NO_VIEWPORT ────────────────────────────────────────────────────
  const content = obs.viewportContent;
  const hasWidth = content !== null && /(^|[;,\s])width\s*=/i.test(content);
  if (!hasWidth) {
    findings.push({
      code: 'MOB_NO_VIEWPORT',
      url,
      evidence: {
        meta_present: content !== null,
        viewport_content: content,
        reason: content === null ? 'meta[name=viewport] missing' : 'content has no width=',
      },
    });
  }

  // ── MOB_HORIZONTAL_OVERFLOW ────────────────────────────────────────────
  // Kıyas, emüle edilen cihaz genişliğine (375px) göre yapılır.
  // window.innerWidth mobil emülasyonda layout viewport'u raporladığı için
  // (viewport meta yokken 980px gibi) güvenilir bir taban değildir.
  const overflowPx = obs.scrollWidth - obs.deviceWidth;
  if (overflowPx > 4) {
    findings.push({
      code: 'MOB_HORIZONTAL_OVERFLOW',
      url,
      evidence: {
        scroll_width: obs.scrollWidth,
        viewport_width: obs.deviceWidth,
        layout_viewport_width: obs.innerWidth,
        offending_selectors: obs.overflowSelectors,
      },
      metricName: 'horizontal_overflow',
      metricValue: overflowPx,
      metricUnit: 'px',
    });
  }

  // ── MOB_TAP_TARGET_SMALL ───────────────────────────────────────────────
  if (obs.smallTapTargets.total >= MIN_SMALL_TAP_TARGETS) {
    findings.push({
      code: 'MOB_TAP_TARGET_SMALL',
      url,
      evidence: {
        count: obs.smallTapTargets.total,
        minimum_px: OBSERVE_THRESHOLDS.MIN_TAP_TARGET_PX,
        samples: obs.smallTapTargets.samples,
      },
      metricName: 'small_tap_targets',
      metricValue: obs.smallTapTargets.total,
      metricUnit: 'count',
    });
  }

  // ── MOB_FORM_FIELD_OVERFLOW ────────────────────────────────────────────
  if (obs.overflowingFormFields.length > 0) {
    findings.push({
      code: 'MOB_FORM_FIELD_OVERFLOW',
      url,
      evidence: {
        viewport_width: obs.deviceWidth,
        samples: obs.overflowingFormFields,
      },
      metricName: 'overflowing_form_fields',
      metricValue: obs.overflowingFormFields.length,
      metricUnit: 'count',
    });
  }

  // ── MOB_TEXT_TOO_SMALL ─────────────────────────────────────────────────
  const { totalNodes, smallNodes, samples } = obs.smallText;
  if (totalNodes >= MIN_TEXT_NODES_FOR_RATIO) {
    const ratio = smallNodes / totalNodes;
    if (ratio >= SMALL_TEXT_RATIO_THRESHOLD) {
      findings.push({
        code: 'MOB_TEXT_TOO_SMALL',
        url,
        evidence: {
          small_nodes: smallNodes,
          total_nodes: totalNodes,
          minimum_px: OBSERVE_THRESHOLDS.MIN_READABLE_FONT_PX,
          samples,
        },
        metricName: 'small_text_ratio',
        metricValue: Math.round(ratio * 100) / 100,
        metricUnit: 'ratio',
      });
    }
  }

  // ── MOB_FIXED_WIDTH_LAYOUT ─────────────────────────────────────────────
  const widest = obs.fixedWidthContainers[0];
  if (widest !== undefined) {
    findings.push({
      code: 'MOB_FIXED_WIDTH_LAYOUT',
      url,
      evidence: {
        threshold_px: OBSERVE_THRESHOLDS.FIXED_WIDTH_THRESHOLD_PX,
        viewport_width: obs.deviceWidth,
        samples: obs.fixedWidthContainers,
      },
      metricName: 'container_width',
      metricValue: widest.width ?? 0,
      metricUnit: 'px',
    });
  }

  return findings;
}
