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

## Rate limit

With `SHORTEN_LIMIT_CAPACITY=5`, sending a few POSTs quickly:

```
HTTP/1.1 201 Created            X-RateLimit-Remaining: 2
HTTP/1.1 201 Created            X-RateLimit-Remaining: 1
HTTP/1.1 201 Created            X-RateLimit-Remaining: 0
HTTP/1.1 429 Too Many Requests  Retry-After: 3
{"error":"Too many requests","retryAfter":3}
```
