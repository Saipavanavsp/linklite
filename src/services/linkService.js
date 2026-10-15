const { encode } = require('../utils/base62');

function createLinkService(db, cache) {
  const bumpCounter = db.prepare('UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value');
  const codeExists = db.prepare('SELECT 1 FROM links WHERE code = ?');
  const insertLink = db.prepare(`
    INSERT INTO links (code, url, is_custom, created_at, expires_at)
    VALUES (@code, @url, @isCustom, @createdAt, @expiresAt)
  `);
  const findByCode = db.prepare('SELECT * FROM links WHERE code = ?');
  const findTarget = db.prepare('SELECT url, expires_at FROM links WHERE code = ?');
  const addClick = db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?');

  // A custom alias like "abcd" is also a valid base62 number, so the counter
  // could reach it later. If the code is already taken we just skip ahead.
  function nextCode() {
    for (;;) {
      const { value } = bumpCounter.get();
      const code = encode(value);
      if (!codeExists.get(code)) return code;
    }
  }

  const create = db.transaction(({ url, alias, expiresAt }) => {
    if (alias && codeExists.get(alias)) {
      const err = new Error(`Alias "${alias}" is already taken`);
      err.status = 409;
      throw err;
    }

    const code = alias || nextCode();
    insertLink.run({
      code,
      url,
      isCustom: alias ? 1 : 0,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt || null,
    });
    return toLink(findByCode.get(code));
  });

  // The cache only holds what a redirect needs. Links never change after
  // creation, so there is nothing to invalidate. Misses are not cached,
  // otherwise a code created later would keep returning 404.
  function resolve(code) {
    let target = cache.get(code);
    const cacheHit = target !== undefined;

    if (!cacheHit) {
      const row = findTarget.get(code);
      if (!row) return { target: null, cacheHit };
      target = { url: row.url, expiresAt: row.expires_at };
      cache.put(code, target);
    }

    return { target, cacheHit };
  }

  function recordClick(code) {
    addClick.run(code);
  }

  function getLink(code) {
    const row = findByCode.get(code);
    return row ? toLink(row) : null;
  }

  return { create, resolve, recordClick, getLink };
}

function toLink(row) {
  return {
    code: row.code,
    url: row.url,
    clicks: row.clicks,
    custom: row.is_custom === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function isExpired(expiresAt, now = Date.now()) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= now;
}

module.exports = { createLinkService, isExpired };
