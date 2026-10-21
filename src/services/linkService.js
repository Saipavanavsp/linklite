// Only what a redirect needs goes into the cache.
function cacheEntry(link) {
  return { url: link.url, expiresAt: link.expiresAt };
}

function createLinkService(repo, cache) {
  async function create(input) {
    const link = await repo.createLink(input);
    // Misses are never cached, so there is no stale "not found" entry to
    // clear. Warming L2 lets the first redirect on any instance skip the DB.
    await cache.setShared(link.code, cacheEntry(link));
    return link;
  }

  // Cache-aside: try the cache, fall back to the DB and fill the cache.
  // Misses are not cached, otherwise a code created later would keep
  // returning 404.
  async function resolve(code) {
    const cached = await cache.get(code);
    if (cached.value !== undefined) {
      return { target: cached.value, cacheHit: true, level: cached.level };
    }

    const link = await repo.findByCode(code);
    if (!link) return { target: null, cacheHit: false, level: null };

    const target = cacheEntry(link);
    await cache.set(code, target);
    return { target, cacheHit: false, level: null };
  }

  async function recordClick(code) {
    await repo.incrementClicks(code);
  }

  async function getLink(code) {
    return repo.findByCode(code);
  }

  // Write to the DB first, then drop the cached copies everywhere.
  async function update(code, fields) {
    const link = await repo.updateLink(code, fields);
    if (link) await cache.invalidate(code);
    return link;
  }

  async function remove(code) {
    const deleted = await repo.deleteLink(code);
    if (deleted) await cache.invalidate(code);
    return deleted;
  }

  return { create, resolve, recordClick, getLink, update, remove };
}

function isExpired(expiresAt, now = Date.now()) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= now;
}

module.exports = { createLinkService, isExpired };
