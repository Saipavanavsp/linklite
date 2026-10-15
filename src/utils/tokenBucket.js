// Tokens are refilled lazily: instead of a timer per bucket, we work out how
// many tokens should have been added since the last call whenever it's used.
class TokenBucket {
  constructor(capacity, refillPerSec, now = Date.now) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new RangeError('capacity and refillPerSec must be positive');
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.tokens = capacity;
    this.lastRefill = now();
  }

  refill() {
    const current = this.now();
    const elapsedSec = (current - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = current;
    }
  }

  tryRemove() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  // whole seconds until at least one token is available again
  retryAfterSec() {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerSec);
  }
}

module.exports = TokenBucket;
