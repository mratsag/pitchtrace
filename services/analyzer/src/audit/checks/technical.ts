import type { PageObservations } from '../observe.js';
import type { RawFinding } from '../../findings/catalog.js';

/** jQuery bu majör sürümün altındaysa eski sayılır. */
export const MIN_JQUERY_MAJOR = 3;

export interface TechnicalCheckInput {
  url: string;
  observations: PageObservations;
  /** Sayfa render edilirken yapılan alt kaynak istekleri. */
  subresourceUrls: string[];
}

/** Sayfa kapsamlı teknik check'ler. Origin/TLS kontrolleri site kapsamındadır. */
export function technicalChecks(input: TechnicalCheckInput): RawFinding[] {
  const { url, observations: obs } = input;
  const findings: RawFinding[] = [];

  // ── TECH_MIXED_CONTENT ─────────────────────────────────────────────────
  // Yalnızca HTTPS sayfalar için anlamlıdır.
  if (url.startsWith('https://')) {
    const insecure = input.subresourceUrls.filter((candidate) => candidate.startsWith('http://'));
    if (insecure.length > 0) {
      findings.push({
        code: 'TECH_MIXED_CONTENT',
        url,
        evidence: { count: insecure.length, samples: insecure.slice(0, 5) },
        metricName: 'insecure_subresources',
        metricValue: insecure.length,
        metricUnit: 'count',
      });
    }
  }

  // ── TECH_DOCUMENT_WRITE ────────────────────────────────────────────────
  if (obs.usesDocumentWrite) {
    findings.push({
      code: 'TECH_DOCUMENT_WRITE',
      url,
      evidence: {
        snippet: obs.documentWriteSnippet,
        note: 'yalnızca sayfa kaynağındaki satır içi scriptler taranır',
      },
    });
  }

  // ── TECH_JQUERY_OUTDATED ───────────────────────────────────────────────
  const version = obs.jqueryVersion;
  if (version !== null) {
    const major = Number.parseInt(version.split('.')[0] ?? '', 10);
    if (Number.isFinite(major) && major < MIN_JQUERY_MAJOR) {
      findings.push({
        code: 'TECH_JQUERY_OUTDATED',
        url,
        evidence: { version, minimum_major: MIN_JQUERY_MAJOR },
        metricName: 'jquery_major',
        metricValue: major,
        metricUnit: 'version',
      });
    }
  }

  // ── TECH_TABLE_LAYOUT ──────────────────────────────────────────────────
  if (obs.layoutTables.count > 0) {
    findings.push({
      code: 'TECH_TABLE_LAYOUT',
      url,
      evidence: {
        count: obs.layoutTables.count,
        samples: obs.layoutTables.samples,
        rule: 'th/caption/role içermeyen ve iç içe tablo barındıran tablolar',
      },
      metricName: 'layout_tables',
      metricValue: obs.layoutTables.count,
      metricUnit: 'count',
    });
  }

  // ── TECH_LEGACY_PLUGIN ─────────────────────────────────────────────────
  if (obs.legacyPlugins.length > 0) {
    findings.push({
      code: 'TECH_LEGACY_PLUGIN',
      url,
      evidence: { samples: obs.legacyPlugins },
      metricName: 'legacy_plugins',
      metricValue: obs.legacyPlugins.length,
      metricUnit: 'count',
    });
  }

  return findings;
}
