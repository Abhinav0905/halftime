// A small in-memory sliding-window limit. Each model call costs money on the
// club's API key, so a loop of requests should not drain it.
// Per server process, which is enough for a single small instance.

// Past this many keys, keys with no calls left in the window are dropped.
const PRUNE_AT = 1_000;

export function createRateLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const calls = new Map<string, number[]>();
  const recent = (key: string, now: number) => (calls.get(key) ?? []).filter((t) => now - t < windowMs);
  return {
    /** True if `key` has a call left in its window. Records nothing. */
    allows(key: string, now = Date.now()): boolean {
      return recent(key, now).length < max;
    },
    /** Records a call and returns true, or returns false if `key` has used up its window. */
    take(key: string, now = Date.now()): boolean {
      const list = recent(key, now);
      if (list.length >= max) {
        calls.set(key, list);
        return false;
      }
      list.push(now);
      calls.set(key, list);
      if (calls.size > PRUNE_AT) {
        for (const [k, times] of calls) if (!times.some((t) => now - t < windowMs)) calls.delete(k);
      }
      return true;
    },
    reset(): void {
      calls.clear();
    },
  };
}
