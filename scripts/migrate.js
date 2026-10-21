// Usage: DATABASE_URL=postgres://... npm run migrate
const { Pool } = require('pg');
const { migrate } = require('../src/storage/migrate');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const ran = await migrate(pool, { log: (msg) => console.log(msg) });
    console.log(ran.length ? `done, ${ran.length} migration(s) applied` : 'schema is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
