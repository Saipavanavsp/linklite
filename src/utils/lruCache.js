class Node {
  constructor(key, value, expiresAt) {
    this.key = key;
    this.value = value;
    this.expiresAt = expiresAt; // ms timestamp, or Infinity for no ttl
    this.prev = null;
    this.next = null;
  }
}

// Map gives O(1) lookup, the linked list keeps usage order.
// Most recently used sits right after head, least recently used right before tail.
// head and tail are dummy nodes so we never have to null-check neighbours.
//
// Entries can optionally have a ttl. Expired entries are dropped lazily when
// someone reads them (and count as a miss), the same way the token bucket
// refills lazily instead of running a timer.
class LRUCache {
  constructor(capacity, { now = Date.now } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.now = now;
    this.map = new Map();
    this.head = new Node(null, null);
    this.tail = new Node(null, null);
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    const node = this.map.get(key);
    if (!node) {
      this.misses++;
      return undefined;
    }
    if (node.expiresAt <= this.now()) {
      this._unlink(node);
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    this._unlink(node);
    this._addToFront(node);
    return node.value;
  }

  put(key, value, ttlMs) {
    const expiresAt = ttlMs === undefined ? Infinity : this.now() + ttlMs;
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this._unlink(existing);
      this._addToFront(existing);
      return;
    }

    if (this.map.size >= this.capacity) {
      const lru = this.tail.prev;
      this._unlink(lru);
      this.map.delete(lru.key);
    }

    const node = new Node(key, value, expiresAt);
    this.map.set(key, node);
    this._addToFront(node);
  }

  has(key) {
    const node = this.map.get(key);
    return Boolean(node) && node.expiresAt > this.now();
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  delete(key) {
    const node = this.map.get(key);
    if (!node) return false;
    this._unlink(node);
    this.map.delete(key);
    return true;
  }

  // keys from most to least recently used, handy for tests and debugging
  keys() {
    const result = [];
    for (let node = this.head.next; node !== this.tail; node = node.next) {
      result.push(node.key);
    }
    return result;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      capacity: this.capacity,
      size: this.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }

  _unlink(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
    node.prev = null;
    node.next = null;
  }

  _addToFront(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }
}

module.exports = LRUCache;
