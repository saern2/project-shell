'use strict';

/**
 * downloader.js
 *
 * Downloads remote files (clips, audio) using Node's built-in http/https
 * modules (no third-party ESM dependencies — fully CJS compatible).
 *
 * Features:
 *  - SSRF hostname allowlist check (pre-fetch, validates after redirects too)
 *  - Content-Length pre-check + streaming byte counter guard
 *  - Configurable per-file and cumulative download size limits
 *  - Timeout via AbortController
 *  - Streaming write to disk (no large buffers in memory)
 *  - file:// URL support for local test fixtures
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { URL } = require('url');

const config = require('./config');
const logger = require('./logger');

// ─── SSRF Guard ───────────────────────────────────────────────────────────────

/**
 * Validates a URL against the SSRF allowlist.
 * Throws with an SSRF_BLOCK prefix if the host is not allowed.
 *
 * @param {string} rawUrl
 */
function assertAllowedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF_BLOCK: Malformed URL rejected: ${rawUrl}`);
  }

  // file:// URLs are only used by local test fixtures — no network SSRF risk
  if (parsed.protocol === 'file:') return;

  if (config.urlAllowlist.length === 0) {
    logger.warn({ url: rawUrl }, 'URL_ALLOWLIST is empty — SSRF protection disabled. Set in production.');
    return;
  }

  const host = parsed.hostname.toLowerCase();

  const allowed = config.urlAllowlist.some(
    (entry) => host === entry || host.endsWith(`.${entry}`)
  );

  if (!allowed) {
    throw new Error(
      `SSRF_BLOCK: Host "${host}" is not on the URL allowlist. ` +
      `Allowed: [${config.urlAllowlist.join(', ')}]`
    );
  }
}

// ─── Core download ────────────────────────────────────────────────────────────

/**
 * Downloads a single URL to a local file path.
 * Supports http://, https://, and file:// URLs.
 *
 * @param {string} url            - Remote URL to download
 * @param {string} destPath       - Absolute local path to write to
 * @param {object} opts
 * @param {number} [opts.maxBytes]  - Per-file byte ceiling
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<number>}       - Actual bytes written
 */
async function downloadFile(url, destPath, { maxBytes = config.maxDownloadBytes, signal } = {}) {
  assertAllowedUrl(url);

  const parsed = new URL(url);

  // ── Local file:// shortcut (for tests) ────────────────────────────────────
  if (parsed.protocol === 'file:') {
    const srcPath = decodeURIComponent(parsed.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    await fsp.copyFile(srcPath, destPath);
    const stat = await fsp.stat(destPath);
    logger.debug({ url, destPath, bytes: stat.size }, 'Copied local file');
    return stat.size;
  }

  // ── HTTP/HTTPS download ───────────────────────────────────────────────────
  logger.debug({ url, destPath }, 'Downloading file');

  return new Promise((resolve, reject) => {
    let bytesWritten = 0;
    let finished = false;
    const timeoutMs = config.downloadTimeoutSeconds * 1000;

    // Track abort signal
    if (signal?.aborted) {
      return reject(new Error('Download aborted before start'));
    }

    function doRequest(requestUrl, redirectCount = 0) {
      if (redirectCount > 5) {
        return reject(new Error(`Too many redirects for URL: ${url}`));
      }

      const parsedReq = new URL(requestUrl);
      const mod = parsedReq.protocol === 'https:' ? https : http;

      const req = mod.get(requestUrl, { signal }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, requestUrl).href;
          try { assertAllowedUrl(redirectUrl); } catch (e) { return reject(e); }
          res.resume(); // consume and discard redirect body
          return doRequest(redirectUrl, redirectCount + 1);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading: ${url}`));
        }

        // Pre-check Content-Length
        const cl = parseInt(res.headers['content-length'] ?? '0', 10);
        if (cl > maxBytes) {
          res.destroy();
          return reject(new Error(
            `Download rejected: Content-Length ${cl} exceeds limit ${maxBytes} for: ${url}`
          ));
        }

        const writeStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            res.destroy();
            writeStream.destroy();
            if (!finished) {
              finished = true;
              reject(new Error(`Download exceeded max size ${maxBytes} bytes for: ${url}`));
            }
          }
        });

        pipeline(res, writeStream)
          .then(() => {
            if (!finished) {
              finished = true;
              logger.debug({ url, destPath, bytesWritten }, 'Download complete');
              resolve(bytesWritten);
            }
          })
          .catch((err) => {
            if (!finished) {
              finished = true;
              reject(new Error(`Stream error downloading ${url}: ${err.message}`));
            }
          });
      });

      // Timeout
      const timer = setTimeout(() => {
        req.destroy(new Error(`Download timed out after ${timeoutMs}ms for: ${url}`));
      }, timeoutMs);

      req.on('error', (err) => {
        clearTimeout(timer);
        if (!finished) {
          finished = true;
          reject(new Error(`Network error downloading ${url}: ${err.message}`));
        }
      });

      req.on('close', () => clearTimeout(timer));

      // Wire abort signal
      signal?.addEventListener('abort', () => {
        req.destroy(new Error('Download aborted'));
      }, { once: true });
    }

    doRequest(url);
  });
}

/**
 * Downloads all clips and the audio track for a job into a temp directory.
 * Accumulates total bytes and rejects if the total exceeds maxDownloadBytes.
 *
 * @param {object} params
 * @param {Array<{clip_url:string, start:number, end:number}>} params.clips
 * @param {string} params.audioUrl
 * @param {string} params.tempDir
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{clipPaths: string[], audioPath: string}>}
 */
async function downloadAll({ clips, audioUrl, tempDir, signal }) {
  let totalBytes = 0;
  const clipPaths = [];

  for (let i = 0; i < clips.length; i++) {
    const { clip_url } = clips[i];
    let ext = '.mp4';
    try {
      ext = path.extname(new URL(clip_url).pathname) || '.mp4';
    } catch { /* file:// or malformed — default */ }

    const destPath = path.join(tempDir, `clip_${i}${ext}`);
    const bytes = await downloadFile(clip_url, destPath, { signal });
    totalBytes += bytes;

    if (totalBytes > config.maxDownloadBytes) {
      throw new Error(
        `Total download size ${totalBytes} bytes exceeds limit of ${config.maxDownloadBytes} bytes`
      );
    }
    clipPaths.push(destPath);
  }

  let audioExt = '.mp3';
  try {
    audioExt = path.extname(new URL(audioUrl).pathname) || '.mp3';
  } catch { /* default */ }

  const audioPath = path.join(tempDir, `audio${audioExt}`);
  const audioBytes = await downloadFile(audioUrl, audioPath, { signal });
  totalBytes += audioBytes;

  if (totalBytes > config.maxDownloadBytes) {
    throw new Error(
      `Total download size ${totalBytes} bytes exceeds limit of ${config.maxDownloadBytes} bytes`
    );
  }

  logger.info({ totalBytes, clipCount: clips.length }, 'All assets downloaded');
  return { clipPaths, audioPath };
}

module.exports = { downloadFile, downloadAll, assertAllowedUrl };
