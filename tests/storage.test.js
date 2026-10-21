const { createRepository } = require('../src/storage');
const { createPostgresRepository } = require('../src/storage/postgresRepository');
const { decode } = require('../src/utils/base62');

describe('createRepository', () => {
  test('defaults to sqlite', async () => {
    const repo = createRepository();
    expect(repo.driver).toBe('sqlite');
    await repo.close();
  });

  test('postgres needs a DATABASE_URL', () => {
    expect(() => createRepository({ driver: 'postgres' })).toThrow(/DATABASE_URL/);
  });

  test('rejects unknown drivers', () => {
    expect(() => createRepository({ driver: 'mongo' })).toThrow(/Unknown DB_DRIVER/);
  });
});

describe('sqlite repository', () => {
  let repo;
  beforeEach(() => {
    repo = createRepository({ driver: 'sqlite' });
  });
  afterEach(() => repo.close());

  test('creates, finds and counts clicks', async () => {
    const link = await repo.createLink({ url: 'https://example.com' });
    expect(link).toMatchObject({ code: '1000', clicks: 0, custom: false, expiresAt: null });

    await repo.incrementClicks('1000');
    expect((await repo.findByCode('1000')).clicks).toBe(1);
    expect(await repo.findByCode('nope')).toBeNull();
  });

  test('throws a 409 for a taken alias', async () => {
    await repo.createLink({ url: 'https://a.com', alias: 'dup' });
    await expect(repo.createLink({ url: 'https://b.com', alias: 'dup' })).rejects.toMatchObject({ status: 409 });
  });

  test('updates url and expiry independently', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repo.createLink({ url: 'https://old.com', alias: 'edit-me', expiresAt });

    let link = await repo.updateLink('edit-me', { url: 'https://new.com' });
    expect(link).toMatchObject({ url: 'https://new.com', expiresAt });

    link = await repo.updateLink('edit-me', { expiresAt: null });
    expect(link).toMatchObject({ url: 'https://new.com', expiresAt: null });

    expect(await repo.updateLink('missing', { url: 'https://x.com' })).toBeNull();
  });

  test('deletes links', async () => {
    await repo.createLink({ url: 'https://a.com', alias: 'gone' });
    expect(await repo.deleteLink('gone')).toBe(true);
    expect(await repo.deleteLink('gone')).toBe(false);
    expect(await repo.findByCode('gone')).toBeNull();
  });

  test('ping works while open', async () => {
    await expect(repo.ping()).resolves.toBeUndefined();
  });
});

// Just enough of pg.Pool to exercise the id block logic without a database.
function fakePool({ counterStart = 62 ** 3 - 1 } = {}) {
  const links = new Map();
  let counter = counterStart;
  const pool = {
    reservations: 0,
    on() {},
    async query(sql, params) {
      if (sql.startsWith('UPDATE id_counter')) {
        pool.reservations++;
        await new Promise((resolve) => setImmediate(resolve)); // simulate a round trip
        counter += params[0];
        return { rows: [{ value: String(counter) }] };
      }
      if (sql.includes('INSERT INTO links')) {
        const [code, url, isCustom, createdAt, expiresAt] = params;
        if (links.has(code)) return { rows: [] };
        const row = { code, url, is_custom: isCustom, clicks: '0', created_at: createdAt, expires_at: expiresAt && new Date(expiresAt) };
        links.set(code, row);
        return { rows: [row] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return pool;
}

describe('postgres repository id blocks', () => {
  test('hands out ids from one reserved block', async () => {
    const pool = fakePool();
    const repo = createPostgresRepository({ pool, idBlockSize: 5 });

    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await repo.createLink({ url: 'https://a.com' })).code);

    expect(codes).toEqual(['1000', '1001', '1002', '1003', '1004']);
    expect(pool.reservations).toBe(1);

    await repo.createLink({ url: 'https://a.com' });
    expect(pool.reservations).toBe(2);
  });

  test('concurrent creates in one process share a single reservation', async () => {
    const pool = fakePool();
    const repo = createPostgresRepository({ pool, idBlockSize: 50 });

    const links = await Promise.all(Array.from({ length: 20 }, () => repo.createLink({ url: 'https://a.com' })));
    const codes = links.map((l) => l.code);

    expect(new Set(codes).size).toBe(20);
    expect(pool.reservations).toBe(1);
  });

  test('two instances on the same database never produce the same code', async () => {
    const pool = fakePool();
    const a = createPostgresRepository({ pool, idBlockSize: 3 });
    const b = createPostgresRepository({ pool, idBlockSize: 3 });

    const created = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).createLink({ url: `https://x.com/${i}` }))
    );
    const ids = created.map((l) => decode(l.code));
    expect(new Set(ids).size).toBe(30);
  });

  test('skips a counter code that is already used as an alias', async () => {
    const pool = fakePool();
    const repo = createPostgresRepository({ pool, idBlockSize: 10 });

    await repo.createLink({ url: 'https://a.com', alias: '1000' });
    const link = await repo.createLink({ url: 'https://b.com' });
    expect(link.code).toBe('1001');
  });

  test('returns 409 when an alias is taken', async () => {
    const repo = createPostgresRepository({ pool: fakePool() });
    await repo.createLink({ url: 'https://a.com', alias: 'mine' });
    await expect(repo.createLink({ url: 'https://b.com', alias: 'mine' })).rejects.toMatchObject({ status: 409 });
  });

  test('maps postgres types to the same shape as sqlite', async () => {
    const repo = createPostgresRepository({ pool: fakePool() });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const link = await repo.createLink({ url: 'https://a.com', expiresAt });

    expect(link).toEqual({
      code: '1000',
      url: 'https://a.com',
      clicks: 0,
      custom: false,
      createdAt: expect.stringMatching(/Z$/),
      expiresAt,
    });
  });

  test('rejects a bad block size', () => {
    expect(() => createPostgresRepository({ pool: fakePool(), idBlockSize: 0 })).toThrow(RangeError);
  });
});
