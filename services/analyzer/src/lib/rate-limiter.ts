const lastRequestAt = new Map<string, number>();
const pending = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Domain başına minimum istek aralığını uygular (docs/design §2.5).
 * Tek process modeli sayesinde in-process kuyruk yeterlidir; API ve worker'lar
 * ayrı container'lara bölünürse bu DB tabanlı bir kilide taşınmalıdır.
 */
export async function acquireDomainSlot(host: string, minIntervalMs: number): Promise<void> {
  const previous = pending.get(host) ?? Promise.resolve();
  const current = previous.then(async () => {
    const last = lastRequestAt.get(host);
    const now = Date.now();
    if (last !== undefined) {
      const wait = last + minIntervalMs - now;
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, Date.now());
  });
  pending.set(host, current);
  await current;
}

/** Yalnızca testler için. */
export function resetRateLimiter(): void {
  lastRequestAt.clear();
  pending.clear();
}
