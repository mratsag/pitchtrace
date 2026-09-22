import { FINDING_CATALOG, type FindingDefinition } from './catalog.js';

const CATEGORY_ORDER = ['MOBILE', 'TECH', 'PERF', 'SEO', 'CONV', 'CONTACT', 'INF'];

const SCOPE_LABEL: Record<string, string> = {
  page: 'sayfa',
  site: 'site',
};

/** docs/finding-codes.md içeriğini katalogdan üretir (tek doğruluk kaynağı). */
export function renderFindingCodesDoc(): string {
  const all = Object.values(FINDING_CATALOG);
  const lines: string[] = [
    '# Bulgu kodları',
    '',
    '> Bu dosya `services/analyzer/src/findings/catalog.ts` dosyasından üretilir.',
    '> Elle düzenlemeyin; `npm run docs:findings` ile yeniden üretin.',
    '',
    '**Kapsam:** `sayfa` bulguları her taranan sayfa için ayrı değerlendirilir.',
    '`site` bulguları taranan tüm sayfaların toplamı üzerinden bir kez üretilir —',
    '"iletişim formu yok" gibi yokluk bulguları tek sayfaya bakılarak verilemez.',
    '',
    '**Outreach:** yalnızca `stable` kodlar e-posta taslağında iddia olarak',
    'kullanılabilir. `experimental` kodlar kaydedilir ve insana gösterilir ama',
    'validator (V16) bunlara dayanan iddiaları reddeder.',
    '',
  ];

  for (const category of CATEGORY_ORDER) {
    const items = all.filter((d) => d.category === category);
    if (items.length === 0) continue;
    lines.push(`## ${category}`, '');
    lines.push('| Kod | Kapsam | Önem | Güven | Durum | Outreach | Açıklama |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const def of items) {
      lines.push(row(def));
    }
    lines.push('');
  }

  lines.push(`Toplam ${all.length} kod.`, '');
  return lines.join('\n');
}

function row(def: FindingDefinition): string {
  return [
    '',
    `\`${def.code}\``,
    SCOPE_LABEL[def.scope] ?? def.scope,
    def.severity,
    def.confidence,
    def.status,
    def.outreachEligible ? 'evet' : 'hayır',
    def.label,
    '',
  ].join(' | ').trim();
}
