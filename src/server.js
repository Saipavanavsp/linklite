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
  cacheSize: num(env.CACHE_SIZE, 1000),
  rateLimit: {
    capacity: num(env.RATE_LIMIT_CAPACITY, 60),
    refillPerSec: num(env.RATE_LIMIT_REFILL, 1),
  },
  shortenLimit: {
    capacity: num(env.SHORTEN_LIMIT_CAPACITY, 10),
    refillPerSec: num(env.SHORTEN_LIMIT_REFILL, 0.2),
  },
  trustProxy: env.TRUST_PROXY === '1',
  logRequests: true,
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`LinkLite running on http://localhost:${port}`);
});

function shutdown() {
  server.close(async () => {
    await app.locals.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
