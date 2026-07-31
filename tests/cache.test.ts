import { describe, it, expect, beforeEach } from 'vitest';
import { SecretCache } from '../src/core/cache.js';

let cache: SecretCache;

beforeEach(() => {
  cache = new SecretCache(1); // 1 second TTL for fast tests
});

describe('SecretCache', () => {
  it('stores and retrieves a value', () => {
    cache.set('KEY', 'value', 1);
    const entry = cache.get('KEY');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('value');
    expect(entry!.version).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('NOPE')).toBeUndefined();
  });

  it('expires entries after TTL', async () => {
    cache.set('KEY', 'value', 1);
    await new Promise(r => setTimeout(r, 1100));
    expect(cache.get('KEY')).toBeUndefined();
  });

  it('invalidates a specific key', () => {
    cache.set('KEY', 'value', 1);
    cache.invalidate('KEY');
    expect(cache.get('KEY')).toBeUndefined();
  });

  it('clears all entries', () => {
    cache.set('A', 'v1', 1);
    cache.set('B', 'v2', 1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('tracks hit/miss stats', () => {
    cache.set('KEY', 'val', 1);
    cache.get('KEY'); // hit
    cache.get('MISS'); // miss
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRatePercent).toBeCloseTo(50);
  });
});
