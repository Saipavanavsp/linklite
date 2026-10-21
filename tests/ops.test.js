const request = require('supertest');
const createApp = require('../src/app');
const { FakeRedisServer } = require('./helpers/fakeRedis');

const quiet = { log() {}, warn() {} };

function makeApp(overrides = {}) {
  return createApp({
    rateLimit: { capacity: 1000, refillPerSec: 100 },
    shortenLimit: { capacity: 1000, refillPerSec: 100 },
    logger: quiet,
    ...overrides,
  });
}

describe('GET /healthz', () => {
  test('ok with sqlite and no redis', async () => {
    const app = makeApp();
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'disabled' });
    await app.locals.close();
  });

  test('ok when redis answers', async () => {
    const app = makeApp({ redis: new FakeRedisServer().client() });
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
    await app.locals.close();
  });

  test('degraded but still 200 when redis is down', async () => {
    const redis = new FakeRedisServer().client();
    const app = makeApp({ redis });
    redis.down = true;

    const res = await request(app).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'degraded', db: 'up', redis: 'down' });
    await app.locals.close();
  });

  test('503 when the database is unreachable', async () => {
    const app = makeApp();
    app.locals.db.close();
    const res = await request(app).get('/healthz').expect(503);
    expect(res.body).toMatchObject({ status: 'down', db: 'down' });
  });

  test('503 while shutting down, so the load balancer drains this instance', async () => {
    const app = makeApp();
    app.locals.shuttingDown = true;
    const res = await request(app).get('/healthz').expect(503);
    expect(res.body.status).toBe('shutting_down');
    await app.locals.close();
  });

  test('is never rate limited', async () => {
    const app = makeApp({ rateLimit: { capacity: 1, refillPerSec: 0.01 } });
    await request(app).get('/api/cache-stats').expect(200);
    await request(app).get('/api/cache-stats').expect(429);
    await request(app).get('/healthz').expect(200);
    await request(app).get('/metrics').expect(200);
    await app.locals.close();
  });
});

describe('GET /metrics', () => {
  test('counts requests by status, rate limit rejections and cache hits', async () => {
    const app = makeApp({ shortenLimit: { capacity: 2, refillPerSec: 0.01 }, instanceId: 'test-1' });

    const { body } = await request(app).post('/api/shorten').send({ url: 'https://example.com' });
    await request(app).post('/api/shorten').send({ url: 'https://example.com' });
    await request(app).post('/api/shorten').send({ url: 'https://example.com' }).expect(429);
    await request(app).get(`/${body.code}`).expect(302);
    await request(app).get(`/${body.code}`).expect(302);
    await request(app).get('/nope1').expect(404);

    const res = await request(app).get('/metrics').expect(200);
    expect(res.body).toMatchObject({
      instance: 'test-1',
      requests: { total: 6, byStatus: { '2xx': 2, '3xx': 2, '4xx': 2, '5xx': 0 } },
      rateLimited: { shorten: 1, total: 1 },
      cache: { l1: { hits: 1, misses: 2 }, l2: { enabled: false } },
      storage: { driver: 'sqlite' },
      redis: { enabled: false },
    });
    expect(typeof res.body.uptimeSec).toBe('number');
    await app.locals.close();
  });

  test('includes L2 numbers when redis is configured', async () => {
    const app = makeApp({ redis: new FakeRedisServer().client() });
    const res = await request(app).get('/metrics').expect(200);
    expect(res.body.cache.l2).toMatchObject({ enabled: true, hits: 0, misses: 0, errors: 0 });
    expect(res.body.redis).toEqual({ enabled: true, status: 'ready' });
    await app.locals.close();
  });
});

describe('instance header and reserved paths', () => {
  test('X-Instance is set when an instance id is configured', async () => {
    const app = makeApp({ instanceId: 'app2' });
    await request(app).get('/healthz').expect('X-Instance', 'app2');
    await app.locals.close();
  });

  test('healthz and metrics cannot be used as aliases', async () => {
    const app = makeApp();
    for (const alias of ['healthz', 'metrics']) {
      const res = await request(app).post('/api/shorten').send({ url: 'https://a.com', alias }).expect(400);
      expect(res.body.error).toMatch(/reserved/);
    }
    await app.locals.close();
  });
});
