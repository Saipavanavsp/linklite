function createLinkService(repo, cache) {
  async function create(input) {
    return repo.createLink(input);
  }

  // The cache only holds what a redirect needs. Links never change after
  // creation, so there is nothing to invalidate. Misses are not cached,
  // otherwise a code created later would keep returning 404.
  async function resolve(code) {
    let target = cache.get(code);
    const cacheHit = target !== undefined;

    if (!cacheHit) {
      const link = await repo.findByCode(code);
      if (!link) return { target: null, cacheHit };
      target = { url: link.url, expiresAt: link.expiresAt };
      cache.put(code, target);
    }

    return { target, cacheHit };
  }

  async function recordClick(code) {
    await repo.incrementClicks(code);
  }

  async function getLink(code) {
    return repo.findByCode(code);
  }

  return { create, resolve, recordClick, getLink };
}

function isExpired(expiresAt, now = Date.now()) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= now;
}

module.exports = { createLinkService, isExpired };
