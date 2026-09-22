import assert from 'node:assert/strict';
import test from 'node:test';
import { isRoleEmail, siteChecks, type SitePage } from '../../src/audit/checks/site.js';
import type { PageObservations } from '../../src/audit/observe.js';

function observations(overrides: Partial<PageObservations> = {}): PageObservations {
  return {
    title: 'Yeterince uzun bir baslik',
    metaDescription: 'Yeterince uzun bir meta aciklama metni burada yer almaktadir efendim.',
    h1Count: 1,
    viewportContent: 'width=device-width, initial-scale=1',
    scrollWidth: 375,
    innerWidth: 375,
    deviceWidth: 375,
    overflowSelectors: [],
    smallTapTargets: { total: 0, samples: [] },
    overflowingFormFields: [],
    smallText: { totalNodes: 20, smallNodes: 0, samples: [] },
    fixedWidthContainers: [],
    usesDocumentWrite: false,
    documentWriteSnippet: null,
    jqueryVersion: null,
    layoutTables: { count: 0, samples: [] },
    legacyPlugins: [],
    contactForms: [],
    telLinks: [],
    whatsappLinks: [],
    bookingLinks: [],
    emails: [],
    htmlBytes: 1000,
    links: [],
    ...overrides,
  };
}

function page(url: string, overrides: Partial<PageObservations> = {}): SitePage {
  return { url, observations: observations(overrides) };
}

const HTTPS_SITE = 'https://ornek.test/';
const HTTP_SITE = 'http://ornek.test/';

function codes(result: ReturnType<typeof siteChecks>): string[] {
  return result.map((f) => f.code).sort();
}

await test('rol tabanlı e-posta tespiti', () => {
  for (const address of [
    'info@ornek.test',
    'iletisim@ornek.test',
    'SALES@ornek.test',
    'destek2@ornek.test',
    'randevu@ornek.test',
  ]) {
    assert.equal(isRoleEmail(address), true, address);
  }
  for (const address of ['ahmet.yilmaz@ornek.test', 'dr.mehmet@ornek.test', 'ayse@ornek.test']) {
    assert.equal(isRoleEmail(address), false, address);
  }
});

await test('pozitif: hiçbir dönüşüm unsuru yoksa tüm CONV yokluk bulguları üretilir', () => {
  const result = codes(siteChecks({ siteUrl: HTTPS_SITE, pages: [page(HTTPS_SITE)] }));
  assert.ok(result.includes('CONV_NO_CONTACT_FORM'));
  assert.ok(result.includes('CONV_NO_TEL_LINK'));
  assert.ok(result.includes('CONV_NO_WHATSAPP_LINK'));
  assert.ok(result.includes('CONV_NO_BOOKING_LINK'));
});

await test('negatif: unsurlar mevcutsa CONV yokluk bulguları üretilmez', () => {
  const result = codes(
    siteChecks({
      siteUrl: HTTPS_SITE,
      pages: [
        page(HTTPS_SITE, {
          contactForms: [{ selector: 'form', fieldCount: 3, hasTextarea: true }],
          telLinks: ['tel:+902321234567'],
          whatsappLinks: ['https://wa.me/905001234567'],
          bookingLinks: [{ url: 'https://ornek.test/randevu', text: 'Randevu' }],
          emails: ['info@ornek.test'],
        }),
      ],
    }),
  );
  assert.deepEqual(result, ['CONTACT_ROLE_EMAIL_FOUND']);
});

await test('yokluk bulguları SAYFA değil SİTE genelinde değerlendirilir', () => {
  // İletişim formu yalnızca ikinci sayfada var → site genelinde eksik sayılmaz.
  const result = codes(
    siteChecks({
      siteUrl: HTTPS_SITE,
      pages: [
        page(HTTPS_SITE),
        page('https://ornek.test/iletisim', {
          contactForms: [{ selector: 'form', fieldCount: 3, hasTextarea: true }],
          telLinks: ['tel:+90232'],
        }),
      ],
    }),
  );
  assert.ok(!result.includes('CONV_NO_CONTACT_FORM'));
  assert.ok(!result.includes('CONV_NO_TEL_LINK'));
  assert.ok(result.includes('CONV_NO_WHATSAPP_LINK'));
});

await test('pozitif/negatif: TECH_NO_HTTPS', () => {
  assert.ok(codes(siteChecks({ siteUrl: HTTP_SITE, pages: [page(HTTP_SITE)] })).includes('TECH_NO_HTTPS'));
  assert.ok(!codes(siteChecks({ siteUrl: HTTPS_SITE, pages: [page(HTTPS_SITE)] })).includes('TECH_NO_HTTPS'));
});

await test('CONTACT: yalnızca rol tabanlı adresler kanıta yazılır', () => {
  const result = siteChecks({
    siteUrl: HTTPS_SITE,
    pages: [page(HTTPS_SITE, { emails: ['info@ornek.test', 'ahmet.yilmaz@ornek.test'] })],
  });
  const finding = result.find((f) => f.code === 'CONTACT_ROLE_EMAIL_FOUND');
  assert.ok(finding);
  assert.deepEqual(finding.evidence['addresses'], ['info@ornek.test']);
  assert.equal(finding.evidence['non_role_addresses_seen'], 1);
  assert.ok(!result.some((f) => f.code === 'CONTACT_NO_EMAIL_FOUND'));
});

await test('CONTACT_NO_EMAIL_FOUND: yalnızca kişisel adres varsa da üretilir', () => {
  const result = codes(
    siteChecks({
      siteUrl: HTTPS_SITE,
      pages: [page(HTTPS_SITE, { emails: ['ahmet.yilmaz@ornek.test'] })],
    }),
  );
  assert.ok(result.includes('CONTACT_NO_EMAIL_FOUND'));
  assert.ok(!result.includes('CONTACT_ROLE_EMAIL_FOUND'));
});

await test('INF_NO_ONLINE_APPOINTMENT yalnızca iki gözlem BİRLİKTE doğruyken üretilir', () => {
  const both = codes(siteChecks({ siteUrl: HTTPS_SITE, pages: [page(HTTPS_SITE)] }));
  assert.ok(both.includes('INF_NO_ONLINE_APPOINTMENT'));

  const withForm = codes(
    siteChecks({
      siteUrl: HTTPS_SITE,
      pages: [
        page(HTTPS_SITE, { contactForms: [{ selector: 'form', fieldCount: 2, hasTextarea: false }] }),
      ],
    }),
  );
  assert.ok(!withForm.includes('INF_NO_ONLINE_APPOINTMENT'));

  const withBooking = codes(
    siteChecks({
      siteUrl: HTTPS_SITE,
      pages: [page(HTTPS_SITE, { bookingLinks: [{ url: 'x', text: 'Randevu' }] })],
    }),
  );
  assert.ok(!withBooking.includes('INF_NO_ONLINE_APPOINTMENT'));
});

await test('sayfa yoksa hiçbir site bulgusu üretilmez', () => {
  assert.deepEqual(siteChecks({ siteUrl: HTTPS_SITE, pages: [] }), []);
});
