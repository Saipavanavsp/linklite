const express = require('express');
const request = require('supertest');
const TokenBucket = require('../src/utils/tokenBucket');
const rateLimiter = require('../src/middleware/rateLimiter');

// fake clock so the tests don't depend on real time passing
function fakeClock(start = 1_000_000) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => {
    time += ms;
  };
  return now;
}

describe('TokenBucket', () => {
  test('allows a burst up to capacity, then blocks', () => {
    const bucket = new TokenBucket(3, 1, fakeClock());
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  test('refills over time at the configured rate', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 2, clock);
    bucket.tryRemove();
    bucket.tryRemove();
    expect(bucket.tryRemove()).toBe(false);

    clock.advance(500); // 2 tokens/sec -> one token after half a second
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  test('never refills above capacity', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1, clock);
    clock.advance(60_000);
    bucket.refill();
    expect(bucket.tokens).toBe(2);
  });

  test('retryAfterSec says how long until the next token', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1, 0.2, clock);
    bucket.tryRemove();
    expect(bucket.retryAfterSec()).toBe(5);

    clock.advance(2000);
    expect(bucket.retryAfterSec()).toBe(3);

    clock.advance(3000);
    expect(bucket.retryAfterSec()).toBe(0);
  });

  test('rejects bad config', () => {
    expect(() => new TokenBucket(0, 1)).toThrow(RangeError);
    expect(() => new TokenBucket(1, 0)).toThrow(RangeError);
  });
});

describe('rateLimiter middleware', () => {
  function makeApp(clock) {
    const app = express();
    app.set('trust proxy', true); // lets the tests pretend to be different IPs
    app.use(rateLimiter({ capacity: 2, refillPerSec: 1, now: clock }));
    app.get('/', (req, res) => res.send('ok'));
    return app;
  }

  test('returns 429 with Retry-After once the bucket is empty', async () => {
    const app = makeApp(fakeClock());

    await request(app).get('/').expect(200).expect('X-RateLimit-Remaining', '1');
    await request(app).get('/').expect(200).expect('X-RateLimit-Remaining', '0');

    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.body).toEqual({ error: 'Too many requests', retryAfter: 1 });
  });

  test('lets requests through again after refill', async () => {
    const clock = fakeClock();
    const app = makeApp(clock);

    await request(app).get('/');
    await request(app).get('/');
    await request(app).get('/').expect(429);

    clock.advance(1000);
    await request(app).get('/').expect(200);
  });

  test('keeps a separate bucket per IP', async () => {
    const app = makeApp(fakeClock());
    const fromA = () => request(app).get('/').set('X-Forwarded-For', '10.0.0.1');
    const fromB = () => request(app).get('/').set('X-Forwarded-For', '10.0.0.2');

    await fromA().expect(200);
    await fromA().expect(200);
    await fromA().expect(429);
    await fromB().expect(200);
  });
});
