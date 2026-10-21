// Load test for the redirect path, run against the docker compose setup.
//
//   docker compose -f docker-compose.yml -f docker-compose.loadtest.yml up -d --build
//   npm run loadtest
//   npm run loadtest -- --duration 60 --connections 100 --links 1000
//
// It creates a set of links, then sends GET /:code for `duration` seconds with
// a skewed distribution (a few links get most of the traffic, like real
// shortener traffic). It prints requests/sec, latency percentiles and the
// cache hit rates, which it works out from /metrics on every instance before
// and after the run.
const fs = require('fs');
const path = require('path');
const autocannon = require('autocannon');

function parseArgs(argv) {
  const opts = { url: 'http://localhost:8080', duration: 30, connections: 50, links: 500, skew: 3, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts)) throw new Error(`unknown option --${key}`);
    opts[key] = typeof opts[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return opts;
}

async function createLinks(base, count) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${base}/api/shorten`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://example.com/loadtest/${Date.now()}/${i}` }),
    });
    if (res.status === 429) {
      throw new Error('got 429 while creating links. Start compose with docker-compose.loadtest.yml (see top of this file).');
    }
    if (!res.ok) throw new Error(`POST /api/shorten returned ${res.status}`);
    codes.push((await res.json()).code);
  }
  return codes;
}

// nginx round-robins, so keep asking until every instance has answered
async function metricsPerInstance(base, tries = 20) {
  const seen = new Map();
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base}/metrics`);
    if (!res.ok) throw new Error(`GET /metrics returned ${res.status}`);
    const m = await res.json();
    seen.set(m.instance || `instance-${seen.size}`, m);
    if (i >= 3 && seen.size >= 2) break;
  }
  return seen;
}

function sumCache(perInstance) {
  const total = { l1Hits: 0, l1Misses: 0, l2Hits: 0, l2Misses: 0, rateLimited: 0 };
  for (const m of perInstance.values()) {
    total.l1Hits += m.cache.l1.hits;
    total.l1Misses += m.cache.l1.misses;
    total.l2Hits += m.cache.l2.hits || 0;
    total.l2Misses += m.cache.l2.misses || 0;
    total.rateLimited += m.rateLimited.total;
  }
  return total;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

const ratio = (a, b) => (b === 0 ? 0 : a / b);
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = opts.url.replace(/\/$/, '');

  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!health || !health.ok) throw new Error(`${base}/healthz is not answering. Is docker compose up?`);

  console.log(`creating ${opts.links} links...`);
  const codes = await createLinks(base, opts.links);

  const before = sumCache(await metricsPerInstance(base));

  // random()^skew pushes most picks towards the start of the list:
  // with skew 3, the first 10% of links get about 46% of the requests
  const pick = () => codes[Math.floor(codes.length * Math.random() ** opts.skew)];

  const latencies = [];
  const statuses = {};

  console.log(`running GET /:code for ${opts.duration}s with ${opts.connections} connections...`);
  const instance = autocannon({
    url: base,
    connections: opts.connections,
    duration: opts.duration,
    requests: [
      {
        method: 'GET',
        setupRequest: (req) => ({ ...req, path: `/${pick()}` }),
      },
    ],
  });
  instance.on('response', (client, statusCode, bytes, responseTime) => {
    latencies.push(responseTime);
    statuses[statusCode] = (statuses[statusCode] || 0) + 1;
  });
  autocannon.track(instance, { renderProgressBar: true, renderResultsTable: false });
  const result = await instance;

  const after = sumCache(await metricsPerInstance(base));
  latencies.sort((a, b) => a - b);

  const l1Hits = after.l1Hits - before.l1Hits;
  const l1Lookups = l1Hits + (after.l1Misses - before.l1Misses);
  const l2Hits = after.l2Hits - before.l2Hits;
  const l2Lookups = l2Hits + (after.l2Misses - before.l2Misses);

  const summary = {
    target: base,
    date: new Date().toISOString(),
    settings: { duration: opts.duration, connections: opts.connections, links: opts.links, skew: opts.skew },
    requests: {
      total: result.requests.total,
      perSecAvg: Math.round(result.requests.average),
      statuses,
      errors: result.errors,
      timeouts: result.timeouts,
    },
    latencyMs: {
      p50: round1(percentile(latencies, 50)),
      p95: round1(percentile(latencies, 95)),
      p99: round1(percentile(latencies, 99)),
      max: round1(latencies[latencies.length - 1] || 0),
    },
    cache: {
      // a request is a cache hit if either level had it
      overallHitRate: Number(ratio(l1Hits + l2Hits, l1Lookups).toFixed(3)),
      l1HitRate: Number(ratio(l1Hits, l1Lookups).toFixed(3)),
      l2HitRate: Number(ratio(l2Hits, l2Lookups).toFixed(3)),
      dbReads: l1Lookups - l1Hits - l2Hits,
    },
    rateLimited: after.rateLimited - before.rateLimited,
  };

  console.log(`
requests/sec (avg)   ${summary.requests.perSecAvg}
total requests       ${summary.requests.total}  (errors ${summary.requests.errors}, timeouts ${summary.requests.timeouts})
status codes         ${JSON.stringify(statuses)}
latency p50 / p95    ${summary.latencyMs.p50} ms / ${summary.latencyMs.p95} ms
latency p99 / max    ${summary.latencyMs.p99} ms / ${summary.latencyMs.max} ms
cache hit rate       ${pct(summary.cache.overallHitRate)}  (L1 ${pct(summary.cache.l1HitRate)}, L2 ${pct(summary.cache.l2HitRate)} of L1 misses)
database reads       ${summary.cache.dbReads}
rate limited (429)   ${summary.rateLimited}
`);

  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(summary, null, 2));
    console.log(`saved to ${opts.out}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
