import { PAGE_LIMIT_CEILING } from '../config.js';
import type { PageLink } from './browser.js';
import type { RobotsPolicy } from './robots.js';

export type PageRole = 'home' | 'contact' | 'about' | 'sitemap_pick';

export interface SelectedPage {
  url: string;
  role: PageRole;
}

/**
 * Asla taranmayacak yollar: oturum, ödeme, sepet, yönetim ve üyelik alanları.
 * Sitemap'ten gelseler bile seçilmezler (docs/design §2.5, F3).
 */
export const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(login|signin|sign-in|log-in|logout|signout|sign-out)(\/|$|\.)/i,
  /(^|\/)(giris|giris-yap|cikis|oturum)(\/|$|\.)/i,
  /(^|\/)(register|signup|sign-up|kayit|uye|uyelik|account|hesabim|profil|profile)(\/|$|\.)/i,
  /(^|\/)(cart|basket|checkout|sepet|odeme|payment|siparis|order)(\/|$|\.)/i,
  /(^|\/)(admin|administrator|wp-admin|wp-login|yonetim|panel|dashboard)(\/|$|\.)/i,
  /(^|\/)(cdn-cgi|xmlrpc\.php|feed|rss|atom)(\/|$|\.)/i,
];

/** Sayfa olmayan uzantılar. */
const NON_PAGE_EXTENSION =
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tar|csv|jpe?g|png|gif|webp|avif|svg|ico|mp[34]|webm|mov|woff2?|ttf|eot|css|js|json|xml|rss)$/i;

const CONTACT_PATTERNS =
  /(iletisim|iletişim|contact|bize-ulasin|bize-ulaşın|randevu|appointment|ulasim)/i;
const ABOUT_PATTERNS = /(hakkimizda|hakkımızda|hakkinda|about|about-us|kurumsal|biz-kimiz)/i;

export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** Aday URL'leri karşılaştırmak için kanonik biçim (fragment atılır, son / sadeleşir). */
export function canonicalize(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

export interface SelectorInput {
  /** Ana sayfanın (redirect sonrası) son adresi. */
  homeUrl: string;
  /** Ana sayfadan çıkarılan bağlantılar. */
  links: PageLink[];
  /** sitemap.xml'den gelen adresler (zaten filtrelenmemiş olabilir). */
  sitemapUrls: string[];
  robots: RobotsPolicy;
  /** Kampanya limiti; her durumda PAGE_LIMIT_CEILING'e kırpılır. */
  pageLimit: number;
}

export interface SelectorResult {
  pages: SelectedPage[];
  /** İstenen limit tavanı aştığı için kırpıldıysa true (çağıran uyarı loglar). */
  clamped: boolean;
  effectiveLimit: number;
}

/**
 * Ana sayfa + iletişim + hakkımızda + sitemap'ten en fazla iki sayfa seçer.
 * Toplam sayfa sayısı hiçbir koşulda PAGE_LIMIT_CEILING'i (5) aşamaz.
 */
export function selectPages(input: SelectorInput): SelectorResult {
  const clamped = input.pageLimit > PAGE_LIMIT_CEILING;
  const effectiveLimit = Math.max(1, Math.min(input.pageLimit, PAGE_LIMIT_CEILING));

  const home = canonicalize(input.homeUrl);
  if (!home) return { pages: [], clamped, effectiveLimit };

  const homeHost = new URL(home).host;
  const pages: SelectedPage[] = [{ url: home, role: 'home' }];
  const seen = new Set([home]);

  const eligible = (candidate: string): string | null => {
    const canonical = canonicalize(candidate);
    if (canonical === null || seen.has(canonical)) return null;
    const url = new URL(canonical);
    if (url.host !== homeHost) return null;
    if (NON_PAGE_EXTENSION.test(url.pathname)) return null;
    if (isExcludedPath(url.pathname)) return null;
    if (!input.robots.isAllowed(url.pathname)) return null;
    return canonical;
  };

  const take = (url: string, role: PageRole): boolean => {
    if (pages.length >= effectiveLimit) return false;
    pages.push({ url, role });
    seen.add(url);
    return true;
  };

  const findByPattern = (pattern: RegExp): string | null => {
    for (const link of input.links) {
      const canonical = eligible(link.url);
      if (canonical === null) continue;
      const pathname = new URL(canonical).pathname;
      if (pattern.test(pathname) || pattern.test(link.text)) return canonical;
    }
    return null;
  };

  const contact = findByPattern(CONTACT_PATTERNS);
  if (contact) take(contact, 'contact');

  const about = findByPattern(ABOUT_PATTERNS);
  if (about) take(about, 'about');

  // Kalan bütçe sitemap'ten doldurulur; en fazla iki sayfa.
  const sitemapCandidates = input.sitemapUrls
    .map((candidate) => eligible(candidate))
    .filter((candidate): candidate is string => candidate !== null)
    // Sığ yollar daha muhtemel "önemli" sayfalardır.
    .sort((a, b) => depth(a) - depth(b) || a.length - b.length);

  let sitemapTaken = 0;
  for (const candidate of sitemapCandidates) {
    if (sitemapTaken >= 2) break;
    if (!take(candidate, 'sitemap_pick')) break;
    sitemapTaken += 1;
  }

  return { pages, clamped, effectiveLimit };
}

function depth(url: string): number {
  return new URL(url).pathname.split('/').filter(Boolean).length;
}
