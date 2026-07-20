'use strict';

/**
 * config.js — All configuration derived from environment variables.
 * Import this module; never read process.env directly in other modules.
 */

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function intEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return n;
}

function strEnv(name, defaultValue) {
  return process.env[name] ?? defaultValue;
}

const config = {
  // Server
  port: intEnv('PORT', 3001),
  nodeEnv: strEnv('NODE_ENV', 'development'),
  logLevel: strEnv('LOG_LEVEL', 'info'),

  // Authentication
  workerApiKey: requireEnv('WORKER_API_KEY'),

  // Redis / BullMQ
  redisUrl: strEnv('REDIS_URL', 'redis://localhost:6379'),
  workerConcurrency: intEnv('WORKER_CONCURRENCY', 2),
  jobAttempts: intEnv('JOB_ATTEMPTS', 3),
  jobBackoffDelayMs: intEnv('JOB_BACKOFF_DELAY_MS', 5000),
  bullStalledIntervalMs: intEnv('BULL_STALLED_INTERVAL_MS', 30_000),

  // Resource limits
  jobTimeoutSeconds: intEnv('JOB_TIMEOUT_SECONDS', 600),
  maxClips: intEnv('MAX_CLIPS', 20),
  maxDurationSeconds: intEnv('MAX_DURATION_SECONDS', 600),
  maxDownloadBytes: intEnv('MAX_DOWNLOAD_BYTES', 2 * 1024 * 1024 * 1024), // 2 GB

  // I/O
  downloadTimeoutSeconds: intEnv('DOWNLOAD_TIMEOUT_SECONDS', 60),
  tempDir: strEnv('TEMP_DIR', '/tmp/render-tmp'),
  outputDir: strEnv('OUTPUT_DIR', '/tmp/renders'),

  // SSRF allowlist — comma-separated hostnames
  urlAllowlist: strEnv('URL_ALLOWLIST', '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

module.exports = config;
