const express = require('express');
const rateLimiter = require('../middleware/rateLimiter');
const { isExpired } = require('../services/linkService');

const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;
const RESERVED = new Set(['api', 'index', 'stats']);
const MAX_URL_LENGTH = 2048;

function checkUrl(value) {
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
  return null;
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

function apiRouter({ links, cache, baseUrl, shortenLimit, limiterOptions = {} }) {
  const router = express.Router();
  const shortUrl = (code) => `${baseUrl}/${code}`;
  // one bucket per IP shared by every write: create, update and delete
  const writeLimit = rateLimiter({ ...shortenLimit, ...limiterOptions, name: 'shorten' });

  router.post('/shorten', writeLimit, async (req, res) => {
    const { url, alias, expiresAt } = req.body || {};
    const hasAlias = alias !== undefined && alias !== null && alias !== '';
    const hasExpiry = expiresAt !== undefined && expiresAt !== null && expiresAt !== '';

    const error =
      checkUrl(url) || (hasAlias && checkAlias(alias)) || (hasExpiry && checkExpiry(expiresAt));
    if (error) return res.status(400).json({ error });

    const link = await links.create({
      url: url.trim(),
      alias: hasAlias ? alias : null,
      expiresAt: hasExpiry ? new Date(expiresAt).toISOString() : null,
    });

    res.status(201).json({ ...link, shortUrl: shortUrl(link.code) });
  });

  router.get('/stats/:code', async (req, res) => {
    const link = await links.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    res.json({ ...link, shortUrl: shortUrl(link.code), expired: isExpired(link.expiresAt) });
  });

  // Change the target url and/or the expiry. expiresAt: null removes the expiry.
  router.patch('/links/:code', writeLimit, async (req, res) => {
    const { url, expiresAt } = req.body || {};
    const changes = {};

    if (url !== undefined) {
      const error = checkUrl(url);
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

  router.delete('/links/:code', writeLimit, async (req, res) => {
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
