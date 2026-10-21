const express = require('express');
const request = require('supertest');
const { RedisTokenBucket, SCRIPT, SHA } = require('../src/utils/redisTokenBucket');
const rateLimiter = require('../src/middleware/rateLimiter');

// The Lua script itself runs against a real Redis in tests/integration.
// These tests mock the client to check everything around it.
function mockRedis(replies = []) {
  const queue = [...replies];
  return {
    evalsha: jest.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    eval: jest.fn(async () => [1, '4', 0]),
  };
}

describe('RedisTokenBucket', () => {
  test('runs the script by sha with the bucket key and settings', async () => {
    const redis = mockRedis([[1, '7.5', 0]]);
    const bucket = new RedisTokenBucket(redis, { capacity: 10, refillPerSec: 2, prefix: 'rl:test:' });

    const result = await bucket.take('1.2.3.4');

    expect(result).toEqual({ allowed: true, remaining: 7, retryAfter: 0 });
    // ttl = time to refill from empty (5s) + 1s slack
    expect(redis.evalsha).toHaveBeenCalledWith(SHA, 1, 'rl:test:1.2.3.4', 10, 2, 6000);
  });

  test('parses a rejection', async () => {
    const bucket = new RedisTokenBucket(mockRedis([[0, '0.2', 4]]), { capacity: 1, refillPerSec: 0.2 });
    expect(await bucket.take('ip')).toEqual({ allowed: false, remaining: 0, retryAfter: 4 });
  });

  test('falls back to EVAL when the script is not cached (NOSCRIPT)', async () => {
    const redis = mockRedis([new Error('NOSCRIPT No matching script. Please use EVAL.')]);
    const bucket = new RedisTokenBucket(redis, { capacity: 5, refillPerSec: 1 });

    expect(await bucket.take('ip')).toEqual({ allowed: true, remaining: 4, retryAfter: 0 });
    expect(redis.eval).toHaveBeenCalledWith(SCRIPT, 1, 'linklite:rl:ip', 5, 1, 6000);
  });

  test('passes other errors up to the caller', async () => {
    const bucket = new RedisTokenBucket(mockRedis([new Error('Connection is closed.')]), { capacity: 5, refillPerSec: 1 });
    await expect(bucket.take('ip')).rejects.toThrow('Connection is closed.');
  });

  test('rejects bad config', () => {
    expect(() => new RedisTokenBucket(mockRedis(), { capacity: 0, refillPerSec: 1 })).toThrow(RangeError);
  });
});

describe('rateLimiter middleware with redis', () => {
  const quiet = () => ({ log: jest.fn(), warn: jest.fn() });

  function makeApp(redis, extra = {}) {
    const app = express();
    app.use(rateLimiter({ capacity: 2, refillPerSec: 1, redis, logger: quiet(), ...extra }));
    app.get('/', (req, res) => res.send('ok'));
    return app;
  }

  test('uses the shared bucket for the decision and headers', async () => {
    const redis = mockRedis([
      [1, '1', 0],
      [0, '0', 3],
    ]);
    const app = makeApp(redis);

    await request(app).get('/').expect(200).expect('X-RateLimit-Limit', '2').expect('X-RateLimit-Remaining', '1');

    const blocked = await request(app).get('/').expect(429);
    expect(blocked.headers['retry-after']).toBe('3');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(blocked.body).toEqual({ error: 'Too many requests', retryAfter: 3 });
  });

  test('keys buckets by limiter name so limits stay separate', async () => {
    const redis = mockRedis([[1, '1', 0]]);
    await request(makeApp(redis, { name: 'shorten' })).get('/');
    expect(redis.evalsha.mock.calls[0][2]).toMatch(/^linklite:rl:shorten:/);
  });

  test('reports rejections through onLimited', async () => {
    const onLimited = jest.fn();
    await request(makeApp(mockRedis([[0, '0', 1]]), { name: 'general', onLimited })).get('/').expect(429);
    expect(onLimited).toHaveBeenCalledWith('general');
  });

  test('falls back to the in-memory bucket when redis fails, and still limits', async () => {
    const down = new Error('Connection is closed.');
    const redis = mockRedis([down, down, down]);
    const logger = quiet();
    const app = makeApp(redis, { logger });

    await request(app).get('/').expect(200).expect('X-RateLimit-Remaining', '1');
    await request(app).get('/').expect(200).expect('X-RateLimit-Remaining', '0');
    const blocked = await request(app).get('/').expect(429);
    expect(blocked.headers['retry-after']).toBe('1');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/using per-instance limit/);
  });

  test('goes back to the shared bucket once redis answers again', async () => {
    const redis = mockRedis([new Error('down'), [0, '0', 9]]);
    const app = makeApp(redis);

    await request(app).get('/').expect(200); // local bucket
    const res = await request(app).get('/').expect(429); // redis says no
    expect(res.headers['retry-after']).toBe('9');
  });
});
