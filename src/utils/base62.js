const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = ALPHABET.length;

const charIndex = {};
for (let i = 0; i < BASE; i++) {
  charIndex[ALPHABET[i]] = i;
}

function encode(num) {
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new RangeError('encode expects a non-negative safe integer');
  }
  if (num === 0) return ALPHABET[0];

  let out = '';
  while (num > 0) {
    out = ALPHABET[num % BASE] + out;
    num = Math.floor(num / BASE);
  }
  return out;
}

function decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new TypeError('decode expects a non-empty string');
  }

  let num = 0;
  for (const ch of str) {
    const value = charIndex[ch];
    if (value === undefined) {
      throw new Error(`invalid base62 character "${ch}"`);
    }
    num = num * BASE + value;
  }

  if (!Number.isSafeInteger(num)) {
    throw new RangeError('decoded value is too large');
  }
  return num;
}

module.exports = { encode, decode };
