const crypto = require('crypto');

// Every link gets a random management token when it's created. It's returned
// once, in the create response, and only its SHA-256 is stored. PATCH and
// DELETE need the token, so knowing a short code is no longer enough to
// change or remove someone else's link.
//
// A plain hash is enough (no bcrypt/scrypt): the token is 192 random bits,
// not a password someone picked, so there's nothing to brute force.
function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || !token || !storedHash) return false;
  const given = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
}

// Unguessable short codes for links that shouldn't be found by counting
// through the base62 sequence. 10 characters from 62 is about 59 bits.
// Bytes >= 248 are thrown away so every character is equally likely
// (248 = 4 * 62, plain modulo would favour the first 8 characters).
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function randomCode(length = 10) {
  let code = '';
  while (code.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < 248 && code.length < length) code += ALPHABET[byte % 62];
    }
  }
  return code;
}

module.exports = { generateToken, hashToken, tokenMatches, randomCode };
