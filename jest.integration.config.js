// npm run test:integration (needs TEST_DATABASE_URL and TEST_REDIS_URL)
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
  testTimeout: 15_000,
};
