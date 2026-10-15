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
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS counter (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    );
  `);

  db.prepare('INSERT OR IGNORE INTO counter (id, value) VALUES (1, ?)').run(COUNTER_START - 1);

  return db;
}

module.exports = { openDb };
