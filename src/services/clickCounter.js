const crypto = require('crypto');
const throttledLog = require('../utils/throttledLog');

const PENDING_KEY = 'linklite:clicks:pending';
const BATCH_PREFIX = 'linklite:clicks:batch:';
// a batch left in Redis this long was abandoned by an instance that died
const STALE_BATCH_MS = 30_000;
const RECOVER_EVERY_MS = 30_000;
// applied batch ids are kept this long, far longer than a batch can sit in Redis
const KEEP_BATCH_IDS_MS = 7 * 24 * 3600_000;

// Counting clicks without a database write on every redirect.
//
// Without Redis, each click is still one UPDATE. That's the single-instance
// SQLite mode, where the write is an in-process call, not a network round trip.
//
// With Redis:
//
//   redirect  ->  HINCRBY linklite:clicks:pending <code> 1  ->  302
//
//   every CLICK_FLUSH_MS, on every instance:
//   1. RENAME pending -> linklite:clicks:batch:<time>-<uuid>. Atomic, so new
//      clicks go into a fresh pending hash and the batch can't change anymore.
//      If two instances flush at once, only one rename finds the key.
//   2. HGETALL the batch and add it to links.clicks in one transaction, which
//      also records the batch id in click_batches.
//   3. DEL the batch.
//
// What happens on a crash:
//   - app dies before step 1: the clicks are still in Redis, the next flush
//     on any instance picks them up.
//   - app dies between 1 and 3: the batch key stays in Redis. Every instance
//     looks for batch keys older than 30s and applies them. If the DB write
//     had already committed, the batch id is in click_batches and it isn't
//     counted twice.
//   - Redis dies: clicks since its last AOF fsync are lost (about 1s with
//     appendfsync everysec, see docker-compose.yml).
//   - Redis unreachable on a redirect: that click goes straight to the DB.
function createClickCounter({ repo, redis = null, flushMs = 1000, logger = console, now = Date.now } = {}) {
  const warn = throttledLog(logger.warn.bind(logger));
  const stats = { buffered: 0, direct: 0, flushedBatches: 0, flushedClicks: 0, errors: 0 };
  let timer = null;
  let lastRecover = 0;
  let flushing = null;

  async function record(code) {
    if (redis) {
      try {
        await redis.hincrby(PENDING_KEY, code, 1);
        stats.buffered++;
        return;
      } catch (err) {
        stats.errors++;
        warn('click-incr', `[clicks] redis unavailable, writing clicks to the database: ${err.message}`);
      }
    }
    stats.direct++;
    await repo.incrementClicks(code);
  }

  // Clicks recorded but not flushed yet, so /api/stats isn't behind.
  // Batches being flushed right now aren't included; that's a few ms.
  async function pending(code) {
    if (!redis) return 0;
    try {
      return Number(await redis.hget(PENDING_KEY, code)) || 0;
    } catch {
      return 0;
    }
  }

  async function applyBatch(key) {
    const counts = await redis.hgetall(key);
    if (Object.keys(counts).length > 0) {
      const batchId = key.slice(BATCH_PREFIX.length);
      const applied = await repo.applyClickBatch(batchId, counts, { pruneBefore: batchIdAt(now() - KEEP_BATCH_IDS_MS) });
      if (applied) {
        stats.flushedBatches++;
        stats.flushedClicks += Object.values(counts).reduce((sum, n) => sum + Number(n), 0);
      }
    }
    await redis.del(key);
  }

  async function recoverStaleBatches() {
    const cutoff = batchIdAt(now() - STALE_BATCH_MS);
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${BATCH_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        if (key.slice(BATCH_PREFIX.length) < cutoff) await applyBatch(key);
      }
    } while (cursor !== '0');
  }

  async function flushOnce() {
    if (!redis) return;
    try {
      if (now() - lastRecover >= RECOVER_EVERY_MS) {
        lastRecover = now();
        await recoverStaleBatches();
      }

      const key = BATCH_PREFIX + batchIdAt(now()) + '-' + crypto.randomUUID();
      try {
        await redis.rename(PENDING_KEY, key);
      } catch (err) {
        if (/no such key/i.test(err.message)) return; // no clicks since the last flush
        throw err;
      }
      await applyBatch(key);
    } catch (err) {
      // the batch (if any) stays in Redis and is retried by the recovery scan
      stats.errors++;
      warn('click-flush', `[clicks] flush failed, will retry: ${err.message}`);
    }
  }

  // never two flushes at once in one process
  function flush() {
    if (!flushing) flushing = flushOnce().finally(() => (flushing = null));
    return flushing;
  }

  function start() {
    if (!redis || timer) return;
    timer = setInterval(flush, flushMs);
    timer.unref();
  }

  // on shutdown: stop the timer and push out what's buffered
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await flush();
  }

  return {
    record,
    pending,
    flush,
    start,
    stop,
    stats: () => ({ mode: redis ? 'redis-buffered' : 'direct', ...stats }),
  };
}

// fixed width, so ids sort by time as plain strings
function batchIdAt(ms) {
  return String(Math.max(0, ms)).padStart(13, '0');
}

module.exports = { createClickCounter, PENDING_KEY, BATCH_PREFIX };
