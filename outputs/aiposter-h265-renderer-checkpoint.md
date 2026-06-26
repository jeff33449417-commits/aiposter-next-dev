# AI Poster H.265 Renderer Checkpoint

Saved at: 2026-06-26 12:15 CST

## Main Worker Deployment

- Worker: `aiposter-new`
- Deployed production version: `2d304579-ba88-44ab-ad26-2b0672a9c935`
- Custom domains:
  - `https://my.aiposter.jp`
  - `https://my.aiposter.tw`
- Production domains are still protected by Cloudflare Access.
- `/api/health` check returned Cloudflare Access `302`, which is expected during beta protection.

## Implemented In This Follow-Up

- Added end-to-end H.265 export flow in the main Worker:
  - Reads source WebM preview from R2.
  - Sends private R2 object to `RENDERER_URL`.
  - Accepts `video/mp4` bytes or JSON renderer responses.
  - Stores completed MP4 at:
    - `users/{owner_user_id}/exports/{job_id}/ai_poster_h265.mp4`
  - Marks job as `completed` or `failed`.
- Added authenticated output download route:
  - `/api/jobs/:jobId/output`
- Updated frontend export status panel:
  - Shows `下載 H.265 MP4` when job output is ready.
- Added local FFmpeg renderer:
  - `renderer/server.js`
  - `renderer/Dockerfile`
- Added Cloudflare Containers proxy Worker:
  - `src/renderer-worker.js`
  - `wrangler.renderer.jsonc`
- Added fixed renderer custom domain config:
  - `https://renderer.aiposter.jp`
- Added deployment helpers:
  - `scripts/deploy-renderer.sh`
  - `scripts/deploy-main.sh`
  - `.github/workflows/deploy-renderer.yml`
- Added `.gitignore` for local cache, build dependencies, and smoke-test media.

## Verified Locally

- `node --check src/index.js`
- `node --check src/renderer-worker.js`
- `node --check renderer/server.js`
- `bash -n scripts/deploy-renderer.sh scripts/deploy-main.sh`
- `wrangler deploy --config wrangler.renderer.jsonc --dry-run --containers-rollout=none`
- `wrangler deploy --dry-run`
- Local renderer smoke test:
  - Input: generated WebM test clip.
  - Output: MP4.
  - `ffprobe` confirmed:
    - `codec_name=hevc`
    - `codec_tag_string=hvc1`
    - `pix_fmt=yuv420p`

## Secrets

- `RENDERER_TOKEN` was created for:
  - `aiposter-renderer`
  - `aiposter-new`
- Local temporary token file was removed after setting secrets.

## Current Blocker

Cloudflare Container renderer deployment did not complete because this machine does not have a `docker` CLI available:

```text
The Docker CLI is needed to build the configured image before deploying but could not be launched.
docker: command not found
```

Because of that:

- `aiposter-renderer` Worker secret exists.
- The renderer Worker/Container code exists locally.
- The renderer Container image has not been built/uploaded.
- `RENDERER_URL` has not been set on `aiposter-new`.
- `renderer.aiposter.jp` is configured in `wrangler.renderer.jsonc`, but it will not become live until the renderer deployment succeeds.

## Next Step

On a machine with Docker installed and running:

```bash
cd /Users/jeff/Documents/Codex/2026-06-26/aiposter-next-dev
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler deploy --config wrangler.renderer.jsonc
```

Then set the main Worker renderer URL:

```bash
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler secret put RENDERER_URL
```

Use:

```text
https://renderer.aiposter.jp/render
```

Then redeploy or test exports from the production app.

Alternatively, push this project to GitHub and run:

```text
.github/workflows/deploy-renderer.yml
```

with GitHub secret:

```text
CLOUDFLARE_API_TOKEN
```
