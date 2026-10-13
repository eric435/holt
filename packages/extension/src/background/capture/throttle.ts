/**
 * A tiny rate limiter: each call to the returned function resolves no sooner
 * than `minIntervalMs` after the previous one was allowed through.
 *
 * Pure (clock injected) so it can be unit-tested.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createRateLimiter(minIntervalMs: number, clock: Clock = realClock): () => Promise<void> {
  let nextAllowedAt = 0;
  return async function waitForTurn(): Promise<void> {
    const now = clock.now();
    const at = Math.max(now, nextAllowedAt);
    // Reserve the slot before sleeping so concurrent callers queue up behind us.
    nextAllowedAt = at + minIntervalMs;
    if (at > now) await clock.sleep(at - now);
  };
}
