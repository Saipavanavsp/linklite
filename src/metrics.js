// Plain in-process counters, exposed as JSON on /metrics. Each instance only
// knows about its own traffic; the load test script reads /metrics from every
// instance behind the load balancer and adds them up.
function createMetrics({ instanceId, now = Date.now } = {}) {
  const startedAt = now();
  const requests = { total: 0, byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } };
  const rateLimited = {};

  function middleware(req, res, next) {
    res.on('finish', () => {
      requests.total++;
      const bucket = `${Math.floor(res.statusCode / 100)}xx`;
      if (bucket in requests.byStatus) requests.byStatus[bucket]++;
    });
    next();
  }

  function recordRateLimited(limiter) {
    rateLimited[limiter] = (rateLimited[limiter] || 0) + 1;
  }

  function snapshot({ cache, storage, redis }) {
    const limitedTotal = Object.values(rateLimited).reduce((sum, n) => sum + n, 0);
    return {
      instance: instanceId,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      requests,
      rateLimited: { ...rateLimited, total: limitedTotal },
      cache,
      storage,
      redis,
    };
  }

  return { middleware, recordRateLimited, snapshot };
}

module.exports = { createMetrics };
