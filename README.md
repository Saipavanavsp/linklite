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
- Editing or deleting a link needs the edit key that comes back when the link
  is created. The page keeps it in your browser, so the Edit and Delete
  buttons in "Links from this browser" just work.

## Features

- `POST /api/shorten` with optional custom alias, optional expiry date, and an
  `opaque` option for a random code that can't be found by counting
- Every link gets a management token; only its SHA-256 is stored
- `GET /:code` does a 302 redirect and counts the click (404 if missing, 410 if expired).
  With Redis, clicks are counted in Redis and written to the database in batches
- `PATCH /api/links/:code` changes the target or expiry, `DELETE /api/links/:code` removes a link.
  Both need the link's token
- Targets pointing at localhost, private networks or this service are rejected, and
  can optionally be checked against Google Safe Browsing
- `GET /api/stats/:code` shows clicks, created date and expiry
- `GET /api/cache-stats` shows hits/misses for L1 and L2, and every redirect has an
  `X-Cache: HIT|MISS` header (plus `X-Cache-Level: L1|L2` on hits)
- 429 with `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining` when a client goes over the limit
- `GET /healthz` (database + Redis) and `GET /metrics` (JSON counters)
- SQLite or PostgreSQL, picked with `DB_DRIVER`
- Docker Compose setup: nginx, 2 app replicas, Postgres, Redis
- 148 unit/API tests plus 26 integration tests against real Postgres and Redis,
  all run on GitHub Actions
- Plain HTML/CSS/JS frontend, no build step: shorten a link, see your links and
  their click counts, edit or delete them

## Demo

All screenshots come from one real local run of the app (`npm start` on
port 3000 with the default settings). Every test also runs on GitHub Actions
on each push; see the badge above.

### Homepage

![Homepage](docs/screenshots/01-homepage.png)

### Shortening links

Four links: two counter codes (`1000`, `1001`), a custom alias (`lru-wiki`),
and one with an expiry date (`node-intro`). The click counts come from real
redirects. The panel at the top is the link just created; its edit key is
hidden in the screenshot.

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
    A->>R: HINCRBY linklite:clicks:pending abc1 1
    A-->>C: 302 Location (or 410 if expired)
    Note over A,P: every second: RENAME the pending hash,<br/>add it to links.clicks in one transaction
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
  services/clickCounter.js  click buffer in Redis, batched writes to the database
  services/safeBrowsing.js  optional Google Safe Browsing lookup
  middleware/rateLimiter.js shared bucket in Redis, local bucket as fallback
  utils/base62.js
  utils/lruCache.js
  utils/tokenBucket.js      in-memory token bucket
  utils/redisTokenBucket.js the same algorithm as a Lua script
  utils/manageToken.js      management tokens and random codes
  utils/urlPolicy.js        which target urls are allowed
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

**Codes nobody can guess.** Counter codes are easy to walk through: if
`1a2B` exists, so does `1a2C`. For a link that shouldn't be found that way,
send `"opaque": true` and the code is 10 random base62 characters from
`crypto.randomBytes` (about 59 bits) instead. Bytes of 248 and up are thrown
away, so every character is equally likely. A collision is retried, but with
62^10 codes it's not something that happens in practice. The counter stays
the default: it gives the shortest codes and never collides.

## How clicks are counted

`src/services/clickCounter.js`

The caches only save the *read* on a redirect. Before this, every redirect
still ran `UPDATE links SET clicks = clicks + 1`, so the database took one
write per click no matter how good the hit rate was.

With Redis configured, a redirect now does `HINCRBY linklite:clicks:pending
<code> 1` and returns. Every second (`CLICK_FLUSH_MS`) each instance tries to
flush:

1. `RENAME` the pending hash to `linklite:clicks:batch:<time>-<uuid>`. The
   rename is atomic, so new clicks start a fresh hash and the batch can't
   change anymore. If two instances flush at the same moment, only one
   rename finds the key.
2. `HGETALL` the batch and add it to `links.clicks` in one transaction
   (`UPDATE ... FROM unnest(codes, counts)`). The same transaction inserts
   the batch id into a `click_batches` table.
3. `DEL` the batch.

What happens when something dies:

| failure | result |
|---|---|
| app crashes before step 1 | clicks are still in Redis, the next flush on any instance takes them |
| app crashes between 1 and 3 | the batch key stays in Redis. Every instance looks for batch keys older than 30s and applies them. If the crash was after `COMMIT`, the batch id is already in `click_batches`, so it isn't counted twice |
| database down during a flush | the batch stays in Redis and is retried by the same scan |
| Redis down on a redirect | that click is written straight to the database |
| Redis itself crashes | clicks since the last AOF fsync are lost, about 1 second (`appendonly yes`, `appendfsync everysec` in `docker-compose.yml`) |

So the counts are exact except for that last case. The pending hash has no
ttl, so `volatile-lru` never evicts it. `GET /api/stats/:code` adds the
pending count from Redis to the database value, so the stats page isn't a
second behind. Without Redis (the live demo), each click is still a direct
`UPDATE`, which in SQLite is an in-process call, not a network round trip.

## Who can change a link

`src/utils/manageToken.js`, `src/routes/api.js`

There are no accounts, but knowing a short code is no longer enough to
change or delete a link. `POST /api/shorten` returns a `manageToken`
(24 random bytes, base64url). Only its SHA-256 is stored. `PATCH` and
`DELETE` need it:

```
Authorization: Bearer <manageToken>
```

- no token: `401` with `WWW-Authenticate: Bearer`
- wrong token, or a link created before tokens existed: `403`
- the comparison uses `crypto.timingSafeEqual` on the hashes
- the token is never in a redirect, the stats response or a log line

A plain SHA-256 is enough here (no bcrypt): the token is 192 random bits, not
a password a person picked, so there's nothing to brute force. The frontend
stores the token in `localStorage` next to the code, which is how the Edit
and Delete buttons work without a login.

## Which targets are allowed

`src/utils/urlPolicy.js`, `src/services/safeBrowsing.js`

LinkLite never fetches a target URL itself. It only sends a `Location`
header, so there's no server-side request to abuse (SSRF). If link previews
were ever added, that code would need its own check after DNS resolution.

It does refuse to hand out links that make no sense on a public shortener:

- `localhost`, `*.local`, `*.internal`, single-label hosts like `http://intranet/`
- private, loopback, link-local (including the cloud metadata address
  `169.254.169.254`), CGNAT and multicast IPs, in v4 and v6, including
  tricks like `http://0x7f.1/` and `http://[::ffff:127.0.0.1]/` (the URL
  parser normalises those before the check)
- a username or password in the URL (`https://paypal.com@evil.example`
  actually goes to `evil.example`)
- links to LinkLite itself, which would just make redirect chains

Only literal IPs are checked, not what a hostname resolves to. That's fine
because nothing fetches these URLs.

**Google Safe Browsing (optional).** I looked through
[public-apis](https://github.com/public-apis/public-apis) for something that
fits a shortener. Google Safe Browsing (Lookup API v4) was the best match:
free, covers phishing and malware, and the request only goes to Google, not
to the target. URLhaus only covers malware, VirusTotal shares submitted URLs
and allows 4 requests a minute, and the QR code APIs would send every short
link to a third party. With `SAFE_BROWSING_API_KEY` set, new and edited
targets are checked and flagged ones get a `400`. If Google is slow (2s
timeout) or down, the link is allowed and the error is counted in
`/metrics`, the same fail-open reasoning as the rate limiter. It only checks
at write time; checking on every redirect would put an external call on the
hot path.

> **Licensing.** Google's terms limit the Safe Browsing API to
> non-commercial use (not for sale or revenue-generating purposes). That
> fits this portfolio project, which is why the check exists and is off by
> default. It is **not** something to turn on in a commercial deployment as
> is. A commercial service would need to review Google's current terms
> itself, and Google points commercial users to its paid Web Risk API.

## API

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/api/shorten` | `{ "url", "alias"?, "expiresAt"?, "opaque"? }` | `201` link JSON with `manageToken` | `400` invalid input, `409` alias taken, `429` |
| GET | `/:code` | | `302` redirect, `X-Cache` header | `404` missing, `410` expired, `429` |
| PATCH | `/api/links/:code` | `{ "url"?, "expiresAt"? }` + `Authorization: Bearer` | `200` link JSON | `400`, `401`, `403`, `404`, `429` |
| DELETE | `/api/links/:code` | `Authorization: Bearer` | `204` | `401`, `403`, `404`, `429` |
| GET | `/api/stats/:code` | | `200` `{ code, url, shortUrl, clicks, custom, createdAt, expiresAt, expired }` | `404` |
| GET | `/api/cache-stats` | | `200` `{ capacity, size, hits, misses, hitRate, l1, l2 }` | |
| GET | `/healthz` | | `200` `{ status, db, redis }` | `503` database down or shutting down |
| GET | `/metrics` | | `200` request, rate limit and cache counters | |

Rules:

- `url` must be `http` or `https`, max 2048 characters, and pass the target
  policy above.
- `alias` is 3-30 characters from `A-Z a-z 0-9 - _`. `api`, `index`, `stats`,
  `healthz` and `metrics` are reserved.
- `opaque: true` gives a random 10 character code. It can't be combined with `alias`.
- `expiresAt` is any date string `Date.parse` understands, and it must be in
  the future. It's stored as UTC ISO. In `PATCH`, `null` removes the expiry.
- Creating a link needs no auth, same as any public shortener. Changing or
  deleting one needs its `manageToken`.

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
| `CLICK_FLUSH_MS` | `1000` | how often buffered clicks go from Redis to the database |
| `SAFE_BROWSING_API_KEY` | | turns on the Google Safe Browsing check |
| `INSTANCE_ID` | | shown in `X-Instance` and `/metrics` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | |

## Running tests

```bash
npm test
```

```
Test Suites: 10 passed, 10 total
Tests:       148 passed, 148 total
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
- `tests/clickCounter.test.js`: batching, two instances flushing at once, Redis down,
  database down, a batch applied twice after a crash (counted once), stale batch recovery
- `tests/safeBrowsing.test.js`: request shape, matches, failing open on errors and timeouts
  (link creation still works), the key never logged
- `tests/api.test.js`: every endpoint against an in-memory SQLite database, including
  404, 410, 409, 400 cases, cache HIT/MISS, the 429, tokens (401/403, hash only),
  opaque codes, blocked targets, and two app instances sharing a fake Redis

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
Tests:       26 passed, 26 total
```

- `postgres.test.js`: migrations (including two runners at once), indexes,
  200 concurrent creates from two repository instances with no duplicate code,
  a click batch applied twice being counted once
- `cache.test.js`: two app instances; L2 hit on the other instance, Redis ttl
  vs link expiry, an update on one instance clearing the other's L1, Redis
  unreachable, clicks on both instances flushed to Postgres exactly once
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

Measured on 2026-10-30 on my laptop: Intel Core Ultra 7 255H (16 threads),
23 GB RAM, Windows 11, Docker Desktop (16 CPUs, ~11 GB for Docker). The load
generator ran on the same machine, through nginx, against both app
instances, with the Compose setup and the load test override above. Skew
was the default 3. These are laptop numbers, a cloud VM will be different.

**After batching clicks through Redis:**

| connections | links | duration | req/s | p50 | p95 | p99 | cache hit (L1 + L2) | L1 hit | errors / non-3xx |
|---|---|---|---|---|---|---|---|---|---|
| 50 | 500 | 30s | 2,911 | 14.9 ms | 37.3 ms | 62.0 ms | 100% | 98.8% | 0 |
| 100 | 500 | 30s | 3,842 | 23.8 ms | 49.7 ms | 66.9 ms | 100% | 99.1% | 0 |
| 50 | 2,000 | 60s | 3,513 | 13.0 ms | 28.5 ms | 42.8 ms | 100% | 72.0% | 0 |
| 100 | 2,000 | 60s | 3,885 | 23.5 ms | 49.6 ms | 70.7 ms | 100% | 72.0% | 0 |

**Before, with one `UPDATE` per click** (same machine, run right before the change):

| connections | links | duration | req/s | p50 | p95 | p99 | cache hit (L1 + L2) | L1 hit | errors / non-3xx |
|---|---|---|---|---|---|---|---|---|---|
| 50 | 500 | 30s | 2,540 | 18.6 ms | 34.3 ms | 48.3 ms | 100% | 98.7% | 0 |
| 100 | 2,000 | 60s | 2,216 | 40.9 ms | 91.1 ms | 131.4 ms | 100% | 71.5% | 0 |

What I read from this:

- At 100 connections and 2,000 links throughput went from 2,216 to 3,885
  req/s (+75%), and p99 from 131 ms to 71 ms. Before, adding connections
  made things *slower* (2,540 to 2,216 req/s), because every redirect waited
  on a Postgres write. Now it scales up instead.
- At 50 connections and 500 links the gain is smaller (+15%), and p95/p99
  are a bit higher than before. With few connections Postgres wasn't the
  bottleneck yet, and both runs are on a laptop that is also running the
  load generator, so I wouldn't read much into a 14 ms p99 difference.
- No request in any run read the database: every redirect was an L1 or L2
  hit. With 2,000 links, 28% of lookups missed L1 (60s ttl, two instances
  each warming their own copy) and were served from Redis.
- Clicks are not lost by batching: after the four runs Postgres had 646,671
  clicks, autocannon counted 646,371 responses. The 300 difference is
  exactly 50+100+50+100, the requests still in flight on each connection
  when each run stopped, which the app served and counted but autocannon
  didn't tally. The Redis pending hash was empty.

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
- Downside: codes are guessable and show how many links exist. For links
  where that matters there's `opaque: true` (random codes, see above). I kept
  the counter as the default instead of replacing it, because it still gives
  the shortest codes with no collisions.

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

- Clicks are batched through Redis, but a Redis crash can still lose about a
  second of them (see the table above). For analytics that must be exact,
  click events would go to a durable queue (Kafka/SQS) instead.
- The rate limiter keys on IP. Users behind one NAT share a bucket, and the
  limit is only as good as the `X-Forwarded-For` handling (nginx overwrites
  it, and the app trusts exactly one proxy hop).
- `/metrics` is per instance and in-memory, so it resets on restart. A real
  setup would use Prometheus format and scrape every instance.
- Postgres is a single primary. Read replicas would help the stats page,
  but redirects mostly never reach the database anyway.
- Link ownership is a per-link token, not accounts. Lose the token (clear the
  browser storage) and the link can't be edited anymore.
- Safe Browsing is checked when a link is created or edited, not on each
  redirect, so a site that turns bad later isn't caught.
- "My links" in the UI is a list of codes and tokens in `localStorage`.

**What I'd do next**

1. Prometheus metrics and a Grafana dashboard instead of the JSON endpoint.
2. Send click events to a queue (Kafka/SQS) for analytics.
3. Accounts, so links and tokens aren't tied to one browser.
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
