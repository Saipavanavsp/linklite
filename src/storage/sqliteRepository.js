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
    INSERT INTO links (code, url, is_custom, created_at, expires_at, manage_token_hash)
    VALUES (@code, @url, @isCustom, @createdAt, @expiresAt, @manageTokenHash)
  `);
  const findByCode = db.prepare('SELECT * FROM links WHERE code = ?');
  const findTokenHash = db.prepare('SELECT manage_token_hash FROM links WHERE code = ?');
  const addClick = db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?');
  const addClicks = db.prepare('UPDATE links SET clicks = clicks + ? WHERE code = ?');
  const markBatch = db.prepare('INSERT OR IGNORE INTO click_batches (id) VALUES (?)');
  const pruneBatches = db.prepare('DELETE FROM click_batches WHERE id < ?');
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

  // `alias` is a code the user picked, `code` a random one from the service.
  // Both are taken as is and give a 409 if they already exist.
  const create = db.transaction(({ url, alias, code: fixedCode, expiresAt, manageTokenHash }) => {
    const wanted = alias || fixedCode;
    if (wanted && codeExists.get(wanted)) {
      throw httpError(409, alias ? `Alias "${alias}" is already taken` : 'Code is already taken');
    }

    const code = wanted || nextCode();
    insertLink.run({
      code,
      url,
      isCustom: alias ? 1 : 0,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt || null,
      manageTokenHash: manageTokenHash || null,
    });
    return toLink(findByCode.get(code));
  });

  const applyBatch = db.transaction((batchId, counts, pruneBefore) => {
    if (markBatch.run(batchId).changes === 0) return false; // already applied
    for (const [code, n] of Object.entries(counts)) addClicks.run(Number(n), code);
    pruneBatches.run(pruneBefore);
    return true;
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

    // null if the link doesn't exist, otherwise { hash } (hash is null for
    // links created before management tokens)
    async findManageTokenHash(code) {
      const row = findTokenHash.get(code);
      return row ? { hash: row.manage_token_hash } : null;
    },

    async incrementClicks(code) {
      addClick.run(code);
    },

    // counts is { code: n }. Returns false if this batch was applied before.
    async applyClickBatch(batchId, counts, { pruneBefore = '' } = {}) {
      return applyBatch(batchId, counts, pruneBefore);
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
