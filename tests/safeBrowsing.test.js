const { createSafeBrowsing } = require('../src/services/safeBrowsing');

const quiet = { log() {}, warn() {} };

function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return respond();
  };
  return { fetch, calls };
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('safe browsing', () => {
  test('is off without an api key and never calls out', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const sb = createSafeBrowsing({ fetch });
    expect(sb.enabled).toBe(false);
    expect(await sb.check('https://a.com')).toEqual({ safe: true });
    expect(calls).toHaveLength(0);
  });

  test('sends the url to the v4 lookup endpoint', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const sb = createSafeBrowsing({ apiKey: 'k3y', fetch, logger: quiet });

    expect(await sb.check('https://a.com/x')).toEqual({ safe: true });
    expect(calls[0].url).toBe('https://safebrowsing.googleapis.com/v4/threatMatches:find?key=k3y');
    expect(calls[0].body.threatInfo.threatEntries).toEqual([{ url: 'https://a.com/x' }]);
    expect(calls[0].body.threatInfo.threatTypes).toContain('SOCIAL_ENGINEERING');
  });

  test('reports the threat type of a match', async () => {
    const { fetch } = fakeFetch(() => json(200, { matches: [{ threatType: 'MALWARE', threat: { url: 'x' } }] }));
    const sb = createSafeBrowsing({ apiKey: 'k', fetch, logger: quiet });
    expect(await sb.check('https://bad.example')).toEqual({ safe: false, threat: 'MALWARE' });
    expect(sb.stats()).toMatchObject({ checked: 1, flagged: 1, errors: 0 });
  });

  test.each([
    ['an error status', () => json(429, {})],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('fails open on %s', async (_, respond) => {
    const warnings = [];
    const sb = createSafeBrowsing({
      apiKey: 'secret-key',
      fetch: fakeFetch(respond).fetch,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    expect(await sb.check('https://a.com')).toEqual({ safe: true });
    expect(sb.stats().errors).toBe(1);
    expect(warnings.join(' ')).not.toContain('secret-key');
  });
});
