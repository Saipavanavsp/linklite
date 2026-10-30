const { generateToken, hashToken, tokenMatches, randomCode } = require('../utils/manageToken');

const RANDOM_CODE_TRIES = 5;

// Only what a redirect needs goes into the cache.
function cacheEntry(link) {
  return { url: link.url, expiresAt: link.expiresAt };
}

function createLinkService(repo, cache, clicks) {
  // `opaque` asks for a random code instead of the next counter value, for
  // links that shouldn't be discoverable by counting through the sequence.
  // Returns the link plus its management token, which is only ever shown here.
  async function create({ url, alias, expiresAt, opaque = false }) {
    const manageToken = generateToken();
    const input = { url, alias, expiresAt, manageTokenHash: hashToken(manageToken) };

    let link;
    if (opaque && !alias) {
      // 62^10 codes, so a collision is very unlikely; retry a few times anyway
      for (let i = 0; !link; i++) {
        try {
          link = await repo.createLink({ ...input, code: randomCode() });
        } catch (err) {
          if (err.status !== 409 || i + 1 >= RANDOM_CODE_TRIES) throw err;
        }
      }
    } else {
      link = await repo.createLink(input);
    }

    // Misses are never cached, so there is no stale "not found" entry to
    // clear. Warming L2 lets the first redirect on any instance skip the DB.
    await cache.setShared(link.code, cacheEntry(link));
    return { link, manageToken };
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
    await clicks.record(code);
  }

  // DB count plus clicks still waiting in Redis to be flushed
  async function getLink(code) {
    const link = await repo.findByCode(code);
    if (!link) return null;
    return { ...link, clicks: link.clicks + (await clicks.pending(code)) };
  }

  // 'ok', 'missing' (no such link) or 'denied' (wrong or no token, or a link
  // from before tokens existed)
  async function authorize(code, token) {
    const row = await repo.findManageTokenHash(code);
    if (!row) return 'missing';
    return tokenMatches(token, row.hash) ? 'ok' : 'denied';
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

  return { create, resolve, recordClick, getLink, authorize, update, remove };
}

function isExpired(expiresAt, now = Date.now()) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= now;
}

module.exports = { createLinkService, isExpired };
