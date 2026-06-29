# AI Poster Production Guardrails

This checklist is for enabling the commercial protections that sit around the
AI Poster Workers app.

## 1. Turnstile

Create a Cloudflare Turnstile widget for the app domains:

- `my.aiposter.jp`
- `my.aiposter.tw`

Recommended widget behavior:

- Use an invisible or managed widget.
- Keep the site key public.
- Keep the secret key private.

Configure the main Worker `aiposter-new`:

- Variable: `TURNSTILE_SITE_KEY=<Cloudflare Turnstile site key>`
- Secret: `TURNSTILE_SECRET_KEY=<Cloudflare Turnstile secret key>`

The frontend reads the site key from `/api/me`. Uploads and MP4 export
submissions send a Turnstile token. The Worker validates that token with
Cloudflare Siteverify before accepting the request.

Reference:

- Cloudflare Turnstile server-side validation:
  https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

If `TURNSTILE_SECRET_KEY` is not set, the app keeps working without Turnstile.
This makes the code safe to deploy before the Cloudflare dashboard setup is
finished.

## 2. Worker Rate Limits

The Worker enforces per-user limits with `APP_KV`:

- `POST /api/assets`: `UPLOAD_RATE_LIMIT_PER_MINUTE`, default `12`
- `POST /api/jobs/export`: `EXPORT_RATE_LIMIT_PER_MINUTE`, default `6`
- Window: `RATE_LIMIT_WINDOW_SECONDS`, default `60`

These are app-level limits. They protect authenticated users and are still
active even if Cloudflare WAF rules are not configured.

## 3. Cloudflare WAF Rate Limiting

Add WAF rate limiting rules in front of the API for another protection layer.
Start in Log mode if you want to observe real traffic first, then switch to
Block.

Export rule:

```txt
(http.host in {"my.aiposter.jp" "my.aiposter.tw"} and http.request.method eq "POST" and http.request.uri.path eq "/api/jobs/export")
```

Suggested limit:

- Count: `6`
- Period: `60 seconds`
- Mitigation: Log first, then Block

Upload rule:

```txt
(http.host in {"my.aiposter.jp" "my.aiposter.tw"} and http.request.method eq "POST" and http.request.uri.path eq "/api/assets")
```

Suggested limit:

- Count: `12`
- Period: `60 seconds`
- Mitigation: Log first, then Block

If the Cloudflare plan only allows one rate limit rule, keep the Worker-level
limits enabled and create the WAF rule for `/api/jobs/export` first. MP4 export
is the expensive path.

Reference:

- Cloudflare WAF rate limiting rules:
  https://developers.cloudflare.com/waf/rate-limiting-rules/

## 4. Existing MP4 Guardrails

These protections already exist in the app:

- One active MP4 export per user.
- Global export backlog limit via `EXPORT_BACKLOG_LIMIT`, currently `50`.
- Queue ETA via `EXPORT_SECONDS_PER_JOB`, currently `120`.
- Stale job timeout via `EXPORT_JOB_TIMEOUT_MINUTES`, currently `45`.
- Video upload cap via `MAX_VIDEO_UPLOAD_MB`, currently `10`.
- D1 unique index prevents duplicate active exports per user.

## 5. Observability

Workers Observability should stay enabled for the main Worker and renderer.
The app logs structured JSON events:

- `asset_uploaded`
- `export_job_created`
- `export_job_status`
- `stale_export_jobs_failed`
- `rate_limited`
- `turnstile_verify_error`
- `turnstile_rejected`

Use these logs when an export appears stuck or users report repeated failures.

## 6. Validation

Before deploying:

```bash
npm run check
npm test
NPM_CONFIG_CACHE=.npm-cache npx wrangler@4 deploy --dry-run --outdir .wrangler/dryrun
```

Deploy after merging:

1. Open GitHub Actions.
2. Select **Deploy AI Poster Main App**.
3. Click **Run workflow**.
4. Use `v2-dev` as the ref after PR merge.
5. Confirm the deploy completes successfully.

After deployment:

1. Open the app through Cloudflare Access.
2. Upload a small image.
3. Upload a small video under 10 MB.
4. Submit one MP4 export.
5. Try submitting another MP4 while the first is active; it should be rejected.
6. Confirm the output is an `.mp4`.
7. Check Workers logs for `export_job_created` and `export_job_status`.
