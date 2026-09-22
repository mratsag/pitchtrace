import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { SsrfErrorCode, SsrfGuard } from './ssrf.js';

export class PinnedRequestError extends Error {
  constructor(readonly code: SsrfErrorCode | 'HTTP_ERROR' | 'TIMEOUT' | 'TOO_MANY_REDIRECTS' | 'RESPONSE_TOO_LARGE', readonly url: string, message: string) {
    super(message);
    this.name = 'PinnedRequestError';
  }
}

export interface PinnedRequestOptions {
  guard: SsrfGuard;
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  ignoreHttpsErrors: boolean;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

const DROP_REQUEST_HEADERS = new Set([
  'connection', 'content-length', 'host', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'transfer-encoding', 'upgrade']);

/**
 * Fetches one browser resource without allowing the HTTP stack to resolve DNS
 * again. Every redirect target is revalidated, then the socket is pinned to a
 * checked address while Host/SNI retain the original hostname.
 */
export async function pinnedRequest(startUrl: string, options: PinnedRequestOptions): Promise<PinnedResponse> {
  let current = startUrl;
  let method = options.method.toUpperCase();
  let body = options.body;

  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const verdict = await options.guard.check(current);
    if (!verdict.ok) throw new PinnedRequestError(verdict.code, current, verdict.reason);
    const address = verdict.addresses[0];
    if (!address) throw new PinnedRequestError('DNS_FAILURE', current, 'no validated address');

    const response = await requestOne(verdict.url, address, {
      ...options, method, body,
    });
    if (response.status < 300 || response.status >= 400) return { ...response, finalUrl: current };

    const location = response.headers['location'];
    if (!location) throw new PinnedRequestError('HTTP_ERROR', current, 'redirect without Location');
    current = new URL(location, current).toString();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = null;
    }
  }
  throw new PinnedRequestError('TOO_MANY_REDIRECTS', current, `exceeded ${options.maxRedirects} redirects`);
}

function requestOne(url: URL, address: string, options: PinnedRequestOptions): Promise<Omit<PinnedResponse, 'finalUrl'>> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers)) {
      if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    headers.host = url.host;
    if (options.body) headers['content-length'] = String(options.body.byteLength);

    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers,
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: !options.ignoreHttpsErrors,
      lookup: (_hostname, _lookupOptions, callback) => {
        callback(null, address, net.isIP(address) || 4);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          req.destroy(new PinnedRequestError('RESPONSE_TOO_LARGE', url.toString(), `resource exceeds ${options.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined || DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(options.timeoutMs, () => req.destroy(new PinnedRequestError('TIMEOUT', url.toString(), 'request timed out')));
    req.on('error', (err) => reject(err instanceof PinnedRequestError ? err : new PinnedRequestError('HTTP_ERROR', url.toString(), err.message)));
    if (options.body) req.write(options.body);
    req.end();
  });
}
