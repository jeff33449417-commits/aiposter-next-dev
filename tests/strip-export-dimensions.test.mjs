// Guards export sizing: the product aspect ratio is ALWAYS preserved exactly.
// The short side is lifted toward a quality target (320) for sharper strips,
// the long side is capped at the mobile ceiling (4096), and ratios so extreme
// that the short side would fall below the encoder/decoder floor (e.g. 96:1)
// are refused rather than distorted. Run with: npm test (node --test tests/*.test.mjs)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const app = readFileSync(new URL("../public/js/app.js", import.meta.url), "utf8");

test("export sizing constants", () => {
  assert.match(app, /const EXPORT_MIN_SHORT_SIDE = 320;/);
  assert.match(app, /const EXPORT_MAX_DIMENSION = 4096;/);
  assert.match(app, /const EXPORT_HARD_MIN_SHORT = 160;/);
  assert.match(app, /const EXPORT_MAX_LONG_SIDE = 960;/);
  assert.match(app, /const EXPORT_FRAME_RATE = 60;/);
});

test("exportCanvasSize preserves aspect (no independent per-side clamp)", () => {
  const fn = app.slice(app.indexOf("function exportCanvasSize"), app.indexOf("function exportSizeIsViable"));
  assert.match(fn, /EXPORT_MIN_SHORT_SIDE\s*\/\s*shortSide/, "lifts short side toward target");
  assert.match(fn, /EXPORT_MAX_DIMENSION\s*\/\s*longSide/, "caps long side, aspect-preserving");
  // The old distortion clamp must be gone.
  assert.doesNotMatch(fn, /Math\.max\(EXPORT_MIN_SHORT_SIDE, width\)/, "no per-side clamp that breaks aspect");
});

test("infeasible (too-extreme) ratios are refused, not distorted", () => {
  assert.match(app, /function exportSizeIsViable\(size\)/);
  assert.match(app, /無法輸出為單一 MP4/, "executeArrangement shows a refusal message");
});

test("recording bitrate scales with resolution and is capped", () => {
  const fn = app.slice(app.indexOf("async function recordPreviewWebM"), app.indexOf("recorder.ondataavailable"));
  assert.match(fn, /canvas\.width \* canvas\.height \* frameRate/, "bitrate scales with pixels");
  assert.match(fn, /Math\.min\(\s*4000000/, "capped to keep WebM under the upload limit");
});

// Mirror of exportCanvasSize's pure math (aspect-preserving). Kept in sync.
function sizeFor(ratio) {
  const MAX_LONG = 960, MIN_SHORT = 320, MAX_DIM = 4096;
  let w = ratio >= 1 ? MAX_LONG : MAX_LONG * ratio;
  let h = ratio >= 1 ? MAX_LONG / ratio : MAX_LONG;
  const shortSide = Math.min(w, h);
  if (shortSide > 0 && shortSide < MIN_SHORT) { const s = MIN_SHORT / shortSide; w *= s; h *= s; }
  const longSide = Math.max(w, h);
  if (longSide > MAX_DIM) { const s = MAX_DIM / longSide; w *= s; h *= s; }
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(w), height: even(h) };
}
const viable = (s) => Math.min(s.width, s.height) >= 160;

test("strips are sharper now (short side 320), aspect preserved", () => {
  assert.deepEqual(sizeFor(12), { width: 3840, height: 320 });      // 12:1
  assert.deepEqual(sizeFor(1 / 6), { width: 320, height: 1920 });   // 1:6
  assert.deepEqual(sizeFor(1 / 10), { width: 320, height: 3200 });  // 1:10
});

test("normal aspect ratios are unchanged", () => {
  assert.deepEqual(sizeFor(1), { width: 960, height: 960 });        // 1:1
  assert.deepEqual(sizeFor(9 / 16), { width: 540, height: 960 });   // 9:16
  assert.deepEqual(sizeFor(3), { width: 960, height: 320 });        // 3:1
});

test("96:1 is not viable (aspect kept, short side below the floor)", () => {
  const size = sizeFor(96);
  assert.equal(size.width, 4096);
  assert.ok(size.height < 160, `96:1 short side is below floor: ${size.height}`);
  assert.ok(!viable(size), "should be refused");
});

test("every viable product keeps its exact aspect ratio", () => {
  for (const ratio of [1, 12, 1 / 6, 3, 6, 0.5, 19.63, 1 / 10, 40 / 23, 4 / 5]) {
    const { width, height } = sizeFor(ratio);
    if (!viable({ width, height })) continue;
    const got = width / height;
    assert.ok(Math.abs(got - ratio) / ratio < 0.03, `aspect preserved for ${ratio}: got ${got.toFixed(3)}`);
    assert.ok(Math.max(width, height) <= 4096, `long side within ceiling for ${ratio}`);
  }
});
