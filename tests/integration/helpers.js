const { Pool } = require('pg');
const Redis = require('ioredis');
const createApp = require('../../src/app');
const { migrate } = require('../../src/storage/migrate');

// These tests need a real Postgres and Redis. Locally:
//
//   docker run -d --name ll-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
//   docker run -d --name ll-test-redis -p 56379:6379 redis:7-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres \
//   TEST_REDIS_URL=redis://localhost:56379 npm run test:integration
//
// They wipe the database and the redis db they point at, so don't point
// them at anything you care about.
function testUrls() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('Set TEST_DATABASE_URL and TEST_REDIS_URL to run the integration tests (see tests/integration/helpers.js)');
  }
  return { databaseUrl, redisUrl };
}

// drop everything and run the migrations from scratch
async function resetDatabase(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query('DROP TABLE IF EXISTS links, id_counter, schema_migrations');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

async function flushRedis(redisUrl) {
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  await redis.quit();
}

const quiet = { log() {}, warn() {} };

// one "app instance", wired the same way as in docker compose
function makeInstance(overrides = {}) {
  const { databaseUrl, redisUrl } = testUrls();
  return createApp({
    dbDriver: 'postgres',
    databaseUrl,
    redisUrl,
    baseUrl: 'http://lnk.test',
    idBlockSize: 10,
    rateLimit: { capacity: 1000, refillPerSec: 100 },
    shortenLimit: { capacity: 1000, refillPerSec: 100 },
    logger: quiet,
    ...overrides,
  });
}

// redis connects in the background; wait until it's usable
async function ready(app) {
  if (app.locals.redis && app.locals.redis.status !== 'ready') {
    await new Promise((resolve) => app.locals.redis.once('ready', resolve));
  }
  await app.locals.ready;
}

async function eventually(check, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

module.exports = { testUrls, resetDatabase, flushRedis, makeInstance, ready, eventually, quiet };
