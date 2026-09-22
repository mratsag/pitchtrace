import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGE_LIMIT_CEILING } from '../../src/config.js';
import { parseRobots } from '../../src/audit/robots.js';
import { canonicalize, isExcludedPath, selectPages } from '../../src/audit/page-selector.js';

const ALLOW_ALL = parseRobots('User-agent: *\nAllow: /\n', 'pitchtracebot');
const ORIGIN = 'https://ornek.test';

function link(path: string, text = ''): { url: string; text: string } {
  return { url: `${ORIGIN}${path}`, text };
}

await test('dışlanan yol kalıpları', () => {
  const excluded = [
    '/login',
    '/login.html',
    '/giris-yap',
    '/hesabim/siparisler',
    '/sepet',
    '/sepet.html',
    '/checkout/step-1',
    '/odeme',
    '/admin',
    '/wp-admin/index.php',
    '/wp-login.php',
    '/panel/',
    '/uye/kayit',
  ];
  for (const path of excluded) {
    assert.equal(isExcludedPath(path), true, `${path} dışlanmalıydı`);
  }

  const allowed = ['/', '/iletisim', '/hakkimizda', '/hizmetler/implant', '/blog/2026-ocak'];
  for (const path of allowed) {
    assert.equal(isExcludedPath(path), false, `${path} dışlanmamalıydı`);
  }
});

await test('canonicalize fragment atar ve sondaki eğik çizgiyi sadeleştirir', () => {
  assert.equal(canonicalize('https://a.test/x/#bolum'), 'https://a.test/x');
  assert.equal(canonicalize('https://a.test/'), 'https://a.test/');
  assert.equal(canonicalize('javascript:alert(1)'), null);
  assert.equal(canonicalize('not a url'), null);
});

await test('ana sayfa + iletişim + hakkımızda + sitemap’ten iki sayfa seçilir', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [
      link('/iletisim', 'Iletisim'),
      link('/hakkimizda', 'Hakkimizda'),
      link('/hizmetler', 'Hizmetler'),
    ],
    sitemapUrls: [`${ORIGIN}/blog`, `${ORIGIN}/hizmetler`, `${ORIGIN}/kampanyalar/2026/ocak`],
    robots: ALLOW_ALL,
    pageLimit: 5,
  });

  assert.deepEqual(
    result.pages.map((p) => p.role),
    ['home', 'contact', 'about', 'sitemap_pick', 'sitemap_pick'],
  );
  assert.equal(result.pages.length, 5);
  assert.equal(result.clamped, false);
});

await test('sitemap’ten en fazla iki sayfa alınır', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [],
    sitemapUrls: [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`, `${ORIGIN}/d`],
    robots: ALLOW_ALL,
    pageLimit: 5,
  });
  assert.equal(result.pages.filter((p) => p.role === 'sitemap_pick').length, 2);
  assert.equal(result.pages.length, 3);
});

await test('page_limit tavanı aşarsa 5’e kırpılır ve bayrak kalkar', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [link('/iletisim', 'Iletisim'), link('/hakkimizda', 'Hakkimizda')],
    sitemapUrls: [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`],
    robots: ALLOW_ALL,
    pageLimit: 6,
  });
  assert.equal(result.clamped, true);
  assert.equal(result.effectiveLimit, PAGE_LIMIT_CEILING);
  assert.equal(result.pages.length, PAGE_LIMIT_CEILING);
});

await test('kullanıcı limiti düşürebilir', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [link('/iletisim', 'Iletisim'), link('/hakkimizda', 'Hakkimizda')],
    sitemapUrls: [`${ORIGIN}/a`],
    robots: ALLOW_ALL,
    pageLimit: 2,
  });
  assert.equal(result.clamped, false);
  assert.equal(result.pages.length, 2);
  assert.deepEqual(
    result.pages.map((p) => p.role),
    ['home', 'contact'],
  );
});

await test('login, sepet ve admin sayfaları sitemap’ten gelse bile seçilmez', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [link('/login', 'Giris'), link('/sepet', 'Sepet')],
    sitemapUrls: [
      `${ORIGIN}/login`,
      `${ORIGIN}/sepet`,
      `${ORIGIN}/checkout`,
      `${ORIGIN}/wp-admin/`,
      `${ORIGIN}/hesabim`,
    ],
    robots: ALLOW_ALL,
    pageLimit: 5,
  });
  assert.equal(result.pages.length, 1, JSON.stringify(result.pages));
  assert.equal(result.pages[0]!.role, 'home');
});

await test('farklı host ve sayfa olmayan uzantılar elenir', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [
      { url: 'https://baska-site.test/iletisim', text: 'Iletisim' },
      link('/brosur.pdf', 'Iletisim brosuru'),
    ],
    sitemapUrls: ['https://baska-site.test/blog', `${ORIGIN}/logo.png`],
    robots: ALLOW_ALL,
    pageLimit: 5,
  });
  assert.equal(result.pages.length, 1);
});

await test('robots tarafından engellenen yollar seçilmez', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /hakkimizda\n', 'pitchtracebot');
  const result = selectPages({
    homeUrl: `${ORIGIN}/`,
    links: [link('/iletisim', 'Iletisim'), link('/hakkimizda', 'Hakkimizda')],
    sitemapUrls: [],
    robots,
    pageLimit: 5,
  });
  assert.deepEqual(
    result.pages.map((p) => p.role),
    ['home', 'contact'],
  );
});

await test('aynı sayfa iki kez seçilmez', () => {
  const result = selectPages({
    homeUrl: `${ORIGIN}/iletisim`,
    links: [link('/iletisim', 'Iletisim')],
    sitemapUrls: [`${ORIGIN}/iletisim`, `${ORIGIN}/iletisim/`],
    robots: ALLOW_ALL,
    pageLimit: 5,
  });
  assert.equal(result.pages.length, 1);
});
