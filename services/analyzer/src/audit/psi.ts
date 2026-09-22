import { config } from '../config.js';

/**
 * PageSpeed Insights (CrUX) alan verisi — gerçek kullanıcılardan toplanan
 * 28 günlük 75. yüzdelik değerler.
 *
 * NOT: Google'ın Mobile-Friendly Test API'si 2023'te kapatılmıştır ve bu
 * projede hiçbir yerde kullanılmaz. Mobil uyumluluk yalnızca kendi
 * Playwright ölçümümüzle belirlenir.
 */
export interface PsiFieldData {
  source: 'crux';
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
  overallCategory: string | null;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const ENDPOINT = 'https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed';

interface PsiMetric {
  percentile?: number;
  category?: string;
}

interface PsiResponse {
  loadingExperience?: {
    overall_category?: string;
    metrics?: Record<string, PsiMetric>;
  };
}

/**
 * PSI alan verisini çeker. Anahtar yoksa ÇAĞRI YAPILMAZ ve null döner —
 * PSI tamamen opsiyoneldir ve yokluğu audit'i etkilemez.
 * Her hata sessizce null'a düşer; PSI bir bulgunun oluşmasını belirlemez.
 */
export async function fetchPsiFieldData(
  pageUrl: string,
  options: { apiKey?: string; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<PsiFieldData | null> {
  const apiKey = options.apiKey ?? config.psiApiKey;
  if (!apiKey) return null;

  const timeoutMs = options.timeoutMs ?? config.psiTimeoutMs;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);

  const url = `${ENDPOINT}?url=${encodeURIComponent(pageUrl)}&strategy=mobile&key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as PsiResponse;
    return parsePsiResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parsePsiResponse(body: PsiResponse): PsiFieldData | null {
  const experience = body.loadingExperience;
  if (!experience || !experience.metrics) return null;

  const lcp = experience.metrics['LARGEST_CONTENTFUL_PAINT_MS']?.percentile;
  const cls = experience.metrics['CUMULATIVE_LAYOUT_SHIFT_SCORE']?.percentile;
  const inp = experience.metrics['INTERACTION_TO_NEXT_PAINT']?.percentile;

  if (lcp === undefined && cls === undefined && inp === undefined) return null;

  return {
    source: 'crux',
    lcpMs: lcp ?? null,
    // CrUX CLS değerini 100 ile çarpılmış tamsayı olarak döndürür.
    clsScore: cls === undefined ? null : Math.round((cls / 100) * 1000) / 1000,
    inpMs: inp ?? null,
    overallCategory: experience.overall_category ?? null,
  };
}
