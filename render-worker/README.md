# render-worker

Standalone video-rendering microservice. Accepts render jobs over HTTP, normalises every clip to a uniform resolution/fps before concatenation (fixing the v1 ~1-in-3 render failure rate), and processes jobs asynchronously via BullMQ + Redis.

---

## Quick start

### Prerequisites
- Node.js ≥ 20
- FFmpeg in `PATH`
- Redis (managed — see below)

### Setup

```bash
cd render-worker
npm install

# Copy and edit env
cp .env.example .env
# Set WORKER_API_KEY, REDIS_URL, URL_ALLOWLIST at minimum

# Generate test fixtures (requires FFmpeg)
bash scripts/generate_test_clips.sh

# Start local Redis (dev only)
docker-compose up redis -d

# Run the worker
npm run dev
```

### Run tests

```bash
# Unit tests (no Redis needed)
npm run test:unit

# Integration tests (requires Redis)
TEST_REDIS_URL=redis://localhost:6379 npm run test:integration

# All tests
npm test
```

---

## HTTP API

All `/jobs` routes require the `X-Api-Key: <WORKER_API_KEY>` header.

### `POST /jobs`

Enqueue a render job. **Idempotent** — submitting the same `job_id` twice returns the existing job without re-rendering.

**Request body:**
```jsonc
{
  "job_id": "uuid",                     // required — idempotency key
  "clips": [
    { "clip_url": "https://...", "start": 0, "end": 30 }
  ],
  "audio_url": "https://...",           // voiceover track
  "aspect_ratio": "16:9",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "transition": "crossfade",           // "crossfade" | "hard-cut"
  "transition_duration": 0.5,
  "format": "mp4",
  "output_upload_url": "https://..."   // pre-signed Supabase PUT URL
}
```

**Response:**
```json
{ "job_id": "uuid", "message": "Job accepted" }
```

### `GET /jobs/:id`

Query job status. The **Lovable backend** calls this endpoint and mirrors the result into `render_jobs` (Postgres). The worker holds no DB credentials.

**Response:**
```jsonc
{
  "job_id": "uuid",
  "status": "rendering",       // waiting | downloading | rendering | completed | failed
  "progress_pct": 42,
  "output_url": null,          // set on completion
  "error": null,               // set on failure — descriptive, not "exit code X"
  "ffmpegStderr": null,        // last 2000 chars of FFmpeg stderr, set on failure
  "attempts_made": 1,
  "created_at": "2025-01-01T00:00:00.000Z"
}
```

### `GET /health`

Liveness + Redis connectivity probe. Returns 503 if Redis is unreachable.

```jsonc
{ "status": "ok", "redis": "ok", "timestamp": "..." }
```

---

## Lovable Backend Integration

When `GET /api/public/render-job/:id` is called on the Lovable backend:

```typescript
// In your Lovable server function:
const workerRes = await fetch(
  `${process.env.RENDER_WORKER_URL}/jobs/${jobId}`,
  { headers: { 'X-Api-Key': process.env.RENDER_WORKER_API_KEY } }
);
const workerStatus = await workerRes.json();

// Mirror into render_jobs table
await supabase
  .from('render_jobs')
  .update({
    status: workerStatus.status,
    progress_pct: workerStatus.progress_pct,
    output_url: workerStatus.output_url,
    error: workerStatus.error,
    ffmpeg_stderr: workerStatus.ffmpegStderr,
    updated_at: new Date().toISOString(),
  })
  .eq('id', jobId);

return workerStatus;
```

When submitting a job from the Lovable backend:

```typescript
// 1. Generate a pre-signed upload URL in Supabase Storage
const { data: signedUpload } = await supabase.storage
  .from('render-outputs')
  .createSignedUploadUrl(`${projectId}/${jobId}.mp4`);

// 2. Submit to render worker
await fetch(`${process.env.RENDER_WORKER_URL}/jobs`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': process.env.RENDER_WORKER_API_KEY,
  },
  body: JSON.stringify({
    job_id: jobId,
    clips: scenes.map((s) => ({ clip_url: s.video_url, start: s.start, end: s.end })),
    audio_url: project.audio_url,
    width: 1920, height: 1080, fps: 30,
    aspect_ratio: '16:9',
    transition: 'crossfade',
    transition_duration: 0.5,
    format: 'mp4',
    output_upload_url: signedUpload.signedUrl,
  }),
});
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP listen port |
| `REDIS_URL` | `redis://localhost:6379` | **Managed Redis URL in production** |
| `WORKER_API_KEY` | — | Shared secret with Lovable backend |
| `WORKER_CONCURRENCY` | `2` | Parallel render jobs |
| `JOB_TIMEOUT_SECONDS` | `600` | Hard timeout per job |
| `MAX_CLIPS` | `20` | Max clips per job (enqueue-time check) |
| `MAX_DURATION_SECONDS` | `600` | Max total clip duration per job |
| `MAX_DOWNLOAD_BYTES` | `2147483648` | Max total download size per job (2 GB) |
| `DOWNLOAD_TIMEOUT_SECONDS` | `60` | Per-file download timeout |
| `URL_ALLOWLIST` | — | Comma-separated hostnames for SSRF guard |
| `JOB_ATTEMPTS` | `3` | BullMQ retry attempts |
| `JOB_BACKOFF_DELAY_MS` | `5000` | BullMQ exponential backoff base |
| `TEMP_DIR` | `/tmp/render-tmp` | Temp files (cleaned after every job) |
| `OUTPUT_DIR` | `/tmp/renders` | Local fallback output (single-instance dev) |

---

## Production Redis

**Do NOT run Redis on the same host as the worker.**

Recommended managed options:
- **[Upstash](https://upstash.com/)** — serverless, free tier, per-request billing
- **[Redis Cloud](https://redis.com/redis-enterprise-cloud/)** — managed cluster

Set `REDIS_URL` to the managed connection string. The `docker-compose.yml` Redis is for local dev only.

---

## Security

- **Authentication**: All `/jobs` routes require `X-Api-Key` matching `WORKER_API_KEY`
- **SSRF**: URLs in job payloads are validated against `URL_ALLOWLIST` before any HTTP request
- **Secrets**: Worker holds only `WORKER_API_KEY` — no Pexels, Pixabay, Supabase, or DB credentials
- **Non-root**: Dockerfile runs as a non-root `worker` user

---

## Architecture notes

### v1 bug fix — per-clip normalisation

Every clip is normalised through this filter chain **before** concat:
```
scale={W}:{H}:force_original_aspect_ratio=decrease,
pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,
setsar=1,
fps={fps}
```

This is applied via the **concat filter** (not the concat demuxer / stream-copy approach). The v1 approach assumed all clips shared resolution/fps, failing ~2/3 of real-world jobs where source clips differed.

### Large filter graphs

For 50+ clip projects, the filter graph is written to a temp file and invoked with `-filter_complex_script <file>` instead of inline `-filter_complex`, avoiding OS command-line argument length limits.
