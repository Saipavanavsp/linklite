const { Pool } = require('pg');
const { migrate } = require('../../src/storage/migrate');
const { createPostgresRepository } = require('../../src/storage/postgresRepository');
const { decode } = require('../../src/utils/base62');
const { testUrls, resetDatabase } = require('./helpers');

const { databaseUrl } = testUrls();

describe('postgres schema', () => {
  let pool;
  beforeAll(async () => {
    await resetDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
  });
  afterAll(() => pool.end());

  test('migrations are recorded and running them again does nothing', async () => {
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql']);
  });

  test('two runners at once do not both apply the same migration', async () => {
    await pool.query('DROP TABLE IF EXISTS links, id_counter, schema_migrations');
    const results = await Promise.all([migrate(pool), migrate(pool)]);
    expect(results.flat()).toEqual(['001_init.sql']);
  });

  test('code has a unique index and expires_at a partial index', async () => {
    const { rows } = await pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'links' ORDER BY indexname"
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.links_code_key).toMatch(/UNIQUE INDEX .* \(code\)/);
    expect(byName.links_expires_at_idx).toMatch(/WHERE \(expires_at IS NOT NULL\)/);
  });
});

describe('postgres repository', () => {
  let repos = [];
  const repo = (opts) => {
    const r = createPostgresRepository({ connectionString: databaseUrl, ...opts });
    repos.push(r);
    return r;
  };

  beforeEach(() => resetDatabase(databaseUrl));
  afterEach(async () => {
    await Promise.all(repos.map((r) => r.close()));
    repos = [];
  });

  test('create, find, click, update, delete', async () => {
    const r = repo();
    const created = await r.createLink({ url: 'https://example.com' });
    expect(created).toMatchObject({ code: '1000', clicks: 0, custom: false, expiresAt: null });

    await r.incrementClicks('1000');
    await r.incrementClicks('1000');
    expect((await r.findByCode('1000')).clicks).toBe(2);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await r.updateLink('1000', { url: 'https://new.com', expiresAt })).toMatchObject({ url: 'https://new.com', expiresAt });
    expect(await r.updateLink('1000', { expiresAt: null })).toMatchObject({ url: 'https://new.com', expiresAt: null });

    expect(await r.deleteLink('1000')).toBe(true);
    expect(await r.findByCode('1000')).toBeNull();
  });

  test('alias conflicts are a 409', async () => {
    const r = repo();
    await r.createLink({ url: 'https://a.com', alias: 'taken' });
    await expect(r.createLink({ url: 'https://b.com', alias: 'taken' })).rejects.toMatchObject({ status: 409 });
  });

  test('the counter skips codes already taken by an alias', async () => {
    const r = repo({ idBlockSize: 5 });
    await r.createLink({ url: 'https://a.com', alias: '1000' });
    await r.createLink({ url: 'https://a.com', alias: '1001' });
    expect((await r.createLink({ url: 'https://b.com' })).code).toBe('1002');
  });

  test('two instances creating links concurrently never collide', async () => {
    const a = repo({ idBlockSize: 7 });
    const b = repo({ idBlockSize: 7 });

    const links = await Promise.all(
      Array.from({ length: 200 }, (_, i) => (i % 2 ? a : b).createLink({ url: `https://example.com/${i}` }))
    );

    const ids = links.map((l) => decode(l.code));
    expect(new Set(ids).size).toBe(200);
    expect(Math.min(...ids)).toBe(62 ** 3);
  });

  test('id blocks reserved by different instances do not overlap', async () => {
    const a = repo({ idBlockSize: 10 });
    const b = repo({ idBlockSize: 10 });

    const fromA = (await a.createLink({ url: 'https://a.com' })).code;
    const fromB = (await b.createLink({ url: 'https://b.com' })).code;
    expect(Math.abs(decode(fromA) - decode(fromB))).toBe(10);
  });
});
