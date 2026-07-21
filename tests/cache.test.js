import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('deduplica cargas simultáneas', async () => {
    const loader = vi.fn(async () => 42);
    const cache = new TtlCache(60);
    expect(await Promise.all([cache.getOrLoad('x', loader), cache.getOrLoad('x', loader)])).toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
