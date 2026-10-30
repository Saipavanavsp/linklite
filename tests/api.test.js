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

// creates a link and returns { code, token } for PATCH/DELETE
async function own(app, body) {
  const res = await shorten(app, body).expect(201);
  return { code: res.body.code, token: res.body.manageToken };
}

function patch(app, { code, token }, body) {
  return request(app).patch(`/api/links/${code}`).set('Authorization', `Bearer ${token}`).send(body);
}

function remove(app, { code, token }) {
  return request(app).delete(`/api/links/${code}`).set('Authorization', `Bearer ${token}`);
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
    expect(res.body.manageToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test('opaque links get a random 10 character code instead of the next counter value', async () => {
    const res = await shorten(app, { url: 'https://example.com/private', opaque: true }).expect(201);
    expect(res.body.code).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(res.body.custom).toBe(false);
    await request(app).get(`/${res.body.code}`).expect(302).expect('Location', 'https://example.com/private');

    // the counter wasn't used
    const next = await shorten(app, { url: 'https://example.com/public' });
    expect(next.body.code).toBe('1000');
  });

  test('two opaque links never get the same code', async () => {
    const codes = new Set();
    for (let i = 0; i < 20; i++) {
      codes.add((await shorten(app, { url: 'https://example.com', opaque: true })).body.code);
    }
    expect(codes.size).toBe(20);
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
    [{ url: 'https://example.com', opaque: 'yes' }, /opaque must be/],
    [{ url: 'https://example.com', opaque: true, alias: 'mine' }, /either alias or opaque/],
    [{ url: 'http://localhost:8080/admin' }, /private networks/],
    [{ url: 'http://127.0.0.1/' }, /private networks/],
    [{ url: 'http://0x7f.1/' }, /private networks/],
    [{ url: 'http://10.1.2.3/' }, /private networks/],
    [{ url: 'http://192.168.1.1/' }, /private networks/],
    [{ url: 'http://169.254.169.254/latest/meta-data/' }, /private networks/],
    [{ url: 'http://[::1]/' }, /private networks/],
    [{ url: 'http://[::ffff:127.0.0.1]/' }, /private networks/],
    [{ url: 'http://[fd00::1]/' }, /private networks/],
    [{ url: 'http://router.local/' }, /private networks/],
    [{ url: 'http://intranet/' }, /private networks/],
    [{ url: 'https://paypal.com@evil.example/' }, /username or password/],
    [{ url: `${BASE_URL}/1000` }, /link to this service/],
  ])('rejects %j', async (body, message) => {
    const res = await shorten(app, body).expect(400);
    expect(res.body.error).toMatch(message);
  });

  test('allows public hosts and IPs', async () => {
    await shorten(app, { url: 'http://93.184.215.14/page' }).expect(201);
    await shorten(app, { url: 'https://sub.example.co.uk:8443/a?b=c#d' }).expect(201);
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

  test('returns clicks, created date and expiry, never the token', async () => {
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
    const link = await own(app, { url: 'https://old.com', alias: 'moving' });
    await request(app).get('/moving').expect(302).expect('Location', 'https://old.com');
    await request(app).get('/moving').expect('X-Cache', 'HIT');

    const res = await patch(app, link, { url: 'https://new.com' }).expect(200);
    expect(res.body).toMatchObject({ code: 'moving', url: 'https://new.com', shortUrl: `${BASE_URL}/moving` });
    expect(res.body.manageToken).toBeUndefined();

    await request(app).get('/moving').expect(302).expect('Location', 'https://new.com').expect('X-Cache', 'MISS');
  });

  test('sets and clears the expiry', async () => {
    const link = await own(app, { url: 'https://a.com', alias: 'timed' });
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    let res = await patch(app, link, { expiresAt }).expect(200);
    expect(res.body.expiresAt).toBe(expiresAt);

    res = await patch(app, link, { expiresAt: null }).expect(200);
    expect(res.body.expiresAt).toBeNull();
  });

  test('un-expires a link that was returning 410', async () => {
    const link = await own(app, { url: 'https://a.com', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    app.locals.db.prepare('UPDATE links SET expires_at = ? WHERE code = ?').run('2000-01-01T00:00:00.000Z', link.code);
    await request(app).get(`/${link.code}`).expect(410);

    await patch(app, link, { expiresAt: null }).expect(200);
    await request(app).get(`/${link.code}`).expect(302);
  });

  test.each([
    [{}, /nothing to update/],
    [{ url: 'ftp://x.com' }, /only http and https/],
    [{ url: 'http://192.168.0.1/' }, /private networks/],
    [{ expiresAt: '2000-01-01T00:00:00Z' }, /in the future/],
  ])('rejects %j', async (body, message) => {
    const link = await own(app, { url: 'https://a.com', alias: 'valid' });
    const res = await patch(app, link, body).expect(400);
    expect(res.body.error).toMatch(message);
  });

  test('returns 404 for unknown codes', async () => {
    await patch(app, { code: 'nothing', token: 'x' }, { url: 'https://a.com' }).expect(404);
  });

  test('401 without a token, 403 with the wrong one, and the link is unchanged', async () => {
    const mine = await own(app, { url: 'https://mine.com', alias: 'mine' });
    const theirs = await own(app, { url: 'https://theirs.com', alias: 'theirs' });

    const noToken = await request(app).patch('/api/links/mine').send({ url: 'https://evil.example' }).expect(401);
    expect(noToken.headers['www-authenticate']).toBe('Bearer');

    // someone else's valid token doesn't work on my link
    await patch(app, { code: 'mine', token: theirs.token }, { url: 'https://evil.example' }).expect(403);
    await patch(app, { code: 'mine', token: 'guess' }, { url: 'https://evil.example' }).expect(403);
    await request(app).patch('/api/links/mine').set('Authorization', mine.token).send({ url: 'https://x.com' }).expect(401);

    const stats = await request(app).get('/api/stats/mine');
    expect(stats.body.url).toBe('https://mine.com');
  });

  test('links created before tokens existed cannot be edited', async () => {
    const link = await own(app, { url: 'https://old.com', alias: 'legacy' });
    app.locals.db.prepare('UPDATE links SET manage_token_hash = NULL WHERE code = ?').run('legacy');
    await patch(app, link, { url: 'https://new.com' }).expect(403);
  });

  test('only a hash of the token is stored', async () => {
    const link = await own(app, { url: 'https://a.com', alias: 'hashed' });
    const row = app.locals.db.prepare('SELECT * FROM links WHERE code = ?').get('hashed');
    expect(row.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(link.token);
  });
});

describe('DELETE /api/links/:code', () => {
  test('deletes the link and evicts it from the cache', async () => {
    const app = makeApp();
    const link = await own(app, { url: 'https://a.com', alias: 'bye-bye' });
    await request(app).get('/bye-bye').expect(302);
    await request(app).get('/bye-bye').expect('X-Cache', 'HIT');

    await remove(app, link).expect(204);
    await request(app).get('/bye-bye').expect(404);
    await request(app).get('/api/stats/bye-bye').expect(404);
    await remove(app, link).expect(404);
    app.locals.db.close();
  });

  test('needs the right token', async () => {
    const app = makeApp();
    await own(app, { url: 'https://a.com', alias: 'keep-me' });
    await request(app).delete('/api/links/keep-me').expect(401);
    await remove(app, { code: 'keep-me', token: 'wrong' }).expect(403);
    await request(app).get('/keep-me').expect(302);
    app.locals.db.close();
  });
});

describe('Google Safe Browsing check', () => {
  function fakeSafeBrowsing(flagged) {
    return {
      enabled: true,
      async check(url) {
        return flagged.includes(url) ? { safe: false, threat: 'SOCIAL_ENGINEERING' } : { safe: true };
      },
      stats: () => ({ enabled: true }),
    };
  }

  test('flagged urls are rejected on create and on update', async () => {
    const app = makeApp({ safeBrowsing: fakeSafeBrowsing(['https://phish.example/login']) });

    const res = await shorten(app, { url: 'https://phish.example/login' }).expect(400);
    expect(res.body.error).toMatch(/Safe Browsing \(SOCIAL_ENGINEERING\)/);

    const link = await own(app, { url: 'https://fine.example' });
    await patch(app, link, { url: 'https://phish.example/login' }).expect(400);
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
    const link = await own(a, { url: 'https://old.com', alias: 'shared' });

    await request(b).get('/shared').expect('Location', 'https://old.com');
    await request(b).get('/shared').expect('X-Cache-Level', 'L1');

    await patch(a, link, { url: 'https://new.com' }).expect(200);
    await flush();

    await request(b).get('/shared').expect('Location', 'https://new.com').expect('X-Cache', 'MISS');
    await repo.close();
  });

  test('clicks are buffered in redis, show up in stats right away, and reach the db on flush', async () => {
    const { a, b, repo } = makePair();
    const { body } = await shorten(a, { url: 'https://example.com' });

    await request(a).get(`/${body.code}`).expect(302);
    await request(b).get(`/${body.code}`).expect(302);
    await request(b).get(`/${body.code}`).expect(302);

    // nothing in the db yet, but stats adds what's pending in redis
    expect((await repo.findByCode(body.code)).clicks).toBe(0);
    expect((await request(a).get(`/api/stats/${body.code}`)).body.clicks).toBe(3);

    await Promise.all([a.locals.clicks.flush(), b.locals.clicks.flush()]);
    expect((await repo.findByCode(body.code)).clicks).toBe(3);
    expect((await request(b).get(`/api/stats/${body.code}`)).body.clicks).toBe(3);
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
