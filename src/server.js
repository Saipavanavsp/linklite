const path = require('path');
const createApp = require('./app');

const env = process.env;
const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

const port = num(env.PORT, 3000);

const app = createApp({
  dbDriver: env.DB_DRIVER || 'sqlite',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'linklite.db'),
  databaseUrl: env.DATABASE_URL,
  idBlockSize: num(env.ID_BLOCK_SIZE, 100),
  pgPoolMax: num(env.PG_POOL_MAX, 10),
  baseUrl: env.BASE_URL || `http://localhost:${port}`,
  redisUrl: env.REDIS_URL || undefined,
  cacheSize: num(env.CACHE_SIZE, 1000),
  cacheTtlSec: num(env.CACHE_TTL_SEC, 3600),
  l1TtlSec: num(env.L1_TTL_SEC, 60),
  rateLimit: {
    capacity: num(env.RATE_LIMIT_CAPACITY, 60),
    refillPerSec: num(env.RATE_LIMIT_REFILL, 1),
  },
  shortenLimit: {
    capacity: num(env.SHORTEN_LIMIT_CAPACITY, 10),
    refillPerSec: num(env.SHORTEN_LIMIT_REFILL, 0.2),
  },
  trustProxy: env.TRUST_PROXY === '1',
  logRequests: env.LOG_REQUESTS !== '0',
  instanceId: env.INSTANCE_ID || undefined,
});

const shutdownTimeoutMs = num(env.SHUTDOWN_TIMEOUT_MS, 10_000);

const server = app.listen(port, '0.0.0.0', () => {
  const backends = `db=${app.locals.repo.driver} redis=${app.locals.redis ? 'on' : 'off'}`;
  console.log(`LinkLite running on http://localhost:${port} (${backends})`);
});

// nginx keeps idle upstream connections open. If node closed them first,
// nginx could send a request on a socket that is already gone.
server.keepAliveTimeout = 65_000;

// Graceful shutdown (docker stop sends SIGTERM):
// 1. /healthz starts returning 503 so the load balancer stops sending traffic
// 2. stop accepting connections, close idle keep-alive sockets
// 3. wait for in-flight requests, then close Redis and the DB pool
// 4. if that takes longer than SHUTDOWN_TIMEOUT_MS, exit anyway
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.locals.shuttingDown = true;
  console.log(`${signal} received, draining connections`);

  setTimeout(() => {
    console.error('shutdown timed out, exiting');
    process.exit(1);
  }, shutdownTimeoutMs).unref();

  server.close(async () => {
    try {
      await app.locals.close();
    } finally {
      console.log('shutdown complete');
      process.exit(0);
    }
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
