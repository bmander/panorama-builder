// Generic LRU + inflight-dedup cache for keyed async fetches. Used by `dem.ts`
// and `imagery.ts`, which fetch the same XYZ tile space but decode it
// differently. Map insertion order doubles as recency: re-inserting moves to
// the end, so deleting the first key drops the oldest. Only successful results
// (non-null) are cached.

export interface TileCache<T> {
  fetch(key: string, source: () => Promise<T | null>): Promise<T | null>;
}

export function createTileCache<T>(maxSize: number): TileCache<T> {
  const cache = new Map<string, T>();
  const inflight = new Map<string, Promise<T | null>>();

  function touch(k: string, value: T): void {
    cache.delete(k);
    cache.set(k, value);
    while (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return {
    fetch(key, source) {
      const cached = cache.get(key);
      if (cached) {
        touch(key, cached);
        return Promise.resolve(cached);
      }
      const pending = inflight.get(key);
      if (pending) return pending;

      const job = (async (): Promise<T | null> => {
        const result = await source();
        if (result !== null) touch(key, result);
        return result;
      })();
      inflight.set(key, job);
      void job.finally(() => { inflight.delete(key); });
      return job;
    },
  };
}
