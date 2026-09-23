export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function retryDelayMs({ attempt, status, retryAfter, random = Math.random }) {
  if (attempt < 1 || attempt >= 3) return null;
  if (status !== undefined && !RETRYABLE_STATUS.has(status)) return null;
  const hinted = parseRetryAfter(retryAfter);
  const exponential = Math.min(8_000, 500 * (2 ** (attempt - 1)));
  return Math.min(10_000, hinted ?? exponential + Math.floor(random() * 250));
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(10_000, Number(value) * 1000);
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(10_000, delay) : null;
}
