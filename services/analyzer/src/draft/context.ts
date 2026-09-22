import { getFindingDefinition } from '../findings/catalog.js';

export interface ContextFinding {
  id: string; code: string; severity: string; confidence: string; url: string | null;
  evidence: Record<string, unknown>; metric_name: string | null; metric_value: string | null;
  metric_unit: string | null; artifact_id: string | null;
}

export function presentFinding(f: ContextFinding): Record<string, unknown> {
  const def = getFindingDefinition(f.code);
  const metric = f.metric_value === null ? null : {
    name: f.metric_name, value: Number(f.metric_value), unit: f.metric_unit,
    // LCP is the last observed paint inside a finite measurement window. Outreach
    // must not turn it into false precision: the safe phrasing is a lower bound.
    wording: f.code === 'PERF_LCP_SLOW' ? `en az ${Number(f.metric_value)} ${f.metric_unit ?? 'ms'}` : undefined,
  };
  return { ...f, metric, label: def.label, outreach_eligible: def.outreachEligible };
}
