const TokenBucket = require('../utils/tokenBucket');

const SWEEP_EVERY_MS = 60_000;

function rateLimiter({ capacity, refillPerSec, now = Date.now }) {
  const buckets = new Map();

  // A bucket that has refilled to full is the same as a brand new one,
  // so we can drop it. Keeps the map from growing with every IP ever seen.
  const sweeper = setInterval(() => {
    for (const [ip, bucket] of buckets) {
      bucket.refill();
      if (bucket.tokens >= capacity) buckets.delete(ip);
    }
  }, SWEEP_EVERY_MS);
  sweeper.unref();

  function limit(req, res, next) {
    const ip = req.ip || 'unknown';
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillPerSec, now);
      buckets.set(ip, bucket);
    }

    res.set('X-RateLimit-Limit', String(capacity));

    if (bucket.tryRemove()) {
      res.set('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
      return next();
    }

    const retryAfter = bucket.retryAfterSec();
    res.set('X-RateLimit-Remaining', '0');
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests', retryAfter });
  }

  return limit;
}

module.exports = rateLimiter;
