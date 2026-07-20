'use strict';

/**
 * queue.js
 *
 * Creates and exports the BullMQ Queue and Worker.
 * Also exports a Redis connection helper for health checks.
 *
 * Job state machine:
 *   waiting → active → completed | failed
 * Status vocabulary (stored in job.data._status):
 *   waiting | downloading | rendering | completed | failed
 *
 * Stalled job detection:
 *   If the worker process is killed mid-job, BullMQ's stalledInterval
 *   detects that the active job heartbeat stopped and automatically
 *   moves it back to waiting (if attempts remain) or failed.
 *   This satisfies the "kill worker mid-render" requirement.
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');
const logger = require('./logger');
const { processRenderJob } = require('./renderJob');

const QUEUE_NAME = 'render';

// ─── Redis connection ─────────────────────────────────────────────────────────

function createRedisConnection() {
  const conn = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  });

  conn.on('connect', () => logger.info('Redis connected'));
  conn.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));

  return conn;
}

let _redisConnection = null;

function getRedisConnection() {
  if (!_redisConnection) _redisConnection = createRedisConnection();
  return _redisConnection;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

let _queue = null;

function getQueue() {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: config.jobAttempts,
        backoff: {
          type: 'exponential',
          delay: config.jobBackoffDelayMs,
        },
        removeOnComplete: { count: 500, age: 86400 }, // keep last 500 / 24h
        removeOnFail: { count: 200, age: 86400 * 7 }, // keep failures for 7 days
      },
    });
  }
  return _queue;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

let _worker = null;

function startWorker() {
  if (_worker) return _worker;

  _worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info({ jobId: job.id }, 'Worker picked up job');
      return processRenderJob(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: config.workerConcurrency,
      stalledInterval: config.bullStalledIntervalMs,
      lockDuration: config.jobTimeoutSeconds * 1000 + 30_000, // slightly longer than job timeout
      lockRenewTime: Math.floor(config.jobTimeoutSeconds * 1000 / 2),
    }
  );

  _worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'Job completed');
  });

  _worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
  });

  _worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, 'Job stalled — will be retried or failed by BullMQ');
  });

  _worker.on('error', (err) => {
    logger.error({ err: err.message }, 'Worker error');
  });

  logger.info(
    { concurrency: config.workerConcurrency, queue: QUEUE_NAME },
    'BullMQ worker started'
  );

  return _worker;
}

// ─── Job status helper ────────────────────────────────────────────────────────

/**
 * Maps a BullMQ job to the status object returned by GET /jobs/:id.
 *
 * @param {import('bullmq').Job | null} job
 * @returns {object | null}
 */
async function getJobStatus(job) {
  if (!job) return null;

  const state = await job.getState(); // 'waiting' | 'active' | 'completed' | 'failed' | etc.
  const data = job.data ?? {};

  // Overlay our finer-grained status from job.data._status
  let status = data._status ?? state;

  // Normalise BullMQ states to our vocabulary
  if (state === 'active' && !data._status) status = 'rendering';
  if (state === 'waiting' || state === 'delayed') status = 'waiting';

  return {
    job_id: job.id,
    status,
    progress_pct: typeof job.progress === 'number' ? job.progress : 0,
    output_url: data._outputUrl ?? null,
    error: data._error ?? (state === 'failed' ? (job.failedReason ?? 'Unknown error') : null),
    ffmpegStderr: data._ffmpegStderr ?? null,
    attempts_made: job.attemptsMade,
    created_at: new Date(job.timestamp).toISOString(),
  };
}

module.exports = {
  getQueue,
  startWorker,
  getRedisConnection,
  getJobStatus,
  QUEUE_NAME,
};
