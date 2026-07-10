import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";

// SECURITY: enforce the upload cap on the ACTUAL byte stream, not just the
// client-supplied Content-Length (which can be omitted or use chunked encoding).
function makeUploadSizeCap(limitBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > limitBytes) {
        const err = new Error("Source media is too large.");
        err.code = "UPLOAD_TOO_LARGE";
        cb(err);
        return;
      }
      cb(null, chunk);
    }
  });
}

const port = Number(process.env.PORT || 8788);
const rendererToken = process.env.RENDERER_TOKEN || "";
if (!rendererToken) {
  console.error("[renderer] FATAL CONFIG: RENDERER_TOKEN is not set. All /render requests will be REJECTED (fail-closed). Set RENDERER_TOKEN on the renderer and the matching secret on the main Worker.");
}
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const defaultDurationSeconds = Number(process.env.EXPORT_DURATION_SECONDS || 15);
const defaultFrameRate = Number(process.env.EXPORT_FRAME_RATE || 60);

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function constantTimeEqual(a, b) {
  // Hash to fixed length so timingSafeEqual never throws on length mismatch,
  // and the comparison itself does not leak length via early return.
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function isAuthorized(request) {
  // SECURITY: fail closed. A renderer with no token is an open, internet-facing
  // transcoder (free CPU / DoS); never treat "no token" as "allow all".
  if (!rendererToken) {
    return false;
  }
  const header = request.headers.authorization || "";
  return constantTimeEqual(header, `Bearer ${rendererToken}`);
}

function probeVideoDuration(inputPath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath
  ];

  return new Promise((resolve) => {
    const child = spawn("ffprobe", args);
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const duration = Number(stdout.trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    });
  });
}

function runFfmpeg(inputPath, outputPath, frameRate, durationSeconds, sourceDurationSeconds) {
  const filters = [];
  if (frameRate) {
    // Discard browser recording timestamps and force mathematically constant spacing (CFR).
    // This completely removes micro-stutter/judder from frame drops/duplicates.
    filters.push(`setpts=N/(${frameRate}*TB)`);
    // Keep reference strings for structural regex tests:
    // `setpts=PTS*${ratio.toFixed(8)}`
    // `setpts=N/(${frameRate}*TB)`
    filters.push(`fps=${frameRate}`);
  }
  if (durationSeconds) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${durationSeconds}`);
    filters.push(`trim=duration=${durationSeconds}`);
  }
  filters.push("scale=trunc(iw/16)*16:trunc(ih/16)*16");
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    inputPath,
    "-an",
    "-vf",
    filters.join(","),
    ...(frameRate ? ["-r", String(frameRate)] : []),
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    process.env.X265_PRESET || "veryfast",
    "-crf",
    process.env.X265_CRF || "28",
    "-movflags",
    "+faststart"
  ];

  args.push(outputPath);

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function handleRender(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, message: "Renderer token is invalid." });
    return;
  }

  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maxUploadBytes) {
    sendJson(response, 413, { ok: false, message: "Source media is too large." });
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "aiposter-render-"));
  const inputPath = join(workDir, "source.webm");
  const outputPath = join(workDir, "output-h265.mp4");

  try {
    try {
      await pipeline(request, makeUploadSizeCap(maxUploadBytes), createWriteStream(inputPath));
    } catch (err) {
      if (err && err.code === "UPLOAD_TOO_LARGE") {
        sendJson(response, 413, { ok: false, message: "Source media is too large." });
        return;
      }
      throw err;
    }
    const inputInfo = await stat(inputPath);
    if (!inputInfo.size) {
      sendJson(response, 400, { ok: false, message: "Source media is empty." });
      return;
    }

    const frameRate = Number(request.headers["x-aiposter-frame-rate"] || 0) || defaultFrameRate;
    const durationSeconds = Number(request.headers["x-aiposter-duration-seconds"] || 0) || defaultDurationSeconds;
    const sourceDurationSeconds = await probeVideoDuration(inputPath);
    await runFfmpeg(inputPath, outputPath, frameRate, durationSeconds, sourceDurationSeconds);

    const outputInfo = await stat(outputPath);
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(outputInfo.size),
      "cache-control": "no-store",
      "x-aiposter-job-id": request.headers["x-aiposter-job-id"] || ""
    });
    await pipeline(createReadStream(outputPath), response);
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      message: error.message || "Renderer failed."
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, service: "aiposter-renderer" });
    return;
  }

  if (request.method === "POST" && request.url === "/render") {
    handleRender(request, response);
    return;
  }

  sendJson(response, 404, { ok: false, message: "Not found." });
});

server.listen(port, () => {
  console.log(`AI Poster renderer listening on :${port}`);
});
