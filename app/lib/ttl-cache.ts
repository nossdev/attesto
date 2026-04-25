/**
 * Minimal in-memory TTL cache used for decrypted tenant credentials.
 *
 * Generic on both key (string) and value. Entries expire after `ttlMs` and
 * are removed lazily on access (no background timer, keeps the module
 * allocation-free at idle). Callers use `loadOrFetch(key, loader)` to dedupe
 * concurrent misses: multiple requests for the same key during a fetch share
 * one in-flight Promise, avoiding stampedes on the DB + decryption path.
 */
export interface TtlCacheOptions {
  ttlMs: number;
  /** Caller-provided clock, for deterministic tests. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
  loadOrFetch(key: string, loader: () => Promise<V>): Promise<V>;
  size(): number;
}

export function createTtlCache<V>(opts: TtlCacheOptions): TtlCache<V> {
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, Entry<V>>();
  const inflight = new Map<string, Promise<V>>();

  function get(key: string): V | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: V): void {
    store.set(key, { value, expiresAt: now() + opts.ttlMs });
  }

  function loadOrFetch(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = loader()
      .then((value) => {
        set(key, value);
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  return {
    get,
    set,
    delete: (key) => void store.delete(key),
    clear: () => {
      store.clear();
      inflight.clear();
    },
    loadOrFetch,
    size: () => store.size,
  };
}
