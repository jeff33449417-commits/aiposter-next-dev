import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const jsRoots = ["src", "renderer", "scripts", "tests"];
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
for (const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  try {
    new Function(match[1]);
    console.log(`html script ${index + 1}: syntax ok`);
  } catch (error) {
    failed = true;
    console.error(`html script ${index + 1}: ${error.message}`);
  }
}

const requiredSnippets = [
  ["15 second timeline", "const TOTAL_SECONDS = 15"],
  ["fixed 60fps export", "const EXPORT_FRAME_RATE = 60"],
  ["540p-ish export long side", "const EXPORT_MAX_LONG_SIDE = 960"],
  ["mobile Safari blob download", "async function downloadJobOutput"],
  ["one active export statuses", "const ACTIVE_EXPORT_STATUSES"],
  ["MP4 filename header", "filename*=UTF-8''"],
  ["one active export D1 index", "idx_jobs_one_active_export_per_user"]
];

const combined = [
  html,
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
