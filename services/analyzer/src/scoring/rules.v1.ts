import { FINDING_CATALOG, type FindingDefinition } from '../findings/catalog.js';

export const RULE_VERSION = 'scoring.v1';

/** docs/design §11 — bileşen tavanları, toplamı 100. */
export const CAPS = {
  technical: 25,
  mobile: 20,
  conversion: 20,
  serviceFit: 20,
  contact: 15,
} as const;

/** Önem derecesine göre puan. Her kod bir kez sayılır. */
export const SEVERITY_POINTS = { high: 8, medium: 5, low: 2 } as const;

/**
 * İletişim adresi bulunamadıysa toplam bu değeri aşamaz.
 * Gerekçe: kurumsal bir adres yoksa fırsat eyleme dönüşemez — ne kadar çok
 * teknik problem bulursak bulalım gönderecek bir yer yoktur.
 * Kampanya varsayılan eşiği 70 olduğu için bu sınır fırsatı otomatik olarak
 * eşiğin altında bırakır.
 */
export const NO_CONTACT_TOTAL_CAP = 49;

export interface ScoreBreakdown {
  technical: number;
  mobile: number;
  conversion: number;
  service_fit: number;
  contact: number;
  /** Negatif veya 0. Bileşenler toplamının total'a eşit kalmasını sağlar. */
  no_contact_penalty: number;
}

export interface ScoreDetails {
  /** Puana katkı veren kodlar (tekilleştirilmiş). */
  counted_codes: string[];
  /** Kaydedilmiş ama puana katılmayan kodlar ve nedeni. */
  excluded: Array<{ code: string; reason: string }>;
  /** service_fit eşleşmeleri. */
  service_fit_matches: Array<{ code: string; points: number }>;
  has_contact: boolean;
}

export interface ScoreResult {
  total: number;
  breakdown: ScoreBreakdown;
  details: ScoreDetails;
  ruleVersion: string;
}

export interface ScoreInput {
  /** Audit'in ürettiği bulgu kodları; tekrarlar önemsizdir. */
  codes: string[];
  /** Kampanyanın "bunu biz çözebiliyoruz" ağırlıkları: kod → puan. */
  serviceFit?: Record<string, number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Bir kodun puana katılıp katılmayacağını belirler.
 *
 * Üç dışlama kuralı vardır:
 *  1. Katalogda olmayan kod — asla sayılmaz.
 *  2. `experimental` kod — outreach'te iddia olarak kullanılamadığı için
 *     e-posta yazıp yazmama kararını veren puanı da yükseltmemelidir.
 *  3. `inferred` bulgu — zaten sayılan gözlemlerden türetilir; saymak aynı
 *     problemi iki kez puanlamak olur.
 */
function exclusionReason(code: string): string | null {
  const def = FINDING_CATALOG[code];
  if (!def) return 'katalogda yok';
  if (def.status !== 'stable') return 'experimental — outreach’te kullanılamaz';
  if (def.confidence !== 'observed') return 'inferred — türetildiği gözlemler zaten sayılıyor';
  return null;
}

function componentOf(def: FindingDefinition): keyof ScoreBreakdown | null {
  switch (def.category) {
    // SEO eksikleri de teknik/bulunabilirlik kovasına girer (docs/design §11).
    case 'TECH':
    case 'PERF':
    case 'SEO':
      return 'technical';
    case 'MOBILE':
      return 'mobile';
    case 'CONV':
    case 'INF':
      return 'conversion';
    case 'CONTACT':
      // İletişim bileşeni problem sayısıyla değil, ulaşılabilirlikle ölçülür.
      return null;
    default:
      return null;
  }
}

/**
 * Fırsat puanı. Saf fonksiyondur: aynı girdi her zaman aynı sonucu verir.
 *
 * Tekilleştirme: bir kod kaç sayfada görülürse görülsün BİR kez sayılır.
 * Beş sayfalık crawl'da aynı mobil sorunu beş kez puanlamak, tek sayfalık bir
 * siteye göre haksız bir avantaj/dezavantaj yaratırdı.
 */
export function scoreFindings(input: ScoreInput): ScoreResult {
  const unique = [...new Set(input.codes)].sort();
  const serviceFit = input.serviceFit ?? {};

  const counted: string[] = [];
  const excluded: Array<{ code: string; reason: string }> = [];

  let technical = 0;
  let mobile = 0;
  let conversion = 0;

  for (const code of unique) {
    const reason = exclusionReason(code);
    if (reason !== null) {
      excluded.push({ code, reason });
      continue;
    }
    counted.push(code);

    const def = FINDING_CATALOG[code]!;
    const component = componentOf(def);
    if (component === null) continue;

    const points = SEVERITY_POINTS[def.severity];
    if (component === 'technical') technical += points;
    else if (component === 'mobile') mobile += points;
    else if (component === 'conversion') conversion += points;
  }

  // ── İletişim güvenilirliği ───────────────────────────────────────────────
  const hasContact = unique.includes('CONTACT_ROLE_EMAIL_FOUND');
  const contact = hasContact ? CAPS.contact : 0;

  // ── Hizmet uyumu ─────────────────────────────────────────────────────────
  const serviceFitMatches: Array<{ code: string; points: number }> = [];
  let serviceFitTotal = 0;
  for (const code of counted) {
    const raw = serviceFit[code];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    const points = clamp(raw, 0, CAPS.serviceFit);
    serviceFitMatches.push({ code, points });
    serviceFitTotal += points;
  }

  const breakdownBase = {
    technical: clamp(Math.round(technical), 0, CAPS.technical),
    mobile: clamp(Math.round(mobile), 0, CAPS.mobile),
    conversion: clamp(Math.round(conversion), 0, CAPS.conversion),
    service_fit: clamp(Math.round(serviceFitTotal), 0, CAPS.serviceFit),
    contact,
  };

  const subtotal =
    breakdownBase.technical +
    breakdownBase.mobile +
    breakdownBase.conversion +
    breakdownBase.service_fit +
    breakdownBase.contact;

  const total = hasContact ? subtotal : Math.min(subtotal, NO_CONTACT_TOTAL_CAP);
  const noContactPenalty = total - subtotal;

  return {
    total,
    breakdown: { ...breakdownBase, no_contact_penalty: noContactPenalty },
    details: {
      counted_codes: counted,
      excluded,
      service_fit_matches: serviceFitMatches,
      has_contact: hasContact,
    },
    ruleVersion: RULE_VERSION,
  };
}

export function breakdownSum(breakdown: ScoreBreakdown): number {
  return (
    breakdown.technical +
    breakdown.mobile +
    breakdown.conversion +
    breakdown.service_fit +
    breakdown.contact +
    breakdown.no_contact_penalty
  );
}
