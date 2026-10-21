const throttledLog = require('../utils/throttledLog');
const { closeRedis } = require('../redis');

const KEY_PREFIX = 'linklite:link:';
const INVALIDATE_CHANNEL = 'linklite:invalidate';

// Two cache levels in front of the database, both cache-aside:
//
//   L1  the hand-written LRU, inside this process. Fastest, but each instance
//       has its own copy.
//   L2  Redis, shared by every instance. One instance's DB read warms the
//       cache for all of them.
//
// Reads go L1 -> L2 -> DB, and fill the levels they missed on the way back.
// Writes go to the DB first, then the cached copies are deleted (not
// overwritten), so a slow writer can't put an older value back over a newer one.
//
// Other instances may still hold the code in their L1, so deletes are also
// broadcast on a pub/sub channel. If a broadcast is missed (Redis blip), the
// short L1 ttl bounds how long a stale entry can live.
//
// Redis being down is never fatal: every Redis call is wrapped, failures are
// counted and logged (throttled), and the cache behaves as L1-only.
class TieredCache {
  constructor({
    l1,
    redis = null,
    ttlSec = 3600,
    l1TtlSec = 60,
    now = Date.now,
    logger = console,
  }) {
    this.l1 = l1;
    this.redis = redis;
    this.ttlMs = ttlSec * 1000;
    this.l1TtlMs = l1TtlSec * 1000;
    this.now = now;
    this.logger = logger;
    this.warn = throttledLog(logger.warn.bind(logger));
    this.l2Stats = { hits: 0, misses: 0, errors: 0 };
    this.subscriber = null;
  }

  // Returns { value, level } where level is 'L1', 'L2' or null (miss).
  async get(code) {
    const fromL1 = this.l1.get(code);
    if (fromL1 !== undefined) return { value: fromL1, level: 'L1' };

    const raw = await this._redis('get', (r) => r.get(KEY_PREFIX + code));
    if (raw === undefined) return { value: undefined, level: null }; // redis off or failed

    if (raw === null) {
      this.l2Stats.misses++;
      return { value: undefined, level: null };
    }

    this.l2Stats.hits++;
    const value = JSON.parse(raw);
    this._putL1(code, value);
    return { value, level: 'L2' };
  }

  // After a DB read: fill both levels.
  async set(code, value) {
    this._putL1(code, value);
    await this.setShared(code, value);
  }

  // Only fills L2. Used right after a link is created, so whichever instance
  // gets the first redirect can skip the DB, without filling this instance's L1
  // with links that may never be clicked.
  async setShared(code, value) {
    const ttl = this._ttlFor(value, this.ttlMs);
    if (ttl <= 0) return;
    await this._redis('set', (r) => r.set(KEY_PREFIX + code, JSON.stringify(value), 'PX', ttl));
  }

  // After an update or delete in the DB.
  async invalidate(code) {
    this.l1.delete(code);
    await this._redis('del', (r) => r.del(KEY_PREFIX + code));
    await this._redis('publish', (r) => r.publish(INVALIDATE_CHANNEL, code));
  }

  // Listen for other instances' invalidations on a separate connection
  // (a subscribed Redis connection can't run normal commands).
  async subscribe(subscriber) {
    this.subscriber = subscriber;
    let connectedBefore = subscriber.status === 'ready';

    subscriber.on('message', (channel, code) => {
      if (channel === INVALIDATE_CHANNEL) this.l1.delete(code);
    });
    subscriber.on('ready', () => {
      // while we were disconnected we may have missed invalidations, so the
      // safest thing is to drop the whole L1 and let it refill
      if (connectedBefore) this.l1.clear();
      connectedBefore = true;
    });

    try {
      await subscriber.subscribe(INVALIDATE_CHANNEL);
    } catch (err) {
      this.warn('subscribe', `[cache] could not subscribe to invalidations: ${err.message}`);
    }
  }

  async close() {
    if (this.subscriber) await closeRedis(this.subscriber);
  }

  stats() {
    const l1 = this.l1.stats();
    const l2Total = this.l2Stats.hits + this.l2Stats.misses;
    return {
      // top-level fields are the L1 numbers, same as before L2 existed
      ...l1,
      l1,
      l2: this.redis
        ? {
            enabled: true,
            ...this.l2Stats,
            hitRate: l2Total === 0 ? 0 : Number((this.l2Stats.hits / l2Total).toFixed(3)),
          }
        : { enabled: false },
    };
  }

  // A cached entry must never outlive the link itself.
  _ttlFor(value, maxMs) {
    if (!value.expiresAt) return maxMs;
    return Math.min(maxMs, Date.parse(value.expiresAt) - this.now());
  }

  _putL1(code, value) {
    const ttl = this._ttlFor(value, this.l1TtlMs);
    if (ttl > 0) this.l1.put(code, value, ttl);
  }

  // Runs a Redis command. Returns undefined if Redis is disabled or the call
  // failed, so callers can treat both the same way.
  async _redis(op, fn) {
    if (!this.redis) return undefined;
    try {
      return await fn(this.redis);
    } catch (err) {
      this.l2Stats.errors++;
      this.warn(op, `[cache] redis ${op} failed, using L1 + database only: ${err.message}`);
      return undefined;
    }
  }
}

module.exports = { TieredCache, KEY_PREFIX, INVALIDATE_CHANNEL };
