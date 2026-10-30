const { EventEmitter } = require('events');

// A tiny in-memory stand-in for the parts of ioredis the cache uses. Clients
// created from the same server (or via duplicate()) share data and pub/sub,
// like several app instances talking to one Redis. Setting `down = true`
// makes every command fail, like a lost connection.
class FakeRedisServer {
  constructor(now = Date.now) {
    this.now = now;
    this.data = new Map();
    this.subscribers = new Set();
  }

  client() {
    return new FakeRedis(this);
  }
}

class FakeRedis extends EventEmitter {
  constructor(server = new FakeRedisServer()) {
    super();
    this.server = server;
    this.status = 'ready';
    this.down = false;
    this.channels = new Set();
  }

  _check() {
    if (this.down) throw new Error('Connection is closed.');
  }

  _entry(key) {
    const entry = this.server.data.get(key);
    if (entry && entry.expiresAt <= this.server.now()) {
      this.server.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key) {
    this._check();
    const entry = this._entry(key);
    return entry ? entry.value : null;
  }

  async set(key, value, mode, ttl) {
    this._check();
    const expiresAt = mode === 'PX' ? this.server.now() + ttl : Infinity;
    this.server.data.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async del(key) {
    this._check();
    return this.server.data.delete(key) ? 1 : 0;
  }

  async hincrby(key, field, by) {
    this._check();
    let entry = this._entry(key);
    if (!entry) {
      entry = { value: new Map(), expiresAt: Infinity };
      this.server.data.set(key, entry);
    }
    const next = Number(entry.value.get(field) || 0) + by;
    entry.value.set(field, String(next));
    return next;
  }

  async hget(key, field) {
    this._check();
    const entry = this._entry(key);
    return (entry && entry.value.get(field)) ?? null;
  }

  async hgetall(key) {
    this._check();
    const entry = this._entry(key);
    return entry ? Object.fromEntries(entry.value) : {};
  }

  async rename(from, to) {
    this._check();
    const entry = this._entry(from);
    if (!entry) throw new Error('ERR no such key');
    this.server.data.delete(from);
    this.server.data.set(to, entry);
    return 'OK';
  }

  // returns every match in one page, which is allowed by the SCAN contract
  async scan(cursor, match, pattern) {
    this._check();
    const prefix = pattern.replace(/\*$/, '');
    const keys = [...this.server.data.keys()].filter((k) => k.startsWith(prefix) && this._entry(k));
    return ['0', keys];
  }

  async pttl(key) {
    this._check();
    const entry = this._entry(key);
    if (!entry) return -2;
    if (entry.expiresAt === Infinity) return -1;
    return entry.expiresAt - this.server.now();
  }

  async ping() {
    this._check();
    return 'PONG';
  }

  async publish(channel, message) {
    this._check();
    let receivers = 0;
    for (const sub of this.server.subscribers) {
      if (!sub.channels.has(channel)) continue;
      receivers++;
      setImmediate(() => sub.emit('message', channel, message));
    }
    return receivers;
  }

  async subscribe(channel) {
    this._check();
    this.channels.add(channel);
    this.server.subscribers.add(this);
    return this.channels.size;
  }

  duplicate() {
    return new FakeRedis(this.server);
  }

  async quit() {
    this.status = 'end';
    this.server.subscribers.delete(this);
    return 'OK';
  }
}

// lets queued setImmediate callbacks (pub/sub deliveries) run
const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { FakeRedis, FakeRedisServer, flush };
