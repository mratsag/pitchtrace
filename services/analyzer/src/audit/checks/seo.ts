import type { PageObservations } from '../observe.js';
import type { RawFinding } from '../../findings/catalog.js';

export const MIN_TITLE_LENGTH = 10;
export const MIN_DESCRIPTION_LENGTH = 40;

export function seoChecks(url: string, obs: PageObservations): RawFinding[] {
  const findings: RawFinding[] = [];

  const title = obs.title.trim();
  if (title.length < MIN_TITLE_LENGTH) {
    findings.push({
      code: 'SEO_MISSING_TITLE',
      url,
      evidence: {
        title,
        reason: title === '' ? 'no <title>' : `title shorter than ${MIN_TITLE_LENGTH} characters`,
      },
      metricName: 'title_length',
      metricValue: title.length,
      metricUnit: 'chars',
    });
  }

  const description = (obs.metaDescription ?? '').trim();
  if (obs.metaDescription === null || description.length < MIN_DESCRIPTION_LENGTH) {
    findings.push({
      code: 'SEO_MISSING_DESCRIPTION',
      url,
      evidence: {
        meta_present: obs.metaDescription !== null,
        description,
        reason:
          obs.metaDescription === null
            ? 'meta[name=description] missing'
            : `description shorter than ${MIN_DESCRIPTION_LENGTH} characters`,
      },
      metricName: 'description_length',
      metricValue: description.length,
      metricUnit: 'chars',
    });
  }

  if (obs.h1Count === 0) {
    findings.push({
      code: 'SEO_MISSING_H1',
      url,
      evidence: { h1_count: 0 },
      metricName: 'h1_count',
      metricValue: 0,
      metricUnit: 'count',
    });
  }

  return findings;
}
