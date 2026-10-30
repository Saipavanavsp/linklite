const throttledLog = require('../utils/throttledLog');

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];

// Optional check against Google Safe Browsing (Lookup API v4) before a link is
// created or its target changed. Only Google is contacted, the destination
// itself is never fetched. Off unless SAFE_BROWSING_API_KEY is set.
//
// Google's terms allow this API for non-commercial use only. Fine for this
// project; a commercial deployment would have to review the terms first
// (Google points commercial users to its Web Risk API).
//
// If Google is slow or down, the link is allowed (fail open), for the same
// reason as the rate limiter: an outage somewhere else shouldn't stop people
// from shortening links. The failure is counted and logged.
//
// It only checks at write time. A link that turns bad later isn't caught;
// re-checking on redirect would put an external call on the hot path.
function createSafeBrowsing({ apiKey, fetch = globalThis.fetch, timeoutMs = 2000, logger = console } = {}) {
  const stats = { checked: 0, flagged: 0, errors: 0 };
  const warn = throttledLog(logger.warn.bind(logger));

  if (!apiKey) {
    return { enabled: false, async check() { return { safe: true }; }, stats: () => ({ enabled: false }) };
  }

  async function check(url) {
    try {
      const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'linklite', clientVersion: '1.0.0' },
          threatInfo: {
            threatTypes: THREAT_TYPES,
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }],
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // the response never echoes the key, but the url we called has it, so
      // only the status goes into the log
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = await res.json();
      stats.checked++;
      if (Array.isArray(body.matches) && body.matches.length > 0) {
        stats.flagged++;
        return { safe: false, threat: body.matches[0].threatType };
      }
      return { safe: true };
    } catch (err) {
      stats.errors++;
      warn('safe-browsing', `[safe browsing] check failed, allowing the url: ${err.message}`);
      return { safe: true };
    }
  }

  return { enabled: true, check, stats: () => ({ enabled: true, ...stats }) };
}

module.exports = { createSafeBrowsing };
