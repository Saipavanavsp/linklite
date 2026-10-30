const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Start the counter at 62^3 so every generated code is at least 4 characters.
const COUNTER_START = 62 ** 3;

function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new Database(file);

  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      url        TEXT NOT NULL,
      clicks     INTEGER NOT NULL DEFAULT 0,
      is_custom  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      manage_token_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS counter (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    );

    -- ids of click batches already added to links.clicks, so a batch that is
    -- flushed twice (crash between the DB write and the Redis DEL) counts once
    CREATE TABLE IF NOT EXISTS click_batches (
      id TEXT PRIMARY KEY
    );
  `);

  // database files created before management tokens existed
  const columns = db.prepare('PRAGMA table_info(links)').all().map((c) => c.name);
  if (!columns.includes('manage_token_hash')) {
    db.exec('ALTER TABLE links ADD COLUMN manage_token_hash TEXT');
  }

  db.prepare('INSERT OR IGNORE INTO counter (id, value) VALUES (1, ?)').run(COUNTER_START - 1);

  return db;
}

module.exports = { openDb };
