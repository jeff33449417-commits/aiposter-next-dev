# AI Poster V1 Checkpoint

Saved at: 2026-06-26 23:30 Asia/Taipei

## Repository

- GitHub: `https://github.com/jeff33449417-commits/aiposter-next-dev.git`
- Branch saved: `main`
- V1 commit: `4723f51 Rename last export label`
- Production app worker: `aiposter-new`
- Renderer worker: `aiposter-renderer`

## Production Domains

- Main app:
  - `https://my.aiposter.jp`
  - `https://my.aiposter.tw`
- Renderer:
  - `https://renderer.aiposter.jp`

The main app remains behind Cloudflare Access, which is expected for this beta/admin workflow.

## V1 Features Completed

- Cloudflare deployment:
  - D1 database: `aiposter`
  - R2 bucket: `aiposter-assets`
  - KV namespace: `APP_KV`
  - Queue: `aiposter-jobs`
  - Cloudflare Access protection on main app domains
- Admin/customer control foundation:
  - Users are derived from Cloudflare Access email.
  - Admin UI exists at `/admin`.
  - App versions, assignments, plans, and feature flags are backed by D1.
- Poster editor:
  - Image/video/text clip placement.
  - Crop/cut controls.
  - Video editing screen.
  - Export panel.
- H.265 MP4 export:
  - Browser records WebM preview.
  - Source WebM is stored in R2.
  - Export job is stored in D1.
  - Queue consumer processes export jobs.
  - Renderer converts WebM to H.265 MP4 using FFmpeg/libx265.
  - MP4 is stored in R2 at:
    - `users/{owner_user_id}/exports/{job_id}/ai_poster_h265.mp4`
  - Authenticated download route:
    - `/api/jobs/:jobId/output`
- Renderer production verification:
  - `https://renderer.aiposter.jp/health` returns 200.
  - Smoke test confirmed output:
    - `codec_name=hevc`
    - `codec_tag_string=hvc1`
    - `pix_fmt=yuv420p`
- UI polish:
  - "編輯完成" button shows blue "請稍後" processing state after click.
  - Export panel label changed to "上次處理文件".

## Important Production Secrets

Do not store secret values in git.

- GitHub repository secret:
  - `CLOUDFLARE_API_TOKEN`
- Cloudflare Worker secrets:
  - `aiposter-new`: `RENDERER_URL`, `RENDERER_TOKEN`
  - `aiposter-renderer`: `RENDERER_TOKEN`

## Current Deployment Notes

- `aiposter-new` latest deployed version after V1 UI copy change:
  - `34076656-06ed-4244-92db-c764168243aa`
- `aiposter-renderer` latest Worker-only fix deployed with:
  - `--containers-rollout=none`
  - Container image was already active.
- `wrangler containers list` showed:
  - `aiposter-renderer-aiposterrenderer`
  - state: `active`
  - live instances: `3`

## Known V1 Limitations

- UI is still a single large `public/index.html`.
- Export status polling only shows the latest export job.
- Queue processing is single-job batch (`max_batch_size: 1`) for safer H.265 rendering.
- Legacy jobs created before renderer connection may still show `waiting_renderer`.
- Video editor and poster preview need more production UX refinement in V2.

## Suggested V2 Directions

1. Split frontend into clearer modules or migrate to a frontend build system.
2. Improve export job history, retry, cancel, and progress states.
3. Add true project/version management for client workflows.
4. Add invite codes, Turnstile, and rate limits for safer onboarding.
5. Add Gmail/Google Workspace intake flow for customer requirements.
6. Improve renderer observability and automated smoke tests in GitHub Actions.

