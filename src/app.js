const path = require('path');
const express = require('express');
const { createRepository } = require('./storage');
const LRUCache = require('./utils/lruCache');
const { TieredCache } = require('./cache/tieredCache');
const { createRedisClient } = require('./redis');
const throttledLog = require('./utils/throttledLog');
const { createLinkService } = require('./services/linkService');
const rateLimiter = require('./middleware/rateLimiter');
const apiRouter = require('./routes/api');
const redirectRouter = require('./routes/redirect');

function createApp(options = {}) {
  const {
    dbPath = ':memory:',
    dbDriver = 'sqlite',
    databaseUrl,
    idBlockSize,
    pgPoolMax,
    repo: injectedRepo,
    baseUrl = 'http://localhost:3000',
    // either a ready ioredis client (the caller closes it) or a url (we own it).
    // Neither means no Redis: L1 cache only and in-memory rate limiting.
    redis: injectedRedis = null,
    redisUrl,
    cacheSize = 1000,
    cacheTtlSec = 3600,
    l1TtlSec = 60,
    rateLimit = { capacity: 60, refillPerSec: 1 },
    shortenLimit = { capacity: 10, refillPerSec: 0.2 },
    trustProxy = false,
    logRequests = false,
    logger = console,
  } = options;

  const repo =
    injectedRepo ||
    createRepository({ driver: dbDriver, sqlitePath: dbPath, databaseUrl, idBlockSize, poolMax: pgPoolMax });

  const redis = injectedRedis || (redisUrl ? createRedisClient(redisUrl, { logger }) : null);
  const cache = new TieredCache({
    l1: new LRUCache(cacheSize),
    redis,
    ttlSec: cacheTtlSec,
    l1TtlSec,
    logger,
  });

  let subscribed = Promise.resolve();
  if (redis) {
    // the subscriber has its own connection and is allowed to queue the
    // SUBSCRIBE until Redis is reachable
    const subscriber = redis.duplicate({ enableOfflineQueue: true });
    const warn = throttledLog(logger.warn.bind(logger));
    subscriber.on('error', (err) => warn('sub-error', `[redis subscriber] ${err.message}`));
    subscribed = cache.subscribe(subscriber);
  }

  const links = createLinkService(repo, cache);

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  if (logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const cacheInfo = res.get('X-Cache') ? ` cache=${res.get('X-Cache')}` : '';
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms${cacheInfo}`);
      });
      next();
    });
  }

  const limiterOptions = { redis, logger };
  app.use(rateLimiter({ ...rateLimit, ...limiterOptions, name: 'general' }));
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', apiRouter({ links, cache, baseUrl, shortenLimit, limiterOptions }));
  app.use(redirectRouter({ links }));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // express only treats this as an error handler because it takes 4 arguments
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  // the raw sqlite handle is still exposed (the tests use it to tweak rows)
  app.locals.db = repo.db;
  app.locals.repo = repo;
  app.locals.cache = cache;
  app.locals.redis = redis;
  app.locals.ready = subscribed;
  app.locals.close = async () => {
    await cache.close();
    if (redis && !injectedRedis) await redis.quit().catch(() => {});
    await repo.close();
  };
  return app;
}

module.exports = createApp;
