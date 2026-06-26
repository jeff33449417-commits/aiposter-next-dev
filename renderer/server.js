import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8788);
const rendererToken = process.env.RENDERER_TOKEN || "";
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function isAuthorized(request) {
  if (!rendererToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${rendererToken}`;
}

function runFfmpeg(inputPath, outputPath, frameRate) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    inputPath,
    "-an",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    process.env.X265_PRESET || "medium",
    "-crf",
    process.env.X265_CRF || "24",
    "-movflags",
    "+faststart"
  ];

  if (frameRate) {
    args.push("-r", String(frameRate));
  }

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
    await pipeline(request, createWriteStream(inputPath));
    const inputInfo = await stat(inputPath);
    if (!inputInfo.size) {
      sendJson(response, 400, { ok: false, message: "Source media is empty." });
      return;
    }

    const frameRate = Number(request.headers["x-aiposter-frame-rate"] || 0) || null;
    await runFfmpeg(inputPath, outputPath, frameRate);

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
