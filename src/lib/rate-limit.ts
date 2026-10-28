/**
 * A per-isolate, in-memory rate limiter: at most `max` calls per key per
 * window.
 *
 * Best effort by nature — each isolate counts only what it sees, and can be
 * recycled at any moment — so it bounds a runaway script rather than a
 * determined attacker. What it must not do is grow without end. The copy
 * checkout carried until 2026-09-28, and account and portal until 2026-10-28, kept
 * one entry per distinct key for the isolate's whole life, so every IP that
 * ever called it stayed in memory.
 *
 * Entries are kept in the order their windows opened (a key whose window
 * lapsed is removed and re-added, not updated in place), and every window is
 * the same length, so the expired entries are always at the front. Each call
 * drops them from there and stops at the first live one — O(expired), not
 * O(everything). A flood of distinct keys inside one window is then capped at
 * `maxKeys` by forgetting the oldest: that key may start counting again, which
 * is the lesser harm next to an isolate running out of memory.
 */

export interface Limiter {
  /** Record a call for `key`; false when it is over the limit for this window. */
  (key: string): boolean;
  /** Keys currently remembered — for tests and diagnostics. */
  readonly size: number;
}

export function createLimiter(max: number, windowMs: number, maxKeys = 10_000): Limiter {
  const seen = new Map<string, { count: number; resetAt: number }>();
  const bound = Math.max(1, maxKeys);

  const allow = (key: string): boolean => {
    const now = Date.now();

    // Deleting the entry being visited is safe during Map iteration.
    for (const [k, entry] of seen) {
      if (entry.resetAt > now) break;
      seen.delete(k);
    }

    const entry = seen.get(key);
    if (entry && entry.resetAt > now) {
      entry.count++;
      return entry.count <= max;
    }

    // A new window. An expired entry the sweep did not reach (a clock that
    // stepped back) is removed first, so the new one goes to the back.
    if (entry) seen.delete(key);
    seen.set(key, { count: 1, resetAt: now + windowMs });
    if (seen.size > bound) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };

  Object.defineProperty(allow, 'size', { get: () => seen.size });
  return allow as Limiter;
}
