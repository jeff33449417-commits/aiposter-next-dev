# AI Poster Claude Code Handoff

This repository is the AI Poster V2 Cloudflare app. Read this file before
editing. Keep changes small, testable, and easy to deploy.

## Current Project State

- Main app Worker: `aiposter-new`
- Production app URLs: `https://my.aiposter.jp`, `https://my.aiposter.tw`
- Renderer URL: `https://renderer.aiposter.jp/render`
- Active branch: `v2-dev`
- Current synced commit: `d04c23a Stabilize export frame cadence`
- GitHub repo: `jeff33449417-commits/aiposter-next-dev`

The app is deployed on Cloudflare Workers with static assets, D1, KV, R2,
Queues, and a separate renderer Worker/Container for H.265 MP4 output.

## Important Local Status

At the time of this handoff, the working tree has one uncommitted change:

- `wrangler.jsonc` has removed `TURNSTILE_ENABLED` and `TURNSTILE_SITE_KEY`
  from `vars`.

Do not blindly revert it. The backend only enables Turnstile when
`TURNSTILE_ENABLED` is exactly `"true"`, so removing the var keeps Turnstile
disabled. The user explicitly does not want visible human verification or
Turnstile timeout messages in the app.

## Source Map

- `src/index.js` - main Cloudflare Worker API, admin UI, queue consumer, MP4
  job coordination, R2/D1/KV access.
- `public/index.html` - shell markup only.
- `public/js/app.js` - frontend editor, upload flow, queue polling, preview
  recording, MP4 download behavior.
- `public/js/products.js` - AI Poster product size list.
- `public/styles.css` - frontend styles and mobile layout.
- `renderer/server.js` - Node/FFmpeg renderer service.
- `renderer/Dockerfile` - renderer container image.
- `src/renderer-worker.js` - Cloudflare Container proxy for renderer.
- `wrangler.jsonc` - main app Worker config.
- `wrangler.renderer.jsonc` - renderer Worker/Container config.
- `migrations/` - D1 schema and queue guardrail migrations.
- `scripts/check.mjs` - structural checks and JS syntax validation.
- `tests/` - node:test coverage.
- `docs/production-guardrails.md` - commercial safety checklist.

## Validate Before Commit

Run these from the repo root:

```bash
npm run check
npm test
NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy --dry-run
```

Expected result:

- `npm run check` passes.
- `npm test` passes.
- Wrangler dry run exits with `--dry-run: exiting now.` and lists bindings.

## Deploy

Main app deploy:

```bash
NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy
```

Renderer deploy is normally done through GitHub Actions:

1. Open GitHub repo.
2. Go to Actions.
3. Select `Deploy AI Poster Renderer`.
4. Click `Run workflow`.
5. Branch/ref: `v2-dev`.
6. Keep main Worker redeploy enabled if the workflow asks.

Local renderer deploy may fail if Docker is not available on the machine.

## Known Product/UX Rules

- Output file must be `.mp4`, not `.html`.
- MP4 output is fixed at 15 seconds, 60 fps, 540p-ish long side
  (`EXPORT_MAX_LONG_SIDE = 960`).
- Upload limit is currently `MAX_VIDEO_UPLOAD_MB=10`.
- The user does not want visible Turnstile/human verification in the editor.
- The user does not want Turnstile timeout text shown in the UI.
- The app should show only the current export progress, not old/stale jobs.
- Mobile editing must remain usable for image/video/text layer move and scale.
- Export output should not jitter or shake.

## Commercial Guardrails Already Present

- Per-user upload rate limit.
- Per-user MP4 export rate limit.
- One active MP4 export per user.
- Global export backlog limit.
- Stale job timeout.
- D1 unique active-job index.
- Worker Observability logs.

## Useful Debug Endpoints

- `/api/health`
- `/api/me`
- `/api/jobs`
- `/api/jobs/:jobId`
- `/api/jobs/:jobId/output`
- `/admin` for admin UI, subject to admin role.

## Do Not Commit Secrets

Secrets must stay in Cloudflare/GitHub:

- `RENDERER_TOKEN`
- `RENDERER_URL`
- `TURNSTILE_SECRET_KEY`
- `CLOUDFLARE_API_TOKEN`

Never write real secret values into tracked files.

## Suggested Next Tasks

1. Decide whether to commit the current `wrangler.jsonc` Turnstile var removal.
2. Confirm no visible Turnstile appears on `my.aiposter.jp` and
   `my.aiposter.tw`.
3. Test a fresh mobile MP4 export after closing old browser tabs.
4. If old jobs still appear stuck, inspect D1 jobs and mark stale queued or
   processing jobs as failed.
5. If `/admin` or `/api/*` route behavior is wrong, inspect whether assets are
   intercepting routes before the Worker and adjust Wrangler routing only after
   a dry run.

