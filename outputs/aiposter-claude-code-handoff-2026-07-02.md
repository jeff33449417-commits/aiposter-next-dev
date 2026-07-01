# AI Poster Claude Code Handoff - 2026-07-02

## Purpose

This file is a safe handoff package for continuing AI Poster V2 work in Claude
Code or another coding assistant. It contains the current state, validation
commands, deployment notes, and the important cautions from recent development.

## Repository

- Local path: `/Users/jeff/Documents/Codex/2026-06-26/aiposter-next-dev`
- GitHub: `https://github.com/jeff33449417-commits/aiposter-next-dev`
- Active branch: `v2-dev`
- Current head: `d04c23a Stabilize export frame cadence`

## Production URLs

- Main JP app: `https://my.aiposter.jp`
- Main TW app: `https://my.aiposter.tw`
- Renderer endpoint: `https://renderer.aiposter.jp/render`

## Current Git Status

The tree is not fully clean. There is one local, uncommitted config change:

```diff
wrangler.jsonc
- TURNSTILE_ENABLED=false
- TURNSTILE_SITE_KEY=...
```

This change removes Turnstile vars from the main Worker config. It should not
be reverted casually because the user asked that human verification and timeout
messages not appear. In the backend, Turnstile is only active when
`TURNSTILE_ENABLED` is exactly `"true"`.

## Recent Completed Work

- Real H.265 MP4 renderer path connected.
- Renderer deployed through GitHub Actions.
- Main app deployed to Cloudflare Worker `aiposter-new`.
- MP4 output uses renderer at `renderer.aiposter.jp/render`.
- Frontend modularized into:
  - `public/index.html`
  - `public/js/app.js`
  - `public/js/products.js`
  - `public/styles.css`
- Mobile UX improved for preview and layer controls.
- Commercial guardrails added:
  - upload rate limit
  - export rate limit
  - one active export per user
  - global backlog limit
  - stale job timeout
  - D1 active export unique index
  - upload size cap
- Turnstile visible verification disabled/silenced in code.
- Export jitter fix added:
  - frontend uses a stable export frame layout snapshot
  - renderer uses `fps=${frameRate}` before scaling in ffmpeg

## Validation Commands

Run from the repository root:

```bash
npm run check
npm test
NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy --dry-run
```

Known good dry-run signal:

```text
--dry-run: exiting now.
```

Wrangler should list bindings for:

- `APP_KV`
- `JOBS_QUEUE`
- `DB`
- `ASSETS_BUCKET`
- `ASSETS`
- production vars

## Deployment Commands

Main Worker deploy:

```bash
NPM_CONFIG_CACHE=/private/tmp/codex-npm-cache npx wrangler deploy
```

Renderer deploy:

Use GitHub Actions:

```text
Actions -> Deploy AI Poster Renderer -> Run workflow -> v2-dev
```

The local machine may not have Docker available, so local renderer deploy can
fail even when GitHub Actions deployment works.

## Important Files

- `CLAUDE.md` - assistant instructions for this repo.
- `README.md` - renderer and deployment overview.
- `docs/production-guardrails.md` - commercial safety checklist.
- `src/index.js` - main Worker and API.
- `public/js/app.js` - frontend editor and export flow.
- `renderer/server.js` - ffmpeg H.265 renderer.
- `wrangler.jsonc` - main app config.
- `wrangler.renderer.jsonc` - renderer config.
- `scripts/check.mjs` - structural validation.
- `tests/app-structure.test.mjs` - behavior/structure tests.
- `tests/frontend-modular.test.mjs` - frontend modularization tests.

## User Requirements To Preserve

- Output must be `.mp4`, not `.html`.
- Download link label remains `下載 H.265 MP4`.
- No visible human verification widget in normal editing flow.
- No `防機器人驗證逾時...` message in the UI.
- Export progress should be current-job only, not old job history.
- Mobile editing must allow usable move/scale for text, image, and video layers.
- Mobile timeline handles must be easier to drag.
- Exported video/image should not jitter.
- MP4 output fixed to 15 seconds, 60fps, 540p-ish long side.
- Upload size limit is currently 10 MB.

## Cloudflare Setup Notes

Main Worker `aiposter-new` has:

- D1 database: `aiposter`
- R2 bucket: `aiposter-assets`
- KV namespace: `APP_KV`
- Queue: `aiposter-jobs`
- Custom domains:
  - `my.aiposter.jp`
  - `my.aiposter.tw`

Secrets should exist in Cloudflare, not in git:

- `RENDERER_TOKEN`
- `RENDERER_URL`
- `TURNSTILE_SECRET_KEY`

GitHub Actions secret:

- `CLOUDFLARE_API_TOKEN`

## Known Issues / Watch Items

1. The current local `wrangler.jsonc` diff needs a decision:
   - commit it if Turnstile should stay fully disabled by config
   - or revert it only if the product decision changes

2. If users see old `輸出中` or `排隊中` after deployment:
   - close old mobile browser tabs
   - start a new export
   - inspect stale jobs in D1 if the old state persists

3. If `/admin` or `/api/*` fails while static assets work:
   - check whether Cloudflare routing sends those paths to the Worker before
     assets
   - validate any `run_worker_first` style config with dry-run before deploy

4. If Android video export is blank:
   - inspect whether the video element has decoded frames before drawImage
   - keep video sources mounted/playable during export
   - fail clearly rather than emitting blank frames

5. If output shakes:
   - keep export canvas layout frozen per job
   - avoid reading live DOM measurements per frame
   - keep ffmpeg fps filter before scaling

## Suggested Claude Code Prompt

Paste this into Claude Code after opening the repo:

```text
Please read CLAUDE.md and outputs/aiposter-claude-code-handoff-2026-07-02.md first.
Continue AI Poster V2 development on branch v2-dev. Do not commit secrets.
Before changing behavior, run git status and inspect current wrangler.jsonc diff.
Preserve: no visible Turnstile, MP4 output only, 15s/60fps/540p-ish export,
mobile editing usability, and no jitter in exports.
For every code change, run npm run check, npm test, and wrangler deploy --dry-run.
Do not deploy until I explicitly ask.
```

