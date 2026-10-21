const express = require('express');

const CHECK_TIMEOUT_MS = 1000;

async function check(fn) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

// /healthz and /metrics. Mounted before the rate limiter and request logging,
// so load balancer probes are never throttled and don't flood the logs.
function opsRouter({ repo, redis, cache, metrics, isShuttingDown }) {
  const router = express.Router();

  // 503 only when this instance can't serve redirects (no database) or is
  // shutting down. Redis down is "degraded" but still 200: the app keeps
  // working without it, and failing the check would take every instance out
  // of the load balancer at once for a cache outage.
  router.get('/healthz', async (req, res) => {
    const [db, redisState] = await Promise.all([
      check(() => repo.ping()),
      redis ? check(() => redis.ping()) : 'disabled',
    ]);

    let status = 'ok';
    if (redisState === 'down') status = 'degraded';
    if (db === 'down') status = 'down';
    if (isShuttingDown()) status = 'shutting_down';

    const code = status === 'down' || status === 'shutting_down' ? 503 : 200;
    res.status(code).set('Cache-Control', 'no-store').json({ status, db, redis: redisState });
  });

  router.get('/metrics', (req, res) => {
    res.set('Cache-Control', 'no-store').json(
      metrics.snapshot({
        cache: cache.stats(),
        storage: { driver: repo.driver },
        redis: redis ? { enabled: true, status: redis.status } : { enabled: false },
      })
    );
  });

  return router;
}

module.exports = opsRouter;
