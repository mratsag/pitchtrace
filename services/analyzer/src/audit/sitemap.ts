import { config } from '../config.js';
import { safeFetch } from '../security/safe-fetch.js';

/** Bir sitemap'ten alınacak en fazla adres sayısı. */
const MAX_SITEMAP_URLS = 200;
/** Sitemap index'te izlenecek en fazla alt sitemap sayısı. */
const MAX_CHILD_SITEMAPS = 1;

function extractTags(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const values: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    const value = (match[1] ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (value !== '') values.push(value);
  }
  return values;
}

async function fetchXml(url: string, allowLoopback: boolean): Promise<string | null> {
  try {
    const result = await safeFetch(url, {
      allowLoopback,
      maxRedirects: config.maxRedirects,
      maxBytes: config.maxSitemapBytes,
      timeoutMs: config.navTimeoutMs,
      userAgent: config.userAgent,
    });
    if (result.status !== 200) return null;
    return result.body;
  } catch {
    return null;
  }
}

/**
 * sitemap.xml adreslerini toplar. Bulunamazsa boş dizi döner — sitemap
 * yokluğu bir hata değildir ve audit'i durdurmaz.
 *
 * Her istek SSRF guard'ından ve boyut sınırından geçer.
 */
export async function fetchSitemapUrls(
  origin: string,
  options: {
    allowLoopback: boolean;
    extraSitemaps?: string[];
    /** Her ağ isteğinden önce çağrılır — domain hız sınırı buraya bağlanır. */
    beforeRequest?: () => Promise<void>;
  },
): Promise<string[]> {
  const candidates = [
    ...(options.extraSitemaps ?? []),
    new URL('/sitemap.xml', origin).toString(),
  ];

  const collected: string[] = [];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    if (collected.length >= MAX_SITEMAP_URLS) break;
    if (visited.has(candidate)) continue;
    visited.add(candidate);

    await options.beforeRequest?.();
    const xml = await fetchXml(candidate, options.allowLoopback);
    if (xml === null) continue;

    // Sitemap index ise sınırlı sayıda alt sitemap izlenir.
    if (/<sitemapindex[\s>]/i.test(xml)) {
      const children = extractTags(xml, 'loc').slice(0, MAX_CHILD_SITEMAPS);
      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);
        await options.beforeRequest?.();
        const childXml = await fetchXml(child, options.allowLoopback);
        if (childXml === null) continue;
        collected.push(...extractTags(childXml, 'loc'));
      }
      continue;
    }

    collected.push(...extractTags(xml, 'loc'));
  }

  return collected.slice(0, MAX_SITEMAP_URLS);
}

export { extractTags as __extractTagsForTests };
