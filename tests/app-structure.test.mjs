import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("frontend keeps the current MP4 export contract", () => {
  const html = read("public/index.html");
  assert.match(html, /const TOTAL_SECONDS = 15;/);
  assert.match(html, /const EXPORT_FRAME_RATE = 60;/);
  assert.match(html, /const EXPORT_MAX_LONG_SIDE = 960;/);
  assert.match(html, /async function downloadJobOutput/);
  assert.match(html, /new Blob\(\[blob\], \{ type: 'video\/mp4' \}\)/);
  assert.match(html, /下載 H\.265 MP4/);
});

test("backend enforces MP4 queue safeguards", () => {
  const worker = read("src/index.js");
  assert.match(worker, /const ACTIVE_EXPORT_STATUSES = \["queued", "processing", "waiting_renderer"\]/);
  assert.match(worker, /DEFAULT_EXPORT_BACKLOG_LIMIT = 50/);
  assert.match(worker, /DEFAULT_VIDEO_UPLOAD_MB = 10/);
  assert.match(worker, /ACTIVE_EXPORT_EXISTS/);
  assert.match(worker, /EXPORT_QUEUE_FULL/);
  assert.match(worker, /content-type": "video\/mp4"/);
  assert.match(worker, /filename\*=UTF-8''/);
});

test("Cloudflare queue and D1 limits are configured", () => {
  const wrangler = read("wrangler.jsonc");
  const migration = read("migrations/0003_export_queue_limits.sql");
  assert.match(wrangler, /"max_batch_size": 5/);
  assert.match(wrangler, /"EXPORT_BACKLOG_LIMIT": "50"/);
  assert.match(wrangler, /"MAX_VIDEO_UPLOAD_MB": "10"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_export_per_user/);
  assert.match(migration, /status IN \('queued', 'processing', 'waiting_renderer'\)/);
});
