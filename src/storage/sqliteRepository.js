const { openDb } = require('../db');
const { encode } = require('../utils/base62');
const httpError = require('../utils/httpError');

// SQLite has a single writer, so the counter can be bumped one id at a time
// inside the insert transaction. That keeps codes strictly sequential.
function createSqliteRepository(file) {
  const db = openDb(file);

  const bumpCounter = db.prepare('UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value');
  const codeExists = db.prepare('SELECT 1 FROM links WHERE code = ?');
  const insertLink = db.prepare(`
    INSERT INTO links (code, url, is_custom, created_at, expires_at)
    VALUES (@code, @url, @isCustom, @createdAt, @expiresAt)
  `);
  const findByCode = db.prepare('SELECT * FROM links WHERE code = ?');
  const addClick = db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?');
  const updateLink = db.prepare(`
    UPDATE links
       SET url = COALESCE(@url, url),
           expires_at = CASE WHEN @setExpiry = 1 THEN @expiresAt ELSE expires_at END
     WHERE code = @code
    RETURNING *
  `);
  const deleteLink = db.prepare('DELETE FROM links WHERE code = ?');

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
      throw httpError(409, `Alias "${alias}" is already taken`);
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

  return {
    driver: 'sqlite',
    db,

    async createLink(input) {
      return create(input);
    },

    async findByCode(code) {
      const row = findByCode.get(code);
      return row ? toLink(row) : null;
    },

    async incrementClicks(code) {
      addClick.run(code);
    },

    async updateLink(code, { url, expiresAt }) {
      const row = updateLink.get({
        code,
        url: url ?? null,
        setExpiry: expiresAt === undefined ? 0 : 1,
        expiresAt: expiresAt ?? null,
      });
      return row ? toLink(row) : null;
    },

    async deleteLink(code) {
      return deleteLink.run(code).changes > 0;
    },

    async ping() {
      db.prepare('SELECT 1').get();
    },

    async close() {
      if (db.open) db.close();
    },
  };
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

module.exports = { createSqliteRepository };
