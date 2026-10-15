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

describe('static frontend', () => {
  test('serves the homepage', async () => {
    const app = makeApp();
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('<title>LinkLite</title>');
    app.locals.db.close();
  });
});
