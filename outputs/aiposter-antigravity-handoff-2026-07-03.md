# AI Poster V2 Antigravity Handoff

Date: 2026-07-03
Workspace: `/Users/jeff/Documents/Codex/2026-06-26/aiposter-next-dev`
GitHub: `https://github.com/jeff33449417-commits/aiposter-next-dev`
Branch: `v2-dev`
Current HEAD: `bb6bd8d Download original MP4 outputs directly`

## Current Production Targets

- Main app Worker: `aiposter-new`
- Main app URLs:
  - `https://my.aiposter.jp`
  - `https://my.aiposter.tw`
- Renderer Worker: `aiposter-renderer`
- Renderer URL: `https://renderer.aiposter.jp/render`
- R2 bucket: `aiposter-assets`
- D1 database: `aiposter`
- Queue: `aiposter-jobs`
- KV namespace binding: `APP_KV`

## Important Product Rules

- Output file must be `.mp4`, not `.html`.
- MP4 export target is 15 seconds, 60fps, 540p-ish max long side currently represented by `EXPORT_MAX_LONG_SIDE = 960`.
- Max uploaded video size is controlled by `MAX_VIDEO_UPLOAD_MB`, currently `10`.
- Visible Turnstile / human verification UI is intentionally disabled. Do not re-add Turnstile variables or visible challenge UI unless product direction changes.
- Export status should show only the current job, not stale previous jobs.
- Mobile editing must remain usable for dragging, resizing, zooming, and timeline trimming.
- Output should avoid visible jitter. Export frame timing should be stable and quantized.

## Latest Issue Fixed

User reported downloaded MP4 files were not smooth. Investigation found:

- Remote R2 original for job `job_232807ed-601f-44e5-bb77-f277eda2394f` was correct:
  - HEVC / H.265
  - 60fps
  - 900 frames
  - 15 seconds
- The local downloaded/shared file had been converted to H.264 30fps, likely by the previous browser/mobile blob download path.

Fix in `bb6bd8d`:

- `public/js/app.js` now downloads MP4 outputs directly from the backend attachment URL.
- It no longer wraps the MP4 response in a frontend Blob before triggering the download.
- Tests were updated to assert direct attachment download behavior.

Production note: after this commit is pushed, deploy the main Worker before judging mobile download behavior.

## Commands

Install dependencies:

```bash
npm install
```

Validate code:

```bash
npm run check
npm test
```

Cloudflare dry run:

```bash
NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy --dry-run
```

Deploy main app Worker:

```bash
NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy
```

After deploy, test with cache-busting URL:

```text
https://my.aiposter.jp/?v=bb6bd8d
```

Deploy renderer:

- Preferred: GitHub Actions workflow `Deploy AI Poster Renderer`
- Or use local script if Cloudflare auth is configured:

```bash
./scripts/deploy-renderer.sh
```

## Files And Responsibilities

- `public/index.html`: app shell only.
- `public/js/app.js`: frontend editor, preview, timeline, upload, export, download behavior.
- `public/js/products.js`: product size definitions.
- `public/styles.css`: app styling and mobile layout.
- `src/index.js`: main Cloudflare Worker, API routes, R2/D1/Queue logic, invite/customer foundation.
- `src/renderer-worker.js`: Cloudflare Worker wrapper for container renderer.
- `renderer/server.js`: container render service.
- `renderer/Dockerfile`: renderer container image.
- `wrangler.jsonc`: main app Cloudflare config.
- `wrangler.renderer.jsonc`: renderer Cloudflare config.
- `migrations/*.sql`: D1 schema migrations.
- `tests/*.test.mjs`: regression tests.
- `scripts/check.mjs`: structural and product-rule assertions.
- `.github/workflows/*.yml`: CI and deployment workflows.
- `docs/production-guardrails.md`: production guardrails and scale notes.
- `outputs/*checkpoint*.md`: historical project checkpoints.

## Secrets Not Included In This Package

Do not put secrets into the repository or handoff package. Current deployment expects secrets/variables to be managed in Cloudflare and GitHub:

- `RENDERER_URL`
- `RENDERER_TOKEN`
- `DY_COMMERCE_API_TOKEN`
- `CLOUDFLARE_API_TOKEN` for GitHub Actions deployments

Turnstile keys should remain absent unless visible human verification is intentionally restored.

## Commercial / Invite Flow Direction

Current intended flow:

1. `dy.com.tw` owns customer purchase/customer data.
2. `dy.com.tw` sends invite-code request to AI Poster.
3. AI Poster creates or returns invite code.
4. `dy.com.tw` sends the invite code to the customer.

Relevant API direction:

```text
POST /api/commerce/invite-request
```

Use `DY_COMMERCE_API_TOKEN` to authenticate commerce-side requests.

## Current Scale Direction

For hundreds to thousands of users:

- Do not rely on manually maintained Cloudflare Access email lists.
- Build formal member / invite-code / customer-plan management.
- Keep per-user MP4 concurrency to 1 active job.
- Keep a global renderer concurrency cap and queue excess work.
- Add clear queue position and estimated wait time.
- Scale renderer horizontally with multiple container instances.
- Keep upload size limits and rate limits.
- Maintain logs, monitoring, and error alerts.

## Known Follow-Up Checks

1. Deploy main Worker after `bb6bd8d`.
2. On iPhone/Android, export a new MP4 and use direct download.
3. Confirm downloaded file remains HEVC/H.265 60fps and does not become H.264 30fps.
4. If stutter remains, inspect the downloaded file with:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration -of default=noprint_wrappers=1:nokey=0 /path/to/file.mp4
```

5. If the R2 original is smooth but downloaded phone file is not, the remaining issue is client download/save/share conversion, not renderer output.

