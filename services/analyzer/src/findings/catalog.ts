export type FindingCategory = 'MOBILE' | 'TECH' | 'PERF' | 'SEO' | 'CONV' | 'CONTACT' | 'INF';
export type FindingSeverity = 'low' | 'medium' | 'high';
export type FindingConfidence = 'observed' | 'inferred' | 'manual';

/**
 * page: her taranan sayfa için ayrı değerlendirilir, bulgu o sayfanın URL'ine bağlanır.
 * site: tüm taranan sayfaların toplamı üzerinden bir kez değerlendirilir.
 *       "İletişim formu yok" gibi YOKLUK bulguları site kapsamlıdır; tek sayfada
 *       bulunmaması siteye ait bir eksiklik anlamına gelmez.
 */
export type FindingScope = 'page' | 'site';

export interface FindingDefinition {
  code: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  scope: FindingScope;
  /**
   * stable: outreach taslağında iddia olarak kullanılabilir.
   * experimental: kaydedilir ve insana gösterilir, iddia üretemez (validator V16).
   */
  status: 'stable' | 'experimental';
  outreachEligible: boolean;
  /** İnsan tarafından okunabilir kısa açıklama (docs/finding-codes.md kaynağı). */
  label: string;
}

function define(def: Omit<FindingDefinition, 'outreachEligible'>): FindingDefinition {
  return { ...def, outreachEligible: def.status === 'stable' };
}

const DEFINITIONS: FindingDefinition[] = [
  // ── MOBILE (sayfa kapsamlı, 375x812 emülasyon) ───────────────────────────
  define({
    code: 'MOB_NO_VIEWPORT',
    category: 'MOBILE',
    severity: 'high',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Mobil viewport meta etiketi yok veya width tanımlamıyor',
  }),
  define({
    code: 'MOB_HORIZONTAL_OVERFLOW',
    category: 'MOBILE',
    severity: 'high',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Sayfa 375px genişlikte yatay olarak taşıyor',
  }),
  define({
    code: 'MOB_TAP_TARGET_SMALL',
    category: 'MOBILE',
    severity: 'medium',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Parmakla dokunulamayacak kadar küçük (44px altı) tıklanabilir alanlar var',
  }),
  define({
    code: 'MOB_FORM_FIELD_OVERFLOW',
    category: 'MOBILE',
    severity: 'high',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Form alanı mobil ekranın dışına taşıyor',
  }),
  define({
    code: 'MOB_TEXT_TOO_SMALL',
    category: 'MOBILE',
    severity: 'medium',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Metnin önemli bölümü mobilde 12px altında',
  }),
  define({
    code: 'MOB_FIXED_WIDTH_LAYOUT',
    category: 'MOBILE',
    severity: 'medium',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Sayfa sabit masaüstü genişliğinde (980px+) kurgulanmış',
  }),

  // ── TECH ─────────────────────────────────────────────────────────────────
  define({
    code: 'TECH_NO_HTTPS',
    category: 'TECH',
    severity: 'high',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Site HTTPS üzerinden sunulmuyor',
  }),
  define({
    code: 'TECH_TLS_EXPIRED',
    category: 'TECH',
    severity: 'high',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'SSL sertifikasının süresi dolmuş',
  }),
  define({
    code: 'TECH_TLS_EXPIRING_SOON',
    category: 'TECH',
    severity: 'medium',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'SSL sertifikasının süresi 21 günden az kaldı',
  }),
  define({
    code: 'TECH_MIXED_CONTENT',
    category: 'TECH',
    severity: 'high',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'HTTPS sayfada güvensiz (http://) kaynak yükleniyor',
  }),
  define({
    code: 'TECH_DOCUMENT_WRITE',
    category: 'TECH',
    severity: 'low',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Sayfa document.write() kullanıyor',
  }),
  define({
    code: 'TECH_JQUERY_OUTDATED',
    category: 'TECH',
    severity: 'low',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Eski jQuery sürümü (3.x öncesi) kullanılıyor',
  }),
  define({
    code: 'TECH_TABLE_LAYOUT',
    category: 'TECH',
    severity: 'medium',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Sayfa yerleşimi iç içe tablolarla kurulmuş',
  }),
  define({
    code: 'TECH_LEGACY_PLUGIN',
    category: 'TECH',
    severity: 'medium',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Artık desteklenmeyen eklenti içeriği (Flash/Silverlight) var',
  }),

  // ── PERF (site kapsamlı; ana sayfada ölçülür) ────────────────────────────
  define({
    code: 'PERF_TTFB_SLOW',
    category: 'PERF',
    severity: 'medium',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Sunucu ilk yanıtı yavaş (TTFB 800 ms üzeri)',
  }),
  define({
    code: 'PERF_LCP_SLOW',
    category: 'PERF',
    severity: 'high',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Ana içerik mobilde geç görünüyor (LCP 4 saniye üzeri)',
  }),
  define({
    code: 'PERF_CLS_HIGH',
    category: 'PERF',
    severity: 'medium',
    confidence: 'observed',
    scope: 'site',
    // EXPERIMENTAL: Chromium bu çalışma ortamında (hem headless shell hem tam
    // binary, hem Windows hem Linux container) layout-shift girdisi HİÇ
    // raporlamıyor — büyük ve belirgin bir kayma için bile. LCP aynı gözlemci
    // üzerinden çalışıyor, yani kurulum doğru. Ölçemediğimiz bir şeyi iddia
    // olarak kullanamayız; kod ölçmeye devam eder ama validator (V16) bu
    // bulguya dayanan iddiaları reddeder. Bkz. docs/security-notes.md.
    status: 'experimental',
    label: 'Sayfa yüklenirken içerik kayıyor (CLS 0.25 üzeri) — ölçüm doğrulanamadı',
  }),
  define({
    code: 'PERF_PAGE_WEIGHT_HIGH',
    category: 'PERF',
    severity: 'medium',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Sayfa ağırlığı mobil bağlantı için yüksek (3 MB üzeri)',
  }),

  // ── SEO ──────────────────────────────────────────────────────────────────
  define({
    code: 'SEO_MISSING_TITLE',
    category: 'SEO',
    severity: 'high',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Sayfa başlığı (title) yok veya 10 karakterden kısa',
  }),
  define({
    code: 'SEO_MISSING_DESCRIPTION',
    category: 'SEO',
    severity: 'medium',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Meta description yok veya 40 karakterden kısa',
  }),
  define({
    code: 'SEO_MISSING_H1',
    category: 'SEO',
    severity: 'low',
    confidence: 'observed',
    scope: 'page',
    status: 'stable',
    label: 'Sayfada h1 başlığı yok',
  }),

  // ── CONV (site kapsamlı yokluk gözlemleri) ───────────────────────────────
  define({
    code: 'CONV_NO_CONTACT_FORM',
    category: 'CONV',
    severity: 'high',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Taranan sayfaların hiçbirinde iletişim formu yok',
  }),
  define({
    code: 'CONV_NO_TEL_LINK',
    category: 'CONV',
    severity: 'medium',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Tıklanabilir telefon bağlantısı (tel:) yok',
  }),
  define({
    code: 'CONV_NO_WHATSAPP_LINK',
    category: 'CONV',
    severity: 'low',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'WhatsApp bağlantısı yok',
  }),
  define({
    code: 'CONV_NO_BOOKING_LINK',
    category: 'CONV',
    severity: 'medium',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Online randevu/rezervasyon bağlantısı yok',
  }),

  // ── CONTACT (site kapsamlı) ──────────────────────────────────────────────
  define({
    code: 'CONTACT_ROLE_EMAIL_FOUND',
    category: 'CONTACT',
    severity: 'low',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Kurumsal (rol tabanlı) e-posta adresi bulundu',
  }),
  define({
    code: 'CONTACT_NO_EMAIL_FOUND',
    category: 'CONTACT',
    severity: 'high',
    confidence: 'observed',
    scope: 'site',
    status: 'stable',
    label: 'Taranan sayfalarda kurumsal e-posta adresi bulunamadı',
  }),

  // ── INF (çıkarım; taslakta yalnızca SORU olarak kullanılabilir) ───────────
  define({
    code: 'INF_NO_ONLINE_APPOINTMENT',
    category: 'INF',
    severity: 'medium',
    confidence: 'inferred',
    scope: 'site',
    status: 'stable',
    label: 'Online randevu alma yolu görünmüyor (form da randevu bağlantısı da yok)',
  }),
];

export const FINDING_CATALOG: Record<string, FindingDefinition> = Object.fromEntries(
  DEFINITIONS.map((d) => [d.code, d]),
);

export function getFindingDefinition(code: string): FindingDefinition {
  const def = FINDING_CATALOG[code];
  if (!def) throw new Error(`unknown finding code: ${code}`);
  return def;
}

export function listFindingCodes(): string[] {
  return DEFINITIONS.map((d) => d.code);
}

/** Bir check'in ürettiği ham bulgu; DB'ye yazılmadan önce katalogla zenginleşir. */
export interface RawFinding {
  code: string;
  url: string;
  evidence: Record<string, unknown>;
  metricName?: string;
  metricValue?: number;
  metricUnit?: string;
}
