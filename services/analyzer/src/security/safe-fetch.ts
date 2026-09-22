import { checkUrl, type SsrfOptions } from './ssrf.js';

export interface SafeFetchOptions extends SsrfOptions {
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  userAgent: string;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  /** maxBytes'a kadar okunan gövde; aşıldıysa kesilmiştir. */
  body: string;
  truncated: boolean;
}

export class SafeFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

/**
 * Redirect'leri elle takip eden, her hop'ta SSRF doğrulaması yapan,
 * gövdeyi bayt sınırında kesen fetch. robots.txt için kullanılır.
 */
export async function safeFetch(
  startUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  let current = startUrl;

  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const verdict = await checkUrl(current, options);
    if (!verdict.ok) {
      throw new SafeFetchError(verdict.code, verdict.reason);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(verdict.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': options.userAgent, accept: 'text/plain,*/*' },
      });
    } catch (err) {
      throw new SafeFetchError(
        controller.signal.aborted ? 'TIMEOUT' : 'FETCH_FAILED',
        `fetch failed for ${current}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new SafeFetchError('BAD_REDIRECT', `redirect without Location at ${current}`);
      }
      // Sonraki tur başında tekrar doğrulanır.
      current = new URL(location, current).toString();
      continue;
    }

    const { body, truncated } = await readCapped(response, options.maxBytes);
    return { status: response.status, finalUrl: current, body, truncated };
  }

  throw new SafeFetchError(
    'TOO_MANY_REDIRECTS',
    `exceeded ${options.maxRedirects} redirects starting at ${startUrl}`,
  );
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}
