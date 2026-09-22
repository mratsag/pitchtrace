import { config } from '../config.js';
import { SafeFetchError, safeFetch } from '../security/safe-fetch.js';

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  /** robots.txt bulunamadıysa true: kural yok, her şey serbest. */
  missing: boolean;
  /** robots.txt'te bildirilen Sitemap adresleri. */
  sitemaps: string[];
  isAllowed(pathname: string): boolean;
}

const ALLOW_ALL: RobotsPolicy = { missing: true, sitemaps: [], isAllowed: () => true };

function normalizeAgent(value: string): string {
  return value.trim().toLowerCase();
}

/** UA token'ı: "PitchTraceBot/0.1 (...)" → "pitchtracebot" */
export function userAgentToken(userAgent: string): string {
  const first = userAgent.split(/[\s/]/)[0] ?? userAgent;
  return first.toLowerCase();
}

/**
 * robots.txt gövdesini ayrıştırır (RFC 9309 alt kümesi).
 * En uzun eşleşen kural kazanır; eşit uzunlukta Allow, Disallow'u yener.
 */
export function parseRobots(body: string, agentToken: string): RobotsPolicy {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim();
    if (line === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(normalizeAgent(value));
      lastLineWasAgent = true;
      continue;
    }

    if (field === 'sitemap') {
      lastLineWasAgent = false;
      if (value !== '') sitemaps.push(value);
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      lastLineWasAgent = false;
      if (!current) continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }

  const exact = groups.filter((g) => g.agents.includes(agentToken));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const selected = exact.length > 0 ? exact : wildcard;
  const rules = selected.flatMap((g) => g.rules);

  return {
    missing: false,
    sitemaps,
    isAllowed(pathname: string): boolean {
      let best: { length: number; allow: boolean } | null = null;
      for (const rule of rules) {
        // "Disallow:" (boş değer) hiçbir şeyi engellemez.
        if (rule.pattern === '') {
          if (!rule.allow) continue;
        }
        if (!matches(rule.pattern, pathname)) continue;
        const length = rule.pattern.length;
        if (best === null || length > best.length || (length === best.length && rule.allow)) {
          best = { length, allow: rule.allow };
        }
      }
      return best === null ? true : best.allow;
    },
  };
}

/** robots.txt joker desteği: '*' herhangi bir dizi, '$' satır sonu. */
function matches(pattern: string, pathname: string): boolean {
  if (pattern === '') return false;
  const endAnchored = pattern.endsWith('$');
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');

  let index = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '') continue;
    if (i === 0) {
      if (!pathname.startsWith(part)) return false;
      index = part.length;
      continue;
    }
    const found = pathname.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }
  if (endAnchored) {
    const last = parts[parts.length - 1]!;
    return last === '' ? true : pathname.endsWith(last) && pathname.length >= index;
  }
  return true;
}

export interface RobotsFetchResult {
  policy: RobotsPolicy;
  status: number | null;
  /** İstek SSRF/ağ hatası ile başarısız olduysa dolu. */
  errorCode: string | null;
}

/**
 * Origin'in robots.txt dosyasını güvenli biçimde çeker.
 * 4xx → kural yok (serbest). 5xx/ağ hatası → çağıran karar verir.
 */
export async function fetchRobots(
  origin: string,
  options: { allowLoopback: boolean },
): Promise<RobotsFetchResult> {
  const url = new URL('/robots.txt', origin).toString();
  try {
    const res = await safeFetch(url, {
      allowLoopback: options.allowLoopback,
      maxRedirects: config.maxRedirects,
      maxBytes: config.maxRobotsBytes,
      timeoutMs: config.navTimeoutMs,
      userAgent: config.userAgent,
    });
    if (res.status >= 400 && res.status < 500) {
      return { policy: ALLOW_ALL, status: res.status, errorCode: null };
    }
    if (res.status >= 500) {
      return { policy: ALLOW_ALL, status: res.status, errorCode: 'ROBOTS_FETCH_FAILED' };
    }
    return {
      policy: parseRobots(res.body, userAgentToken(config.userAgent)),
      status: res.status,
      errorCode: null,
    };
  } catch (err) {
    const code = err instanceof SafeFetchError ? err.code : 'ROBOTS_FETCH_FAILED';
    return { policy: ALLOW_ALL, status: null, errorCode: code };
  }
}
