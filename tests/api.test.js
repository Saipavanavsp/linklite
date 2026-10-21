const request = require('supertest');
const createApp = require('../src/app');
const { decode } = require('../src/utils/base62');

const BASE_URL = 'http://lnk.test';

function makeApp(overrides = {}) {
  return createApp({
    dbPath: ':memory:',
    baseUrl: BASE_URL,
    rateLimit: { capacity: 1000, refillPerSec: 100 },
    shortenLimit: { capacity: 1000, refillPerSec: 100 },
    ...overrides,
  });
}

function shorten(app, body) {
  return request(app).post('/api/shorten').send(body);
}

describe('POST /api/shorten', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });
  afterEach(() => app.locals.db.close());

  test('creates a short code from the counter', async () => {
    const res = await shorten(app, { url: 'https://example.com/a' }).expect(201);

    expect(res.body).toMatchObject({
      code: '1000',
      url: 'https://example.com/a',
      shortUrl: `${BASE_URL}/1000`,
      clicks: 0,
      custom: false,
      expiresAt: null,
    });
    expect(new Date(res.body.createdAt).toString()).not.toBe('Invalid Date');
  });

  test('codes are sequential', async () => {
    const first = await shorten(app, { url: 'https://example.com/1' });
    const second = await shorten(app, { url: 'https://example.com/2' });
    expect(decode(second.body.code)).toBe(decode(first.body.code) + 1);
  });

  test('accepts a custom alias', async () => {
    const res = await shorten(app, { url: 'https://example.com', alias: 'my-link' }).expect(201);
    expect(res.body.code).toBe('my-link');
    expect(res.body.custom).toBe(true);
  });

  test('returns 409 when the alias is taken', async () => {
    await shorten(app, { url: 'https://example.com', alias: 'taken' }).expect(201);
    const res = await shorten(app, { url: 'https://other.com', alias: 'taken' }).expect(409);
    expect(res.body.error).toMatch(/already taken/);
  });

  test('counter skips codes already used as an alias', async () => {
    await shorten(app, { url: 'https://example.com', alias: '1000' }).expect(201);
    const res = await shorten(app, { url: 'https://example.com/next' }).expect(201);
    expect(res.body.code).toBe('1001');
  });

  test('stores an expiry date', async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const res = await shorten(app, { url: 'https://example.com', expiresAt }).expect(201);
    expect(res.body.expiresAt).toBe(expiresAt);
  });

  test.each([
    [{}, /url is required/],
    [{ url: 'not a url' }, /not valid/],
    [{ url: 'ftp://example.com/file' }, /only http and https/],
    [{ url: 'javascript:alert(1)' }, /only http and https/],
    [{ url: 'https://example.com', alias: 'a' }, /alias must be/],
    [{ url: 'https://example.com', alias: 'has space' }, /alias must be/],
    [{ url: 'https://example.com', alias: 'API' }, /reserved/],
    [{ url: 'https://example.com', expiresAt: 'tomorrow-ish' }, /valid date/],
    [{ url: 'https://example.com', expiresAt: '2000-01-01T00:00:00Z' }, /in the future/],
  ])('rejects %j', async (body, message) => {
    const res = await shorten(app, body).expect(400);
    expect(res.body.error).toMatch(message);
  });

  test('rejects malformed JSON', async () => {
    await request(app)
      .post('/api/shorten')
      .set('Content-Type', 'application/json')
      .send('{"url": ')
      .expect(400);
  });
});

describe('GET /:code', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });
  afterEach(() => app.locals.db.close());

  test('redirects with 302 and counts the click', async () => {
    const { body } = await shorten(app, { url: 'https://example.com/target' });

    const res = await request(app).get(`/${body.code}`).expect(302);
    expect(res.headers.location).toBe('https://example.com/target');

    await request(app).get(`/${body.code}`).expect(302);
    const stats = await request(app).get(`/api/stats/${body.code}`);
    expect(stats.body.clicks).toBe(2);
  });

  test('first redirect is a cache miss, second is a hit', async () => {
    const { body } = await shorten(app, { url: 'https://example.com' });

    await request(app).get(`/${body.code}`).expect('X-Cache', 'MISS');
    await request(app).get(`/${body.code}`).expect('X-Cache', 'HIT');

    const cache = await request(app).get('/api/cache-stats').expect(200);
    expect(cache.body).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  test('returns 404 for unknown codes', async () => {
    await request(app).get('/doesNotExist').expect(404);
    await request(app).get('/bad.code').expect(404);
  });

  test('returns 410 for expired links and does not count the click', async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const { body } = await shorten(app, { url: 'https://example.com', expiresAt });

    // move the expiry into the past directly in the db
    app.locals.db
      .prepare('UPDATE links SET expires_at = ? WHERE code = ?')
      .run('2000-01-01T00:00:00.000Z', body.code);

    await request(app).get(`/${body.code}`).expect(410);
    const stats = await request(app).get(`/api/stats/${body.code}`);
    expect(stats.body.clicks).toBe(0);
    expect(stats.body.expired).toBe(true);
  });
});

describe('GET /api/stats/:code', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });
  afterEach(() => app.locals.db.close());

  test('returns clicks, created date and expiry', async () => {
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const { body } = await shorten(app, { url: 'https://example.com', alias: 'stats-me', expiresAt });

    const res = await request(app).get('/api/stats/stats-me').expect(200);
    expect(res.body).toEqual({
      code: 'stats-me',
      url: 'https://example.com',
      shortUrl: `${BASE_URL}/stats-me`,
      clicks: 0,
      custom: true,
      createdAt: body.createdAt,
      expiresAt,
      expired: false,
    });
  });

  test('returns 404 for unknown codes', async () => {
    await request(app).get('/api/stats/nothing').expect(404);
  });
});

describe('rate limiting', () => {
  test('POST /api/shorten returns 429 with Retry-After when over the limit', async () => {
    const app = makeApp({ shortenLimit: { capacity: 2, refillPerSec: 0.5 } });

    await shorten(app, { url: 'https://example.com/1' }).expect(201);
    await shorten(app, { url: 'https://example.com/2' }).expect(201);
    const res = await shorten(app, { url: 'https://example.com/3' }).expect(429);

    expect(res.headers['retry-after']).toBe('2');
    expect(res.body.error).toBe('Too many requests');

    // other routes use the general limiter, so they still work
    await request(app).get('/api/cache-stats').expect(200);
    app.locals.db.close();
  });
});

describe('PATCH /api/links/:code', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
  });
  afterEach(() => app.locals.db.close());

  test('changes the target and the next redirect uses it, even if it was cached', async () => {
    await shorten(app, { url: 'https://old.com', alias: 'moving' });
    await request(app).get('/moving').expect(302).expect('Location', 'https://old.com');
    await request(app).get('/moving').expect('X-Cache', 'HIT');

    const res = await request(app).patch('/api/links/moving').send({ url: 'https://new.com' }).expect(200);
    expect(res.body).toMatchObject({ code: 'moving', url: 'https://new.com', shortUrl: `${BASE_URL}/moving` });

    await request(app).get('/moving').expect(302).expect('Location', 'https://new.com').expect('X-Cache', 'MISS');
  });

  test('sets and clears the expiry', async () => {
    await shorten(app, { url: 'https://a.com', alias: 'timed' });
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    let res = await request(app).patch('/api/links/timed').send({ expiresAt }).expect(200);
    expect(res.body.expiresAt).toBe(expiresAt);

    res = await request(app).patch('/api/links/timed').send({ expiresAt: null }).expect(200);
    expect(res.body.expiresAt).toBeNull();
  });

  test('un-expires a link that was returning 410', async () => {
    const { body } = await shorten(app, { url: 'https://a.com', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    app.locals.db.prepare('UPDATE links SET expires_at = ? WHERE code = ?').run('2000-01-01T00:00:00.000Z', body.code);
    await request(app).get(`/${body.code}`).expect(410);

    await request(app).patch(`/api/links/${body.code}`).send({ expiresAt: null }).expect(200);
    await request(app).get(`/${body.code}`).expect(302);
  });

  test.each([
    [{}, /nothing to update/],
    [{ url: 'ftp://x.com' }, /only http and https/],
    [{ expiresAt: '2000-01-01T00:00:00Z' }, /in the future/],
  ])('rejects %j', async (body, message) => {
    await shorten(app, { url: 'https://a.com', alias: 'valid' });
    const res = await request(app).patch('/api/links/valid').send(body).expect(400);
    expect(res.body.error).toMatch(message);
  });

  test('returns 404 for unknown codes', async () => {
    await request(app).patch('/api/links/nothing').send({ url: 'https://a.com' }).expect(404);
  });
});

describe('DELETE /api/links/:code', () => {
  test('deletes the link and evicts it from the cache', async () => {
    const app = makeApp();
    await shorten(app, { url: 'https://a.com', alias: 'bye-bye' });
    await request(app).get('/bye-bye').expect(302);
    await request(app).get('/bye-bye').expect('X-Cache', 'HIT');

    await request(app).delete('/api/links/bye-bye').expect(204);
    await request(app).get('/bye-bye').expect(404);
    await request(app).get('/api/stats/bye-bye').expect(404);
    await request(app).delete('/api/links/bye-bye').expect(404);
    app.locals.db.close();
  });
});

describe('two instances sharing a cache (fake redis)', () => {
  const { FakeRedisServer, flush } = require('./helpers/fakeRedis');
  const { createSqliteRepository } = require('../src/storage/sqliteRepository');
  const quiet = { log() {}, warn() {} };

  // Two apps, one database and one redis, like two containers behind nginx.
  function makePair() {
    const repo = createSqliteRepository(':memory:');
    const server = new FakeRedisServer();
    const a = makeApp({ repo, redis: server.client(), logger: quiet });
    const b = makeApp({ repo, redis: server.client(), logger: quiet });
    return { a, b, repo };
  }

  test('a link created on one instance is an L2 hit on the other', async () => {
    const { a, b, repo } = makePair();
    const { body } = await shorten(a, { url: 'https://example.com' });

    await request(b).get(`/${body.code}`).expect(302).expect('X-Cache', 'HIT').expect('X-Cache-Level', 'L2');
    await request(b).get(`/${body.code}`).expect('X-Cache-Level', 'L1');

    const stats = await request(b).get('/api/cache-stats').expect(200);
    expect(stats.body).toMatchObject({ l1: { hits: 1, misses: 1 }, l2: { enabled: true, hits: 1, misses: 0 } });
    await repo.close();
  });

  test('an update on one instance clears the L1 copy on the other', async () => {
    const { a, b, repo } = makePair();
    await Promise.all([a.locals.ready, b.locals.ready]);
    await shorten(a, { url: 'https://old.com', alias: 'shared' });

    await request(b).get('/shared').expect('Location', 'https://old.com');
    await request(b).get('/shared').expect('X-Cache-Level', 'L1');

    await request(a).patch('/api/links/shared').send({ url: 'https://new.com' }).expect(200);
    await flush();

    await request(b).get('/shared').expect('Location', 'https://new.com').expect('X-Cache', 'MISS');
    await repo.close();
  });
});

describe('static frontend', () => {
  test('serves the homepage', async () => {
    const app = makeApp();
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('<title>LinkLite</title>');
    app.locals.db.close();
  });
});
