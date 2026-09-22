export type ClaimType = 'assertion' | 'question' | 'neutral';
export type ClaimConfidence = 'observed' | 'inferred';

export interface DraftClaimInput {
  text: string;
  claim_type: ClaimType;
  confidence: ClaimConfidence;
  finding_ids: string[];
}

export interface DraftOutput {
  language: 'tr' | 'en';
  subject: string;
  greeting: string;
  claims: DraftClaimInput[];
  closing: string;
}

export const OUTREACH_DRAFT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'OutreachDraftOutput',
  type: 'object', additionalProperties: false,
  required: ['language', 'subject', 'greeting', 'claims', 'closing'],
  properties: {
    language: { enum: ['tr', 'en'] },
    subject: { type: 'string', minLength: 10, maxLength: 90 },
    greeting: { type: 'string', maxLength: 120 },
    claims: {
      type: 'array', minItems: 2, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['text', 'claim_type', 'confidence', 'finding_ids'],
        properties: {
          text: { type: 'string', minLength: 15, maxLength: 320 },
          claim_type: { enum: ['assertion', 'question', 'neutral'] },
          confidence: { enum: ['observed', 'inferred'] },
          finding_ids: { type: 'array', maxItems: 3, items: { type: 'string', format: 'uuid' } },
        },
      },
    },
    closing: { type: 'string', maxLength: 240 },
  },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function schemaErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['V1: output must be an object'];
  const v = value as Record<string, unknown>;
  const allowed = new Set(['language', 'subject', 'greeting', 'claims', 'closing']);
  if (Object.keys(v).some((k) => !allowed.has(k))) return ['V1: additional property'];
  if (!['tr', 'en'].includes(String(v.language))) return ['V1: invalid language'];
  if (typeof v.subject !== 'string' || v.subject.length < 10 || v.subject.length > 90) return ['V1: invalid subject'];
  if (typeof v.greeting !== 'string' || v.greeting.length > 120) return ['V1: invalid greeting'];
  if (typeof v.closing !== 'string' || v.closing.length > 240) return ['V1: invalid closing'];
  if (!Array.isArray(v.claims) || v.claims.length < 2 || v.claims.length > 6) return ['V1: invalid claims'];
  for (const claim of v.claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return ['V1: invalid claim'];
    const c = claim as Record<string, unknown>;
    const keys = new Set(['text', 'claim_type', 'confidence', 'finding_ids']);
    if (Object.keys(c).some((k) => !keys.has(k)) || typeof c.text !== 'string' || c.text.length < 15 || c.text.length > 320 ||
        !['assertion','question','neutral'].includes(String(c.claim_type)) || !['observed','inferred'].includes(String(c.confidence)) ||
        !Array.isArray(c.finding_ids) || c.finding_ids.length > 3 || c.finding_ids.some((id) => typeof id !== 'string' || !UUID.test(id))) {
      return ['V1: invalid claim'];
    }
  }
  return [];
}
