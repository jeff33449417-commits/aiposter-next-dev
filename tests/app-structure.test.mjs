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
  assert.match(app, /const downloadLink = document\.createElement\('a'\)/);
  assert.match(app, /downloadLink\.href = outputUrl/);
  assert.match(app, /downloadLink\.download = filename/);
  assert.doesNotMatch(app, /new Blob\(\[blob\], \{ type: 'video\/mp4' \}\)/);
  assert.match(app, /下載 H\.265 MP4/);
  assert.match(app, /const TURNSTILE_TOKEN_TIMEOUT_MS = 10000;/);
  assert.match(app, /execution: 'execute'/);
  assert.match(app, /appearance: 'interaction-only'/);
  assert.match(app, /turnstile\.execute\(host\)/);
  assert.doesNotMatch(app, /防機器人驗證逾時/);
  assert.match(app, /function createExportFrameLayout/);
  assert.match(app, /canvas\.captureStream\(0\)/);
  assert.match(app, /videoTrack\?\.requestFrame\?\.\(\)/);
  assert.match(app, /frameIndex \/ frameRate/);
});

test("renderer normalizes MP4 output cadence", () => {
  const renderer = read("renderer/server.js");
  assert.match(renderer, /const defaultDurationSeconds = Number\(process\.env\.EXPORT_DURATION_SECONDS \|\| 15\)/);
  assert.match(renderer, /const defaultFrameRate = Number\(process\.env\.EXPORT_FRAME_RATE \|\| 60\)/);
  assert.match(renderer, /function probeVideoDuration/);
  assert.match(renderer, /spawn\("ffprobe", args\)/);
  assert.match(renderer, /x-aiposter-duration-seconds/);
  assert.match(renderer, /x-aiposter-frame-rate/);
  assert.match(renderer, /sourceDurationSeconds = await probeVideoDuration\(inputPath\)/);
  assert.match(renderer, /setpts=PTS\*\$\{ratio\.toFixed\(8\)\}/);
  assert.match(renderer, /setpts=N\/\(\$\{frameRate\}\*TB\)/);
  assert.match(renderer, /fps=\$\{frameRate\}/);
  assert.match(renderer, /tpad=stop_mode=clone:stop_duration=\$\{durationSeconds\}/);
  assert.match(renderer, /trim=duration=\$\{durationSeconds\}/);
  assert.match(renderer, /\.\.\.\(frameRate \? \["-r", String\(frameRate\)\] : \[\]\)/);
  assert.match(renderer, /scale=trunc\(iw\/16\)\*16:trunc\(ih\/16\)\*16/);
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
  assert.match(worker, /function turnstileEnabled/);
  assert.match(worker, /turnstileToken/);
  assert.match(worker, /content-type": "video\/mp4"/);
  assert.match(worker, /filename\*=UTF-8''/);
});

test("Cloudflare queue and D1 limits are configured", () => {
  const wrangler = read("wrangler.jsonc");
  const migration = read("migrations/0003_export_queue_limits.sql");
  // Queue is tuned to the renderer's concurrency: one export per delivery and
  // no more concurrent consumers than the renderer can transcode at once.
  assert.match(wrangler, /"max_batch_size": 1/);
  assert.match(wrangler, /"max_concurrency": 1/);
  // Stale-export cleanup runs on a Cron schedule, not on every /api/jobs poll.
  assert.match(wrangler, /"crons":/);
  assert.match(wrangler, /"EXPORT_BACKLOG_LIMIT": "50"/);
  assert.match(wrangler, /"MAX_VIDEO_UPLOAD_MB": "10"/);
  assert.match(wrangler, /"UPLOAD_RATE_LIMIT_PER_MINUTE": "12"/);
  assert.match(wrangler, /"EXPORT_RATE_LIMIT_PER_MINUTE": "6"/);
  // Turnstile vars are intentionally kept out of wrangler.jsonc so no visible
  // human-verification is configured. The backend only enables Turnstile when
  // TURNSTILE_ENABLED === "true", so their absence keeps it disabled.
  assert.doesNotMatch(wrangler, /"TURNSTILE_ENABLED"/);
  assert.doesNotMatch(wrangler, /"TURNSTILE_SITE_KEY"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_export_per_user/);
  assert.match(migration, /status IN \('queued', 'processing', 'waiting_renderer'\)/);
});

test("commercial launch foundation is wired for customers, invites, support, and renderer pool", () => {
  const worker = read("src/index.js");
  const migration = read("migrations/0004_commercial_foundation.sql");

  for (const table of [
    "billing_plans",
    "customer_accounts",
    "customer_members",
    "commercial_invite_codes",
    "commerce_invite_requests",
    "invoices",
    "payments",
    "export_workers",
    "system_alerts",
    "backup_runs"
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(worker, /async function handleInviteRedemption/);
  assert.match(worker, /async function handleCommerceInviteRequest/);
  assert.match(worker, /async function requireCommerceToken/);
  assert.match(worker, /async function timingSafeSecretEqual/);
  assert.match(worker, /async function handleAdminCommercial/);
  assert.match(worker, /async function handleAdminSupport/);
  assert.match(worker, /async function handleAdminRenderers/);
  assert.match(worker, /async function getRendererEndpoint/);
  assert.match(worker, /\/api\/invites\/redeem/);
  assert.match(worker, /\/api\/commerce\/invite-request/);
  assert.match(worker, /\/api\/admin\/commercial/);
  assert.match(worker, /\/api\/admin\/support/);
  assert.match(worker, /\/api\/admin\/renderers/);
  assert.match(worker, /\/api\/admin\/jobs\//);
  assert.match(worker, /商用營運總覽/);
});

test("dy.com.tw commerce invite API keeps secrets server-side", () => {
  const worker = read("src/index.js");
  const wrangler = read("wrangler.jsonc");
  const migration = read("migrations/0004_commercial_foundation.sql");

  assert.match(worker, /DY_COMMERCE_API_TOKEN/);
  assert.match(worker, /x-aiposter-commerce-token/);
  assert.match(worker, /IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(worker, /commerce_invite_created/);
  assert.match(worker, /aiposter\.jp 只建立邀請碼；邀請信由 dy\.com\.tw 發送給客戶。/);
  assert.match(migration, /UNIQUE\(source, idempotency_key\)/);
  assert.doesNotMatch(wrangler, /DY_COMMERCE_API_TOKEN/);
});
