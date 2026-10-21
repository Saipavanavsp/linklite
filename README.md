# LinkLite

[![tests](https://github.com/Saipavanavsp/linklite/actions/workflows/test.yml/badge.svg)](https://github.com/Saipavanavsp/linklite/actions/workflows/test.yml)

A URL shortener built with Node.js and Express. It started as a single
server on SQLite and now also runs as several instances behind a load
balancer, sharing PostgreSQL and Redis. The two parts I cared most about are
written by hand instead of pulled from npm:

- an **LRU cache** (hash map + doubly linked list) that sits in front of the
  database for redirects. It's now the L1 level, with Redis as a shared L2
- a **token bucket rate limiter**, per IP. It now runs as an atomic Lua
  script in Redis so the limit holds across instances, with the in-memory
  version as the fallback

Short codes come from an auto-increment counter encoded in base62, not random
strings.

## Live demo

**https://linklite-8fe6.onrender.com**

Hosted on Render's free tier, so keep in mind:

- The instance sleeps after about 15 minutes without traffic. The first
  request after that can take up to a minute.
- There is no persistent disk on the free plan. The SQLite database is wiped
  whenever the service restarts, redeploys or spins down, so links you create
  there are temporary.
- The demo runs the single-instance mode: SQLite, the in-process LRU and the
  in-memory rate limiter, no Redis or Postgres. Everything new in the API
  (`PATCH`/`DELETE /api/links/:code`, `/healthz`, `/metrics`) works there too.
  The multi-instance setup runs with Docker Compose (below).

## Features

- `POST /api/shorten` with optional custom alias and optional expiry date
- `GET /:code` does a 302 redirect and counts the click (404 if missing, 410 if expired)
- `PATCH /api/links/:code` changes the target or expiry, `DELETE /api/links/:code` removes a link
- `GET /api/stats/:code` shows clicks, created date and expiry
- `GET /api/cache-stats` shows hits/misses for L1 and L2, and every redirect has an
  `X-Cache: HIT|MISS` header (plus `X-Cache-Level: L1|L2` on hits)
- 429 with `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining` when a client goes over the limit
- `GET /healthz` (database + Redis) and `GET /metrics` (JSON counters)
- SQLite or PostgreSQL, picked with `DB_DRIVER`
- Docker Compose setup: nginx, 2 app replicas, Postgres, Redis
- 107 unit/API tests plus 23 integration tests against real Postgres and Redis,
  all run on GitHub Actions
- Plain HTML/CSS/JS frontend: shorten a link, see your links and their click counts

## Demo

All screenshots come from one real local run of the app (`npm start` on
port 3000 with the default settings). Every test also runs on GitHub Actions
on each push; see the badge above.

### Homepage

![Homepage](docs/screenshots/01-homepage.png)

### Shortening links

Four links: two counter codes (`1000`, `1001`), a custom alias (`lru-wiki`),
and one with an expiry date (`node-intro`). The click counts come from real
redirects.

![Shortened link and my links table](docs/screenshots/02-shortened-link.png)

### Redirect, cache HIT/MISS, 410 and 404

The first redirect for a new code reads SQLite (`X-Cache: MISS`). The second
is served from the LRU cache (`X-Cache: HIT`). An expired link returns 410
and an unknown code returns 404.

![curl redirect output](docs/screenshots/03-redirect.png)

### Stats page

![Stats page](docs/screenshots/04-stats-page.png)

### Rate limiter (429)

12 POSTs in a row to `/api/shorten`. The bucket holds 10 tokens, so
requests 11 and 12 get `429` with `Retry-After`.

![429 rate limit](docs/screenshots/05-rate-limit-429.png)

### Tests

![45 tests passing](docs/screenshots/06-tests-passing.png)

### Server log

Every request from the run above, with cache hits and misses on redirects.

![Server terminal](docs/screenshots/07-server-terminal.png)

## Architecture

There are two ways to run it, and they use the same code:

| | single instance (default, live demo) | distributed (Docker Compose) |
|---|---|---|
| database | SQLite file | PostgreSQL |
| cache | LRU in the process | LRU (L1) + Redis (L2) |
| rate limit | buckets in process memory | buckets in Redis, Lua script |
| instances | 1 | 2 behind nginx (more is just another service) |

Nothing has to be configured for the first one. Setting `DB_DRIVER=postgres`
and `REDIS_URL` switches to the second.

```mermaid
flowchart LR
    C[Browser / curl] --> N[nginx<br/>round robin]
    N --> A1
    N --> A2

    subgraph A1 [app1]
        direction TB
        RL1[rate limiter] --> S1[linkService] --> L1a[(L1 LRU)]
    end
    subgraph A2 [app2]
        direction TB
        RL2[rate limiter] --> S2[linkService] --> L1b[(L1 LRU)]
    end

    A1 & A2 -->|token buckets Lua<br/>L2 cache GET/SET<br/>invalidation pub/sub| R[(Redis)]
    A1 & A2 -->|links, clicks,<br/>id blocks| P[(PostgreSQL)]
```

A redirect, step by step:

```mermaid
sequenceDiagram
    participant C as Client
    participant A as App instance
    participant L1 as L1 (LRU, in process)
    participant R as Redis (L2)
    participant P as Postgres

    C->>A: GET /abc1
    A->>R: EVALSHA token bucket (ip)
    R-->>A: allowed, tokens left
    A->>L1: get(abc1)
    alt L1 hit
        L1-->>A: url, expiresAt
    else L1 miss
        A->>R: GET linklite:link:abc1
        alt L2 hit
            R-->>A: url, expiresAt
            A->>L1: put (ttl capped by expiry)
        else L2 miss
            A->>P: SELECT ... WHERE code = 'abc1'
            A->>R: SET ... PX ttl
            A->>L1: put
        end
    end
    A->>P: UPDATE clicks = clicks + 1
    A-->>C: 302 Location (or 410 if expired)
```

```
src/
  app.js                    builds the express app (used by server.js and the tests)
  server.js                 reads env vars, starts listening, graceful shutdown
  db.js                     opens sqlite and creates tables
  redis.js                  ioredis client settings (fail fast, reconnect in background)
  metrics.js                counters behind /metrics
  storage/                  repository interface: sqlite and postgres versions, migration runner
  cache/tieredCache.js      L1 + L2 cache-aside, invalidation over pub/sub
  routes/api.js             /api/shorten, /api/links/:code, /api/stats/:code, /api/cache-stats
  routes/redirect.js        /:code
  routes/ops.js             /healthz, /metrics
  services/linkService.js   ties the repository and the cache together
  middleware/rateLimiter.js shared bucket in Redis, local bucket as fallback
  utils/base62.js
  utils/lruCache.js
  utils/tokenBucket.js      in-memory token bucket
  utils/redisTokenBucket.js the same algorithm as a Lua script
migrations/                 sql files for postgres
nginx/nginx.conf            load balancer config
scripts/                    migrate.js, loadtest.js
public/                     frontend (index.html, stats.html)
tests/                      unit + API tests, tests/integration needs real postgres and redis
docs/                       api examples, AWS deploy guide, screenshots
```

## How the LRU cache works

`src/utils/lruCache.js`

- A `Map` from key to a list node gives O(1) lookup.
- A doubly linked list keeps the order of use. The most recently used node is
  right after `head`, the least recently used is right before `tail`.
- `head` and `tail` are dummy nodes, so inserting and removing never needs
  null checks.
- `get(key)`: look up the node, unlink it, put it at the front. O(1).
- `put(key, value, ttlMs?)`: if the key exists, update and move to front. Otherwise,
  if the cache is full, remove `tail.prev` (the LRU entry) from both the list
  and the map, then add the new node at the front. O(1).
- Entries can have an optional ttl. Like the token bucket's refill, expiry is
  lazy: there's no timer, an expired entry is removed when someone reads it,
  and that read counts as a miss.

The cache stores `{ url, expiresAt }` for each code. Expiry is checked on
every redirect, so a cached link still returns 410 once it expires.

Cache misses are not cached. If they were, a code that did not exist yet
would keep returning 404 after someone created it.

(A JS `Map` remembers insertion order, so you could build an LRU with just a
`Map` by deleting and re-inserting keys. I used the linked list on purpose
because that's the classic design and it works the same way in any language.)

## How the two cache levels work

`src/cache/tieredCache.js`, `src/services/linkService.js`

The LRU above is L1, one per process. Redis is L2, shared by every instance.
Both are **cache-aside**: the app code reads the cache, and on a miss reads
the database and fills the cache itself. The database doesn't know the caches
exist.

**Reads.** L1, then L2, then Postgres. An L2 hit is copied into L1. A
database read fills both.

**TTLs.** A Redis entry lives at most `CACHE_TTL_SEC` (1 hour), an L1 entry at
most `L1_TTL_SEC` (60s). Both are also capped by the link's own expiry, so a
link that expires in 30 seconds gets a 30 second ttl. Links that have already
expired aren't cached at all.

**Writes.**

- *Create*: the new link is written to L2 straight away (not L1), so the
  first redirect, on whichever instance gets it, skips the database. L1
  isn't filled because most links are never clicked from the instance that
  created them.
- *Update / delete*: write to Postgres first, then **delete** the cached
  copy from L2 and publish the code on a Redis pub/sub channel. Every
  instance is subscribed and drops that code from its own L1. Deleting
  instead of overwriting means a slow request can't put an older value back
  after a newer one.

**Hit/miss metrics** are tracked per level. L1 numbers count every lookup,
L2 numbers count only what reached Redis (L1 misses). Both are in
`/api/cache-stats` and `/metrics`.

**When Redis is down.** Every Redis call goes through one wrapper that
catches the error, counts it and logs a warning at most once every 10
seconds. The cache then behaves as L1-only and the app reads Postgres on L1
misses. The client is set to fail fast instead of queueing commands
(`enableOfflineQueue: false`, 500ms command timeout) and reconnects in the
background. When the pub/sub connection comes back, L1 is cleared, because
invalidation messages may have been missed while it was down.

## How the token bucket works

`src/utils/tokenBucket.js`, `src/utils/redisTokenBucket.js`, `src/middleware/rateLimiter.js`

- Each IP gets a bucket with `capacity` tokens. Every request takes one token.
- Tokens refill at `refillPerSec`, up to `capacity`.
- Refill is lazy: there's no timer per bucket. When a request comes in, the
  bucket adds `elapsedSeconds * refillPerSec` tokens and then tries to take one.
- No token left: respond `429` with `Retry-After` set to
  `ceil((1 - tokens) / refillPerSec)` seconds.

**Shared across instances.** With one process, the buckets can live in a
`Map`. With two instances behind a load balancer, each would have its own
bucket per IP, so a client would get twice the limit. So the bucket state
(`tokens`, `ts`) is now a Redis hash, and refill-and-take is one Lua script.
Redis runs a script atomically, so two instances can't both read "1 token
left" and both let a request through. The script:

1. reads the time with Redis `TIME` (so app servers with slightly different
   clocks still agree),
2. reads the hash (a missing key means a full bucket), adds the refilled
   tokens, takes one if it can,
3. writes the hash back and sets `PEXPIRE` to the time it takes to refill
   from empty. A bucket that would be full again is the same as a missing
   one, so Redis drops idle buckets on its own. This replaces the sweeper
   the in-memory version uses for the same reason.

It's called with `EVALSHA`. If Redis was restarted and forgot the script,
the `NOSCRIPT` error is caught and it's sent once with `EVAL`.

**When Redis is down, which way to fail?**

- *Fail closed* (reject when the limiter can't check): a Redis outage turns
  into a full outage of the site, including redirects, which is the main thing
  a shortener does.
- *Fail open* (allow everything): the API is unprotected for as long as Redis
  is down.

I went with a middle ground: fall back to the in-memory bucket on each
instance. It's still fail-open as far as the global limit goes. With N
instances, a client can get up to N times the limit until Redis comes back.
But no single instance can be flooded, and nothing breaks. The trade-off is
written down in `src/middleware/rateLimiter.js` too.

There are two limiters:

| Limiter | Applies to | Default |
|---|---|---|
| general | every request except `/healthz` and `/metrics` | burst 60, refill 1/sec |
| shorten | `POST /api/shorten`, `PATCH` and `DELETE /api/links/:code` | burst 10, refill 1 every 5 sec |

The token bucket allows short bursts but caps the average rate. A fixed
window counter is simpler, but it lets a client send twice the limit around
the window boundary.

## Short codes with several instances

`src/storage/postgresRepository.js`

With SQLite, the counter is bumped inside the insert transaction, one id at a
time, which works because SQLite has a single writer.

With Postgres and several instances, each one reserves a **block** of ids
with one statement:

```sql
UPDATE id_counter SET value = value + 100 WHERE id = 1 RETURNING value
```

Postgres locks the row while it does this, so two instances can never get
overlapping blocks. The instance then hands out ids from its block in memory,
and only goes back to the database when the block runs out. Concurrent
requests in the same process share one in-flight reservation.

Inserts use `ON CONFLICT (code) DO NOTHING`. A custom alias is also a valid
base62 number, so if the counter lands on a code someone already took as an
alias, no row comes back and the next id is tried.

What this costs: codes are unique but no longer globally in order (app1 may
be handing out `1000`-`101B` while app2 hands out `101C`-...), and ids left in
a block when an instance stops are skipped. Neither matters for a shortener.

## API

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/api/shorten` | `{ "url", "alias"?, "expiresAt"? }` | `201` link JSON | `400` invalid input, `409` alias taken, `429` |
| GET | `/:code` | | `302` redirect, `X-Cache` header | `404` missing, `410` expired, `429` |
| PATCH | `/api/links/:code` | `{ "url"?, "expiresAt"? }` | `200` link JSON | `400`, `404`, `429` |
| DELETE | `/api/links/:code` | | `204` | `404`, `429` |
| GET | `/api/stats/:code` | | `200` `{ code, url, shortUrl, clicks, custom, createdAt, expiresAt, expired }` | `404` |
| GET | `/api/cache-stats` | | `200` `{ capacity, size, hits, misses, hitRate, l1, l2 }` | |
| GET | `/healthz` | | `200` `{ status, db, redis }` | `503` database down or shutting down |
| GET | `/metrics` | | `200` request, rate limit and cache counters | |

Rules:

- `url` must be `http` or `https`, max 2048 characters.
- `alias` is 3-30 characters from `A-Z a-z 0-9 - _`. `api`, `index`, `stats`,
  `healthz` and `metrics` are reserved.
- `expiresAt` is any date string `Date.parse` understands, and it must be in
  the future. It's stored as UTC ISO. In `PATCH`, `null` removes the expiry.

There's no auth, so anyone can edit or delete any link, same as anyone can
create one. Fine for a demo, it would need accounts or per-link tokens
before real use.

Full request/response examples are in [docs/api.md](docs/api.md).

## Setup

Requires Node.js 22 or newer (it uses `node --env-file-if-exists`).

```bash
git clone https://github.com/Saipavanavsp/linklite.git
cd linklite
npm install
cp .env.example .env      # optional, every value has a default
npm start
```

Open http://localhost:3000.

The SQLite file is created at `data/linklite.db` (gitignored). `better-sqlite3`
ships prebuilt binaries for Windows, macOS and Linux, so you don't need a C++
compiler. Its compile-from-source script is turned off in `allowScripts` in
`package.json`.

### Running with Docker Compose (Postgres, Redis, 2 instances)

Needs Docker with the Compose plugin.

```bash
docker compose up -d --build
docker compose ps              # wait until everything is "healthy"
```

Open http://localhost:8080. What starts:

| service | what it does |
|---|---|
| `postgres` | PostgreSQL 17, data in the `pgdata` volume |
| `redis` | Redis 7, 128MB, evicts keys with a ttl when full |
| `migrate` | runs `migrations/*.sql` once and exits; the apps wait for it |
| `app1`, `app2` | the app, built from the `Dockerfile` |
| `nginx` | round-robins between the two apps, retries on the other one if one is down |

Each service has a healthcheck, and nginx only starts once both apps report
healthy. To see the load balancing and the shared cache:

```bash
curl -s -X POST localhost:8080/api/shorten -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
curl -si localhost:8080/1000 | grep -i -E "x-instance|x-cache"   # run it a few times
curl -s localhost:8080/metrics
```

Postgres and Redis aren't published on the host. To look inside:
`docker compose exec postgres psql -U linklite` or `docker compose exec redis redis-cli`.

`docker compose down` stops everything. `docker compose down -v` also
deletes the data.

The image is a two-stage build on `node:22-alpine`: dependencies are installed
in the first stage, and only production `node_modules` and the app files are
copied into the second. It runs as the unprivileged `node` user, starts
`node` directly so it gets SIGTERM, and the app layer is about 10MB on top of
the base image.

**Graceful shutdown.** On SIGTERM (`docker stop`), the app makes `/healthz`
return 503, stops accepting connections, closes idle keep-alive sockets,
waits for in-flight requests, then closes Redis and the Postgres pool. If that
takes longer than `SHUTDOWN_TIMEOUT_MS` it exits anyway. I checked it by
stopping `app1` while sending requests through nginx: all of them got a 200
from `app2`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | |
| `BASE_URL` | `http://localhost:PORT` | used to build `shortUrl` |
| `DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |
| `DB_PATH` | `./data/linklite.db` | sqlite only |
| `DATABASE_URL` | | postgres only, run `npm run migrate` once |
| `PG_POOL_MAX` | `10` | connections per instance |
| `ID_BLOCK_SIZE` | `100` | ids each instance reserves at a time (postgres) |
| `REDIS_URL` | | turns on the L2 cache and the shared rate limit |
| `CACHE_SIZE` | `1000` | max links in the LRU cache (L1) |
| `CACHE_TTL_SEC` / `L1_TTL_SEC` | `3600` / `60` | max time in L2 / L1 |
| `RATE_LIMIT_CAPACITY` / `RATE_LIMIT_REFILL` | `60` / `1` | general limiter |
| `SHORTEN_LIMIT_CAPACITY` / `SHORTEN_LIMIT_REFILL` | `10` / `0.2` | write limiter |
| `TRUST_PROXY` | `0` | set to `1` behind a reverse proxy so the real client IP is used |
| `LOG_REQUESTS` | `1` | one log line per request |
| `INSTANCE_ID` | | shown in `X-Instance` and `/metrics` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | |

## Running tests

```bash
npm test
```

```
Test Suites: 8 passed, 8 total
Tests:       107 passed, 107 total
```

These need nothing installed. Redis is replaced by a small in-memory fake
(`tests/helpers/fakeRedis.js`) or Jest mocks, and the Postgres repository's id
block logic is tested with a fake pool.

- `tests/base62.test.js`: known values, round trips, invalid input
- `tests/lruCache.test.js`: eviction order, `get` refreshing a key, updates, hit/miss counts, ttl, `clear`
- `tests/tokenBucket.test.js`: burst, refill, capacity cap, `Retry-After` math, per-IP buckets
  (uses a fake clock, so no sleeps)
- `tests/storage.test.js`: the sqlite repository, and id blocks / alias collisions in the postgres one
- `tests/tieredCache.test.js`: L1/L2 order, ttls capped by expiry, invalidation across
  instances, Redis failing and coming back
- `tests/redisRateLimiter.test.js`: the Lua call, `NOSCRIPT` fallback, headers, fallback to memory
- `tests/ops.test.js`: `/healthz` states, `/metrics` counters
- `tests/api.test.js`: every endpoint against an in-memory SQLite database, including
  404, 410, 409, 400 cases, cache HIT/MISS, the 429, and two app instances sharing a fake Redis

### Integration tests

These run against a real Postgres and Redis. They wipe both, so use throwaway
containers:

```bash
docker run -d --name ll-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
docker run -d --name ll-test-redis -p 56379:6379 redis:7-alpine

TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres \
TEST_REDIS_URL=redis://localhost:56379 \
npm run test:integration
```

```
Test Suites: 3 passed, 3 total
Tests:       23 passed, 23 total
```

- `postgres.test.js`: migrations (including two runners at once), indexes,
  200 concurrent creates from two repository instances with no duplicate code
- `cache.test.js`: two app instances; L2 hit on the other instance, Redis ttl
  vs link expiry, an update on one instance clearing the other's L1, Redis
  unreachable
- `rateLimit.test.js`: **requests alternated between two instances are
  limited to 5 in total, not 5 each** (and without Redis it's 10, the old
  behaviour); the Lua script under 200 concurrent calls, refill, key expiry,
  `SCRIPT FLUSH`

GitHub Actions runs the unit tests on Node 22 and 24, the integration tests
with Postgres and Redis service containers, and builds the Docker image.

## Load testing

`scripts/loadtest.js` uses [autocannon](https://github.com/mcollina/autocannon).
It creates a set of links, then sends `GET /:code` for a fixed time. Most
requests go to a few links, like real shortener traffic. It reads `/metrics`
from both instances before and after the run to work out the cache hit rate.

The rate limits would turn a load test from one IP into a wall of 429s, so
start Compose with the override that raises them and turns off request logs:

```bash
docker compose -f docker-compose.yml -f docker-compose.loadtest.yml up -d --build
npm run loadtest                                          # 30s, 50 connections, 500 links
npm run loadtest -- --duration 60 --connections 100 --links 2000 --out loadtest-results/run1.json
```

Options: `--url` (default `http://localhost:8080`), `--duration` (seconds),
`--connections`, `--links`, `--skew` (higher = more traffic on fewer links),
`--out` (save the summary as JSON).

## Results

Fill in after running the load test. Note the machine, since numbers from a
laptop and from a t3.micro are very different.

Machine: _(e.g. laptop CPU / RAM, or EC2 instance type)_
Command: `npm run loadtest -- --duration __ --connections __ --links __`

| metric | value |
|---|---|
| requests/sec (avg) | _ |
| latency p50 | _ ms |
| latency p95 | _ ms |
| latency p99 | _ ms |
| cache hit rate (L1 + L2) | _ % |
| L1 hit rate | _ % |
| errors / non-3xx | _ |

## Design trade-offs

**Why a base62 counter instead of random strings**

- No collisions and no retry loop. Every code is unique by construction.
- Codes stay as short as possible: 62^4 is about 14.7 million codes in 4
  characters, and 62^6 is about 56 billion in 6.
- The counter starts at 62^3, so generated codes are at least 4 characters long.
- Custom aliases share the same namespace (`abcd` is also a base62 number), so
  if the counter lands on a code that's already taken as an alias, it skips it.
- With several instances, ids come in blocks per instance (see above), so
  the counter row is touched once per 100 links instead of once per link.
- Downside: codes are guessable and show how many links exist. If that matters,
  you can shuffle the counter with a bijective function (multiply by a large
  odd number mod 62^n, or Feistel rounds). You keep uniqueness and the codes
  stop looking sequential.

**Why LRU for the cache**

- Redirect traffic is very skewed: a few links get most of the clicks. LRU
  keeps the popular ones in memory without extra bookkeeping.
- LFU could do better for traffic that stays hot for a long time, but it's
  more complex and slow to adapt when a link suddenly goes viral.

**Consistency vs availability**

- Postgres is the source of truth. The caches are allowed to be briefly
  stale, the database never is.
- After an update, another instance can serve the old target for as long as
  it takes the pub/sub message to arrive (milliseconds), or, if the message
  is lost, until its L1 entry expires (`L1_TTL_SEC`, 60s). A shorter L1 ttl
  means fresher data and more Redis reads. For a shortener, a minute of
  staleness after editing a link is acceptable. For something like
  permissions it wouldn't be.
- There's a classic cache-aside race: instance A reads the old row, B
  updates the row and deletes the cache key, then A writes the old value into
  the cache. The ttl bounds how long that can last. Fixing it fully needs
  versioned entries or a lease, which I didn't think was worth it here.
- When Redis is down the app picks availability: it keeps serving from L1
  and Postgres, and rate limits per instance. `/healthz` reports `degraded`
  but stays 200. If it returned 503, a Redis outage would take every instance
  out of the load balancer at the same time.

**Fail-open vs fail-closed for the rate limiter**

Covered above: it falls back to per-instance buckets, so the limit gets
looser (up to N times) but never disappears and never blocks everyone.

**Cache invalidation**

- Delete on write, not update on write, so concurrent writers can't leave
  an older value in the cache.
- Misses are never cached, so creating a link never needs an invalidation.
- Every cached entry has a ttl no longer than the link's expiry, so expiry
  doesn't need invalidation either.
- L1 is cleared completely after a pub/sub reconnect, since messages sent
  while disconnected are gone.

**Limits of this design**

- Click counting is still a database `UPDATE` on every redirect, so the
  caches only save the read. For heavy traffic, counts should be buffered in
  memory or Redis (`INCR`) and written in batches, or sent to a queue.
- The rate limiter keys on IP. Users behind one NAT share a bucket, and the
  limit is only as good as the `X-Forwarded-For` handling (nginx overwrites
  it, and the app trusts exactly one proxy hop).
- `/metrics` is per instance and in-memory, so it resets on restart. A real
  setup would use Prometheus format and scrape every instance.
- Postgres is a single primary. Read replicas would help the stats page,
  but redirects mostly never reach the database anyway.
- No auth on create/update/delete, and no check for malicious target URLs.
- "My links" in the UI is just a list of codes in `localStorage`.

**What I'd do next**

1. Buffer click counts in Redis and flush them to Postgres in batches.
2. Prometheus metrics and a Grafana dashboard instead of the JSON endpoint.
3. Send click events to a queue (Kafka/SQS) for analytics.
4. A CDN in front for the hottest redirects (with a short cache time, since
   a cached redirect isn't counted).

## Deploying

[docs/DEPLOY_AWS.md](docs/DEPLOY_AWS.md) walks through running the Docker
Compose setup on one EC2 instance with HTTPS (Caddy + Let's Encrypt), and how
each piece maps to managed AWS services (RDS, ElastiCache, ECS + ALB) at a
larger scale.

## Author

Sai Pavan

## License

MIT, see [LICENSE](LICENSE).
