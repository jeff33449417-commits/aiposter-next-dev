import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
// Include public/js so the extracted frontend modules are syntax-checked too.
const jsRoots = ["src", "renderer", "scripts", "tests", "public/js"];
const jsFiles = [];

function collectJsFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(path);
      continue;
    }
    if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      jsFiles.push(path);
    }
  }
}

for (const dir of jsRoots) {
  collectJsFiles(join(root, dir));
}

let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout);
  } else {
    console.log(`syntax ok: ${file.replace(`${root}/`, "")}`);
  }
}

const html = readFileSync(join(root, "public/index.html"), "utf8");

// Frontend modularization invariants: the CSS/JS live in their own files and
// index.html only references them (no inline <style>/<script> blocks remain).
const moduleRefs = [
  ['<link rel="stylesheet" href="/styles.css">', "stylesheet link"],
  ['src="/js/products.js"', "products.js script tag"],
  ['src="/js/app.js"', "app.js script tag"]
];
for (const [needle, label] of moduleRefs) {
  if (html.includes(needle)) {
    console.log(`structure ok: ${label}`);
  } else {
    failed = true;
    console.error(`missing required structure: ${label}`);
  }
}

if (/<style[\s>]/i.test(html)) {
  failed = true;
  console.error("index.html still contains an inline <style> block");
} else {
  console.log("structure ok: no inline <style> block");
}

// Any remaining <script> must be an external (src) reference — no inline code.
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i.test(html);
if (inlineScript) {
  failed = true;
  console.error("index.html still contains an inline (src-less) <script> block");
} else {
  console.log("structure ok: no inline <script> block");
}

const requiredSnippets = [
  ["15 second timeline", "const TOTAL_SECONDS = 15"],
  ["fixed 60fps export", "const EXPORT_FRAME_RATE = 60"],
  ["540p-ish export long side", "const EXPORT_MAX_LONG_SIDE = 960"],
  ["mobile Safari blob download", "async function downloadJobOutput"],
  ["one active export statuses", "const ACTIVE_EXPORT_STATUSES"],
  ["turnstile verification hook", "TURNSTILE_VERIFY_URL"],
  ["upload rate limit", "UPLOAD_RATE_LIMIT_PER_MINUTE"],
  ["export rate limit", "EXPORT_RATE_LIMIT_PER_MINUTE"],
  ["MP4 filename header", "filename*=UTF-8''"],
  ["one active export D1 index", "idx_jobs_one_active_export_per_user"]
];

// Frontend constants now live in public/js/app.js after modularization, so
// scan it alongside the worker, the markup and the migration.
const combined = [
  html,
  readFileSync(join(root, "public/js/app.js"), "utf8"),
  readFileSync(join(root, "src/index.js"), "utf8"),
  readFileSync(join(root, "migrations/0003_export_queue_limits.sql"), "utf8")
].join("\n");

for (const [label, snippet] of requiredSnippets) {
  if (!combined.includes(snippet)) {
    failed = true;
    console.error(`missing required structure: ${label}`);
  } else {
    console.log(`structure ok: ${label}`);
  }
}

if (failed) {
  process.exitCode = 1;
}
