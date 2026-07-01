// Structural guards for the Android Chrome MP4 export fix.
// The export render loop must never block on video readiness (a per-frame
// await video.play() that never resolved on Android froze the whole export and
// produced a fully blank MP4). Video frames are drawn from the on-screen,
// forced-rendered <video>; the per-frame draw is synchronous and skips frames
// that aren't decoded yet. Run with: npm test (node --test tests/*.test.mjs)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const app = readFileSync(new URL("../public/js/app.js", import.meta.url), "utf8");

function slice(from, to) {
  const a = app.indexOf(from);
  const b = app.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `could not locate ${from} .. ${to}`);
  return app.slice(a, b);
}

test("drawVideoClip is synchronous and never awaits (no render-loop stall)", () => {
  const fn = slice("function drawVideoClip(", "async function prepareExportVideos");
  assert.doesNotMatch(fn, /async function drawVideoClip/, "must not be async");
  assert.doesNotMatch(fn, /\bawait\b/, "must not await anything per frame");
  assert.match(fn, /clip\._exportVideo \|\| layer\.querySelector\('\.preview-media-element'\)/, "draws from the live/export element");
  assert.match(fn, /if \(!video \|\| !video\.videoWidth \|\| !video\.videoHeight\) return;/, "skips frames that aren't decoded yet");
  assert.match(fn, /syncExportVideoTime\(video, clip, elapsedSeconds\)/, "aligns the playhead each frame");
});

test("video time-sync aligns currentTime to (elapsed - start) without blocking", () => {
  const fn = slice("function syncExportVideoTime(", "// Synchronous: never await");
  assert.doesNotMatch(fn, /\bawait\b/, "must not await the seek");
  assert.match(fn, /elapsedSeconds - start/, "target time is elapsed minus clip start");
  assert.match(fn, /video\.currentTime = target/, "seeks the playhead to the clip-local time");
});

test("the export frame loop calls drawVideoClip without awaiting it", () => {
  assert.match(app, /\n\s*drawVideoClip\(ctx, clip, layer, box, effect, elapsedSeconds\);/, "called synchronously with elapsed");
  assert.doesNotMatch(app, /await drawVideoClip\(/, "never awaited");
});

test("prepareExportVideos forces the layer rendered and bounds its waits", () => {
  const fn = slice("async function prepareExportVideos", "function drawTextClip");
  assert.match(fn, /classList\.remove\('playback-hidden'\)/, "un-hides the layer so the video keeps decoding");
  assert.match(fn, /Promise\.race\(\[video\.play\(\), exportDelay\(/, "play() is time-bounded");
  assert.match(fn, /Promise\.race\(\[waitForVideoFrame\(video, \d+\), exportDelay\(/, "frame wait is time-bounded");
  assert.match(fn, /clip\._exportVideo = video;/, "records the export video on the clip");
});

test("export restores visibility and pauses videos when done", () => {
  assert.match(app, /function endExportVideos\(\)/);
  assert.match(app, /classList\.add\('playback-hidden'\)/, "re-hides layers it un-hid");
  assert.match(app, /\n\s*endExportVideos\(\);/, "called after recording stops");
});

test("MP4 export spec is unchanged (15s / 60fps / 960 long side / webm capture)", () => {
  assert.match(app, /const TOTAL_SECONDS = 15;/);
  assert.match(app, /const EXPORT_FRAME_RATE = 60;/);
  assert.match(app, /const EXPORT_MAX_LONG_SIDE = 960;/);
  assert.match(app, /new Blob\(chunks, \{ type: 'video\/webm' \}\)/);
});
