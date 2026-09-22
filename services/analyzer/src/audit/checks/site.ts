import type { PageObservations } from '../observe.js';
import type { RawFinding } from '../../findings/catalog.js';

/**
 * Kurumsal (rol tabanlı) e-posta ön ekleri. Yalnızca bu adresler kanıt olarak
 * saklanır; kişi adı taşıyan adresler sayılır ama KAYDEDİLMEZ.
 */
export const ROLE_EMAIL_PREFIXES = [
  'info',
  'iletisim',
  'contact',
  'bilgi',
  'sales',
  'satis',
  'destek',
  'support',
  'hello',
  'merhaba',
  'randevu',
  'appointment',
  'klinik',
  'admin',
  'office',
  'ofis',
  'muhasebe',
  'ik',
  'kariyer',
];

export function isRoleEmail(address: string): boolean {
  const local = address.split('@')[0]?.toLowerCase() ?? '';
  const normalized = local.replace(/[._-]?\d+$/, '');
  return ROLE_EMAIL_PREFIXES.includes(normalized);
}

export interface SitePage {
  url: string;
  observations: PageObservations;
}

export interface SiteInput {
  /** Bulguların bağlanacağı adres (ana sayfanın son URL'i). */
  siteUrl: string;
  pages: SitePage[];
}

/**
 * Site kapsamlı check'ler. "X yok" türü bulgular taranan TÜM sayfaların
 * toplamına bakılarak bir kez üretilir; tek bir sayfada bulunmaması siteye
 * ait bir eksiklik anlamına gelmez.
 */
export function siteChecks(input: SiteInput): RawFinding[] {
  const { siteUrl, pages } = input;
  if (pages.length === 0) return [];

  const findings: RawFinding[] = [];
  const pageUrls = pages.map((p) => p.url);

  // ── TECH_NO_HTTPS ──────────────────────────────────────────────────────
  if (siteUrl.startsWith('http://')) {
    findings.push({
      code: 'TECH_NO_HTTPS',
      url: siteUrl,
      evidence: {
        final_url: siteUrl,
        reason: 'site son adresinde https kullanılmıyor',
      },
    });
  }

  const allForms = pages.flatMap((p) => p.observations.contactForms);
  const allTel = pages.flatMap((p) => p.observations.telLinks);
  const allWhatsapp = pages.flatMap((p) => p.observations.whatsappLinks);
  const allBooking = pages.flatMap((p) => p.observations.bookingLinks);

  // ── CONV_* (yokluk gözlemleri) ─────────────────────────────────────────
  if (allForms.length === 0) {
    findings.push({
      code: 'CONV_NO_CONTACT_FORM',
      url: siteUrl,
      evidence: { pages_checked: pageUrls },
    });
  }
  if (allTel.length === 0) {
    findings.push({
      code: 'CONV_NO_TEL_LINK',
      url: siteUrl,
      evidence: { pages_checked: pageUrls },
    });
  }
  if (allWhatsapp.length === 0) {
    findings.push({
      code: 'CONV_NO_WHATSAPP_LINK',
      url: siteUrl,
      evidence: { pages_checked: pageUrls },
    });
  }
  if (allBooking.length === 0) {
    findings.push({
      code: 'CONV_NO_BOOKING_LINK',
      url: siteUrl,
      evidence: { pages_checked: pageUrls },
    });
  }

  // ── CONTACT_* ──────────────────────────────────────────────────────────
  const allEmails = [...new Set(pages.flatMap((p) => p.observations.emails))];
  const roleEmails = allEmails.filter(isRoleEmail);
  const otherCount = allEmails.length - roleEmails.length;

  if (roleEmails.length > 0) {
    findings.push({
      code: 'CONTACT_ROLE_EMAIL_FOUND',
      url: siteUrl,
      evidence: {
        // Yalnızca rol tabanlı adresler saklanır.
        addresses: roleEmails.slice(0, 5),
        non_role_addresses_seen: otherCount,
        note: 'kişi adı taşıyan adresler sayılır ama kaydedilmez',
      },
      metricName: 'role_emails',
      metricValue: roleEmails.length,
      metricUnit: 'count',
    });
  } else {
    findings.push({
      code: 'CONTACT_NO_EMAIL_FOUND',
      url: siteUrl,
      evidence: { pages_checked: pageUrls, non_role_addresses_seen: otherCount },
    });
  }

  // ── INF_NO_ONLINE_APPOINTMENT (çıkarım) ────────────────────────────────
  // Yalnızca iki gözlemin BİRLİKTE doğru olduğu durumda üretilir ve
  // taslakta yalnızca soru olarak kullanılabilir (validator V7).
  if (allBooking.length === 0 && allForms.length === 0) {
    findings.push({
      code: 'INF_NO_ONLINE_APPOINTMENT',
      url: siteUrl,
      evidence: {
        derived_from: ['CONV_NO_BOOKING_LINK', 'CONV_NO_CONTACT_FORM'],
        pages_checked: pageUrls,
      },
    });
  }

  return findings;
}
