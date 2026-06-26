# AI Poster Next Dev

Follow-up development workspace for AI Poster.

## What This Version Adds

- Keeps the deployed Cloudflare Worker app and admin UI from the checkpoint.
- Adds a real H.265 MP4 renderer contract.
- Adds a local/container Node renderer that shells out to FFmpeg `libx265`.
- Changes export jobs so the Worker:
  - stores the browser-recorded WebM preview in R2,
  - sends that private R2 object to the renderer,
  - stores the returned H.265 MP4 in R2,
  - exposes the final MP4 through `/api/jobs/:jobId/output`.

## Renderer API

The Worker sends:

```http
POST /render
Content-Type: video/webm
Authorization: Bearer <RENDERER_TOKEN>
X-Aiposter-Job-Id: job_...
X-Aiposter-Frame-Rate: 60
```

The renderer returns either:

- `200 video/mp4` with the converted H.265 MP4 bytes, or
- JSON error payload with a non-2xx status.

## Run Renderer Locally

Requires `ffmpeg` with `libx265` support installed.

```bash
RENDERER_TOKEN=local-dev-token npm run renderer
```

Health check:

```bash
curl http://127.0.0.1:8788/health
```

Manual render test:

```bash
curl -X POST http://127.0.0.1:8788/render \
  -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: video/webm" \
  --data-binary @sample.webm \
  --output sample-h265.mp4
```

## Run Renderer With Docker

```bash
docker build -t aiposter-renderer ./renderer
docker run --rm -p 8788:8788 \
  -e RENDERER_TOKEN=local-dev-token \
  aiposter-renderer
```

## Deploy Renderer On Cloudflare Containers

This repo includes a separate Worker config for the renderer proxy:

- Worker config: `wrangler.renderer.jsonc`
- Worker entry: `src/renderer-worker.js`
- Container image: `renderer/Dockerfile`
- Custom domain: `https://renderer.aiposter.jp`

The proxy validates `RENDERER_TOKEN`, starts a Cloudflare Container, and forwards `/render` to the FFmpeg service inside the container.

```bash
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler secret put RENDERER_TOKEN --config wrangler.renderer.jsonc
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler deploy --config wrangler.renderer.jsonc
```

After deploy, use this main app `RENDERER_URL`:

```text
https://renderer.aiposter.jp/render
```

If the current machine does not have Docker installed, use the GitHub Actions workflow:

```text
.github/workflows/deploy-renderer.yml
```

Required GitHub secret:

```text
CLOUDFLARE_API_TOKEN
```

The workflow deploys the renderer Worker/Container, stores `https://renderer.aiposter.jp/render` as `RENDERER_URL` on the main Worker, and optionally redeploys the main Worker.

Recommended Cloudflare API token permissions for the GitHub secret:

```text
Account / Workers Scripts / Edit
Account / Workers KV Storage / Edit
Account / D1 / Edit
Account / Queues / Edit
Account / Containers / Edit
Account / Cloudchamber / Edit
Zone / Zone / Read
Zone / Workers Routes / Edit
```

Limit the token to account `6791879effd82436b651aac6abafebbe` and the zones:

```text
aiposter.jp
aiposter.tw
```

If Cloudflare's token UI does not show one of the container-related permissions, create a broader temporary token for the first deployment, run the workflow once, then replace it with a narrower token after deployment is confirmed.

After adding the secret, run:

```text
GitHub repo -> Actions -> Deploy AI Poster Renderer -> Run workflow
```

If it fails, open the failed run and check the failing step name first. The most likely failures are:

- `Deploy renderer Worker and Container`: missing Docker support on the runner, missing Containers permission, or Cloudflare Containers beta not enabled.
- `Set main Worker RENDERER_URL`: token is missing Workers Scripts edit permission.
- `Deploy main Worker`: token is missing one of the existing app binding permissions, such as D1, KV, Queues, R2, or route access.

## Worker Configuration

Set these secrets/vars for the Cloudflare Worker:

```bash
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler secret put RENDERER_TOKEN
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler secret put RENDERER_URL
NPM_CONFIG_CACHE=.npm-cache npx --yes wrangler deploy
```

Use a renderer URL that points directly to the render endpoint, for example:

```text
https://renderer.aiposter.jp/render
```

For beta, keep Cloudflare Access around the app. The renderer should be separately protected by `RENDERER_TOKEN` and network policy where it is hosted.

## Notes

- The Worker currently starts rendering with `ctx.waitUntil()` after job creation, so it does not depend on the Queue consumer being registered.
- The existing Queue consumer path still calls the same renderer function and can be used later when the Cloudflare Queue permission issue is resolved.
- Very large or long videos should eventually move to a dedicated async renderer that pulls work from a durable queue and calls back to a Worker endpoint. This version is the smallest end-to-end path for beta H.265 output.
