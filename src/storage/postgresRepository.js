const { Pool } = require('pg');
const { encode } = require('../utils/base62');
const httpError = require('../utils/httpError');

// Several app instances write to the same database, so ids can't come from a
// per-process counter. Each instance reserves a block of ids with one atomic
// UPDATE ... RETURNING (Postgres row-locks the counter row for the duration),
// then hands them out locally. Two instances can never get overlapping blocks.
//
// The cost: codes are no longer globally sequential (instance A may hand out
// 1000-1063 while B hands out 1064-...), and ids left in a block when an
// instance stops are never used. Both are fine for a URL shortener.
function createPostgresRepository({ connectionString, pool, idBlockSize = 100, poolMax = 10 } = {}) {
  if (!Number.isInteger(idBlockSize) || idBlockSize < 1) {
    throw new RangeError('idBlockSize must be a positive integer');
  }

  const ownsPool = !pool;
  pool =
    pool ||
    new Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

  // an idle client losing its connection emits 'error' on the pool; without a
  // listener that would crash the process
  pool.on('error', (err) => console.warn(`[postgres] idle client error: ${err.message}`));

  let nextId = 0;
  let lastId = -1;
  let reserving = null;

  async function reserveBlock() {
    const { rows } = await pool.query(
      'UPDATE id_counter SET value = value + $1 WHERE id = 1 RETURNING value',
      [idBlockSize]
    );
    lastId = Number(rows[0].value);
    nextId = lastId - idBlockSize + 1;
  }

  async function takeId() {
    // concurrent requests in this process share one in-flight reservation
    while (nextId > lastId) {
      if (!reserving) reserving = reserveBlock().finally(() => (reserving = null));
      await reserving;
    }
    return nextId++;
  }

  const INSERT = `
    INSERT INTO links (code, url, is_custom, created_at, expires_at, manage_token_hash)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (code) DO NOTHING
    RETURNING *
  `;

  async function insert(code, url, isCustom, expiresAt, manageTokenHash) {
    const { rows } = await pool.query(INSERT, [code, url, isCustom, new Date(), expiresAt, manageTokenHash]);
    return rows[0] ? toLink(rows[0]) : null;
  }

  return {
    driver: 'postgres',
    pool,

    // `alias` is a code the user picked, `code` a random one from the service
    async createLink({ url, alias, code, expiresAt, manageTokenHash = null }) {
      const wanted = alias || code;
      if (wanted) {
        const link = await insert(wanted, url, Boolean(alias), expiresAt || null, manageTokenHash);
        if (!link) throw httpError(409, alias ? `Alias "${alias}" is already taken` : 'Code is already taken');
        return link;
      }

      // ON CONFLICT DO NOTHING means a counter code that collides with an
      // existing alias returns no row, and we try the next id instead
      for (;;) {
        const link = await insert(encode(await takeId()), url, false, expiresAt || null, manageTokenHash);
        if (link) return link;
      }
    },

    async findManageTokenHash(code) {
      const { rows } = await pool.query('SELECT manage_token_hash FROM links WHERE code = $1', [code]);
      return rows[0] ? { hash: rows[0].manage_token_hash } : null;
    },

    // Adds a batch of buffered clicks in one transaction. The batch id is
    // inserted first: if it's already there, this batch was applied before
    // (an instance crashed after COMMIT but before deleting it from Redis)
    // and nothing is added twice.
    async applyClickBatch(batchId, counts, { pruneBefore = '' } = {}) {
      const codes = Object.keys(counts);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const marked = await client.query(
          'INSERT INTO click_batches (id) VALUES ($1) ON CONFLICT DO NOTHING',
          [batchId]
        );
        if (marked.rowCount === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `UPDATE links AS l SET clicks = l.clicks + v.n
             FROM unnest($1::text[], $2::bigint[]) AS v(code, n)
            WHERE l.code = v.code`,
          [codes, codes.map((c) => Number(counts[c]))]
        );
        await client.query('DELETE FROM click_batches WHERE id < $1', [pruneBefore]);
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async findByCode(code) {
      const { rows } = await pool.query('SELECT * FROM links WHERE code = $1', [code]);
      return rows[0] ? toLink(rows[0]) : null;
    },

    async incrementClicks(code) {
      await pool.query('UPDATE links SET clicks = clicks + 1 WHERE code = $1', [code]);
    },

    async updateLink(code, { url, expiresAt }) {
      const { rows } = await pool.query(
        `UPDATE links
            SET url = COALESCE($2, url),
                expires_at = CASE WHEN $3 THEN $4::timestamptz ELSE expires_at END
          WHERE code = $1
         RETURNING *`,
        [code, url ?? null, expiresAt !== undefined, expiresAt ?? null]
      );
      return rows[0] ? toLink(rows[0]) : null;
    },

    async deleteLink(code) {
      const { rowCount } = await pool.query('DELETE FROM links WHERE code = $1', [code]);
      return rowCount > 0;
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async close() {
      if (ownsPool && !pool.ended) await pool.end();
    },
  };
}

function toLink(row) {
  return {
    code: row.code,
    url: row.url,
    clicks: Number(row.clicks),
    custom: row.is_custom,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

module.exports = { createPostgresRepository };
