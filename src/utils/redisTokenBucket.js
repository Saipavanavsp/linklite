const crypto = require('crypto');

// Same token bucket as tokenBucket.js, but the state lives in a Redis hash so
// every app instance draws from the same bucket. Refill and take happen in one
// Lua script, which Redis runs atomically: two instances can't both read
// "1 token left" and both let a request through.
//
// The clock comes from Redis TIME rather than the app servers, so instances
// with slightly different clocks still agree on how much has refilled.
//
// Returns { allowed (0/1), tokens left (as a string, Lua would truncate a
// float reply to an integer), retry after in seconds }.
const SCRIPT = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local ttl_ms   = tonumber(ARGV[3])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
-- once a bucket would have refilled to full it's the same as a missing one,
-- so let Redis drop it (same idea as the sweeper in the in-memory limiter)
redis.call('PEXPIRE', key, ttl_ms)

return { allowed, tostring(tokens), retry }
`;

const SHA = crypto.createHash('sha1').update(SCRIPT).digest('hex');

class RedisTokenBucket {
  constructor(redis, { capacity, refillPerSec, prefix = 'linklite:rl:' }) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new RangeError('capacity and refillPerSec must be positive');
    }
    this.redis = redis;
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.prefix = prefix;
    this.ttlMs = Math.ceil((capacity / refillPerSec) * 1000) + 1000;
  }

  async take(id) {
    const args = [1, this.prefix + id, this.capacity, this.refillPerSec, this.ttlMs];

    let reply;
    try {
      // EVALSHA sends 40 bytes instead of the whole script every time
      reply = await this.redis.evalsha(SHA, ...args);
    } catch (err) {
      if (!String(err.message).startsWith('NOSCRIPT')) throw err;
      // first call after a Redis restart: EVAL also caches the script again
      reply = await this.redis.eval(SCRIPT, ...args);
    }

    const [allowed, tokens, retryAfter] = reply;
    return {
      allowed: Number(allowed) === 1,
      remaining: Math.floor(Number(tokens)),
      retryAfter: Number(retryAfter),
    };
  }
}

module.exports = { RedisTokenBucket, SCRIPT, SHA };
