'use strict';

/**
 * tests/globalSetup.js
 * Jest global setup — runs once before all test suites.
 * Sets required environment variables for all tests.
 */

module.exports = async function globalSetup() {
  // Set env vars before any module is imported
  process.env.WORKER_API_KEY = 'test-api-key-12345';
  process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'warn'; // suppress logs during tests
  process.env.WORKER_CONCURRENCY = '2';
  process.env.JOB_TIMEOUT_SECONDS = '120';
  process.env.MAX_CLIPS = '60'; // allow 50-clip stress test
  process.env.MAX_DURATION_SECONDS = '600';
  process.env.MAX_DOWNLOAD_BYTES = String(2 * 1024 * 1024 * 1024);
  process.env.DOWNLOAD_TIMEOUT_SECONDS = '60';
  process.env.TEMP_DIR = require('os').tmpdir() + '/render-worker-test-tmp';
  process.env.OUTPUT_DIR = require('os').tmpdir() + '/render-worker-test-out';
  process.env.URL_ALLOWLIST = ''; // empty = disabled for tests using local file:// paths
  process.env.JOB_ATTEMPTS = '1'; // no retries in tests — fail fast
  process.env.JOB_BACKOFF_DELAY_MS = '0';
};
