export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface NormalizedInput {
  /** Kullanıcının verdiği ham değer; hiçbir zaman değiştirilmez. */
  submittedUrl: string;
  /** lowercase, www yok, punycode, path/query yok */
  normalizedDomain: string;
  /** Audit'in başlayacağı URL. */
  entryUrl: string;
}

/**
 * Kullanıcının verdiği adresi normalize eder.
 * Şema yoksa https varsayılır. Redirect sonuçları bu değerleri ETKİLEMEZ.
 */
export function normalizeCompanyInput(raw: string): NormalizedInput {
  const submitted = raw.trim();
  if (submitted === '') throw new DomainError('empty website value');

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(submitted)
    ? submitted
    : `https://${submitted}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new DomainError(`not a parsable URL: ${submitted}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DomainError(`unsupported scheme: ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new DomainError('credentials are not allowed in company URLs');
  }

  // URL sınıfı hostname'i zaten punycode + lowercase yapar.
  let host = url.hostname.replace(/\.$/, '');
  if (host === '') throw new DomainError(`no hostname in: ${submitted}`);
  if (host.startsWith('www.')) host = host.slice(4);

  const entry = new URL(url.toString());
  entry.hash = '';
  entry.search = '';

  return { submittedUrl: submitted, normalizedDomain: host, entryUrl: entry.toString() };
}
