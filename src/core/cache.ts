import type { CacheEntry } from '../types.js';

export class SecretCache {
  private store = new Map<string, CacheEntry>();
  private ttlMs: number;
  private hits = 0;
  private misses = 0;

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() > entry.expires_at) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry;
  }

  set(key: string, value: string, version: number): void {
    this.store.set(key, { value, version, expires_at: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  size(): number { return this.store.size; }

  stats(): { hits: number; misses: number; hitRatePercent: number; entries: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRatePercent: total === 0 ? 0 : (this.hits / total) * 100,
      entries: this.store.size,
    };
  }
}
