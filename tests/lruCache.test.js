const LRUCache = require('../src/utils/lruCache');

describe('LRUCache', () => {
  test('get returns stored values and undefined for missing keys', () => {
    const cache = new LRUCache(2);
    cache.put('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('nope')).toBeUndefined();
  });

  test('evicts the least recently used key when full', () => {
    const cache = new LRUCache(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.put('d', 4);

    expect(cache.has('a')).toBe(false);
    expect(cache.keys()).toEqual(['d', 'c', 'b']);
    expect(cache.size).toBe(3);
  });

  test('get moves a key to the front so it survives eviction', () => {
    const cache = new LRUCache(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);

    cache.get('a');
    cache.put('d', 4);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.keys()).toEqual(['d', 'a', 'c']);
  });

  test('put on an existing key updates it without growing', () => {
    const cache = new LRUCache(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('a', 10);
    cache.put('c', 3);

    expect(cache.get('a')).toBe(10);
    expect(cache.has('b')).toBe(false);
    expect(cache.size).toBe(2);
  });

  test('capacity of one keeps only the latest key', () => {
    const cache = new LRUCache(1);
    cache.put('a', 1);
    cache.put('b', 2);
    expect(cache.keys()).toEqual(['b']);
  });

  test('delete removes a key and keeps the list intact', () => {
    const cache = new LRUCache(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);

    expect(cache.delete('b')).toBe(true);
    expect(cache.delete('b')).toBe(false);
    expect(cache.keys()).toEqual(['c', 'a']);
  });

  test('tracks hits and misses', () => {
    const cache = new LRUCache(2);
    cache.put('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('x');

    expect(cache.stats()).toEqual({ capacity: 2, size: 1, hits: 2, misses: 1, hitRate: 0.667 });
  });

  test('an entry with a ttl expires and counts as a miss', () => {
    let time = 0;
    const cache = new LRUCache(2, { now: () => time });
    cache.put('a', 1, 1000);
    cache.put('b', 2);

    time = 999;
    expect(cache.get('a')).toBe(1);
    time = 1000;
    expect(cache.has('a')).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.keys()).toEqual(['b']);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  test('put refreshes the ttl of an existing key', () => {
    let time = 0;
    const cache = new LRUCache(2, { now: () => time });
    cache.put('a', 1, 1000);
    time = 900;
    cache.put('a', 2, 1000);
    time = 1500;
    expect(cache.get('a')).toBe(2);
  });

  test('clear empties the cache and it still works afterwards', () => {
    const cache = new LRUCache(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
    cache.put('c', 3);
    expect(cache.keys()).toEqual(['c']);
  });

  test('rejects invalid capacity', () => {
    expect(() => new LRUCache(0)).toThrow(RangeError);
    expect(() => new LRUCache(2.5)).toThrow(RangeError);
  });
});
