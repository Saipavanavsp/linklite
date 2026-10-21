const request = require('supertest');
const Redis = require('ioredis');
const createApp = require('../../src/app');
const { RedisTokenBucket } = require('../../src/utils/redisTokenBucket');
const { testUrls, resetDatabase, flushRedis, makeInstance, ready, quiet } = require('./helpers');

const { databaseUrl, redisUrl } = testUrls();
const LIMIT = { capacity: 5, refillPerSec: 0.1 };

const shorten = (app, i) => request(app).post('/api/shorten').send({ url: `https://example.com/${i}` });

// alternate requests between the instances, like round robin behind nginx
async function sendAlternating(apps, count) {
  const statuses = [];
  for (let i = 0; i < count; i++) {
    const res = await shorten(apps[i % apps.length], i);
    statuses.push(res.status);
  }
  return statuses;
}

describe('rate limit across two app instances', () => {
  let apps = [];
  beforeEach(async () => {
    await resetDatabase(databaseUrl);
    await flushRedis(redisUrl);
  });
  afterEach(async () => {
    await Promise.all(apps.map((app) => app.locals.close()));
    apps = [];
  });

  test('with redis the limit is shared: 5 requests total, not 5 per instance', async () => {
    apps = [makeInstance({ shortenLimit: LIMIT }), makeInstance({ shortenLimit: LIMIT })];
    await Promise.all(apps.map(ready));

    const statuses = await sendAlternating(apps, 8);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429, 429]);

    // and whichever instance rejects, the response looks the same
    const res = await shorten(apps[1], 99).expect(429);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  test('without redis each instance has its own bucket (the old behaviour)', async () => {
    apps = [
      makeInstance({ shortenLimit: LIMIT, redisUrl: undefined }),
      makeInstance({ shortenLimit: LIMIT, redisUrl: undefined }),
    ];

    const statuses = await sendAlternating(apps, 12);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
  });

  test('X-RateLimit-Remaining counts down across instances', async () => {
    apps = [makeInstance({ shortenLimit: LIMIT }), makeInstance({ shortenLimit: LIMIT })];
    await Promise.all(apps.map(ready));

    const remaining = [];
    for (let i = 0; i < 5; i++) {
      const res = await shorten(apps[i % 2], i);
      remaining.push(res.headers['x-ratelimit-remaining']);
    }
    expect(remaining).toEqual(['4', '3', '2', '1', '0']);
  });

  test('different client ips get different buckets', async () => {
    const opts = { shortenLimit: { capacity: 1, refillPerSec: 0.01 }, trustProxy: true };
    apps = [makeInstance(opts), makeInstance(opts)];
    await Promise.all(apps.map(ready));

    const from = (app, ip) => request(app).post('/api/shorten').set('X-Forwarded-For', ip).send({ url: 'https://a.com' });
    await from(apps[0], '10.0.0.1').expect(201);
    await from(apps[1], '10.0.0.1').expect(429);
    await from(apps[1], '10.0.0.2').expect(201);
  });
});

describe('lua token bucket on a real redis', () => {
  let redis;
  beforeEach(async () => {
    redis = new Redis(redisUrl);
    await redis.flushdb();
  });
  afterEach(() => redis.quit());

  test('refills over time', async () => {
    const bucket = new RedisTokenBucket(redis, { capacity: 2, refillPerSec: 20 });
    expect((await bucket.take('ip')).allowed).toBe(true);
    expect((await bucket.take('ip')).allowed).toBe(true);
    expect((await bucket.take('ip')).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 120)); // 20/s -> 2 tokens back
    expect((await bucket.take('ip')).allowed).toBe(true);
  });

  test('stays exact under many concurrent requests', async () => {
    const bucket = new RedisTokenBucket(redis, { capacity: 50, refillPerSec: 0.001 });
    const results = await Promise.all(Array.from({ length: 200 }, () => bucket.take('busy')));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
  });

  test('sets an expiry so idle buckets disappear', async () => {
    const bucket = new RedisTokenBucket(redis, { capacity: 10, refillPerSec: 1, prefix: 'rl:' });
    await bucket.take('idle');
    const ttl = await redis.pttl('rl:idle');
    expect(ttl).toBeGreaterThan(10_000);
    expect(ttl).toBeLessThanOrEqual(11_000);
  });

  test('recovers when redis forgets the script (restart / SCRIPT FLUSH)', async () => {
    const bucket = new RedisTokenBucket(redis, { capacity: 3, refillPerSec: 1 });
    await bucket.take('x');
    await redis.script('FLUSH');
    expect(await bucket.take('x')).toMatchObject({ allowed: true, remaining: 1 });
  });
});

describe('rate limit when redis goes away', () => {
  test('falls back to a per-instance bucket instead of failing open or closed', async () => {
    await resetDatabase(databaseUrl);
    const app = createApp({
      dbDriver: 'postgres',
      databaseUrl,
      redisUrl: 'redis://127.0.0.1:1',
      shortenLimit: { capacity: 2, refillPerSec: 0.01 },
      logger: quiet,
    });

    await shorten(app, 1).expect(201);
    await shorten(app, 2).expect(201);
    await shorten(app, 3).expect(429);
    await app.locals.close();
  });
});
