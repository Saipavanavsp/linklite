const { encode, decode } = require('../src/utils/base62');

describe('base62', () => {
  test('encodes small numbers', () => {
    expect(encode(0)).toBe('0');
    expect(encode(9)).toBe('9');
    expect(encode(10)).toBe('a');
    expect(encode(35)).toBe('z');
    expect(encode(36)).toBe('A');
    expect(encode(61)).toBe('Z');
    expect(encode(62)).toBe('10');
  });

  test('62^3 is the first 4 character code', () => {
    expect(encode(62 ** 3 - 1)).toBe('ZZZ');
    expect(encode(62 ** 3)).toBe('1000');
  });

  test('decode is the inverse of encode', () => {
    const samples = [0, 1, 61, 62, 3843, 238328, 999999, 123456789, Number.MAX_SAFE_INTEGER];
    for (const n of samples) {
      expect(decode(encode(n))).toBe(n);
    }
  });

  test('consecutive numbers give different codes', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(encode(i));
    expect(seen.size).toBe(5000);
  });

  test('rejects bad input', () => {
    expect(() => encode(-1)).toThrow(RangeError);
    expect(() => encode(1.5)).toThrow(RangeError);
    expect(() => decode('')).toThrow(TypeError);
    expect(() => decode('ab-c')).toThrow(/invalid base62 character/);
    expect(() => decode('zzzzzzzzzzzz')).toThrow(RangeError);
  });
});
