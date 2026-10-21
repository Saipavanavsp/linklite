const Redis = require('ioredis');
const throttledLog = require('./utils/throttledLog');

// Settings chosen so a dead Redis never stalls a request:
// - enableOfflineQueue: false -> commands fail immediately while disconnected
//   instead of queueing until Redis comes back
// - commandTimeout -> a hung connection fails after 500ms
// - retryStrategy -> keep reconnecting in the background, backing off to 5s
function createRedisClient(url, { logger = console } = {}) {
  const warn = throttledLog(logger.warn.bind(logger));
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // ioredis emits 'error' on every failed reconnect. Without a listener node
  // would treat it as an unhandled error and crash the process.
  client.on('error', (err) => warn('redis-error', `[redis] ${err.message}`));
  client.on('ready', () => logger.log('[redis] connected'));
  return client;
}

// QUIT waits for Redis to answer. If Redis is unreachable that never happens
// and the client keeps reconnecting, which would keep the process alive, so
// in that case just drop the connection.
async function closeRedis(client) {
  if (!client || client.status === 'end') return;
  if (client.status === 'ready') {
    await client.quit().catch(() => client.disconnect());
  } else {
    client.disconnect();
  }
}

module.exports = { createRedisClient, closeRedis };
