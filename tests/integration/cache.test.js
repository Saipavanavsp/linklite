const request = require('supertest');
const Redis = require('ioredis');
const { KEY_PREFIX } = require('../../src/cache/tieredCache');
const { testUrls, resetDatabase, flushRedis, makeInstance, ready, eventually } = require('./helpers');

const { databaseUrl, redisUrl } = testUrls();

describe('two instances, shared postgres and redis', () => {
  let a;
  let b;
  let redis;

  beforeEach(async () => {
    await resetDatabase(databaseUrl);
    await flushRedis(redisUrl);
    a = makeInstance({ instanceId: 'a' });
    b = makeInstance({ instanceId: 'b' });
    redis = new Redis(redisUrl);
    await Promise.all([ready(a), ready(b)]);
  });

  afterEach(async () => {
    await Promise.all([a.locals.close(), b.locals.close(), redis.quit()]);
  });

  test('a link created on A is served from L2 on B, then from L1', async () => {
    const { body } = await request(a).post('/api/shorten').send({ url: 'https://example.com' }).expect(201);

    await request(b).get(`/${body.code}`).expect(302).expect('X-Cache-Level', 'L2');
    await request(b).get(`/${body.code}`).expect(302).expect('X-Cache-Level', 'L1');

    const { body: stats } = await request(b).get('/api/cache-stats');
    expect(stats.l2).toMatchObject({ enabled: true, hits: 1, misses: 0 });
  });

  test('a DB read on one instance fills L2 for the other', async () => {
    const { body } = await request(a).post('/api/shorten').send({ url: 'https://example.com' });
    await redis.flushdb(); // pretend the create-time write expired

    await request(a).get(`/${body.code}`).expect('X-Cache', 'MISS');
    await request(b).get(`/${body.code}`).expect('X-Cache-Level', 'L2');
  });

  test('the redis ttl is capped by the link expiry', async () => {
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const { body } = await request(a).post('/api/shorten').send({ url: 'https://example.com', expiresAt });

    const ttl = await redis.pttl(KEY_PREFIX + body.code);
    expect(ttl).toBeGreaterThan(25_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  test("an update on A removes the cached copy from L2 and from B's L1", async () => {
    await request(a).post('/api/shorten').send({ url: 'https://old.com', alias: 'shared' });
    await request(b).get('/shared').expect('Location', 'https://old.com');
    await request(b).get('/shared').expect('X-Cache-Level', 'L1');

    await request(a).patch('/api/links/shared').send({ url: 'https://new.com' }).expect(200);
    expect(await redis.get(KEY_PREFIX + 'shared')).toBeNull();

    // pub/sub delivery is asynchronous
    await eventually(async () => {
      expect(b.locals.cache.l1.has('shared')).toBe(false);
    });
    await request(b).get('/shared').expect(302).expect('Location', 'https://new.com');
  });

  test('a delete on A makes the link 404 on B', async () => {
    await request(a).post('/api/shorten').send({ url: 'https://a.com', alias: 'temp' });
    await request(b).get('/temp').expect(302);
    await request(b).get('/temp').expect(302);

    await request(a).delete('/api/links/temp').expect(204);
    await eventually(async () => {
      await request(b).get('/temp').expect(404);
    });
  });
});

describe('redis unavailable', () => {
  test('the app keeps serving from L1 and postgres, and /healthz says degraded', async () => {
    await resetDatabase(databaseUrl);
    // nothing listens on port 1
    const app = makeInstance({ redisUrl: 'redis://127.0.0.1:1' });

    const { body } = await request(app).post('/api/shorten').send({ url: 'https://example.com' }).expect(201);
    await request(app).get(`/${body.code}`).expect(302).expect('X-Cache', 'MISS');
    await request(app).get(`/${body.code}`).expect(302).expect('X-Cache-Level', 'L1');

    const health = await request(app).get('/healthz').expect(200);
    expect(health.body).toEqual({ status: 'degraded', db: 'up', redis: 'down' });

    const { body: stats } = await request(app).get('/api/cache-stats');
    expect(stats.l2.errors).toBeGreaterThan(0);

    await app.locals.close();
  });
});
