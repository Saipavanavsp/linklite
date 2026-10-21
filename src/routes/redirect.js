const express = require('express');
const { isExpired } = require('../services/linkService');

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,30}$/;

function redirectRouter({ links }) {
  const router = express.Router();

  router.get('/:code', async (req, res) => {
    const { code } = req.params;
    if (!CODE_PATTERN.test(code)) {
      return res.status(404).json({ error: 'Link not found' });
    }

    const { target, cacheHit, level } = await links.resolve(code);
    res.set('X-Cache', cacheHit ? 'HIT' : 'MISS');
    if (level) res.set('X-Cache-Level', level);

    if (!target) return res.status(404).json({ error: 'Link not found' });
    if (isExpired(target.expiresAt)) return res.status(410).json({ error: 'Link has expired' });

    await links.recordClick(code);
    res.redirect(302, target.url);
  });

  return router;
}

module.exports = redirectRouter;
