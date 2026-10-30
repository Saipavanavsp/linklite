const { createClickCounter, PENDING_KEY, BATCH_PREFIX } = require('../src/services/clickCounter');
const { createSqliteRepository } = require('../src/storage/sqliteRepository');
const { FakeRedisServer } = require('./helpers/fakeRedis');

const quiet = { log() {}, warn() {} };

describe('click counter', () => {
  let repo;
  let server;
  let redis;
  let clock;

  beforeEach(async () => {
    repo = createSqliteRepository(':memory:');
    clock = { t: 1_800_000_000_000 };
    server = new FakeRedisServer(() => clock.t);
    redis = server.client();
    await repo.createLink({ url: 'https://a.com', alias: 'aaa' });
    await repo.createLink({ url: 'https://b.com', alias: 'bbb' });
  });
  afterEach(() => repo.close());

  const clicksIn = async (code) => (await repo.findByCode(code)).clicks;
  const makeCounter = (overrides = {}) =>
    createClickCounter({ repo, redis, logger: quiet, now: () => clock.t, ...overrides });

  test('without redis every click is written straight to the database', async () => {
    const clicks = createClickCounter({ repo, logger: quiet });
    await clicks.record('aaa');
    await clicks.record('aaa');
    expect(await clicksIn('aaa')).toBe(2);
    expect(await clicks.pending('aaa')).toBe(0);
    expect(clicks.stats()).toMatchObject({ mode: 'direct', direct: 2 });
  });

  test('with redis clicks are buffered and written in one batch', async () => {
    const clicks = makeCounter();
    for (let i = 0; i < 5; i++) await clicks.record('aaa');
    await clicks.record('bbb');

    expect(await clicksIn('aaa')).toBe(0);
    expect(await clicks.pending('aaa')).toBe(5);

    await clicks.flush();
    expect(await clicksIn('aaa')).toBe(5);
    expect(await clicksIn('bbb')).toBe(1);
    expect(await clicks.pending('aaa')).toBe(0);
    expect(clicks.stats()).toMatchObject({ mode: 'redis-buffered', buffered: 6, flushedBatches: 1, flushedClicks: 6 });

    // nothing left behind in redis
    expect([...server.data.keys()]).toEqual([]);
  });

  test('a flush with no clicks does nothing', async () => {
    const clicks = makeCounter();
    await clicks.flush();
    expect(clicks.stats()).toMatchObject({ flushedBatches: 0, errors: 0 });
  });

  test('two instances flushing at the same time count each click once', async () => {
    const a = makeCounter();
    const b = createClickCounter({ repo, redis: server.client(), logger: quiet, now: () => clock.t });
    for (let i = 0; i < 4; i++) await (i % 2 ? a : b).record('aaa');

    await Promise.all([a.flush(), b.flush()]);
    expect(await clicksIn('aaa')).toBe(4);
  });

  test('if redis is down the click goes to the database instead of being lost', async () => {
    const clicks = makeCounter();
    redis.down = true;
    await clicks.record('aaa');
    expect(await clicksIn('aaa')).toBe(1);
    expect(clicks.stats()).toMatchObject({ direct: 1, errors: 1 });
  });

  test('if the database write fails the batch stays in redis and is applied later', async () => {
    const clicks = makeCounter();
    await clicks.record('aaa');
    await clicks.record('aaa');

    const apply = repo.applyClickBatch;
    repo.applyClickBatch = async () => {
      throw new Error('database is down');
    };
    await clicks.flush();
    expect(await clicksIn('aaa')).toBe(0);
    const leftover = [...server.data.keys()].filter((k) => k.startsWith(BATCH_PREFIX));
    expect(leftover).toHaveLength(1);

    // database is back; the batch is picked up once it's older than 30s
    repo.applyClickBatch = apply;
    await clicks.record('aaa');
    clock.t += 31_000;
    await clicks.flush();
    expect(await clicksIn('aaa')).toBe(3);
    expect([...server.data.keys()]).toEqual([]);
  });

  test('a batch applied twice (crash before the redis DEL) is only counted once', async () => {
    const clicks = makeCounter();
    await clicks.record('aaa');
    await clicks.record('aaa');

    // simulate: an instance renamed and committed the batch, then died before DEL
    const key = `${BATCH_PREFIX}${String(clock.t).padStart(13, '0')}-dead-instance`;
    await redis.rename(PENDING_KEY, key);
    await repo.applyClickBatch(key.slice(BATCH_PREFIX.length), await redis.hgetall(key));
    expect(await clicksIn('aaa')).toBe(2);

    // another instance finds the stale batch and must not add it again
    clock.t += 31_000;
    await makeCounter().flush();
    expect(await clicksIn('aaa')).toBe(2);
    expect(server.data.has(key)).toBe(false);
  });

  test('stop() pushes out what is still buffered', async () => {
    const clicks = makeCounter();
    clicks.start();
    await clicks.record('bbb');
    await clicks.stop();
    expect(await clicksIn('bbb')).toBe(1);
  });

  test('clicks for a deleted link are dropped without errors', async () => {
    const clicks = makeCounter();
    await clicks.record('aaa');
    await repo.deleteLink('aaa');
    await clicks.flush();
    expect(clicks.stats().errors).toBe(0);
  });
});
