import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("frontend keeps the current MP4 export contract", () => {
  // After modularization these constants/functions live in public/js/app.js
  // (index.html now only references the external scripts).
  const app = read("public/js/app.js");
  assert.match(app, /const TOTAL_SECONDS = 15;/);
  assert.match(app, /const EXPORT_FRAME_RATE = 60;/);
  assert.match(app, /const EXPORT_MAX_LONG_SIDE = 960;/);
  assert.match(app, /async function downloadJobOutput/);
  assert.match(app, /new Blob\(\[blob\], \{ type: 'video\/mp4' \}\)/);
  assert.match(app, /下載 H\.265 MP4/);
  assert.match(app, /const TURNSTILE_TOKEN_TIMEOUT_MS = 10000;/);
  assert.match(app, /execution: 'execute'/);
  assert.match(app, /appearance: 'interaction-only'/);
  assert.match(app, /turnstile\.execute\(host\)/);
});

test("backend enforces MP4 queue safeguards", () => {
  const worker = read("src/index.js");
  assert.match(worker, /const ACTIVE_EXPORT_STATUSES = \["queued", "processing", "waiting_renderer"\]/);
  assert.match(worker, /DEFAULT_EXPORT_BACKLOG_LIMIT = 50/);
  assert.match(worker, /DEFAULT_VIDEO_UPLOAD_MB = 10/);
  assert.match(worker, /DEFAULT_UPLOAD_RATE_LIMIT_PER_MINUTE = 12/);
  assert.match(worker, /DEFAULT_EXPORT_RATE_LIMIT_PER_MINUTE = 6/);
  assert.match(worker, /ACTIVE_EXPORT_EXISTS/);
  assert.match(worker, /EXPORT_QUEUE_FULL/);
  assert.match(worker, /TURNSTILE_VERIFY_URL/);
  assert.match(worker, /turnstileToken/);
  assert.match(worker, /content-type": "video\/mp4"/);
  assert.match(worker, /filename\*=UTF-8''/);
});

test("Cloudflare queue and D1 limits are configured", () => {
  const wrangler = read("wrangler.jsonc");
  const migration = read("migrations/0003_export_queue_limits.sql");
  assert.match(wrangler, /"max_batch_size": 5/);
  assert.match(wrangler, /"EXPORT_BACKLOG_LIMIT": "50"/);
  assert.match(wrangler, /"MAX_VIDEO_UPLOAD_MB": "10"/);
  assert.match(wrangler, /"UPLOAD_RATE_LIMIT_PER_MINUTE": "12"/);
  assert.match(wrangler, /"EXPORT_RATE_LIMIT_PER_MINUTE": "6"/);
  assert.match(wrangler, /"TURNSTILE_SITE_KEY": "0x4AAAA/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_export_per_user/);
  assert.match(migration, /status IN \('queued', 'processing', 'waiting_renderer'\)/);
});
