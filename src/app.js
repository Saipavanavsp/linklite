const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const LRUCache = require('./utils/lruCache');
const { createLinkService } = require('./services/linkService');
const rateLimiter = require('./middleware/rateLimiter');
const apiRouter = require('./routes/api');
const redirectRouter = require('./routes/redirect');

function createApp(options = {}) {
  const {
    dbPath = ':memory:',
    baseUrl = 'http://localhost:3000',
    cacheSize = 1000,
    rateLimit = { capacity: 60, refillPerSec: 1 },
    shortenLimit = { capacity: 10, refillPerSec: 0.2 },
    trustProxy = false,
    logRequests = false,
  } = options;

  const db = openDb(dbPath);
  const cache = new LRUCache(cacheSize);
  const links = createLinkService(db, cache);

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  if (logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const cacheInfo = res.get('X-Cache') ? ` cache=${res.get('X-Cache')}` : '';
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms${cacheInfo}`);
      });
      next();
    });
  }

  app.use(rateLimiter(rateLimit));
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', apiRouter({ links, cache, baseUrl, shortenLimit }));
  app.use(redirectRouter({ links }));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // express only treats this as an error handler because it takes 4 arguments
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = createApp;
