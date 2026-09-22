import { getFindingDefinition } from '../findings/catalog.js';
import { renderBody } from './render.js';
import { schemaErrors, type DraftOutput } from './schema.js';

export interface ValidationFinding {
  id: string; audit_id: string; company_id: string; code: string;
  confidence: 'observed' | 'inferred' | 'manual'; url: string | null;
  metric_value: number | string | null; metric_unit: string | null;
}
export interface ValidationContext {
  auditId: string; companyId: string; normalizedDomain: string; auditFinalUrl: string | null;
  campaignLanguage: 'tr' | 'en'; contactEmail: string; suppressed: boolean;
  companyName: string; findings: ValidationFinding[];
}
export interface ValidationResult { valid: boolean; errors: string[]; warnings: string[]; body: string; }

const FORBIDDEN = [/\bgaranti\b/i, /\bkesin(?:likle)?\b/i, /\bmutlaka\b/i, /\byüzde yüz\b/i,
  /\bguaranteed?\b/i, /\bdefinitely\b/i, /\ben iyi\b/i, /\brakipleriniz\b/i];
const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const NUMBER_RE = /(?<![\p{L}\d])\d+(?:[.,]\d+)?/gu;

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function validateDraft(raw: unknown, ctx: ValidationContext): ValidationResult {
  const errors = schemaErrors(raw);
  if (errors.length) return { valid: false, errors, warnings: [], body: '' };
  const draft = raw as DraftOutput;
  const findings = new Map(ctx.findings.map((f) => [f.id, f]));
  const used = new Map<string, number>();

  if (!draft.claims.some((c) => c.claim_type === 'assertion')) errors.push('V2: at least one assertion is required');
  if (draft.language !== ctx.campaignLanguage) errors.push('V13: language differs from campaign');
  if (ctx.suppressed) errors.push('V14: contact or domain is suppressed');

  for (const claim of draft.claims) {
    if (claim.claim_type === 'assertion' && claim.finding_ids.length === 0) errors.push('V3: assertion requires a finding');
    const linked = claim.finding_ids.map((id) => findings.get(id));
    if (linked.some((f) => !f)) errors.push('V4: finding does not exist');
    const present = linked.filter((f): f is ValidationFinding => Boolean(f));
    if (present.some((f) => f.audit_id !== ctx.auditId)) errors.push('V5: finding belongs to another audit');
    if (present.some((f) => f.company_id !== ctx.companyId)) errors.push('V6: finding belongs to another company');
    if (present.some((f) => f.confidence === 'inferred') && claim.claim_type !== 'question') errors.push('V7: inferred finding must be a question');
    const weakest = present.some((f) => f.confidence === 'inferred') ? 'inferred' : 'observed';
    if (present.length && claim.confidence !== weakest) errors.push('V8: claim confidence does not match findings');

    const metrics = present.flatMap((f) => f.metric_value === null ? [] : [Number(f.metric_value)]).filter(Number.isFinite);
    for (const token of claim.text.match(NUMBER_RE) ?? []) {
      const n = Number(token.replace(',', '.'));
      if (!metrics.some((m) => Math.abs(m - n) <= Math.max(Math.abs(m) * 0.05, 0.01))) errors.push(`V9: unsupported number ${token}`);
    }
    const urls = new Set(present.flatMap((f) => f.url ? [f.url] : []));
    for (const url of claim.text.match(URL_RE) ?? []) if (!urls.has(url.replace(/[.,;!?]+$/, ''))) errors.push(`V10: unsupported URL ${url}`);
    if (claim.claim_type === 'neutral' && ((claim.text.match(NUMBER_RE)?.length ?? 0) > 0 || /https?:\/\//i.test(claim.text) || claim.text.toLocaleLowerCase('tr').includes(ctx.companyName.toLocaleLowerCase('tr')))) errors.push('V11: neutral claim contains a factual statement');
    if (FORBIDDEN.some((p) => p.test(claim.text))) errors.push('V12: forbidden expression');
    for (const f of present) {
      used.set(f.id, (used.get(f.id) ?? 0) + 1);
      try { if (!getFindingDefinition(f.code).outreachEligible) errors.push('V16: finding is not outreach eligible'); }
      catch { errors.push('V16: unknown finding code'); }
    }
  }

  const finalDomain = domainOf(ctx.auditFinalUrl);
  if (finalDomain && finalDomain !== ctx.normalizedDomain.toLowerCase().replace(/^www\./, '')) errors.push('V6: audit domain differs from company');
  const body = renderBody(draft);
  if (body.length > 1400 || draft.subject.length > 90) errors.push('V15: message is too long');
  const warnings: string[] = [];
  if (!draft.claims.some((c) => c.claim_type === 'question')) warnings.push('W1: no question claim');
  if (draft.claims.length < 3 || draft.claims.length > 5) warnings.push('W2: prefer 3–5 claims');
  if ([...used.values()].some((n) => n > 1)) warnings.push('W3: finding reused across claims');
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings, body };
}
