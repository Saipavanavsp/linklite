const TokenBucket = require('../utils/tokenBucket');
const { RedisTokenBucket } = require('../utils/redisTokenBucket');
const throttledLog = require('../utils/throttledLog');

const SWEEP_EVERY_MS = 60_000;

// With `redis`, the bucket for each IP is shared by every app instance.
// Without it (or while Redis is unreachable) each instance keeps its own
// buckets in memory, like the original single-server version.
//
// Fail-open vs fail-closed, when Redis is down:
//   fail-closed would reject every request, so a cache outage becomes a full
//   site outage, for a URL shortener whose main job is redirects.
//   fail-open with no limit at all would leave the API unprotected.
// So this falls back to the local in-memory bucket: still fail-open as far as
// the global limit goes (with N instances a client can get up to N x the limit
// for as long as Redis is down), but no single instance can be flooded.
function rateLimiter({
  capacity,
  refillPerSec,
  now = Date.now,
  redis = null,
  name = 'general',
  logger = console,
  onLimited = () => {},
}) {
  const buckets = new Map();
  const shared = redis ? new RedisTokenBucket(redis, { capacity, refillPerSec, prefix: `linklite:rl:${name}:` }) : null;
  const warn = throttledLog(logger.warn.bind(logger));

  // A bucket that has refilled to full is the same as a brand new one,
  // so we can drop it. Keeps the map from growing with every IP ever seen.
  const sweeper = setInterval(() => {
    for (const [ip, bucket] of buckets) {
      bucket.refill();
      if (bucket.tokens >= capacity) buckets.delete(ip);
    }
  }, SWEEP_EVERY_MS);
  sweeper.unref();

  function takeLocal(ip) {
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillPerSec, now);
      buckets.set(ip, bucket);
    }
    if (bucket.tryRemove()) {
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfter: 0 };
    }
    return { allowed: false, remaining: 0, retryAfter: bucket.retryAfterSec() };
  }

  async function take(ip) {
    if (shared) {
      try {
        return await shared.take(ip);
      } catch (err) {
        warn('redis', `[rate limit:${name}] redis unavailable, using per-instance limit: ${err.message}`);
      }
    }
    return takeLocal(ip);
  }

  async function limit(req, res, next) {
    const ip = req.ip || 'unknown';
    const result = await take(ip);

    res.set('X-RateLimit-Limit', String(capacity));

    if (result.allowed) {
      res.set('X-RateLimit-Remaining', String(result.remaining));
      return next();
    }

    onLimited(name);
    res.set('X-RateLimit-Remaining', '0');
    res.set('Retry-After', String(result.retryAfter));
    res.status(429).json({ error: 'Too many requests', retryAfter: result.retryAfter });
  }

  return limit;
}

module.exports = rateLimiter;
