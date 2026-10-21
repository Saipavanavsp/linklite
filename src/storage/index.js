const { createSqliteRepository } = require('./sqliteRepository');
const { createPostgresRepository } = require('./postgresRepository');

// Every repository has the same async interface:
//   createLink({ url, alias, expiresAt }) -> link   (409 error if alias is taken)
//   findByCode(code)                      -> link | null
//   incrementClicks(code)
//   updateLink(code, { url?, expiresAt? }) -> link | null   (expiresAt: null clears it)
//   deleteLink(code)                      -> boolean
//   ping(), close()
function createRepository({ driver = 'sqlite', sqlitePath = ':memory:', databaseUrl, idBlockSize, poolMax } = {}) {
  switch (driver) {
    case 'sqlite':
      return createSqliteRepository(sqlitePath);
    case 'postgres':
      if (!databaseUrl) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
      return createPostgresRepository({ connectionString: databaseUrl, idBlockSize, poolMax });
    default:
      throw new Error(`Unknown DB_DRIVER "${driver}" (expected sqlite or postgres)`);
  }
}

module.exports = { createRepository };
