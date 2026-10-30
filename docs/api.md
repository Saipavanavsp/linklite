# API examples

These are real responses from a local run (some headers removed to keep it short).

## Shorten a URL

```bash
curl -i -X POST http://localhost:3000/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/expressjs/express"}'
```

```
HTTP/1.1 201 Created
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4

{"code":"1000","url":"https://github.com/expressjs/express","clicks":0,"custom":false,
 "createdAt":"2026-10-15T14:51:32.551Z","expiresAt":null,"shortUrl":"http://localhost:3000/1000"}
```

With a custom alias and an expiry:

```bash
curl -X POST http://localhost:3000/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/short-lived","alias":"soon-gone","expiresAt":"2026-10-15T14:51:36.470Z"}'
```

```
{"code":"soon-gone","url":"https://example.com/short-lived","clicks":0,"custom":true,
 "createdAt":"2026-10-15T14:51:32.616Z","expiresAt":"2026-10-15T14:51:36.470Z",
 "shortUrl":"http://localhost:3000/soon-gone"}
```

Errors:

```
HTTP/1.1 400 Bad Request
{"error":"only http and https urls are allowed"}

HTTP/1.1 409 Conflict
{"error":"Alias \"base62-wiki\" is already taken"}
```

Every create response also has a `manageToken` (32 characters, base64url). It's
the only time the token is shown; keep it to edit or delete the link later.
The real tokens are replaced with `<manageToken>` in these examples. This one is from the
Docker Compose setup:

```bash
curl -X POST http://localhost:8080/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://nodejs.org/en/docs","alias":"node-docs"}'
```

```
HTTP/1.1 201 Created
{"code":"node-docs","url":"https://nodejs.org/en/docs","clicks":0,"custom":true,
 "createdAt":"2026-10-30T12:26:12.994Z","expiresAt":null,
 "shortUrl":"http://localhost:8080/node-docs","manageToken":"<manageToken>"}
```

A random code instead of the next counter value:

```bash
curl -X POST http://localhost:8080/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/private-doc","opaque":true}'
```

```
HTTP/1.1 201 Created
{"code":"vHmfPSLzNE","url":"https://example.com/private-doc","clicks":0,"custom":false,
 "createdAt":"2026-10-30T12:26:13.011Z","expiresAt":null,
 "shortUrl":"http://localhost:8080/vHmfPSLzNE","manageToken":"<manageToken>"}
```

Targets that are refused:

```
POST {"url":"http://169.254.169.254/latest/meta-data/"}
HTTP/1.1 400 Bad Request
{"error":"urls pointing to localhost or private networks are not allowed"}

POST {"url":"https://paypal.com@evil.example/"}
HTTP/1.1 400 Bad Request
{"error":"urls with a username or password are not allowed"}
```

With `SAFE_BROWSING_API_KEY` set, a target Google has flagged gets
`400 {"error":"url is flagged by Google Safe Browsing (SOCIAL_ENGINEERING)"}`.

## Redirect

```bash
curl -i http://localhost:3000/1000
```

```
HTTP/1.1 302 Found
X-Cache: MISS
Location: https://github.com/expressjs/express
```

Calling it again gives `X-Cache: HIT`.

```
GET /nope123    -> 404 {"error":"Link not found"}
GET /soon-gone  -> 410 {"error":"Link has expired"}
```

## Stats

```bash
curl http://localhost:3000/api/stats/1000
```

```
{"code":"1000","url":"https://github.com/expressjs/express","clicks":1,"custom":false,
 "createdAt":"2026-10-15T14:51:32.551Z","expiresAt":null,
 "shortUrl":"http://localhost:3000/1000","expired":false}
```

## Cache stats

```bash
curl http://localhost:3000/api/cache-stats
```

```
{"capacity":1000,"size":4,"hits":4,"misses":5,"hitRate":0.444}
```

When Redis is configured the response also has per-level numbers. The
top-level fields stay the L1 numbers so older clients keep working. This one
is from the Docker Compose setup right after a load test:

```
{"capacity":1000,"size":400,"hits":44663,"misses":403,"hitRate":0.991,
 "l1":{"capacity":1000,"size":400,"hits":44663,"misses":403,"hitRate":0.991},
 "l2":{"enabled":true,"hits":402,"misses":1,"errors":0,"hitRate":0.998}}
```

Without Redis, `l2` is `{"enabled":false}`.

## Redirects behind the load balancer

With Docker Compose, two redirects in a row land on different instances. The
link was created on one of them, which also wrote it to Redis, so neither
has to read Postgres:

```
HTTP/1.1 302 Found
X-Instance: app2
X-Cache: HIT
X-Cache-Level: L2
Location: https://nodejs.org/en/docs

HTTP/1.1 302 Found
X-Instance: app1
X-Cache: HIT
X-Cache-Level: L2
```

`X-Cache-Level` is only set on hits. `X-Instance` is only set when
`INSTANCE_ID` is configured.

## Update a link

Needs the `manageToken` from the create response.

```bash
curl -X PATCH http://localhost:8080/api/links/node-docs \
  -H "Authorization: Bearer <manageToken>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://nodejs.org/api/","expiresAt":"2027-01-01T00:00:00Z"}'
```

```
{"code":"node-docs","url":"https://nodejs.org/api/","clicks":0,"custom":true,
 "createdAt":"2026-10-30T12:26:12.994Z","expiresAt":"2027-01-01T00:00:00.000Z",
 "shortUrl":"http://localhost:8080/node-docs","expired":false}
```

Both fields are optional, but at least one is required. `"expiresAt": null`
removes the expiry. The cached copies are removed from Redis and from every
instance's L1.

Without the token, or with the wrong one:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
{"error":"management token required (Authorization: Bearer <token>)"}

HTTP/1.1 403 Forbidden
{"error":"management token does not match this link"}
```

## Delete a link

```bash
curl -i -X DELETE http://localhost:8080/api/links/node-docs \
  -H "Authorization: Bearer <manageToken>"
```

```
HTTP/1.1 204 No Content
```

Same `401`/`403` rules as `PATCH`.

```
GET /node-docs -> 404 {"error":"Link not found"}
```

`PATCH` and `DELETE` share the shorten limiter's bucket with `POST /api/shorten`.

## Health check

```bash
curl http://localhost:8080/healthz
```

```
{"status":"ok","db":"up","redis":"up"}
```

| status | HTTP | when |
|---|---|---|
| `ok` | 200 | database up, Redis up or not configured (`"redis":"disabled"`) |
| `degraded` | 200 | Redis down, still serving from L1 + database |
| `down` | 503 | database unreachable |
| `shutting_down` | 503 | SIGTERM received, draining |

## Metrics

```bash
curl http://localhost:8080/metrics
```

```
{"instance":"app1","uptimeSec":117,
 "requests":{"total":45256,"byStatus":{"2xx":202,"3xx":45054,"4xx":0,"5xx":0}},
 "rateLimited":{"total":0},
 "cache":{ ...same as /api/cache-stats... },
 "storage":{"driver":"postgres"},
 "redis":{"enabled":true,"status":"ready"}}
```

It also has `clicks` and `safeBrowsing` sections. This is app1 after the
load tests in the README:

```
"clicks":{"mode":"redis-buffered","buffered":323340,"direct":0,"flushedBatches":180,
          "flushedClicks":80094,"errors":0},
"safeBrowsing":{"enabled":false}
```

`buffered` is clicks this instance put into Redis; `flushedClicks` is what
this instance moved to Postgres. They differ because whichever instance
renames the pending hash first flushes everyone's clicks. `direct` counts
clicks written straight to the database (no Redis, or Redis unreachable).

Each instance reports only its own numbers. `rateLimited` has one counter
per limiter (`general`, `shorten`) once something has been rejected. In the
Docker Compose setup nginx only allows `/metrics` from private addresses.

## Rate limit

With `SHORTEN_LIMIT_CAPACITY=5`, sending a few POSTs quickly:

```
HTTP/1.1 201 Created            X-RateLimit-Remaining: 2
HTTP/1.1 201 Created            X-RateLimit-Remaining: 1
HTTP/1.1 201 Created            X-RateLimit-Remaining: 0
HTTP/1.1 429 Too Many Requests  Retry-After: 3
{"error":"Too many requests","retryAfter":3}
```
