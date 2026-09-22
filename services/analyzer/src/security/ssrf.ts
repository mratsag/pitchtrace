import dns from 'node:dns/promises';
import net from 'node:net';
import { checkIp } from './ip-ranges.js';

export type SsrfErrorCode =
  | 'INVALID_URL'
  | 'SCHEME_BLOCKED'
  | 'CREDENTIALS_IN_URL'
  | 'HOSTNAME_BLOCKED'
  | 'PRIVATE_ADDRESS'
  | 'DNS_FAILURE';

export interface SsrfOk {
  ok: true;
  url: URL;
  hostname: string;
  /** Doğrulanmış IP adresleri (DNS pinlemesi için kullanılır). */
  addresses: string[];
}

export interface SsrfDenied {
  ok: false;
  code: SsrfErrorCode;
  reason: string;
}

export type SsrfResult = SsrfOk | SsrfDenied;

export interface SsrfOptions {
  /** SADECE TEST: 127.0.0.0/8 ve ::1 serbest. Diğer engelli aralıklar kapalı kalır. */
  allowLoopback?: boolean;
  /** Test tarayıcısında yalnızca açıkça kaydedilmiş fixture origin'leri. */
  allowedLoopbackOrigins?: Set<string>;
  /** Test enjeksiyonu için DNS çözücü. */
  resolver?: (hostname: string) => Promise<string[]>;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** docs/design §2.2 — hostname blocklist. */
const BLOCKED_HOST_EXACT = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);
const BLOCKED_HOST_SUFFIX = ['.localhost', '.local', '.internal', '.home.arpa'];

async function defaultResolver(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Bir URL'nin crawl edilmesinin güvenli olup olmadığını belirler.
 *
 * Bu fonksiyon yalnızca giriş URL'si için değil, her redirect hop'u ve
 * tarayıcıdaki her ağ isteği için çağrılır (docs/design §2.4).
 */
export async function checkUrl(raw: string, options: SsrfOptions = {}): Promise<SsrfResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'INVALID_URL', reason: `not a valid absolute URL: ${raw}` };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      code: 'SCHEME_BLOCKED',
      reason: `scheme ${url.protocol} is not allowed (only http: and https:)`,
    };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'CREDENTIALS_IN_URL', reason: 'URL contains credentials' };
  }

  const hostname = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  if (hostname === '') {
    return { ok: false, code: 'INVALID_URL', reason: 'empty hostname' };
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily === 0) {
    if (BLOCKED_HOST_EXACT.has(hostname)) {
      return { ok: false, code: 'HOSTNAME_BLOCKED', reason: `hostname ${hostname} is blocked` };
    }
    for (const suffix of BLOCKED_HOST_SUFFIX) {
      if (hostname.endsWith(suffix)) {
        return {
          ok: false,
          code: 'HOSTNAME_BLOCKED',
          reason: `hostname suffix ${suffix} is blocked`,
        };
      }
    }
  }

  let addresses: string[];
  if (literalFamily !== 0) {
    addresses = [hostname];
  } else {
    const resolve = options.resolver ?? defaultResolver;
    try {
      addresses = await resolve(hostname);
    } catch (err) {
      return {
        ok: false,
        code: 'DNS_FAILURE',
        reason: `DNS lookup failed for ${hostname}: ${(err as Error).message}`,
      };
    }
    if (addresses.length === 0) {
      return { ok: false, code: 'DNS_FAILURE', reason: `no addresses for ${hostname}` };
    }
  }

  // Dönen adreslerin TAMAMI doğrulanır; biri bile engelliyse istek reddedilir.
  for (const address of addresses) {
    const verdict = checkIp(address);
    if (verdict.blockedReason === null) continue;
    if (verdict.isLoopback && options.allowLoopback === true &&
        (options.allowedLoopbackOrigins === undefined || options.allowedLoopbackOrigins.has(url.origin))) continue;
    return {
      ok: false,
      code: 'PRIVATE_ADDRESS',
      reason: `${hostname} resolves to ${address} → ${verdict.blockedReason}`,
    };
  }

  return { ok: true, url, hostname, addresses };
}

/** Audit süresince hostname doğrulamalarını önbellekleyen sarmalayıcı. */
export class SsrfGuard {
  private readonly options: SsrfOptions;

  constructor(options: SsrfOptions = {}) {
    this.options = options.allowLoopback
      ? { ...options, allowedLoopbackOrigins: options.allowedLoopbackOrigins ?? new Set<string>() }
      : options;
  }

  /** Yalnızca test fixture'ının tam origin'ini (port dahil) açar. */
  allowLoopbackOrigin(raw: string): void {
    if (!this.options.allowLoopback || !this.options.allowedLoopbackOrigins) return;
    this.options.allowedLoopbackOrigins.add(new URL(raw).origin);
  }

  check(raw: string): Promise<SsrfResult> {
    // URL'nin tamamını her istekte yeniden doğrula. Origin bazlı verdict
    // önbelleği path'i ilk istekle karıştırabilir ve DNS değişimini gizler.
    return checkUrl(raw, this.options);
  }

  clear(): void {}
}
