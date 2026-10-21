const LRUCache = require('../src/utils/lruCache');
const { TieredCache, KEY_PREFIX } = require('../src/cache/tieredCache');
const { FakeRedisServer, flush } = require('./helpers/fakeRedis');

function fakeClock(start = Date.parse('2030-01-01T00:00:00Z')) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => {
    time += ms;
  };
  return now;
}

const quietLogger = () => ({ log: jest.fn(), warn: jest.fn() });

function makeCache({ redis = null, clock = fakeClock(), logger = quietLogger(), ...rest } = {}) {
  return new TieredCache({
    l1: new LRUCache(10, { now: clock }),
    redis,
    ttlSec: 3600,
    l1TtlSec: 60,
    now: clock,
    logger,
    ...rest,
  });
}

const link = { url: 'https://example.com', expiresAt: null };

describe('TieredCache without redis', () => {
  test('works as a plain L1 cache', async () => {
    const cache = makeCache();
    expect(await cache.get('a')).toEqual({ value: undefined, level: null });

    await cache.set('a', link);
    expect(await cache.get('a')).toEqual({ value: link, level: 'L1' });

    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, l1: { hits: 1, misses: 1 }, l2: { enabled: false } });
  });

  test('setShared is a no-op', async () => {
    const cache = makeCache();
    await cache.setShared('a', link);
    expect((await cache.get('a')).value).toBeUndefined();
  });
});

describe('TieredCache with redis', () => {
  let server;
  let clock;
  beforeEach(() => {
    clock = fakeClock();
    server = new FakeRedisServer(clock);
  });

  test('an L1 miss is served from L2 and copied into L1', async () => {
    const writer = makeCache({ redis: server.client(), clock });
    const reader = makeCache({ redis: server.client(), clock });

    await writer.set('a', link);

    expect(await reader.get('a')).toEqual({ value: link, level: 'L2' });
    expect(await reader.get('a')).toEqual({ value: link, level: 'L1' });

    expect(reader.stats().l1).toMatchObject({ hits: 1, misses: 1 });
    expect(reader.stats().l2).toMatchObject({ enabled: true, hits: 1, misses: 0, hitRate: 1 });
  });

  test('counts L2 misses separately', async () => {
    const cache = makeCache({ redis: server.client(), clock });
    await cache.get('nope');
    expect(cache.stats().l2).toMatchObject({ hits: 0, misses: 1, errors: 0 });
  });

  test('setShared fills L2 but not L1', async () => {
    const redis = server.client();
    const cache = makeCache({ redis, clock });
    await cache.setShared('a', link);

    expect(cache.l1.has('a')).toBe(false);
    expect(await redis.get(KEY_PREFIX + 'a')).toBe(JSON.stringify(link));
  });

  test('uses the default ttl for links that never expire', async () => {
    const redis = server.client();
    await makeCache({ redis, clock }).set('a', link);
    expect(await redis.pttl(KEY_PREFIX + 'a')).toBe(3600_000);
  });

  test('redis ttl never outlives the link expiry', async () => {
    const redis = server.client();
    const cache = makeCache({ redis, clock });
    const expiresAt = new Date(clock() + 90_000).toISOString();

    await cache.set('soon', { url: 'https://a.com', expiresAt });
    expect(await redis.pttl(KEY_PREFIX + 'soon')).toBe(90_000);

    // the L1 copy is capped too: 60s default here, so it goes first
    clock.advance(61_000);
    expect(cache.l1.has('soon')).toBe(false);
    clock.advance(30_000);
    expect(await redis.get(KEY_PREFIX + 'soon')).toBeNull();
  });

  test('L1 ttl is capped by the link expiry when that comes first', async () => {
    const cache = makeCache({ redis: server.client(), clock });
    await cache.set('x', { url: 'https://a.com', expiresAt: new Date(clock() + 5_000).toISOString() });

    clock.advance(5_000);
    expect((await cache.get('x')).value).toBeUndefined();
  });

  test('does not cache links that have already expired', async () => {
    const redis = server.client();
    const cache = makeCache({ redis, clock });
    await cache.set('old', { url: 'https://a.com', expiresAt: new Date(clock() - 1).toISOString() });

    expect(cache.l1.size).toBe(0);
    expect(await redis.get(KEY_PREFIX + 'old')).toBeNull();
  });

  test('invalidate clears L1 and L2 and tells other instances', async () => {
    const a = makeCache({ redis: server.client(), clock });
    const b = makeCache({ redis: server.client(), clock });
    await b.subscribe(server.client());

    await a.set('k', link);
    await b.get('k'); // b now has it in L1
    expect(b.l1.has('k')).toBe(true);

    await a.invalidate('k');
    await flush();

    expect(a.l1.has('k')).toBe(false);
    expect(b.l1.has('k')).toBe(false);
    expect(await server.client().get(KEY_PREFIX + 'k')).toBeNull();
  });

  test('drops L1 after the subscriber reconnects, since messages may have been missed', async () => {
    const cache = makeCache({ redis: server.client(), clock });
    const subscriber = server.client();
    await cache.subscribe(subscriber);
    await cache.set('k', link);

    subscriber.emit('ready'); // reconnect
    expect(cache.l1.size).toBe(0);
  });
});

describe('TieredCache when redis is down', () => {
  test('falls back to L1 without throwing and warns only once', async () => {
    const clock = fakeClock();
    const logger = quietLogger();
    const redis = new FakeRedisServer(clock).client();
    const cache = makeCache({ redis, clock, logger });
    redis.down = true;

    await expect(cache.set('a', link)).resolves.toBeUndefined();
    expect(await cache.get('a')).toEqual({ value: link, level: 'L1' });

    expect(await cache.get('b')).toEqual({ value: undefined, level: null });
    await cache.get('c');
    await expect(cache.invalidate('a')).resolves.toBeUndefined();

    expect(cache.stats().l2.errors).toBeGreaterThanOrEqual(3);
    // one warning per kind of operation, not one per call
    const getWarnings = logger.warn.mock.calls.filter(([msg]) => msg.includes('redis get failed'));
    expect(getWarnings).toHaveLength(1);
  });

  test('picks L2 back up when redis recovers', async () => {
    const server = new FakeRedisServer();
    const redis = server.client();
    const cache = makeCache({ redis, logger: quietLogger() });

    redis.down = true;
    await cache.get('a');
    redis.down = false;

    await server.client().set(KEY_PREFIX + 'a', JSON.stringify(link));
    expect(await cache.get('a')).toEqual({ value: link, level: 'L2' });
  });

  test('a failed subscribe is logged, not thrown', async () => {
    const logger = quietLogger();
    const cache = makeCache({ logger });
    const subscriber = new FakeRedisServer().client();
    subscriber.down = true;

    await expect(cache.subscribe(subscriber)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not subscribe/));
  });
});
