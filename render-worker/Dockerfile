# syntax=docker/dockerfile:1
# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install FFmpeg (system package — pinned to distro version for reproducibility)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r worker && useradd -r -g worker worker

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy source
COPY src/ ./src/
COPY package.json ./

# Create temp/output dirs and set ownership
RUN mkdir -p /tmp/render-tmp /tmp/renders && \
    chown -R worker:worker /app /tmp/render-tmp /tmp/renders

USER worker

# Health check: verifies process is alive and Redis is reachable
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3001) + '/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })" || exit 1

EXPOSE 3001

CMD ["node", "src/server.js"]
