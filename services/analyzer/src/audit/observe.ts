import type { Page } from 'playwright';
import { MOBILE_VIEWPORT } from '../config.js';

export interface PageLink {
  url: string;
  text: string;
}

export interface ElementSample {
  selector: string;
  width?: number;
  height?: number;
  right?: number;
  fontSizePx?: number;
}

export interface PageObservations {
  title: string;
  metaDescription: string | null;
  h1Count: number;

  /** <meta name="viewport"> içeriği; etiket yoksa null. */
  viewportContent: string | null;
  scrollWidth: number;
  /** Sayfanın raporladığı layout viewport genişliği (emülasyonda 375'ten farklı olabilir). */
  innerWidth: number;
  /** Emüle edilen cihaz genişliği (375). Taşma kıyası BUNA göre yapılır. */
  deviceWidth: number;
  overflowSelectors: string[];

  smallTapTargets: { total: number; samples: ElementSample[] };
  overflowingFormFields: ElementSample[];
  smallText: { totalNodes: number; smallNodes: number; samples: ElementSample[] };
  fixedWidthContainers: ElementSample[];

  usesDocumentWrite: boolean;
  documentWriteSnippet: string | null;
  jqueryVersion: string | null;
  layoutTables: { count: number; samples: string[] };
  legacyPlugins: Array<{ tag: string; type: string | null; src: string | null }>;

  contactForms: Array<{ selector: string; fieldCount: number; hasTextarea: boolean }>;
  telLinks: string[];
  whatsappLinks: string[];
  bookingLinks: Array<{ url: string; text: string }>;
  emails: string[];

  htmlBytes: number;
  links: PageLink[];
}

const MAX_LINKS = 300;
const MIN_TAP_TARGET_PX = 44;
const MIN_READABLE_FONT_PX = 12;
const FIXED_WIDTH_THRESHOLD_PX = 980;

/**
 * Sayfadan tüm check'lerin ihtiyaç duyduğu ham gözlemleri TEK seferde toplar.
 * Karar mantığı burada değil, check modüllerindedir; burada yalnızca ölçüm yapılır.
 */
export async function collectObservations(page: Page): Promise<PageObservations> {
  return page.evaluate(
    (cfg: {
      deviceWidth: number;
      maxLinks: number;
      minTapTarget: number;
      minFont: number;
      fixedWidth: number;
    }) => {
      const describe = (el: Element): string => {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className.trim() !== ''
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };

      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      // ── SEO ──────────────────────────────────────────────────────────────
      const descriptionMeta = document.querySelector('meta[name="description" i]');
      const metaDescription = descriptionMeta
        ? (descriptionMeta.getAttribute('content') ?? '')
        : null;
      const h1Count = document.querySelectorAll('h1').length;

      // ── Viewport / taşma ─────────────────────────────────────────────────
      const viewportMeta = document.querySelector('meta[name="viewport" i]');
      const viewportContent = viewportMeta ? (viewportMeta.getAttribute('content') ?? '') : null;
      const innerWidth = window.innerWidth;
      const scrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body ? document.body.scrollWidth : 0,
      );

      const overflowSelectors: string[] = [];
      if (scrollWidth > cfg.deviceWidth + 4 && document.body) {
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.right > cfg.deviceWidth + 4) {
            const selector = describe(el);
            if (!overflowSelectors.includes(selector)) overflowSelectors.push(selector);
            if (overflowSelectors.length >= 3) break;
          }
        }
      }

      // ── Dokunma hedefleri ────────────────────────────────────────────────
      const tapTargetSelector =
        'a[href], button, input[type="submit"], input[type="button"], [role="button"]';
      const smallTapSamples: Array<{ selector: string; width: number; height: number }> = [];
      let smallTapTotal = 0;
      for (const el of Array.from(document.querySelectorAll(tapTargetSelector))) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < cfg.minTapTarget || rect.height < cfg.minTapTarget) {
          smallTapTotal += 1;
          if (smallTapSamples.length < 3) {
            smallTapSamples.push({
              selector: describe(el),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
          }
        }
      }

      // ── Taşan form alanları ──────────────────────────────────────────────
      const overflowingFormFields: Array<{ selector: string; right: number }> = [];
      for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
        if (!isVisible(el)) continue;
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        if (type === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.right > cfg.deviceWidth + 4) {
          overflowingFormFields.push({ selector: describe(el), right: Math.round(rect.right) });
          if (overflowingFormFields.length >= 3) break;
        }
      }

      // ── Okunabilir metin boyutu ──────────────────────────────────────────
      const walker = document.createTreeWalker(document.body ?? document, NodeFilter.SHOW_TEXT);
      let totalTextNodes = 0;
      let smallTextNodes = 0;
      const smallTextSamples: Array<{ selector: string; fontSizePx: number }> = [];
      let node = walker.nextNode();
      while (node !== null) {
        const text = (node.textContent ?? '').trim();
        const parent = node.parentElement;
        if (text.length >= 10 && parent && isVisible(parent)) {
          const tag = parent.tagName.toLowerCase();
          if (tag !== 'script' && tag !== 'style' && tag !== 'noscript') {
            totalTextNodes += 1;
            const fontSize = Number.parseFloat(window.getComputedStyle(parent).fontSize);
            if (Number.isFinite(fontSize) && fontSize < cfg.minFont) {
              smallTextNodes += 1;
              if (smallTextSamples.length < 3) {
                smallTextSamples.push({
                  selector: describe(parent),
                  fontSizePx: Math.round(fontSize * 10) / 10,
                });
              }
            }
          }
        }
        node = walker.nextNode();
      }

      // ── Sabit masaüstü genişliği ─────────────────────────────────────────
      const fixedWidthContainers: Array<{ selector: string; width: number }> = [];
      const containerCandidates: Element[] = document.body
        ? [document.body, ...Array.from(document.body.children)]
        : [];
      for (const el of containerCandidates) {
        if (!isVisible(el)) continue;
        const width = Number.parseFloat(window.getComputedStyle(el).width);
        if (Number.isFinite(width) && width >= cfg.fixedWidth) {
          fixedWidthContainers.push({ selector: describe(el), width: Math.round(width) });
          if (fixedWidthContainers.length >= 3) break;
        }
      }

      // ── Eski teknoloji izleri ────────────────────────────────────────────
      const html = document.documentElement.outerHTML;
      const documentWriteMatch = /document\s*\.\s*write(ln)?\s*\(/.exec(html);
      const documentWriteSnippet = documentWriteMatch
        ? html.slice(
            Math.max(0, documentWriteMatch.index - 40),
            documentWriteMatch.index + 80,
          )
        : null;

      const jq = (window as unknown as { jQuery?: { fn?: { jquery?: string } } }).jQuery;
      const jqueryVersion = jq?.fn?.jquery ?? null;

      // Layout tablosu: başlık hücresi/caption/role içermeyen ve içinde
      // başka tablo barındıran tablolar. İç içe olma şartı yanlış pozitifi düşürür.
      const layoutTableSamples: string[] = [];
      let layoutTableCount = 0;
      for (const table of Array.from(document.querySelectorAll('table'))) {
        const hasSemantics =
          table.querySelector('th') !== null ||
          table.querySelector('caption') !== null ||
          table.hasAttribute('role');
        const hasNestedTable = table.querySelector('table') !== null;
        if (!hasSemantics && hasNestedTable) {
          layoutTableCount += 1;
          if (layoutTableSamples.length < 3) layoutTableSamples.push(describe(table));
        }
      }

      const legacyPlugins: Array<{ tag: string; type: string | null; src: string | null }> = [];
      for (const el of Array.from(document.querySelectorAll('object, embed, applet'))) {
        const type = el.getAttribute('type');
        const src = el.getAttribute('src') ?? el.getAttribute('data');
        const classid = el.getAttribute('classid') ?? '';
        const legacy =
          /flash|shockwave|silverlight|x-java/i.test(type ?? '') ||
          /\.(swf|xap|jar|class)(\?|$)/i.test(src ?? '') ||
          classid !== '' ||
          el.tagName.toLowerCase() === 'applet';
        if (legacy) {
          legacyPlugins.push({ tag: el.tagName.toLowerCase(), type, src });
          if (legacyPlugins.length >= 3) break;
        }
      }

      // ── Dönüşüm unsurları ────────────────────────────────────────────────
      const contactForms: Array<{ selector: string; fieldCount: number; hasTextarea: boolean }> =
        [];
      for (const form of Array.from(document.querySelectorAll('form'))) {
        const fields = Array.from(form.querySelectorAll('input, textarea, select')).filter((f) => {
          const type = (f.getAttribute('type') ?? '').toLowerCase();
          return type !== 'hidden' && type !== 'submit' && type !== 'button';
        });
        const hasTextarea = form.querySelector('textarea') !== null;
        const looksLikeSearch =
          fields.length <= 1 &&
          fields.some((f) => {
            const hint = `${f.getAttribute('type') ?? ''} ${f.getAttribute('name') ?? ''} ${
              f.getAttribute('id') ?? ''
            } ${f.getAttribute('placeholder') ?? ''}`.toLowerCase();
            return /search|ara|arama|\bq\b|sorgu/.test(hint);
          });
        // İletişim formu sayılması için: arama formu olmamalı ve ya bir textarea
        // ya da en az iki gerçek alan içermeli.
        if (!looksLikeSearch && (hasTextarea || fields.length >= 2)) {
          contactForms.push({
            selector: describe(form),
            fieldCount: fields.length,
            hasTextarea,
          });
          if (contactForms.length >= 3) break;
        }
      }

      const telLinks: string[] = [];
      const whatsappLinks: string[] = [];
      const bookingLinks: Array<{ url: string; text: string }> = [];
      const emails = new Set<string>();
      const links: Array<{ url: string; text: string }> = [];

      const bookingPattern =
        /(randevu|rezervasyon|appointment|booking|book-?now|online-?randevu|calendly|doctolib|setmore|simplybook)/i;

      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        const raw = anchor.getAttribute('href') ?? '';
        const text = (anchor.textContent ?? '').trim().slice(0, 120);

        if (/^tel:/i.test(raw)) {
          if (telLinks.length < 5) telLinks.push(raw);
          continue;
        }
        if (/^mailto:/i.test(raw)) {
          const address = raw.slice(7).split('?')[0]!.trim().toLowerCase();
          if (address !== '') emails.add(address);
          continue;
        }

        const href = (anchor as HTMLAnchorElement).href;
        if (!href) continue;

        if (/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:)/i.test(href)) {
          if (whatsappLinks.length < 5) whatsappLinks.push(href);
        }
        if (bookingPattern.test(href) || bookingPattern.test(text)) {
          if (bookingLinks.length < 5) bookingLinks.push({ url: href, text });
        }
        if (links.length < cfg.maxLinks) links.push({ url: href, text });
      }

      // Gövde metnindeki e-posta adresleri (mailto olmayanlar).
      const bodyText = document.body ? (document.body.innerText ?? '') : '';
      const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
      for (const match of bodyText.matchAll(emailPattern)) {
        emails.add(match[0].toLowerCase());
        if (emails.size >= 20) break;
      }

      return {
        title: document.title ?? '',
        metaDescription,
        h1Count,
        viewportContent,
        scrollWidth,
        innerWidth,
        deviceWidth: cfg.deviceWidth,
        overflowSelectors,
        smallTapTargets: { total: smallTapTotal, samples: smallTapSamples },
        overflowingFormFields,
        smallText: {
          totalNodes: totalTextNodes,
          smallNodes: smallTextNodes,
          samples: smallTextSamples,
        },
        fixedWidthContainers,
        usesDocumentWrite: documentWriteMatch !== null,
        documentWriteSnippet,
        jqueryVersion,
        layoutTables: { count: layoutTableCount, samples: layoutTableSamples },
        legacyPlugins,
        contactForms,
        telLinks,
        whatsappLinks,
        bookingLinks,
        emails: Array.from(emails),
        htmlBytes: html.length,
        links,
      };
    },
    {
      deviceWidth: MOBILE_VIEWPORT.width as number,
      maxLinks: MAX_LINKS,
      minTapTarget: MIN_TAP_TARGET_PX,
      minFont: MIN_READABLE_FONT_PX,
      fixedWidth: FIXED_WIDTH_THRESHOLD_PX,
    },
  );
}

export const OBSERVE_THRESHOLDS = {
  MIN_TAP_TARGET_PX,
  MIN_READABLE_FONT_PX,
  FIXED_WIDTH_THRESHOLD_PX,
} as const;
