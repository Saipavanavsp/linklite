const express = require('express');
const rateLimiter = require('../middleware/rateLimiter');
const { isExpired } = require('../services/linkService');
const { checkDestination } = require('../utils/urlPolicy');

const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;
const RESERVED = new Set(['api', 'index', 'stats', 'healthz', 'metrics']);
const MAX_URL_LENGTH = 2048;

function checkUrl(value, ownHost) {
  if (typeof value !== 'string' || value.trim() === '') return 'url is required';
  if (value.length > MAX_URL_LENGTH) return `url must be at most ${MAX_URL_LENGTH} characters`;

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return 'url is not valid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'only http and https urls are allowed';
  }
  return checkDestination(parsed, { ownHost });
}

function checkAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    return 'alias must be 3-30 characters: letters, numbers, - or _';
  }
  if (RESERVED.has(alias.toLowerCase())) return `alias "${alias}" is reserved`;
  return null;
}

function checkExpiry(expiresAt) {
  const time = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(time)) return 'expiresAt must be a valid date';
  if (time <= Date.now()) return 'expiresAt must be in the future';
  return null;
}

function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('Authorization') || '');
  return match ? match[1] : null;
}

function apiRouter({ links, cache, baseUrl, shortenLimit, limiterOptions = {}, safeBrowsing }) {
  const router = express.Router();
  const shortUrl = (code) => `${baseUrl}/${code}`;
  const ownHost = new URL(baseUrl).host;
  // one bucket per IP shared by every write: create, update and delete
  const writeLimit = rateLimiter({ ...shortenLimit, ...limiterOptions, name: 'shorten' });

  async function unsafeUrlError(url) {
    const result = await safeBrowsing.check(url);
    return result.safe ? null : `url is flagged by Google Safe Browsing (${result.threat})`;
  }

  // PATCH and DELETE need the token that came back when the link was created:
  //   Authorization: Bearer <manageToken>
  // 404 if the link doesn't exist (anyone can already see that from the
  // redirect), 401 without a token, 403 with the wrong one.
  async function requireToken(req, res, next) {
    const token = bearerToken(req);
    const result = await links.authorize(req.params.code, token);
    if (result === 'missing') return res.status(404).json({ error: 'Link not found' });
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'management token required (Authorization: Bearer <token>)' });
    }
    if (result !== 'ok') return res.status(403).json({ error: 'management token does not match this link' });
    next();
  }

  router.post('/shorten', writeLimit, async (req, res) => {
    const { url, alias, expiresAt, opaque } = req.body || {};
    const hasAlias = alias !== undefined && alias !== null && alias !== '';
    const hasExpiry = expiresAt !== undefined && expiresAt !== null && expiresAt !== '';

    const error =
      checkUrl(url, ownHost) ||
      (hasAlias && checkAlias(alias)) ||
      (hasExpiry && checkExpiry(expiresAt)) ||
      (opaque !== undefined && typeof opaque !== 'boolean' && 'opaque must be true or false') ||
      (opaque === true && hasAlias && 'use either alias or opaque, not both') ||
      (await unsafeUrlError(url.trim()));
    if (error) return res.status(400).json({ error });

    const { link, manageToken } = await links.create({
      url: url.trim(),
      alias: hasAlias ? alias : null,
      expiresAt: hasExpiry ? new Date(expiresAt).toISOString() : null,
      opaque: opaque === true,
    });

    res.status(201).json({ ...link, shortUrl: shortUrl(link.code), manageToken });
  });

  router.get('/stats/:code', async (req, res) => {
    const link = await links.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    res.json({ ...link, shortUrl: shortUrl(link.code), expired: isExpired(link.expiresAt) });
  });

  // Change the target url and/or the expiry. expiresAt: null removes the expiry.
  router.patch('/links/:code', writeLimit, requireToken, async (req, res) => {
    const { url, expiresAt } = req.body || {};
    const changes = {};

    if (url !== undefined) {
      const error = checkUrl(url, ownHost) || (await unsafeUrlError(url.trim()));
      if (error) return res.status(400).json({ error });
      changes.url = url.trim();
    }
    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === '') {
        changes.expiresAt = null;
      } else {
        const error = checkExpiry(expiresAt);
        if (error) return res.status(400).json({ error });
        changes.expiresAt = new Date(expiresAt).toISOString();
      }
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ error: 'nothing to update, send url and/or expiresAt' });
    }

    const link = await links.update(req.params.code, changes);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    res.json({ ...link, shortUrl: shortUrl(link.code), expired: isExpired(link.expiresAt) });
  });

  router.delete('/links/:code', writeLimit, requireToken, async (req, res) => {
    const deleted = await links.remove(req.params.code);
    if (!deleted) return res.status(404).json({ error: 'Link not found' });
    res.status(204).end();
  });

  router.get('/cache-stats', (req, res) => {
    res.json(cache.stats());
  });

  return router;
}

module.exports = apiRouter;
