const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const ACTIVE_EXPORT_STATUSES = ["queued", "processing", "waiting_renderer"];
const DEFAULT_EXPORT_BACKLOG_LIMIT = 50;
const DEFAULT_EXPORT_SECONDS_PER_JOB = 120;
const DEFAULT_VIDEO_UPLOAD_MB = 10;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_UPLOAD_RATE_LIMIT_PER_MINUTE = 12;
const DEFAULT_EXPORT_RATE_LIMIT_PER_MINUTE = 6;
const DEFAULT_COMMERCE_INVITE_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_COMMERCE_ALLOWED_ORIGINS = ["https://dy.com.tw", "https://www.dy.com.tw"];
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function envNumber(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...jsonHeaders,
      ...(init.headers || {})
    }
  });
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
}

function commerceAllowedOrigins(env) {
  const configured = String(env.DY_COMMERCE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_COMMERCE_ALLOWED_ORIGINS;
}

function commerceCorsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!origin || !commerceAllowedOrigins(env).includes(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, idempotency-key, x-aiposter-commerce-token",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function commerceOriginForbidden(request, env) {
  const origin = request.headers.get("origin") || "";
  return Boolean(origin && !commerceAllowedOrigins(env).includes(origin));
}

function getAccessEmail(request) {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  return email ? email.trim().toLowerCase() : "";
}

function turnstileEnabled(env) {
  return String(env.TURNSTILE_ENABLED || "").trim().toLowerCase() === "true";
}

function publicSecurityConfig(env) {
  const turnstileSiteKey = (env.TURNSTILE_SITE_KEY || "").trim();
  const enabled = turnstileEnabled(env) && Boolean(turnstileSiteKey);
  return {
    turnstile: {
      enabled,
      required: enabled && Boolean((env.TURNSTILE_SECRET_KEY || "").trim()),
      siteKey: enabled ? turnstileSiteKey : ""
    }
  };
}

async function enforceRateLimit(env, request, user, scope, envVarName, fallbackLimit, extraHeaders = {}) {
  if (!env.APP_KV) {
    return null;
  }

  const limit = envNumber(env, envVarName, fallbackLimit);
  const windowSeconds = envNumber(env, "RATE_LIMIT_WINDOW_SECONDS", DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
  const identity = user?.id || clientIp(request) || "anonymous";
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rate:${scope}:${identity}:${bucket}`;
  const current = Number(await env.APP_KV.get(key) || 0) + 1;

  await env.APP_KV.put(key, String(current), { expirationTtl: Math.max(60, windowSeconds + 30) });

  if (current <= limit) {
    return null;
  }

  console.warn(JSON.stringify({
    event: "rate_limited",
    scope,
    identity,
    limit,
    windowSeconds,
    ray: request.headers.get("cf-ray") || ""
  }));

  return json({
    ok: false,
    code: "RATE_LIMITED",
    message: "操作太頻繁，請稍後再試。",
    retryAfterSeconds: windowSeconds
  }, {
    status: 429,
    headers: {
      ...extraHeaders,
      "retry-after": String(windowSeconds)
    }
  });
}

async function requireTurnstile(env, request, token, user, action) {
  if (!turnstileEnabled(env)) {
    return null;
  }

  const secret = (env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    return null;
  }

  if (!token || typeof token !== "string") {
    return json({
      ok: false,
      code: "TURNSTILE_REQUIRED",
      message: "請先完成防機器人驗證後再送出。"
    }, { status: 403 });
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  const remoteIp = clientIp(request);
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  let data = null;
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    data = await response.json();
  } catch (error) {
    console.warn(JSON.stringify({
      event: "turnstile_verify_error",
      action,
      userId: user?.id || null,
      message: error.message || "Turnstile verification failed"
    }));
    return json({
      ok: false,
      code: "TURNSTILE_UNAVAILABLE",
      message: "防機器人驗證暫時無法使用，請稍後再試。"
    }, { status: 503 });
  }

  if (data?.success) {
    return null;
  }

  console.warn(JSON.stringify({
    event: "turnstile_rejected",
    action,
    userId: user?.id || null,
    errors: data?.["error-codes"] || []
  }));

  return json({
    ok: false,
    code: "TURNSTILE_REJECTED",
    message: "防機器人驗證未通過，請重新操作一次。"
  }, { status: 403 });
}

function userIdFromEmail(email) {
  return `user_${email.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function parseJsonObject(value, fallback = {}) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function sha256Bytes(value) {
  const encoded = new TextEncoder().encode(String(value || ""));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

async function timingSafeSecretEqual(provided, expected) {
  const [left, right] = await Promise.all([
    sha256Bytes(provided),
    sha256Bytes(expected)
  ]);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function isSchemaMissing(error) {
  return /no such table|no such column/i.test(error?.message || "");
}

async function dbAll(env, statement, bindings = []) {
  return env.DB.prepare(statement).bind(...bindings).all();
}

async function dbFirst(env, statement, bindings = []) {
  return env.DB.prepare(statement).bind(...bindings).first();
}

async function safeAll(env, statement, bindings = []) {
  try {
    return await dbAll(env, statement, bindings);
  } catch (error) {
    if (isSchemaMissing(error)) {
      return { results: [] };
    }
    throw error;
  }
}

async function safeFirst(env, statement, bindings = []) {
  try {
    return await dbFirst(env, statement, bindings);
  } catch (error) {
    if (isSchemaMissing(error)) {
      return null;
    }
    throw error;
  }
}

function outputUrlForJob(job) {
  return job?.output_r2_key ? `/api/jobs/${encodeURIComponent(job.id)}/output` : null;
}

function serializeJob(row) {
  const input = parseJsonObject(row.input_json);
  return {
    ...row,
    input,
    sourceAssetUrl: input.settings?.sourceAssetUrl || null,
    outputUrl: outputUrlForJob(row),
    outputFilename: row?.output_r2_key ? `${row.id}_60frame_h265.mp4` : null
  };
}

function serializeJobWithQueue(row, queueInfo = null) {
  const job = serializeJob(row);
  if (queueInfo) {
    job.queue = queueInfo;
  }
  return job;
}

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function normalizeInviteCode(code) {
  return (code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "")
    .slice(0, 64);
}

function randomHex(bytes = 8) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function generateInviteCode() {
  return `AIP-${randomHex(6).toUpperCase()}`;
}

function normalizeCustomerId(value, fallbackName = "customer") {
  const base = (value || fallbackName || "customer")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "customer";
  return base.startsWith("customer_") ? base : `customer_${base}`;
}

async function getAssignmentForEmail(env, email) {
  if (!email) {
    return null;
  }

  return env.DB.prepare(
    `SELECT email, display_name, app_version_id, plan, role, status, feature_overrides_json, notes, created_at, updated_at
     FROM user_app_assignments
     WHERE email = ? AND status = 'active'`
  ).bind(normalizeEmail(email)).first();
}

async function getAppVersion(env, id) {
  let row = null;
  if (id) {
    row = await env.DB.prepare(
      `SELECT id, name, description, config_json, is_default, created_at, updated_at
       FROM app_versions
       WHERE id = ?`
    ).bind(id).first();
  }

  if (!row) {
    row = await env.DB.prepare(
      `SELECT id, name, description, config_json, is_default, created_at, updated_at
       FROM app_versions
       WHERE is_default = 1
       ORDER BY updated_at DESC
       LIMIT 1`
    ).first();
  }

  if (!row) {
    return {
      id: "default",
      name: "AI Poster Default",
      description: "Default configuration",
      config_json: "{}",
      is_default: 1
    };
  }

  return row;
}

async function getOrCreateUser(request, env) {
  const email = normalizeEmail(getAccessEmail(request));
  if (!email) {
    return null;
  }

  const id = userIdFromEmail(email);
  const ownerEmail = (env.OWNER_EMAIL || "").trim().toLowerCase();
  const isOwner = ownerEmail && email === ownerEmail;
  const assignment = await getAssignmentForEmail(env, email);
  const role = isOwner ? "admin" : (assignment?.role || "beta_user");
  const plan = isOwner ? "pro" : (assignment?.plan || "beta");
  const displayName = assignment?.display_name || email;
  const status = assignment?.status || "active";

  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
      (id, email, display_name, role, plan, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, email, displayName, role, plan, status).run();

  await env.DB.prepare(
    `UPDATE users
     SET display_name = ?, role = ?, plan = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(displayName, role, plan, status, id).run();

  return env.DB.prepare(
    `SELECT id, email, display_name, role, plan, status, created_at, updated_at
     FROM users
     WHERE id = ? AND status = 'active'`
  ).bind(id).first();
}

async function getFeaturePayload(env, user) {
  const plan = user?.plan || "free";
  const assignment = user ? await getAssignmentForEmail(env, user.email) : null;
  const appVersion = await getAppVersion(env, assignment?.app_version_id || "default");
  const planFeatureRows = await env.DB.prepare(
    `SELECT feature_name, enabled FROM plan_features WHERE plan = ?`
  ).bind(plan).all();
  const limitRow = await env.DB.prepare(
    `SELECT projects, exports_per_day, ai_jobs_per_day, max_upload_mb
     FROM plan_limits WHERE plan = ?`
  ).bind(plan).first();

  const features = {};
  for (const row of planFeatureRows.results || []) {
    features[row.feature_name] = Boolean(row.enabled);
  }

  if (user) {
    const overrides = await env.DB.prepare(
      `SELECT feature_name, enabled
       FROM user_feature_overrides
       WHERE user_id = ?`
    ).bind(user.id).all();
    for (const row of overrides.results || []) {
      features[row.feature_name] = Boolean(row.enabled);
    }

    const assignmentOverrides = parseJsonObject(assignment?.feature_overrides_json);
    for (const [featureName, enabled] of Object.entries(assignmentOverrides)) {
      features[featureName] = Boolean(enabled);
    }
  }

  return {
    authenticated: Boolean(user),
    security: publicSecurityConfig(env),
    user: user ? {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      plan: user.plan
    } : null,
    assignment: assignment ? {
      email: assignment.email,
      displayName: assignment.display_name,
      appVersionId: assignment.app_version_id,
      plan: assignment.plan,
      role: assignment.role,
      status: assignment.status,
      notes: assignment.notes,
      featureOverrides: parseJsonObject(assignment.feature_overrides_json)
    } : null,
    appVersion: {
      id: appVersion.id,
      name: appVersion.name,
      description: appVersion.description,
      isDefault: Boolean(appVersion.is_default),
      config: parseJsonObject(appVersion.config_json)
    },
    features,
    limits: limitRow || {
      projects: 3,
      exports_per_day: 2,
      ai_jobs_per_day: 5,
      max_upload_mb: 25
    }
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleProjects(request, env, user) {
  if (!user) {
    return json({
      ok: false,
      code: "ACCESS_REQUIRED",
      message: "Cloudflare Access login is required before project data can be used."
    }, { status: 401 });
  }

  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, title, settings_json, created_at, updated_at
       FROM projects
       WHERE owner_user_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 100`
    ).bind(user.id).all();

    return json({
      ok: true,
      projects: (rows.results || []).map((row) => ({
        id: row.id,
        title: row.title,
        settings: JSON.parse(row.settings_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.title !== "string" || typeof body.settings !== "object") {
      return json({
        ok: false,
        code: "INVALID_PROJECT_PAYLOAD",
        message: "Project payload must include title and settings."
      }, { status: 400 });
    }

    const id = `project_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO projects
        (id, owner_user_id, title, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(id, user.id, body.title.slice(0, 120), JSON.stringify(body.settings)).run();

    return json({ ok: true, id }, { status: 201 });
  }

  return json({
    ok: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Only GET and POST are allowed for projects."
  }, { status: 405, headers: { allow: "GET, POST" } });
}

function requireUser(user) {
  if (user) {
    return null;
  }

  return json({
    ok: false,
    code: "ACCESS_REQUIRED",
    message: "Cloudflare Access login is required before this API can be used."
  }, { status: 401 });
}

async function userOwnsProject(env, user, projectId) {
  if (!projectId) {
    return true;
  }

  const project = await env.DB.prepare(
    `SELECT id FROM projects
     WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
  ).bind(projectId, user.id).first();

  return Boolean(project);
}

function activeStatusPlaceholders() {
  return ACTIVE_EXPORT_STATUSES.map(() => "?").join(", ");
}

async function cleanupStaleExportJobs(env) {
  const timeoutMinutes = envNumber(env, "EXPORT_JOB_TIMEOUT_MINUTES", 45);
  const result = await env.DB.prepare(
    `UPDATE jobs
     SET status = 'failed',
         error_message = 'Timed out while waiting for MP4 export. Please submit a new export.',
         updated_at = datetime('now')
     WHERE type = 'export_h265'
       AND status IN (${activeStatusPlaceholders()})
       AND datetime(updated_at) < datetime('now', ?)`
  ).bind(...ACTIVE_EXPORT_STATUSES, `-${timeoutMinutes} minutes`).run();

  const changed = Number(result?.meta?.changes || 0);
  if (changed > 0) {
    console.warn(JSON.stringify({
      event: "stale_export_jobs_failed",
      count: changed,
      timeoutMinutes
    }));
  }
}

async function getActiveExportForUser(env, userId) {
  return env.DB.prepare(
    `SELECT id, project_id, type, status, input_json, output_r2_key, error_message, created_at, updated_at
     FROM jobs
     WHERE owner_user_id = ?
       AND type = 'export_h265'
       AND status IN (${activeStatusPlaceholders()})
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(userId, ...ACTIVE_EXPORT_STATUSES).first();
}

async function countActiveExports(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM jobs
     WHERE type = 'export_h265'
       AND status IN (${activeStatusPlaceholders()})`
  ).bind(...ACTIVE_EXPORT_STATUSES).first();
  return Number(row?.count || 0);
}

async function countDailyExports(env, userId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM jobs
     WHERE owner_user_id = ?
       AND type = 'export_h265'
       AND date(created_at) = date('now')`
  ).bind(userId).first();
  return Number(row?.count || 0);
}

async function exportQueueInfo(env, job) {
  if (!job || !ACTIVE_EXPORT_STATUSES.includes(job.status)) {
    return null;
  }

  const activeJobs = await env.DB.prepare(
    `SELECT id, status, created_at, updated_at
     FROM jobs
     WHERE type = 'export_h265'
       AND status IN (${activeStatusPlaceholders()})
     ORDER BY created_at ASC`
  ).bind(...ACTIVE_EXPORT_STATUSES).all();

  const jobsList = activeJobs.results || [];
  const currentIndex = jobsList.findIndex(j => j.id === job.id);
  
  if (currentIndex === -1) {
    const secondsPerJob = envNumber(env, "EXPORT_SECONDS_PER_JOB", DEFAULT_EXPORT_SECONDS_PER_JOB);
    return {
      position: 1,
      ahead: 0,
      estimatedSeconds: secondsPerJob
    };
  }

  const secondsPerJob = envNumber(env, "EXPORT_SECONDS_PER_JOB", DEFAULT_EXPORT_SECONDS_PER_JOB);
  let totalEstimatedRemaining = 0;

  for (let i = 0; i <= currentIndex; i++) {
    const j = jobsList[i];
    if (j.status === 'processing') {
      const updatedAtStr = j.updated_at ? j.updated_at.replace(' ', 'T') + 'Z' : new Date().toISOString();
      const updatedAtMs = new Date(updatedAtStr).getTime();
      const nowMs = Date.now();
      const elapsedSeconds = Math.max(0, (nowMs - updatedAtMs) / 1000);
      const remainingSeconds = Math.max(10, secondsPerJob - elapsedSeconds);
      totalEstimatedRemaining += remainingSeconds;
    } else {
      totalEstimatedRemaining += secondsPerJob;
    }
  }

  return {
    position: currentIndex + 1,
    ahead: currentIndex,
    estimatedSeconds: Math.max(10, Math.round(totalEstimatedRemaining))
  };
}

async function serializeJobForResponse(env, row) {
  return serializeJobWithQueue(row, await exportQueueInfo(env, row));
}

async function createSystemAlert(env, severity, source, title, message, options = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO system_alerts
        (id, severity, source, title, message, status, related_job_id, related_email, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, datetime('now'))`
    ).bind(
      `alert_${crypto.randomUUID()}`,
      severity || "warning",
      source || "worker",
      String(title || "System alert").slice(0, 160),
      String(message || "").slice(0, 2000),
      options.jobId || null,
      normalizeEmail(options.email) || null
    ).run();
  } catch (error) {
    if (!isSchemaMissing(error)) {
      console.warn(JSON.stringify({
        event: "system_alert_write_failed",
        title,
        message: error.message || "Unable to write alert"
      }));
    }
  }
}

async function getRendererEndpoint(env) {
  const worker = await safeFirst(
    env,
    `SELECT id, name, endpoint_url, active_jobs, max_concurrent_jobs
     FROM export_workers
     WHERE status = 'active'
       AND TRIM(endpoint_url) != ''
       AND (max_concurrent_jobs <= 0 OR active_jobs < max_concurrent_jobs)
     ORDER BY active_jobs ASC, weight DESC, updated_at ASC
     LIMIT 1`
  );

  if (worker?.endpoint_url) {
    return {
      url: worker.endpoint_url.trim(),
      workerId: worker.id,
      name: worker.name,
      token: env.RENDERER_TOKEN || ""
    };
  }

  const fallbackUrl = (env.RENDERER_URL || "").trim();
  return fallbackUrl
    ? { url: fallbackUrl, workerId: null, name: "RENDERER_URL", token: env.RENDERER_TOKEN || "" }
    : null;
}

async function rendererAvailable(env) {
  return Boolean(await getRendererEndpoint(env));
}

async function bumpRendererActiveJobs(env, workerId, delta) {
  if (!workerId) {
    return;
  }

  try {
    await env.DB.prepare(
      `UPDATE export_workers
       SET active_jobs = MAX(0, active_jobs + ?),
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(delta, workerId).run();
  } catch (error) {
    if (!isSchemaMissing(error)) {
      throw error;
    }
  }
}

async function handleJobs(request, env, user) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for jobs."
    }, { status: 405, headers: { allow: "GET" } });
  }

  await cleanupStaleExportJobs(env);
  const rows = await env.DB.prepare(
    `SELECT id, project_id, type, status, input_json, output_r2_key, error_message, created_at, updated_at
     FROM jobs
     WHERE owner_user_id = ?
     ORDER BY updated_at DESC
     LIMIT 100`
  ).bind(user.id).all();

  return json({
    ok: true,
    jobs: await Promise.all((rows.results || []).map((row) => serializeJobForResponse(env, row)))
  });
}

async function handleJobById(request, env, user, jobId) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for a job."
    }, { status: 405, headers: { allow: "GET" } });
  }

  await cleanupStaleExportJobs(env);
  const job = await env.DB.prepare(
    `SELECT id, project_id, type, status, input_json, output_r2_key, error_message, created_at, updated_at
     FROM jobs
     WHERE id = ? AND owner_user_id = ?`
  ).bind(jobId, user.id).first();

  if (!job) {
    return json({
      ok: false,
      code: "JOB_NOT_FOUND",
      message: "Job was not found."
    }, { status: 404 });
  }

  return json({
    ok: true,
    job: await serializeJobForResponse(env, job)
  });
}

async function handleExportJob(request, env, user, ctx) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only POST is allowed for export jobs."
    }, { status: 405, headers: { allow: "POST" } });
  }

  const rateLimited = await enforceRateLimit(
    env,
    request,
    user,
    "export_submit",
    "EXPORT_RATE_LIMIT_PER_MINUTE",
    DEFAULT_EXPORT_RATE_LIMIT_PER_MINUTE
  );
  if (rateLimited) {
    return rateLimited;
  }

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return json({
      ok: false,
      code: "INVALID_EXPORT_PAYLOAD",
      message: "Export payload must be JSON."
    }, { status: 400 });
  }

  const turnstileRejected = await requireTurnstile(env, request, body.turnstileToken, user, "export");
  if (turnstileRejected) {
    return turnstileRejected;
  }

  const featurePayload = await getFeaturePayload(env, user);
  if (!featurePayload.features.h265_export) {
    return json({
      ok: false,
      code: "FEATURE_NOT_ENABLED",
      message: "H.265 export is not enabled for this user."
    }, { status: 403 });
  }

  await cleanupStaleExportJobs(env);
  const dailyExportCount = await countDailyExports(env, user.id);
  if (dailyExportCount >= Number(featurePayload.limits.exports_per_day || 0)) {
    return json({
      ok: false,
      code: "EXPORT_DAILY_LIMIT_REACHED",
      message: `今天的 MP4 輸出配額已用完，請明天再試。`
    }, { status: 429 });
  }

  const activeUserJob = await getActiveExportForUser(env, user.id);
  if (activeUserJob) {
    return json({
      ok: false,
      code: "ACTIVE_EXPORT_EXISTS",
      message: "你已經有一個 MP4 任務正在處理，請等它完成後再送出新的安排。",
      job: await serializeJobForResponse(env, activeUserJob)
    }, { status: 409 });
  }

  const activeExportCount = await countActiveExports(env);
  const backlogLimit = envNumber(env, "EXPORT_BACKLOG_LIMIT", DEFAULT_EXPORT_BACKLOG_LIMIT);
  if (activeExportCount >= backlogLimit) {
    const secondsPerJob = envNumber(env, "EXPORT_SECONDS_PER_JOB", DEFAULT_EXPORT_SECONDS_PER_JOB);
    return json({
      ok: false,
      code: "EXPORT_QUEUE_FULL",
      message: `目前 MP4 佇列已滿，請稍後再送出。`,
      queue: {
        active: activeExportCount,
        limit: backlogLimit,
        estimatedSeconds: activeExportCount * secondsPerJob
      }
    }, { status: 429 });
  }

  if (body.projectId && !(await userOwnsProject(env, user, body.projectId))) {
    return json({
      ok: false,
      code: "PROJECT_NOT_FOUND",
      message: "Project was not found for this user."
    }, { status: 404 });
  }

  const sourceAssetId = body.settings?.sourceAssetId;
  if (sourceAssetId) {
    const sourceAsset = await env.DB.prepare(
      `SELECT id, r2_key, mime_type, size_bytes FROM assets
       WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
    ).bind(sourceAssetId, user.id).first();

    if (!sourceAsset) {
      return json({
        ok: false,
        code: "SOURCE_ASSET_NOT_FOUND",
        message: "The source asset was not found for this user."
      }, { status: 404 });
    }

    const maxVideoBytes = envNumber(env, "MAX_VIDEO_UPLOAD_MB", DEFAULT_VIDEO_UPLOAD_MB) * 1024 * 1024;
    const isSystemPreview = /^ai_poster_preview\.(webm|mp4|mov)$/i.test(filenameFromR2Key(sourceAsset.r2_key));
    if ((sourceAsset.mime_type || "").startsWith("video/") && Number(sourceAsset.size_bytes || 0) > maxVideoBytes && !isSystemPreview) {
      return json({
        ok: false,
        code: "EXPORT_SOURCE_TOO_LARGE",
        message: `MP4 輸出素材超過 ${envNumber(env, "MAX_VIDEO_UPLOAD_MB", DEFAULT_VIDEO_UPLOAD_MB)}MB，請先壓縮或縮短影片。`
      }, { status: 413 });
    }
  }

  const jobId = `job_${crypto.randomUUID()}`;
  const hasRenderer = await rendererAvailable(env);
  const initialStatus = hasRenderer ? "queued" : "waiting_renderer";
  const initialError = hasRenderer
    ? null
    : "H.265 renderer service is not connected yet. Source asset is already stored in R2.";
  const input = {
    projectId: body.projectId || null,
    format: body.format || "h265",
    settings: body.settings || {},
    requestedAt: new Date().toISOString()
  };

  try {
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, owner_user_id, project_id, type, status, input_json, error_message, created_at, updated_at)
       VALUES (?, ?, ?, 'export_h265', ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(jobId, user.id, input.projectId, initialStatus, JSON.stringify(input), initialError).run();
    console.log(JSON.stringify({
      event: "export_job_created",
      jobId,
      userId: user.id,
      status: initialStatus,
      rendererEnabled: hasRenderer,
      activeExports: activeExportCount
    }));
  } catch (error) {
    const existingJob = await getActiveExportForUser(env, user.id);
    if (existingJob) {
      return json({
        ok: false,
        code: "ACTIVE_EXPORT_EXISTS",
        message: "你已經有一個 MP4 任務正在處理，請等它完成後再送出新的安排。",
        job: await serializeJobForResponse(env, existingJob)
      }, { status: 409 });
    }
    throw error;
  }

  if (hasRenderer) {
    if (env.JOBS_QUEUE) {
      await env.JOBS_QUEUE.send({ jobId }, { contentType: "json" });
    } else {
      const renderPromise = processExportJob(env, jobId);
      if (ctx?.waitUntil) {
        ctx.waitUntil(renderPromise);
      } else {
        await renderPromise;
      }
    }
  }

  return json({
    ok: true,
    job: {
      id: jobId,
      status: initialStatus,
      message: initialError,
      sourceAssetUrl: input.settings?.sourceAssetUrl || null,
      queue: hasRenderer
        ? {
            position: activeExportCount + 1,
            ahead: activeExportCount,
            estimatedSeconds: (activeExportCount + 1) * envNumber(env, "EXPORT_SECONDS_PER_JOB", DEFAULT_EXPORT_SECONDS_PER_JOB)
          }
        : null
    }
  }, { status: 202 });
}

async function markJob(env, jobId, status, errorMessage = null, outputR2Key = null) {
  await env.DB.prepare(
    `UPDATE jobs
     SET status = ?,
         error_message = ?,
         output_r2_key = COALESCE(?, output_r2_key),
         updated_at = datetime('now')
     WHERE id = ?
       AND status IN (${activeStatusPlaceholders()})`
  ).bind(status, errorMessage, outputR2Key, jobId, ...ACTIVE_EXPORT_STATUSES).run();

  console.log(JSON.stringify({
    event: "export_job_status",
    jobId,
    status,
    hasOutput: Boolean(outputR2Key),
    errorMessage: errorMessage || null
  }));
}

function buildExportOutputKey(job) {
  return `users/${job.owner_user_id}/exports/${job.id}/ai_poster_h265.mp4`;
}

async function getJobForQueue(env, jobId) {
  const job = await env.DB.prepare(
    `SELECT id, owner_user_id, project_id, type, status, input_json, output_r2_key, error_message
     FROM jobs
     WHERE id = ?`
  ).bind(jobId).first();

  if (!job) {
    return null;
  }

  return {
    ...job,
    input: parseJsonObject(job.input_json)
  };
}

async function processRendererResponse(env, job, response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    if (!response.ok) {
      await markJob(
        env,
        job.id,
        "failed",
        data.message || data.error || `Renderer returned HTTP ${response.status}`
      );
      return;
    }

    if (data.outputBase64) {
      const binary = Uint8Array.from(atob(data.outputBase64), (char) => char.charCodeAt(0));
      const outputKey = data.outputR2Key || buildExportOutputKey(job);
      await env.ASSETS_BUCKET.put(outputKey, binary, {
        httpMetadata: {
          contentType: "video/mp4"
        },
        customMetadata: {
          ownerUserId: job.owner_user_id,
          jobId: job.id,
          format: "h265"
        }
      });
      await markJob(env, job.id, "completed", data.message || null, outputKey);
      return;
    }

    await markJob(
      env,
      job.id,
      data.status || "processing",
      data.message || null,
      data.outputR2Key || null
    );
    return;
  }

  const body = await response.arrayBuffer();
  if (!response.ok) {
    const message = new TextDecoder().decode(body).slice(0, 500);
    await markJob(env, job.id, "failed", message || `Renderer returned HTTP ${response.status}`);
    return;
  }

  const outputKey = buildExportOutputKey(job);
  await env.ASSETS_BUCKET.put(outputKey, body, {
    httpMetadata: {
      contentType: "video/mp4"
    },
    customMetadata: {
      ownerUserId: job.owner_user_id,
      jobId: job.id,
      format: "h265"
    }
  });
  await markJob(env, job.id, "completed", null, outputKey);
}

async function processExportJob(env, jobId) {
  const job = await getJobForQueue(env, jobId);
  if (!job || !["queued", "processing"].includes(job.status)) {
    return;
  }

  const renderer = await getRendererEndpoint(env);
  if (!renderer?.url) {
    await markJob(
      env,
      jobId,
      "waiting_renderer",
      "H.265 renderer service is not connected yet. Source asset is already stored in R2."
    );
    await createSystemAlert(
      env,
      "warning",
      "renderer",
      "No renderer available",
      `Job ${jobId} is waiting because no active renderer endpoint is configured.`,
      { jobId }
    );
    return;
  }

  const sourceAssetId = job.input?.settings?.sourceAssetId;
  if (!sourceAssetId) {
    await markJob(env, jobId, "failed", "Missing source asset for H.265 export.");
    return;
  }

  const sourceAsset = await env.DB.prepare(
    `SELECT id, r2_key, mime_type
     FROM assets
     WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
  ).bind(sourceAssetId, job.owner_user_id).first();

  if (!sourceAsset) {
    await markJob(env, jobId, "failed", "Source asset was not found.");
    return;
  }

  const sourceObject = await env.ASSETS_BUCKET.get(sourceAsset.r2_key);
  if (!sourceObject) {
    await markJob(env, jobId, "failed", "Source asset object was not found in R2.");
    return;
  }

  await markJob(env, jobId, "processing", null);
  await bumpRendererActiveJobs(env, renderer.workerId, 1);

  try {
    const response = await fetch(renderer.url, {
      method: "POST",
      headers: {
        "content-type": sourceAsset.mime_type || "video/webm",
        "x-aiposter-job-id": job.id,
        "x-aiposter-owner-user-id": job.owner_user_id,
        "x-aiposter-renderer-worker-id": renderer.workerId || "",
        "x-aiposter-source-filename": filenameFromR2Key(sourceAsset.r2_key),
        "x-aiposter-duration-seconds": String(job.input?.settings?.durationSeconds || ""),
        "x-aiposter-frame-rate": String(job.input?.settings?.frameRate || ""),
        ...(renderer.token ? { authorization: `Bearer ${renderer.token}` } : {})
      },
      body: sourceObject.body
    });

    await processRendererResponse(env, job, response);
  } catch (error) {
    await markJob(env, jobId, "failed", error.message || "Renderer request failed.");
    await createSystemAlert(
      env,
      "error",
      "renderer",
      "Renderer request failed",
      error.message || "Renderer request failed.",
      { jobId }
    );
  } finally {
    await bumpRendererActiveJobs(env, renderer.workerId, -1);
  }
}

async function processExportQueueMessage(message, env) {
  const payload = message.body || {};
  const jobId = payload.jobId;
  if (!jobId) {
    return;
  }
  await processExportJob(env, jobId);
}

function sanitizeFilename(name) {
  return (name || "upload")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "upload";
}

function filenameFromR2Key(key) {
  const filename = (key || "").split("/").pop() || "asset";
  return sanitizeFilename(decodeURIComponent(filename));
}

async function handleAssets(request, env, user) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, project_id, r2_key, mime_type, size_bytes, created_at
       FROM assets
       WHERE owner_user_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 100`
    ).bind(user.id).all();

    return json({
      ok: true,
      assets: (rows.results || []).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        filename: filenameFromR2Key(row.r2_key),
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
        downloadUrl: `/api/assets/${row.id}`
      }))
    });
  }

  if (request.method === "POST") {
    const rateLimited = await enforceRateLimit(
      env,
      request,
      user,
      "asset_upload",
      "UPLOAD_RATE_LIMIT_PER_MINUTE",
      DEFAULT_UPLOAD_RATE_LIMIT_PER_MINUTE
    );
    if (rateLimited) {
      return rateLimited;
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({
        ok: false,
        code: "INVALID_UPLOAD_CONTENT_TYPE",
        message: "Upload must use multipart/form-data with a file field."
      }, { status: 400 });
    }

    const form = await request.formData();
    const file = form.get("file");
    const projectId = form.get("projectId") || null;

    const turnstileRejected = await requireTurnstile(env, request, form.get("turnstileToken"), user, "upload");
    if (turnstileRejected) {
      return turnstileRejected;
    }

    if (!file || typeof file === "string") {
      return json({
        ok: false,
        code: "MISSING_FILE",
        message: "A file field is required."
      }, { status: 400 });
    }

    if (projectId && !(await userOwnsProject(env, user, projectId))) {
      return json({
        ok: false,
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found for this user."
      }, { status: 404 });
    }

    const featurePayload = await getFeaturePayload(env, user);
    const maxBytes = featurePayload.limits.max_upload_mb * 1024 * 1024;
    if (file.size > maxBytes) {
      return json({
        ok: false,
        code: "UPLOAD_TOO_LARGE",
        message: `Upload exceeds the ${featurePayload.limits.max_upload_mb} MB plan limit.`
      }, { status: 413 });
    }

    const maxVideoBytes = envNumber(env, "MAX_VIDEO_UPLOAD_MB", DEFAULT_VIDEO_UPLOAD_MB) * 1024 * 1024;
    const isSystemPreview = /^ai_poster_preview\.(webm|mp4|mov)$/i.test(file.name);
    if ((file.type || "").startsWith("video/") && file.size > maxVideoBytes && !isSystemPreview) {
      return json({
        ok: false,
        code: "VIDEO_UPLOAD_TOO_LARGE",
        message: `影片上傳限制為 ${envNumber(env, "MAX_VIDEO_UPLOAD_MB", DEFAULT_VIDEO_UPLOAD_MB)}MB，請先壓縮或縮短影片。`
      }, { status: 413 });
    }

    const id = `asset_${crypto.randomUUID()}`;
    const filename = sanitizeFilename(file.name);
    const key = `users/${user.id}/assets/${id}/${filename}`;

    await env.ASSETS_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream"
      },
      customMetadata: {
        ownerUserId: user.id,
        assetId: id,
        projectId: projectId || ""
      }
    });

    await env.DB.prepare(
      `INSERT INTO assets
        (id, owner_user_id, project_id, r2_key, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, user.id, projectId, key, file.type || "application/octet-stream", file.size).run();

    console.log(JSON.stringify({
      event: "asset_uploaded",
      assetId: id,
      userId: user.id,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size
    }));

    return json({
      ok: true,
      asset: {
        id,
        projectId,
        filename,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        downloadUrl: `/api/assets/${id}`
      }
    }, { status: 201 });
  }

  return json({
    ok: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Only GET and POST are allowed for assets."
  }, { status: 405, headers: { allow: "GET, POST" } });
}

async function handleAssetById(request, env, user, assetId) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for an asset."
    }, { status: 405, headers: { allow: "GET" } });
  }

  const asset = await env.DB.prepare(
    `SELECT id, r2_key, mime_type
     FROM assets
     WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`
  ).bind(assetId, user.id).first();

  if (!asset) {
    return json({
      ok: false,
      code: "ASSET_NOT_FOUND",
      message: "Asset was not found."
    }, { status: 404 });
  }

  const object = await env.ASSETS_BUCKET.get(asset.r2_key);
  if (!object) {
    return json({
      ok: false,
      code: "ASSET_OBJECT_NOT_FOUND",
      message: "Asset file was not found."
    }, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "content-type": asset.mime_type || "application/octet-stream",
      "content-disposition": `inline; filename="${filenameFromR2Key(asset.r2_key)}"`,
      "cache-control": "private, max-age=300",
      "etag": object.httpEtag
    }
  });
}

async function handleJobOutput(request, env, user, jobId) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for a job output."
    }, { status: 405, headers: { allow: "GET" } });
  }

  const job = await env.DB.prepare(
    `SELECT id, output_r2_key
     FROM jobs
     WHERE id = ? AND owner_user_id = ? AND status = 'completed'`
  ).bind(jobId, user.id).first();

  if (!job?.output_r2_key) {
    return json({
      ok: false,
      code: "JOB_OUTPUT_NOT_FOUND",
      message: "Job output was not found."
    }, { status: 404 });
  }

  const object = await env.ASSETS_BUCKET.get(job.output_r2_key);
  if (!object) {
    return json({
      ok: false,
      code: "JOB_OUTPUT_OBJECT_NOT_FOUND",
      message: "Job output file was not found."
    }, { status: 404 });
  }

  const filename = `${job.id}_h265.mp4`;
  return new Response(object.body, {
    headers: {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
      "etag": object.httpEtag
    }
  });
}

function requireAdmin(user) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (user.role !== "admin") {
    return json({
      ok: false,
      code: "ADMIN_REQUIRED",
      message: "Only an admin can use this API."
    }, { status: 403 });
  }

  return null;
}

function slugFromName(name) {
  return (name || "version")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "version";
}

function normalizePlan(plan) {
  return ["free", "beta", "pro", "business"].includes(plan) ? plan : "beta";
}

function normalizeRole(role) {
  return ["free_user", "beta_user", "pro_user", "business_user", "customer_admin", "admin"].includes(role) ? role : "beta_user";
}

function normalizeStatus(status) {
  return ["active", "paused", "disabled"].includes(status) ? status : "active";
}

function normalizeCommercialStatus(status) {
  return ["active", "trial", "past_due", "paused", "disabled"].includes(status) ? status : "active";
}

function normalizeInviteStatus(status) {
  return ["active", "redeemed", "expired", "disabled"].includes(status) ? status : "active";
}

function normalizeRendererStatus(status) {
  return ["active", "paused", "draining", "disabled"].includes(status) ? status : "active";
}

function roleForPlan(plan) {
  if (plan === "business") return "business_user";
  if (plan === "pro") return "pro_user";
  if (plan === "free") return "free_user";
  return "beta_user";
}

function positiveInteger(value, fallback, max = 1000000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(number), max);
}

function optionalText(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bearerTokenFromRequest(request) {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return (match?.[1] || request.headers.get("x-aiposter-commerce-token") || "").trim();
}

async function requireCommerceToken(request, env, corsHeaders = {}) {
  const expected = String(env.DY_COMMERCE_API_TOKEN || "").trim();
  if (!expected) {
    return json({
      ok: false,
      code: "COMMERCE_API_TOKEN_NOT_CONFIGURED",
      message: "dy.com.tw 串接 token 尚未設定。請先設定 DY_COMMERCE_API_TOKEN secret。"
    }, { status: 503, headers: corsHeaders });
  }

  const provided = bearerTokenFromRequest(request);
  if (!provided || !(await timingSafeSecretEqual(provided, expected))) {
    return json({
      ok: false,
      code: "COMMERCE_API_UNAUTHORIZED",
      message: "購物平台 API token 不正確。"
    }, { status: 401, headers: corsHeaders });
  }

  return null;
}

function normalizeCommerceSource(value) {
  const source = optionalText(value, 80)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return source || "dy.com.tw";
}

function commerceInviteRedeemUrl(request, env, code) {
  const configured = optionalText(env.PUBLIC_APP_URL, 240).replace(/\/+$/, "");
  const base = configured || new URL(request.url).origin;
  return `${base}/?invite=${encodeURIComponent(code)}`;
}

function compactJson(value, max = 8000) {
  try {
    return JSON.stringify(value || {}).slice(0, max);
  } catch {
    return "{}";
  }
}

function adminOutputUrlForJob(job) {
  return job?.output_r2_key ? `/api/admin/jobs/${encodeURIComponent(job.id)}/output` : null;
}

function serializeAdminJob(row) {
  const job = serializeJob(row);
  return {
    ...job,
    outputUrl: adminOutputUrlForJob(row)
  };
}

async function handleInviteRedemption(request, env, user) {
  const unauthorized = requireUser(user);
  if (unauthorized) {
    return unauthorized;
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only POST is allowed for invite redemption."
    }, { status: 405, headers: { allow: "POST" } });
  }

  const body = await readJson(request);
  const code = normalizeInviteCode(body?.code);
  if (!code) {
    return json({
      ok: false,
      code: "INVALID_INVITE_CODE",
      message: "請輸入有效邀請碼。"
    }, { status: 400 });
  }

  const invite = await safeFirst(
    env,
    `SELECT code, customer_id, email, plan, role, app_version_id, max_redemptions,
            redemption_count, expires_at, status, notes
     FROM commercial_invite_codes
     WHERE code = ?`,
    [code]
  );

  if (!invite) {
    return json({
      ok: false,
      code: "INVITE_NOT_FOUND",
      message: "邀請碼不存在或尚未啟用。"
    }, { status: 404 });
  }

  if (invite.status !== "active") {
    return json({
      ok: false,
      code: "INVITE_NOT_ACTIVE",
      message: "此邀請碼已停用或已使用完畢。"
    }, { status: 409 });
  }

  if (invite.expires_at && Date.parse(invite.expires_at) < Date.now()) {
    await env.DB.prepare(
      `UPDATE commercial_invite_codes
       SET status = 'expired', updated_at = datetime('now')
       WHERE code = ?`
    ).bind(code).run();

    return json({
      ok: false,
      code: "INVITE_EXPIRED",
      message: "此邀請碼已過期。"
    }, { status: 409 });
  }

  const inviteEmail = normalizeEmail(invite.email);
  if (inviteEmail && inviteEmail !== user.email) {
    return json({
      ok: false,
      code: "INVITE_EMAIL_MISMATCH",
      message: "此邀請碼不屬於目前登入的 email。"
    }, { status: 403 });
  }

  const nextRedemptionCount = Number(invite.redemption_count || 0) + 1;
  if (nextRedemptionCount > Number(invite.max_redemptions || 1)) {
    return json({
      ok: false,
      code: "INVITE_REDEMPTION_LIMIT_REACHED",
      message: "此邀請碼已達使用上限。"
    }, { status: 409 });
  }

  const plan = normalizePlan(invite.plan);
  const role = normalizeRole(invite.role || roleForPlan(plan));
  const version = await getAppVersion(env, invite.app_version_id || "default");
  const displayName = user.display_name || user.email;

  try {
    await env.DB.prepare(
      `INSERT INTO user_app_assignments
        (email, display_name, app_version_id, plan, role, status, feature_overrides_json, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, datetime('now'), datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         app_version_id = excluded.app_version_id,
         plan = excluded.plan,
         role = excluded.role,
         status = 'active',
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).bind(
      user.email,
      displayName,
      version.id,
      plan,
      role,
      `Redeemed invite ${code}${invite.notes ? `: ${invite.notes}` : ""}`.slice(0, 1000)
    ).run();

    await env.DB.prepare(
      `UPDATE users
       SET display_name = ?, role = ?, plan = ?, status = 'active', updated_at = datetime('now')
       WHERE id = ?`
    ).bind(displayName, role, plan, user.id).run();

    if (invite.customer_id) {
      await env.DB.prepare(
        `INSERT INTO customer_members
          (customer_id, email, display_name, role, status, invited_at, accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'), datetime('now'), datetime('now'))
         ON CONFLICT(customer_id, email) DO UPDATE SET
           display_name = excluded.display_name,
           role = excluded.role,
           status = 'active',
           accepted_at = datetime('now'),
           updated_at = datetime('now')`
      ).bind(invite.customer_id, user.email, displayName, role).run();
    }

    await env.DB.prepare(
      `UPDATE commercial_invite_codes
       SET redemption_count = ?,
           status = CASE WHEN ? >= max_redemptions THEN 'redeemed' ELSE status END,
           updated_at = datetime('now')
       WHERE code = ?`
    ).bind(nextRedemptionCount, nextRedemptionCount, code).run();
  } catch (error) {
    if (isSchemaMissing(error)) {
      return json({
        ok: false,
        code: "COMMERCIAL_SCHEMA_NOT_READY",
        message: "商用會員資料庫尚未套用，請先套用 migrations/0004_commercial_foundation.sql。"
      }, { status: 503 });
    }
    throw error;
  }

  return json({
    ok: true,
    assignment: {
      email: user.email,
      appVersionId: version.id,
      plan,
      role,
      customerId: invite.customer_id || null
    }
  }, { status: 201 });
}

async function handleCommerceInviteRequest(request, env) {
  const corsHeaders = commerceCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only POST is allowed for commerce invite requests."
    }, { status: 405, headers: { ...corsHeaders, allow: "POST, OPTIONS" } });
  }

  if (commerceOriginForbidden(request, env)) {
    return json({
      ok: false,
      code: "COMMERCE_ORIGIN_FORBIDDEN",
      message: "此來源不允許呼叫購物平台邀請碼 API。"
    }, { status: 403, headers: corsHeaders });
  }

  const unauthorized = await requireCommerceToken(request, env, corsHeaders);
  if (unauthorized) {
    return unauthorized;
  }

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return json({
      ok: false,
      code: "INVALID_COMMERCE_PAYLOAD",
      message: "請提供 JSON 格式的客戶與邀請碼資料。"
    }, { status: 400, headers: corsHeaders });
  }

  const source = normalizeCommerceSource(body.source || "dy.com.tw");
  const rateLimited = await enforceRateLimit(
    env,
    request,
    { id: `commerce:${source}` },
    "commerce_invite",
    "COMMERCE_INVITE_RATE_LIMIT_PER_MINUTE",
    DEFAULT_COMMERCE_INVITE_RATE_LIMIT_PER_MINUTE,
    corsHeaders
  );
  if (rateLimited) {
    return rateLimited;
  }

  const idempotencyKey = optionalText(request.headers.get("idempotency-key") || body.idempotencyKey, 160);
  if (!idempotencyKey) {
    return json({
      ok: false,
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "dy.com.tw 每次請求都必須提供 Idempotency-Key，避免重複發邀請碼。"
    }, { status: 400, headers: corsHeaders });
  }

  const existing = await safeFirst(
    env,
    `SELECT id, customer_id, invite_code, email, status, response_json, created_at, updated_at
     FROM commerce_invite_requests
     WHERE source = ? AND idempotency_key = ?`,
    [source, idempotencyKey]
  );
  if (existing) {
    const stored = parseJsonObject(existing.response_json);
    return json({
      ok: true,
      idempotent: true,
      ...stored,
      request: {
        id: existing.id,
        source,
        idempotencyKey,
        status: existing.status,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at
      }
    }, { headers: corsHeaders });
  }

  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const invite = body.invite && typeof body.invite === "object" ? body.invite : {};
  const inviteEmail = normalizeEmail(invite.email || customer.ownerEmail || body.email);
  const ownerEmail = normalizeEmail(customer.ownerEmail || inviteEmail);
  const customerName = optionalText(customer.name || customer.companyName || body.customerName || inviteEmail, 160);

  if (!inviteEmail.includes("@") || !ownerEmail.includes("@") || !customerName) {
    return json({
      ok: false,
      code: "INVALID_COMMERCE_CUSTOMER",
      message: "customer.name、customer.ownerEmail 或 invite.email 格式不正確。"
    }, { status: 400, headers: corsHeaders });
  }

  const externalCustomerId = optionalText(customer.externalCustomerId || body.externalCustomerId, 160);
  const customerId = customer.id
    ? normalizeCustomerId(customer.id)
    : normalizeCustomerId(`dy_${externalCustomerId || idempotencyKey || inviteEmail}`);
  const plan = normalizePlan(invite.plan || customer.plan || body.plan || "business");
  const role = normalizeRole(invite.role || roleForPlan(plan));
  const version = await getAppVersion(env, invite.appVersionId || body.appVersionId || "default");
  const code = normalizeInviteCode(invite.code) || generateInviteCode();
  const maxRedemptions = positiveInteger(invite.maxRedemptions, 1, 5000);
  const expiresAt = optionalText(invite.expiresAt || body.expiresAt, 80) || null;

  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return json({
      ok: false,
      code: "INVALID_INVITE_EXPIRY",
      message: "invite.expiresAt 必須是可解析的日期時間。"
    }, { status: 400, headers: corsHeaders });
  }

  const nowNote = `Created from ${source} commerce API; idempotency=${idempotencyKey}`;
  const requestId = `commerce_invite_${randomHex(8)}`;
  const responsePayload = {
    source,
    idempotencyKey,
    customer: {
      id: customerId,
      name: customerName,
      ownerEmail,
      plan
    },
    invite: {
      code,
      email: inviteEmail,
      plan,
      role,
      appVersionId: version.id,
      maxRedemptions,
      expiresAt,
      redeemUrl: commerceInviteRedeemUrl(request, env, code)
    },
    delivery: {
      sender: source,
      note: "aiposter.jp 只建立邀請碼；邀請信由 dy.com.tw 發送給客戶。"
    }
  };

  try {
    await env.DB.prepare(
      `INSERT INTO customer_accounts
        (id, name, owner_email, status, plan, billing_email, company_name, tax_id,
         payment_provider, external_customer_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         owner_email = excluded.owner_email,
         status = 'active',
         plan = excluded.plan,
         billing_email = excluded.billing_email,
         company_name = excluded.company_name,
         tax_id = excluded.tax_id,
         payment_provider = excluded.payment_provider,
         external_customer_id = excluded.external_customer_id,
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).bind(
      customerId,
      customerName,
      ownerEmail,
      plan,
      normalizeEmail(customer.billingEmail) || null,
      optionalText(customer.companyName, 160) || null,
      optionalText(customer.taxId, 80) || null,
      optionalText(customer.paymentProvider, 80) || "dy.com.tw",
      externalCustomerId || null,
      optionalText(customer.notes || nowNote, 2000) || nowNote
    ).run();

    await env.DB.prepare(
      `INSERT INTO customer_members
        (customer_id, email, display_name, role, status, invited_at, accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'invited', datetime('now'), NULL, datetime('now'), datetime('now'))
       ON CONFLICT(customer_id, email) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role,
         status = CASE WHEN customer_members.status = 'active' THEN 'active' ELSE 'invited' END,
         invited_at = datetime('now'),
         updated_at = datetime('now')`
    ).bind(customerId, inviteEmail, optionalText(invite.displayName || customerName, 160), role).run();

    await env.DB.prepare(
      `INSERT INTO commercial_invite_codes
        (code, customer_id, email, plan, role, app_version_id, max_redemptions,
         redemption_count, expires_at, status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(code) DO UPDATE SET
         customer_id = excluded.customer_id,
         email = excluded.email,
         plan = excluded.plan,
         role = excluded.role,
         app_version_id = excluded.app_version_id,
         max_redemptions = excluded.max_redemptions,
         expires_at = excluded.expires_at,
         status = 'active',
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).bind(
      code,
      customerId,
      inviteEmail,
      plan,
      role,
      version.id,
      maxRedemptions,
      expiresAt,
      optionalText(invite.notes || nowNote, 1000) || nowNote,
      `commerce:${source}`
    ).run();

    await env.DB.prepare(
      `INSERT INTO commerce_invite_requests
        (id, source, idempotency_key, customer_id, invite_code, email, status,
         request_json, response_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      requestId,
      source,
      idempotencyKey,
      customerId,
      code,
      inviteEmail,
      compactJson(body),
      compactJson(responsePayload)
    ).run();
  } catch (error) {
    if (isSchemaMissing(error)) {
      return json({
        ok: false,
        code: "COMMERCIAL_SCHEMA_NOT_READY",
        message: "商用邀請碼請求資料庫尚未套用，請先套用 migrations/0004_commercial_foundation.sql。"
      }, { status: 503, headers: corsHeaders });
    }

    if (/UNIQUE constraint failed: commerce_invite_requests\.source, commerce_invite_requests\.idempotency_key/i.test(error?.message || "")) {
      const replay = await safeFirst(
        env,
        `SELECT id, customer_id, invite_code, email, status, response_json, created_at, updated_at
         FROM commerce_invite_requests
         WHERE source = ? AND idempotency_key = ?`,
        [source, idempotencyKey]
      );
      if (replay) {
        return json({
          ok: true,
          idempotent: true,
          ...parseJsonObject(replay.response_json),
          request: {
            id: replay.id,
            source,
            idempotencyKey,
            status: replay.status,
            createdAt: replay.created_at,
            updatedAt: replay.updated_at
          }
        }, { headers: corsHeaders });
      }
    }

    throw error;
  }

  console.log(JSON.stringify({
    event: "commerce_invite_created",
    source,
    customerId,
    inviteEmail,
    plan,
    requestId
  }));

  return json({
    ok: true,
    idempotent: false,
    request: {
      id: requestId,
      source,
      idempotencyKey,
      status: "created"
    },
    ...responsePayload
  }, { status: 201, headers: corsHeaders });
}

async function handleAdminCommercial(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for commercial overview."
    }, { status: 405, headers: { allow: "GET" } });
  }

  const [plans, customers, invites, renderers, alerts, invoices, payments, backups] = await Promise.all([
    safeAll(env, `SELECT * FROM billing_plans ORDER BY monthly_price_cents ASC`),
    safeAll(env, `SELECT * FROM customer_accounts ORDER BY updated_at DESC LIMIT 200`),
    safeAll(env, `SELECT * FROM commercial_invite_codes ORDER BY updated_at DESC LIMIT 200`),
    safeAll(env, `SELECT * FROM export_workers ORDER BY status ASC, active_jobs ASC, weight DESC, updated_at DESC`),
    safeAll(env, `SELECT * FROM system_alerts ORDER BY created_at DESC LIMIT 100`),
    safeAll(env, `SELECT * FROM invoices ORDER BY created_at DESC LIMIT 100`),
    safeAll(env, `SELECT * FROM payments ORDER BY created_at DESC LIMIT 100`),
    safeAll(env, `SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 50`)
  ]);

  return json({
    ok: true,
    plans: (plans.results || []).map((row) => ({ ...row, features: parseJsonObject(row.features_json) })),
    customers: customers.results || [],
    invites: invites.results || [],
    renderers: (renderers.results || []).map((row) => ({ ...row, metadata: parseJsonObject(row.metadata_json) })),
    alerts: alerts.results || [],
    invoices: invoices.results || [],
    payments: payments.results || [],
    backups: (backups.results || []).map((row) => ({ ...row, metadata: parseJsonObject(row.metadata_json) }))
  });
}

async function handleAdminCustomers(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await safeAll(env, `SELECT * FROM customer_accounts ORDER BY updated_at DESC LIMIT 300`);
    return json({ ok: true, customers: rows.results || [] });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET and POST are allowed for customers."
    }, { status: 405, headers: { allow: "GET, POST" } });
  }

  const body = await readJson(request);
  const name = optionalText(body?.name, 160);
  const ownerEmail = normalizeEmail(body?.ownerEmail);
  if (!name || !ownerEmail.includes("@")) {
    return json({
      ok: false,
      code: "INVALID_CUSTOMER_PAYLOAD",
      message: "客戶名稱與 owner email 都是必填。"
    }, { status: 400 });
  }

  const id = body?.id ? normalizeCustomerId(body.id) : normalizeCustomerId(`${name}_${randomHex(3)}`);
  const plan = normalizePlan(body?.plan || "business");
  const status = normalizeCommercialStatus(body?.status);

  try {
    await env.DB.prepare(
      `INSERT INTO customer_accounts
        (id, name, owner_email, status, plan, billing_email, company_name, tax_id,
         payment_provider, external_customer_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         owner_email = excluded.owner_email,
         status = excluded.status,
         plan = excluded.plan,
         billing_email = excluded.billing_email,
         company_name = excluded.company_name,
         tax_id = excluded.tax_id,
         payment_provider = excluded.payment_provider,
         external_customer_id = excluded.external_customer_id,
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).bind(
      id,
      name,
      ownerEmail,
      status,
      plan,
      normalizeEmail(body?.billingEmail) || null,
      optionalText(body?.companyName, 160) || null,
      optionalText(body?.taxId, 80) || null,
      optionalText(body?.paymentProvider, 80) || null,
      optionalText(body?.externalCustomerId, 160) || null,
      optionalText(body?.notes, 2000) || null
    ).run();
  } catch (error) {
    if (isSchemaMissing(error)) {
      return json({
        ok: false,
        code: "COMMERCIAL_SCHEMA_NOT_READY",
        message: "商用客戶資料庫尚未套用。"
      }, { status: 503 });
    }
    throw error;
  }

  return json({ ok: true, customer: { id, name, ownerEmail, status, plan } }, { status: 201 });
}

async function handleAdminInvites(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await safeAll(env, `SELECT * FROM commercial_invite_codes ORDER BY updated_at DESC LIMIT 300`);
    return json({ ok: true, invites: rows.results || [] });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET and POST are allowed for invite codes."
    }, { status: 405, headers: { allow: "GET, POST" } });
  }

  const body = await readJson(request);
  const code = normalizeInviteCode(body?.code) || generateInviteCode();
  const email = normalizeEmail(body?.email) || null;
  const plan = normalizePlan(body?.plan || "business");
  const role = normalizeRole(body?.role || roleForPlan(plan));
  const version = await getAppVersion(env, body?.appVersionId || "default");
  const maxRedemptions = positiveInteger(body?.maxRedemptions, email ? 1 : 50, 5000);
  const customerId = optionalText(body?.customerId, 80) || null;
  const expiresAt = optionalText(body?.expiresAt, 60) || null;
  const status = normalizeInviteStatus(body?.status);

  try {
    await env.DB.prepare(
      `INSERT INTO commercial_invite_codes
        (code, customer_id, email, plan, role, app_version_id, max_redemptions,
         redemption_count, expires_at, status, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(code) DO UPDATE SET
         customer_id = excluded.customer_id,
         email = excluded.email,
         plan = excluded.plan,
         role = excluded.role,
         app_version_id = excluded.app_version_id,
         max_redemptions = excluded.max_redemptions,
         expires_at = excluded.expires_at,
         status = excluded.status,
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).bind(
      code,
      customerId,
      email,
      plan,
      role,
      version.id,
      maxRedemptions,
      expiresAt,
      status,
      optionalText(body?.notes, 1000) || null,
      user.email
    ).run();
  } catch (error) {
    if (isSchemaMissing(error)) {
      return json({
        ok: false,
        code: "COMMERCIAL_SCHEMA_NOT_READY",
        message: "商用邀請碼資料庫尚未套用。"
      }, { status: 503 });
    }
    throw error;
  }

  return json({
    ok: true,
    invite: { code, customerId, email, plan, role, appVersionId: version.id, maxRedemptions, status }
  }, { status: 201 });
}

async function handleAdminRenderers(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await safeAll(env, `SELECT * FROM export_workers ORDER BY status ASC, active_jobs ASC, weight DESC`);
    return json({
      ok: true,
      renderers: (rows.results || []).map((row) => ({ ...row, metadata: parseJsonObject(row.metadata_json) }))
    });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET and POST are allowed for renderers."
    }, { status: 405, headers: { allow: "GET, POST" } });
  }

  const body = await readJson(request);
  const endpointUrl = optionalText(body?.endpointUrl, 500);
  if (!/^https?:\/\//i.test(endpointUrl)) {
    return json({
      ok: false,
      code: "INVALID_RENDERER_URL",
      message: "renderer endpoint 必須是 http 或 https URL。"
    }, { status: 400 });
  }

  const name = optionalText(body?.name, 120) || "AI Poster Renderer";
  const id = body?.id ? slugFromName(body.id) : `renderer_${slugFromName(name)}_${randomHex(3)}`;
  const status = normalizeRendererStatus(body?.status);
  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};

  try {
    await env.DB.prepare(
      `INSERT INTO export_workers
        (id, name, endpoint_url, status, weight, max_concurrent_jobs, active_jobs,
         last_heartbeat_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         endpoint_url = excluded.endpoint_url,
         status = excluded.status,
         weight = excluded.weight,
         max_concurrent_jobs = excluded.max_concurrent_jobs,
         last_heartbeat_at = datetime('now'),
         metadata_json = excluded.metadata_json,
         updated_at = datetime('now')`
    ).bind(
      id,
      name,
      endpointUrl,
      status,
      positiveInteger(body?.weight, 100, 10000),
      positiveInteger(body?.maxConcurrentJobs, 1, 100),
      JSON.stringify(metadata)
    ).run();
  } catch (error) {
    if (isSchemaMissing(error)) {
      return json({
        ok: false,
        code: "COMMERCIAL_SCHEMA_NOT_READY",
        message: "renderer pool 資料庫尚未套用。"
      }, { status: 503 });
    }
    throw error;
  }

  return json({ ok: true, renderer: { id, name, endpointUrl, status } }, { status: 201 });
}

async function handleAdminSupport(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for support lookup."
    }, { status: 405, headers: { allow: "GET" } });
  }

  const url = new URL(request.url);
  const email = normalizeEmail(url.searchParams.get("email"));
  const jobId = optionalText(url.searchParams.get("jobId"), 120);
  if (!email && !jobId) {
    return json({
      ok: false,
      code: "SUPPORT_LOOKUP_REQUIRED",
      message: "請輸入 email 或 job id。"
    }, { status: 400 });
  }

  let userRows = { results: [] };
  let assignment = null;
  let customerMemberships = { results: [] };
  let jobs = { results: [] };
  let invoices = { results: [] };
  let alerts = { results: [] };

  if (email) {
    userRows = await safeAll(
      env,
      `SELECT id, email, display_name, role, plan, status, created_at, updated_at
       FROM users
       WHERE email = ?
       LIMIT 20`,
      [email]
    );
    assignment = await safeFirst(
      env,
      `SELECT email, display_name, app_version_id, plan, role, status, feature_overrides_json, notes, created_at, updated_at
       FROM user_app_assignments
       WHERE email = ?`,
      [email]
    );
    customerMemberships = await safeAll(
      env,
      `SELECT m.*, c.name AS customer_name, c.plan AS customer_plan, c.status AS customer_status
       FROM customer_members m
       LEFT JOIN customer_accounts c ON c.id = m.customer_id
       WHERE m.email = ?
       ORDER BY m.updated_at DESC`,
      [email]
    );
    invoices = await safeAll(
      env,
      `SELECT i.*
       FROM invoices i
       JOIN customer_members m ON m.customer_id = i.customer_id
       WHERE m.email = ?
       ORDER BY i.created_at DESC
       LIMIT 50`,
      [email]
    );
    alerts = await safeAll(
      env,
      `SELECT *
       FROM system_alerts
       WHERE related_email = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [email]
    );
  }

  const jobBindings = jobId ? [jobId] : [email];
  const jobSql = jobId
    ? `SELECT j.*, u.email AS owner_email
       FROM jobs j
       LEFT JOIN users u ON u.id = j.owner_user_id
       WHERE j.id = ?
       ORDER BY j.updated_at DESC
       LIMIT 50`
    : `SELECT j.*, u.email AS owner_email
       FROM jobs j
       LEFT JOIN users u ON u.id = j.owner_user_id
       WHERE u.email = ?
       ORDER BY j.updated_at DESC
       LIMIT 50`;
  jobs = await safeAll(env, jobSql, jobBindings);

  if (jobId) {
    alerts = await safeAll(
      env,
      `SELECT *
       FROM system_alerts
       WHERE related_job_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [jobId]
    );
  }

  return json({
    ok: true,
    email,
    jobId,
    users: userRows.results || [],
    assignment: assignment
      ? { ...assignment, featureOverrides: parseJsonObject(assignment.feature_overrides_json) }
      : null,
    customerMemberships: customerMemberships.results || [],
    jobs: (jobs.results || []).map(serializeAdminJob),
    invoices: invoices.results || [],
    alerts: alerts.results || []
  });
}

async function handleAdminJobOutput(request, env, user, jobId) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for admin job output."
    }, { status: 405, headers: { allow: "GET" } });
  }

  const job = await env.DB.prepare(
    `SELECT id, output_r2_key
     FROM jobs
     WHERE id = ? AND status = 'completed'`
  ).bind(jobId).first();

  if (!job?.output_r2_key) {
    return json({
      ok: false,
      code: "JOB_OUTPUT_NOT_FOUND",
      message: "Job output was not found."
    }, { status: 404 });
  }

  const object = await env.ASSETS_BUCKET.get(job.output_r2_key);
  if (!object) {
    return json({
      ok: false,
      code: "JOB_OUTPUT_OBJECT_NOT_FOUND",
      message: "Job output file was not found."
    }, { status: 404 });
  }

  const filename = `${job.id}_60frame_h265.mp4`;
  return new Response(object.body, {
    headers: {
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
      "etag": object.httpEtag
    }
  });
}

async function handleAdminAlerts(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await safeAll(env, `SELECT * FROM system_alerts ORDER BY created_at DESC LIMIT 200`);
    return json({ ok: true, alerts: rows.results || [] });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET and POST are allowed for alerts."
    }, { status: 405, headers: { allow: "GET, POST" } });
  }

  const body = await readJson(request);
  const id = optionalText(body?.id, 120);
  const status = ["open", "acknowledged", "resolved"].includes(body?.status) ? body.status : "acknowledged";
  if (!id) {
    return json({
      ok: false,
      code: "INVALID_ALERT_ID",
      message: "Alert id is required."
    }, { status: 400 });
  }

  await env.DB.prepare(
    `UPDATE system_alerts
     SET status = ?,
         acknowledged_at = CASE WHEN ? = 'acknowledged' THEN COALESCE(acknowledged_at, datetime('now')) ELSE acknowledged_at END,
         resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, datetime('now')) ELSE resolved_at END
     WHERE id = ?`
  ).bind(status, status, status, id).run();

  return json({ ok: true, id, status });
}

async function handleAdminBackupRuns(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await safeAll(env, `SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 100`);
    return json({
      ok: true,
      backups: (rows.results || []).map((row) => ({ ...row, metadata: parseJsonObject(row.metadata_json) }))
    });
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET and POST are allowed for backup runs."
    }, { status: 405, headers: { allow: "GET, POST" } });
  }

  const body = await readJson(request);
  const id = `backup_${crypto.randomUUID()}`;
  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
  await env.DB.prepare(
    `INSERT INTO backup_runs
      (id, kind, status, target, started_at, finished_at, metadata_json, error_message)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)`
  ).bind(
    id,
    optionalText(body?.kind, 80) || "manual",
    optionalText(body?.status, 40) || "pending",
    optionalText(body?.target, 500) || null,
    body?.status === "completed" || body?.status === "failed" ? new Date().toISOString() : null,
    JSON.stringify(metadata),
    optionalText(body?.errorMessage, 1000) || null
  ).run();

  return json({ ok: true, id }, { status: 201 });
}

async function handleAdminOverview(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method !== "GET") {
    return json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET is allowed for admin overview."
    }, { status: 405, headers: { allow: "GET" } });
  }

  const [versions, assignments, users] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, description, config_json, is_default, created_at, updated_at
       FROM app_versions
       ORDER BY is_default DESC, updated_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT a.email, a.display_name, a.app_version_id, v.name AS app_version_name,
              a.plan, a.role, a.status, a.feature_overrides_json, a.notes, a.created_at, a.updated_at
       FROM user_app_assignments a
       LEFT JOIN app_versions v ON v.id = a.app_version_id
       ORDER BY a.updated_at DESC
       LIMIT 200`
    ).all(),
    env.DB.prepare(
      `SELECT id, email, display_name, role, plan, status, created_at, updated_at
       FROM users
       ORDER BY updated_at DESC
       LIMIT 200`
    ).all()
  ]);

  return json({
    ok: true,
    versions: (versions.results || []).map((row) => ({
      ...row,
      isDefault: Boolean(row.is_default),
      config: parseJsonObject(row.config_json)
    })),
    assignments: (assignments.results || []).map((row) => ({
      email: row.email,
      displayName: row.display_name,
      appVersionId: row.app_version_id,
      appVersionName: row.app_version_name,
      plan: row.plan,
      role: row.role,
      status: row.status,
      featureOverrides: parseJsonObject(row.feature_overrides_json),
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    users: users.results || []
  });
}

async function handleAdminVersions(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, name, description, config_json, is_default, created_at, updated_at
       FROM app_versions
       ORDER BY is_default DESC, updated_at DESC`
    ).all();

    return json({
      ok: true,
      versions: (rows.results || []).map((row) => ({
        ...row,
        isDefault: Boolean(row.is_default),
        config: parseJsonObject(row.config_json)
      }))
    });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.name !== "string") {
      return json({
        ok: false,
        code: "INVALID_VERSION_PAYLOAD",
        message: "Version payload must include a name."
      }, { status: 400 });
    }

    const id = body.id ? slugFromName(body.id) : `version_${slugFromName(body.name)}_${crypto.randomUUID().slice(0, 8)}`;
    const config = body.config && typeof body.config === "object" ? body.config : {};
    const isDefault = body.isDefault ? 1 : 0;

    if (isDefault) {
      await env.DB.prepare(`UPDATE app_versions SET is_default = 0`).run();
    }

    await env.DB.prepare(
      `INSERT INTO app_versions
        (id, name, description, config_json, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         config_json = excluded.config_json,
         is_default = excluded.is_default,
         updated_at = datetime('now')`
    ).bind(
      id,
      body.name.trim().slice(0, 120),
      (body.description || "").trim().slice(0, 500),
      JSON.stringify(config),
      isDefault
    ).run();

    return json({ ok: true, id }, { status: 201 });
  }

  return json({
    ok: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Only GET and POST are allowed for app versions."
  }, { status: 405, headers: { allow: "GET, POST" } });
}

async function handleAdminAssignments(request, env, user) {
  const forbidden = requireAdmin(user);
  if (forbidden) {
    return forbidden;
  }

  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT a.email, a.display_name, a.app_version_id, v.name AS app_version_name,
              a.plan, a.role, a.status, a.feature_overrides_json, a.notes, a.created_at, a.updated_at
       FROM user_app_assignments a
       LEFT JOIN app_versions v ON v.id = a.app_version_id
       ORDER BY a.updated_at DESC
       LIMIT 200`
    ).all();

    return json({
      ok: true,
      assignments: (rows.results || []).map((row) => ({
        email: row.email,
        displayName: row.display_name,
        appVersionId: row.app_version_id,
        appVersionName: row.app_version_name,
        plan: row.plan,
        role: row.role,
        status: row.status,
        featureOverrides: parseJsonObject(row.feature_overrides_json),
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    const email = normalizeEmail(body?.email);
    if (!email || !email.includes("@")) {
      return json({
        ok: false,
        code: "INVALID_ASSIGNMENT_EMAIL",
        message: "A valid email is required."
      }, { status: 400 });
    }

    const version = await getAppVersion(env, body.appVersionId || "default");
    const featureOverrides = body.featureOverrides && typeof body.featureOverrides === "object"
      ? body.featureOverrides
      : {};
    const plan = normalizePlan(body.plan);
    const role = normalizeRole(body.role || (plan === "pro" ? "pro_user" : `${plan}_user`));
    const status = normalizeStatus(body.status);
    const displayName = (body.displayName || email).trim().slice(0, 120);

    await env.DB.prepare(
      `INSERT INTO user_app_assignments
        (email, display_name, app_version_id, plan, role, status, feature_overrides_json, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name,
         app_version_id = excluded.app_version_id,
         plan = excluded.plan,
         role = excluded.role,
         status = excluded.status,
         feature_overrides_json = excluded.feature_overrides_json,
         notes = excluded.notes,
         updated_at = datetime('now')`
    ).bind(
      email,
      displayName,
      version.id,
      plan,
      role,
      status,
      JSON.stringify(featureOverrides),
      (body.notes || "").trim().slice(0, 1000)
    ).run();

    const userId = userIdFromEmail(email);
    await env.DB.prepare(
      `UPDATE users
       SET display_name = ?, role = ?, plan = ?, status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(displayName, role, plan, status, userId).run();

    return json({
      ok: true,
      assignment: {
        email,
        displayName,
        appVersionId: version.id,
        plan,
        role,
        status,
        featureOverrides
      }
    }, { status: 201 });
  }

  return json({
    ok: false,
    code: "METHOD_NOT_ALLOWED",
    message: "Only GET and POST are allowed for user assignments."
  }, { status: 405, headers: { allow: "GET, POST" } });
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Poster 管理台</title>
  <style>
    :root { color-scheme: light; --ink:#17204f; --muted:#667085; --line:#d7dbea; --blue:#2563eb; --bg:#fbfaf2; --panel:#fffef8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Noto Sans TC", sans-serif; background: var(--bg); color: var(--ink); }
    header { padding: 28px clamp(18px, 4vw, 56px) 18px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 16px; align-items: end; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 46px); line-height: 1; }
    h2 { margin: 0 0 14px; font-size: 22px; }
    main { padding: 24px clamp(18px, 4vw, 56px) 48px; display: grid; gap: 20px; }
    .grid { display: grid; grid-template-columns: minmax(320px, 0.75fr) minmax(420px, 1.25fr); gap: 20px; align-items: start; }
    .grid.three { grid-template-columns: repeat(3, minmax(220px, 1fr)); }
    .grid.equal { grid-template-columns: repeat(2, minmax(320px, 1fr)); }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; box-shadow: 0 10px 28px rgba(23,32,79,.06); }
    label { display: grid; gap: 6px; font-weight: 700; margin: 12px 0; }
    input, select, textarea { width: 100%; border: 1px solid #b8bfd6; border-radius: 6px; padding: 10px 12px; font: inherit; color: var(--ink); background: white; }
    textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    button { border: 0; background: var(--blue); color: white; border-radius: 6px; padding: 11px 16px; font-weight: 800; cursor: pointer; }
    button.secondary { background: #eef2ff; color: var(--ink); border: 1px solid #bcc7f4; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .muted { color: var(--muted); }
    .status { min-height: 24px; font-weight: 700; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 12px; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: white; }
    .card strong { display: block; font-size: 30px; line-height: 1.1; margin-top: 6px; }
    .badge { display: inline-flex; align-items: center; border: 1px solid #bbc2d8; border-radius: 4px; padding: 4px 8px; font-weight: 800; }
    .badge.ok { color: #087443; border-color: #9bd6b5; background: #effaf3; }
    .badge.warn { color: #9a3412; border-color: #fed7aa; background: #fff7ed; }
    .badge.fail { color: #b42318; border-color: #fecaca; background: #fff1f2; }
    .scroll { overflow-x: auto; }
    .support-result { display: grid; gap: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    code { background: #eef2ff; border-radius: 4px; padding: 2px 5px; }
    @media (max-width: 900px) { .grid, .grid.three, .grid.equal, .cards { grid-template-columns: 1fr; } header { align-items: start; flex-direction: column; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AI Poster 管理台</h1>
      <p class="muted">新增客戶 email、指定版本、方案與功能。此頁只有 admin 可使用。</p>
    </div>
    <div class="row">
      <a href="/" class="muted">回到 App</a>
      <button class="secondary" id="refreshButton">重新整理</button>
    </div>
  </header>
  <main>
    <div class="grid">
      <section>
        <h2>新增使用者設定</h2>
        <form id="assignmentForm">
          <label>Email
            <input name="email" type="email" placeholder="client@example.com" required>
          </label>
          <label>姓名
            <input name="displayName" placeholder="客戶姓名或公司名稱">
          </label>
          <label>指定 Web App 版本
            <select name="appVersionId" id="versionSelect"></select>
          </label>
          <label>方案
            <select name="plan">
              <option value="beta">beta</option>
              <option value="pro">pro</option>
              <option value="business">business</option>
              <option value="free">free</option>
            </select>
          </label>
          <label>角色
            <select name="role">
              <option value="beta_user">beta_user</option>
              <option value="pro_user">pro_user</option>
              <option value="business_user">business_user</option>
              <option value="customer_admin">customer_admin</option>
              <option value="free_user">free_user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label>狀態
            <select name="status">
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>功能覆寫 JSON
            <textarea name="featureOverrides">{"h265_export":true,"video_editor":true,"custom_templates":true}</textarea>
          </label>
          <label>備註
            <textarea name="notes" placeholder="需求、交付內容、合約或客製說明"></textarea>
          </label>
          <div class="row">
            <button type="submit">儲存使用者設定</button>
            <span class="status" id="assignmentStatus"></span>
          </div>
        </form>
      </section>
      <section>
        <h2>新增 Web App 版本</h2>
        <form id="versionForm">
          <label>版本 ID
            <input name="id" placeholder="restaurant_v1">
          </label>
          <label>版本名稱
            <input name="name" placeholder="餐飲客戶版 v1" required>
          </label>
          <label>描述
            <input name="description" placeholder="適合餐飲店家的模板與功能">
          </label>
          <label>版本設定 JSON
            <textarea name="config">{"theme":"client","templateSet":"restaurant","entryPath":"/","enabledPanels":["text","image","video"],"branding":{"name":"AI Poster"}}</textarea>
          </label>
          <label class="row">
            <input name="isDefault" type="checkbox" style="width:auto"> 設為預設版本
          </label>
          <div class="row">
            <button type="submit">儲存版本</button>
            <span class="status" id="versionStatus"></span>
          </div>
        </form>
      </section>
    </div>
    <section>
      <h2>商用營運總覽</h2>
      <div class="cards" id="commercialCards">
        <div class="card muted">載入中...</div>
      </div>
      <p class="muted">正式商用核心：會員/邀請碼、方案配額、renderer pool、客服查詢、警報與備份紀錄。付款與電子發票目前保留資料欄位，實際刷卡/開票需再串接金流或發票服務。</p>
    </section>
    <div class="grid equal">
      <section>
        <h2>客戶帳號</h2>
        <form id="customerForm">
          <label>客戶名稱
            <input name="name" placeholder="ABC Retail / 測試客戶" required>
          </label>
          <label>Owner Email
            <input name="ownerEmail" type="email" placeholder="owner@example.com" required>
          </label>
          <label>方案
            <select name="plan">
              <option value="business">business</option>
              <option value="pro">pro</option>
              <option value="beta">beta</option>
              <option value="free">free</option>
            </select>
          </label>
          <label>狀態
            <select name="status">
              <option value="active">active</option>
              <option value="trial">trial</option>
              <option value="past_due">past_due</option>
              <option value="paused">paused</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>Billing Email
            <input name="billingEmail" type="email" placeholder="billing@example.com">
          </label>
          <label>公司名稱 / 統編
            <input name="companyName" placeholder="公司名稱">
            <input name="taxId" placeholder="統一編號">
          </label>
          <label>付款 provider / 外部客戶 ID
            <input name="paymentProvider" placeholder="stripe / tappay / ecpay">
            <input name="externalCustomerId" placeholder="cus_xxx">
          </label>
          <label>備註
            <textarea name="notes" placeholder="合約、客服、付款或客製化備註"></textarea>
          </label>
          <div class="row">
            <button type="submit">建立/更新客戶</button>
            <span class="status" id="customerStatus"></span>
          </div>
        </form>
      </section>
      <section>
        <h2>商用邀請碼</h2>
        <form id="inviteForm">
          <label>客戶
            <select name="customerId" id="customerSelect"><option value="">不指定客戶</option></select>
          </label>
          <label>Email
            <input name="email" type="email" placeholder="tester@example.com">
          </label>
          <label>方案 / 角色
            <select name="plan">
              <option value="business">business</option>
              <option value="pro">pro</option>
              <option value="beta">beta</option>
              <option value="free">free</option>
            </select>
            <select name="role">
              <option value="business_user">business_user</option>
              <option value="customer_admin">customer_admin</option>
              <option value="pro_user">pro_user</option>
              <option value="beta_user">beta_user</option>
              <option value="free_user">free_user</option>
            </select>
          </label>
          <label>指定 Web App 版本
            <select name="appVersionId" id="inviteVersionSelect"></select>
          </label>
          <label>可使用次數 / 到期日
            <input name="maxRedemptions" type="number" min="1" value="1">
            <input name="expiresAt" type="datetime-local">
          </label>
          <label>邀請碼（可留空自動產生）
            <input name="code" placeholder="AI-POSTER-CLIENT-001">
          </label>
          <label>備註
            <textarea name="notes" placeholder="測試批次、客戶專案或方案說明"></textarea>
          </label>
          <div class="row">
            <button type="submit">建立邀請碼</button>
            <span class="status" id="inviteStatus"></span>
          </div>
        </form>
      </section>
    </div>
    <div class="grid equal">
      <section>
        <h2>Renderer Pool</h2>
        <form id="rendererForm">
          <label>名稱
            <input name="name" placeholder="Tokyo renderer 01" required>
          </label>
          <label>Endpoint URL
            <input name="endpointUrl" placeholder="https://renderer.aiposter.jp/render" required>
          </label>
          <label>狀態
            <select name="status">
              <option value="active">active</option>
              <option value="draining">draining</option>
              <option value="paused">paused</option>
              <option value="disabled">disabled</option>
            </select>
          </label>
          <label>權重 / 同時轉檔上限
            <input name="weight" type="number" min="1" value="100">
            <input name="maxConcurrentJobs" type="number" min="1" value="1">
          </label>
          <label>Metadata JSON
            <textarea name="metadata">{"region":"asia","codec":"h265","fps":60}</textarea>
          </label>
          <div class="row">
            <button type="submit">新增/更新 renderer</button>
            <span class="status" id="rendererStatus"></span>
          </div>
        </form>
      </section>
      <section>
        <h2>客服查詢</h2>
        <form id="supportForm">
          <label>Email
            <input name="email" type="email" placeholder="client@example.com">
          </label>
          <label>Job ID
            <input name="jobId" placeholder="job_xxx">
          </label>
          <div class="row">
            <button type="submit">查詢</button>
            <span class="status" id="supportStatus"></span>
          </div>
        </form>
        <div id="supportResult" class="support-result muted">輸入 email 或 job id 後查詢。</div>
      </section>
    </div>
    <div class="grid equal">
      <section>
        <h2>客戶清單</h2>
        <div id="customerTable" class="scroll muted">載入中...</div>
      </section>
      <section>
        <h2>邀請碼清單</h2>
        <div id="inviteTable" class="scroll muted">載入中...</div>
      </section>
    </div>
    <div class="grid equal">
      <section>
        <h2>Renderer 狀態</h2>
        <div id="rendererTable" class="scroll muted">載入中...</div>
      </section>
      <section>
        <h2>方案、警報、備份</h2>
        <div id="opsTable" class="scroll muted">載入中...</div>
      </section>
    </div>
    <section>
      <h2>目前使用者指派</h2>
      <div id="assignmentTable" class="muted">載入中...</div>
    </section>
    <section>
      <h2>Web App 版本</h2>
      <div id="versionTable" class="muted">載入中...</div>
    </section>
  </main>
  <script>
    const state = {
      versions: [],
      assignments: [],
      commercial: {
        plans: [],
        customers: [],
        invites: [],
        renderers: [],
        alerts: [],
        invoices: [],
        payments: [],
        backups: []
      }
    };
    const qs = (selector) => document.querySelector(selector);

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    }

    function readJsonField(value) {
      try {
        return value.trim() ? JSON.parse(value) : {};
      } catch (error) {
        throw new Error("JSON 格式不正確：" + error.message);
      }
    }

    function setStatus(selector, text) {
      const node = qs(selector);
      if (node) node.textContent = text;
    }

    function badge(value) {
      const text = escapeHtml(value || "");
      const className = /failed|disabled|past_due|open/i.test(value || "")
        ? "fail"
        : /queued|processing|trial|warning|paused|draining/i.test(value || "")
          ? "warn"
          : "ok";
      return '<span class="badge ' + className + '">' + text + '</span>';
    }

    function money(cents, currency) {
      const amount = Number(cents || 0) / 100;
      return escapeHtml(currency || "TWD") + " " + amount.toLocaleString("zh-TW");
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          "content-type": "application/json",
          ...(options.headers || {})
        }
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.message || data.code || "Request failed");
      }
      return data;
    }

    function renderVersions() {
      qs("#versionSelect").innerHTML = state.versions.map((version) =>
        '<option value="' + escapeHtml(version.id) + '">' +
        escapeHtml(version.name) + ' (' + escapeHtml(version.id) + ')' +
        (version.isDefault ? ' - default' : '') + '</option>'
      ).join("");

      qs("#versionTable").innerHTML = '<table><thead><tr><th>ID</th><th>名稱</th><th>預設</th><th>設定</th></tr></thead><tbody>' +
        state.versions.map((version) => '<tr><td><code>' + escapeHtml(version.id) + '</code></td><td>' +
        escapeHtml(version.name) + '<br><span class="muted">' + escapeHtml(version.description || "") +
        '</span></td><td>' + (version.isDefault ? '是' : '') + '</td><td><code>' +
        escapeHtml(JSON.stringify(version.config || {})) + '</code></td></tr>').join("") +
        '</tbody></table>';
    }

    function renderAssignments() {
      if (!state.assignments.length) {
        qs("#assignmentTable").innerHTML = '<p class="muted">尚未建立使用者指派。</p>';
        return;
      }

      qs("#assignmentTable").innerHTML = '<table><thead><tr><th>Email</th><th>姓名</th><th>版本</th><th>方案</th><th>功能覆寫</th><th>狀態</th><th>更新</th></tr></thead><tbody>' +
        state.assignments.map((item) => '<tr><td><code>' + escapeHtml(item.email) + '</code></td><td>' +
        escapeHtml(item.displayName || '') + '</td><td>' + escapeHtml(item.appVersionName || item.appVersionId) +
        '<br><code>' + escapeHtml(item.appVersionId) + '</code></td><td>' + escapeHtml(item.plan) +
        '<br><span class="muted">' + escapeHtml(item.role) + '</span></td><td><code>' +
        escapeHtml(JSON.stringify(item.featureOverrides || {})) + '</code></td><td>' + escapeHtml(item.status) +
        '</td><td>' + escapeHtml(item.updatedAt || '') + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function fillCommercialSelects() {
      qs("#customerSelect").innerHTML = '<option value="">不指定客戶</option>' +
        state.commercial.customers.map((customer) =>
          '<option value="' + escapeHtml(customer.id) + '">' + escapeHtml(customer.name) + ' (' + escapeHtml(customer.id) + ')</option>'
        ).join("");

      qs("#inviteVersionSelect").innerHTML = state.versions.map((version) =>
        '<option value="' + escapeHtml(version.id) + '">' + escapeHtml(version.name) + ' (' + escapeHtml(version.id) + ')</option>'
      ).join("");
    }

    function renderCommercialCards() {
      const activeRenderers = state.commercial.renderers.filter((row) => row.status === "active").length;
      const openAlerts = state.commercial.alerts.filter((row) => row.status === "open").length;
      const queuedJobs = state.commercial.alerts.filter((row) => /renderer|queue/i.test(row.source || "")).length;
      qs("#commercialCards").innerHTML = [
        ["客戶", state.commercial.customers.length, "customer_accounts"],
        ["邀請碼", state.commercial.invites.length, "commercial_invite_codes"],
        ["Active Renderers", activeRenderers, "export_workers"],
        ["未處理警報", openAlerts, "system_alerts"],
        ["佇列警報", queuedJobs, "queue / renderer"],
        ["發票紀錄", state.commercial.invoices.length, "invoices"],
        ["付款紀錄", state.commercial.payments.length, "payments"],
        ["備份紀錄", state.commercial.backups.length, "backup_runs"]
      ].map((item) => '<div class="card"><span class="muted">' + escapeHtml(item[0]) + '</span><strong>' +
        escapeHtml(item[1]) + '</strong><code>' + escapeHtml(item[2]) + '</code></div>').join("");
    }

    function renderCustomers() {
      if (!state.commercial.customers.length) {
        qs("#customerTable").innerHTML = '<p class="muted">尚未建立客戶。</p>';
        return;
      }
      qs("#customerTable").innerHTML = '<table><thead><tr><th>ID</th><th>客戶</th><th>Owner</th><th>方案</th><th>狀態</th><th>付款</th></tr></thead><tbody>' +
        state.commercial.customers.map((customer) => '<tr><td><code>' + escapeHtml(customer.id) + '</code></td><td>' +
        escapeHtml(customer.name) + '<br><span class="muted">' + escapeHtml(customer.company_name || "") + '</span></td><td><code>' +
        escapeHtml(customer.owner_email) + '</code></td><td>' + escapeHtml(customer.plan) + '</td><td>' + badge(customer.status) +
        '</td><td>' + escapeHtml(customer.payment_provider || "未設定") + '<br><span class="muted">' +
        escapeHtml(customer.billing_email || "") + '</span></td></tr>').join("") + '</tbody></table>';
    }

    function renderInvites() {
      if (!state.commercial.invites.length) {
        qs("#inviteTable").innerHTML = '<p class="muted">尚未建立邀請碼。</p>';
        return;
      }
      qs("#inviteTable").innerHTML = '<table><thead><tr><th>Code</th><th>Email</th><th>客戶</th><th>方案</th><th>使用</th><th>狀態</th></tr></thead><tbody>' +
        state.commercial.invites.map((invite) => '<tr><td><code>' + escapeHtml(invite.code) + '</code></td><td>' +
        escapeHtml(invite.email || "不限") + '</td><td><code>' + escapeHtml(invite.customer_id || "") + '</code></td><td>' +
        escapeHtml(invite.plan) + '<br><span class="muted">' + escapeHtml(invite.role) + '</span></td><td>' +
        escapeHtml(invite.redemption_count || 0) + ' / ' + escapeHtml(invite.max_redemptions || 1) + '</td><td>' +
        badge(invite.status) + '</td></tr>').join("") + '</tbody></table>';
    }

    function renderRenderers() {
      if (!state.commercial.renderers.length) {
        qs("#rendererTable").innerHTML = '<p class="muted">尚未建立 renderer。若未建立，系統會 fallback 到 RENDERER_URL secret。</p>';
        return;
      }
      qs("#rendererTable").innerHTML = '<table><thead><tr><th>ID</th><th>名稱</th><th>URL</th><th>負載</th><th>狀態</th><th>更新</th></tr></thead><tbody>' +
        state.commercial.renderers.map((renderer) => '<tr><td><code>' + escapeHtml(renderer.id) + '</code></td><td>' +
        escapeHtml(renderer.name) + '</td><td><code>' + escapeHtml(renderer.endpoint_url) + '</code></td><td>' +
        escapeHtml(renderer.active_jobs || 0) + ' / ' + escapeHtml(renderer.max_concurrent_jobs || 1) + '<br><span class="muted">weight ' +
        escapeHtml(renderer.weight || 100) + '</span></td><td>' + badge(renderer.status) + '</td><td>' +
        escapeHtml(renderer.updated_at || "") + '</td></tr>').join("") + '</tbody></table>';
    }

    function renderOps() {
      const planRows = state.commercial.plans.map((plan) => '<tr><td><code>' + escapeHtml(plan.id) + '</code></td><td>' +
        escapeHtml(plan.name) + '</td><td>' + money(plan.monthly_price_cents, plan.currency) + '</td><td>' +
        escapeHtml(plan.exports_per_day) + '/day, ' + escapeHtml(plan.concurrent_exports) + ' concurrent</td></tr>').join("");
      const alertRows = state.commercial.alerts.slice(0, 8).map((alert) => '<tr><td>' + badge(alert.status) + '</td><td>' +
        escapeHtml(alert.title) + '<br><span class="muted">' + escapeHtml(alert.message) + '</span></td><td>' +
        escapeHtml(alert.created_at || "") + '</td></tr>').join("");
      const backupRows = state.commercial.backups.slice(0, 5).map((backup) => '<tr><td><code>' + escapeHtml(backup.id) + '</code></td><td>' +
        escapeHtml(backup.kind) + '</td><td>' + badge(backup.status) + '</td><td>' + escapeHtml(backup.started_at || "") + '</td></tr>').join("");
      qs("#opsTable").innerHTML =
        '<h3>方案</h3><table><tbody>' + (planRows || '<tr><td class="muted">尚未套用商用 schema。</td></tr>') + '</tbody></table>' +
        '<h3>警報</h3><table><tbody>' + (alertRows || '<tr><td class="muted">目前沒有警報。</td></tr>') + '</tbody></table>' +
        '<h3>備份紀錄</h3><table><tbody>' + (backupRows || '<tr><td class="muted">尚未建立備份紀錄。</td></tr>') + '</tbody></table>';
    }

    function renderCommercial() {
      fillCommercialSelects();
      renderCommercialCards();
      renderCustomers();
      renderInvites();
      renderRenderers();
      renderOps();
    }

    function renderSupportResult(data) {
      const jobs = (data.jobs || []).map((job) => '<tr><td><code>' + escapeHtml(job.id) + '</code></td><td>' +
        badge(job.status) + '</td><td>' + escapeHtml(job.errorMessage || job.error_message || "") + '</td><td>' +
        (job.outputUrl ? '<a href="' + escapeHtml(job.outputUrl) + '">下載</a>' : '<span class="muted">無</span>') +
        '</td><td>' + escapeHtml(job.updatedAt || job.updated_at || "") + '</td></tr>').join("");
      const users = (data.users || []).map((item) => '<tr><td><code>' + escapeHtml(item.email) + '</code></td><td>' +
        escapeHtml(item.plan) + '</td><td>' + escapeHtml(item.role) + '</td><td>' + badge(item.status) + '</td></tr>').join("");
      const alerts = (data.alerts || []).map((alert) => '<tr><td>' + badge(alert.status) + '</td><td>' +
        escapeHtml(alert.title) + '<br><span class="muted">' + escapeHtml(alert.message) + '</span></td><td>' +
        escapeHtml(alert.created_at || "") + '</td></tr>').join("");
      qs("#supportResult").innerHTML =
        '<h3>使用者</h3><table><tbody>' + (users || '<tr><td class="muted">查無使用者。</td></tr>') + '</tbody></table>' +
        '<h3>輸出任務</h3><table><thead><tr><th>Job</th><th>狀態</th><th>錯誤</th><th>下載</th><th>更新</th></tr></thead><tbody>' +
        (jobs || '<tr><td class="muted" colspan="5">查無任務。</td></tr>') + '</tbody></table>' +
        '<h3>相關警報</h3><table><tbody>' + (alerts || '<tr><td class="muted">查無警報。</td></tr>') + '</tbody></table>';
    }

    async function loadAdmin() {
      const [data, commercial] = await Promise.all([
        api("/api/admin/overview"),
        api("/api/admin/commercial")
      ]);
      state.versions = data.versions || [];
      state.assignments = data.assignments || [];
      state.commercial = {
        plans: commercial.plans || [],
        customers: commercial.customers || [],
        invites: commercial.invites || [],
        renderers: commercial.renderers || [],
        alerts: commercial.alerts || [],
        invoices: commercial.invoices || [],
        payments: commercial.payments || [],
        backups: commercial.backups || []
      };
      renderVersions();
      renderAssignments();
      renderCommercial();
    }

    qs("#refreshButton").addEventListener("click", () => {
      loadAdmin().catch((error) => alert(error.message));
    });

    qs("#customerForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setStatus("#customerStatus", "儲存中...");
      try {
        await api("/api/admin/customers", {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            ownerEmail: form.get("ownerEmail"),
            plan: form.get("plan"),
            status: form.get("status"),
            billingEmail: form.get("billingEmail"),
            companyName: form.get("companyName"),
            taxId: form.get("taxId"),
            paymentProvider: form.get("paymentProvider"),
            externalCustomerId: form.get("externalCustomerId"),
            notes: form.get("notes")
          })
        });
        setStatus("#customerStatus", "已儲存");
        await loadAdmin();
      } catch (error) {
        setStatus("#customerStatus", error.message);
      }
    });

    qs("#inviteForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setStatus("#inviteStatus", "儲存中...");
      try {
        await api("/api/admin/invites", {
          method: "POST",
          body: JSON.stringify({
            customerId: form.get("customerId"),
            email: form.get("email"),
            plan: form.get("plan"),
            role: form.get("role"),
            appVersionId: form.get("appVersionId"),
            maxRedemptions: form.get("maxRedemptions"),
            expiresAt: form.get("expiresAt"),
            code: form.get("code"),
            notes: form.get("notes")
          })
        });
        setStatus("#inviteStatus", "已建立");
        event.currentTarget.reset();
        await loadAdmin();
      } catch (error) {
        setStatus("#inviteStatus", error.message);
      }
    });

    qs("#rendererForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setStatus("#rendererStatus", "儲存中...");
      try {
        await api("/api/admin/renderers", {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            endpointUrl: form.get("endpointUrl"),
            status: form.get("status"),
            weight: form.get("weight"),
            maxConcurrentJobs: form.get("maxConcurrentJobs"),
            metadata: readJsonField(form.get("metadata"))
          })
        });
        setStatus("#rendererStatus", "已儲存");
        await loadAdmin();
      } catch (error) {
        setStatus("#rendererStatus", error.message);
      }
    });

    qs("#supportForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const params = new URLSearchParams();
      if (form.get("email")) params.set("email", form.get("email"));
      if (form.get("jobId")) params.set("jobId", form.get("jobId"));
      setStatus("#supportStatus", "查詢中...");
      try {
        const data = await api("/api/admin/support?" + params.toString());
        renderSupportResult(data);
        setStatus("#supportStatus", "完成");
      } catch (error) {
        setStatus("#supportStatus", error.message);
      }
    });

    qs("#assignmentForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      qs("#assignmentStatus").textContent = "儲存中...";
      try {
        await api("/api/admin/assignments", {
          method: "POST",
          body: JSON.stringify({
            email: form.get("email"),
            displayName: form.get("displayName"),
            appVersionId: form.get("appVersionId"),
            plan: form.get("plan"),
            role: form.get("role"),
            status: form.get("status"),
            featureOverrides: readJsonField(form.get("featureOverrides")),
            notes: form.get("notes")
          })
        });
        qs("#assignmentStatus").textContent = "已儲存";
        await loadAdmin();
      } catch (error) {
        qs("#assignmentStatus").textContent = error.message;
      }
    });

    qs("#versionForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      qs("#versionStatus").textContent = "儲存中...";
      try {
        await api("/api/admin/versions", {
          method: "POST",
          body: JSON.stringify({
            id: form.get("id"),
            name: form.get("name"),
            description: form.get("description"),
            isDefault: form.get("isDefault") === "on",
            config: readJsonField(form.get("config"))
          })
        });
        qs("#versionStatus").textContent = "已儲存";
        event.currentTarget.reset();
        await loadAdmin();
      } catch (error) {
        qs("#versionStatus").textContent = error.message;
      }
    });

    loadAdmin().catch((error) => {
      qs("#assignmentTable").textContent = error.message;
      qs("#versionTable").textContent = error.message;
    });
  </script>
</body>
</html>`;

function html(content, init = {}) {
  return new Response(content, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {})
    }
  });
}

export default {
  async queue(batch, env) {
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await processExportQueueMessage(message, env);
        message.ack();
      } catch (error) {
        const jobId = message.body?.jobId;
        if (jobId) {
          await markJob(env, jobId, "failed", error.message || "Queue processing failed.");
        }
        message.ack();
      }
    }));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      const user = await getOrCreateUser(request, env);
      const forbidden = requireAdmin(user);
      if (forbidden) {
        return forbidden;
      }
      return html(ADMIN_HTML);
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "aiposter-new",
        env: env.APP_ENV || "production"
      });
    }

    if (url.pathname === "/api/me") {
      const user = await getOrCreateUser(request, env);
      return json({
        ok: true,
        ...(await getFeaturePayload(env, user))
      });
    }

    if (url.pathname === "/api/features") {
      const user = await getOrCreateUser(request, env);
      return json({
        ok: true,
        ...(await getFeaturePayload(env, user))
      });
    }

    if (url.pathname === "/api/commerce/invite-request") {
      return handleCommerceInviteRequest(request, env);
    }

    if (url.pathname === "/api/invites/redeem") {
      const user = await getOrCreateUser(request, env);
      return handleInviteRedemption(request, env, user);
    }

    if (url.pathname === "/api/admin/overview") {
      const user = await getOrCreateUser(request, env);
      return handleAdminOverview(request, env, user);
    }

    if (url.pathname === "/api/admin/versions") {
      const user = await getOrCreateUser(request, env);
      return handleAdminVersions(request, env, user);
    }

    if (url.pathname === "/api/admin/assignments") {
      const user = await getOrCreateUser(request, env);
      return handleAdminAssignments(request, env, user);
    }

    if (url.pathname === "/api/admin/commercial") {
      const user = await getOrCreateUser(request, env);
      return handleAdminCommercial(request, env, user);
    }

    if (url.pathname === "/api/admin/customers") {
      const user = await getOrCreateUser(request, env);
      return handleAdminCustomers(request, env, user);
    }

    if (url.pathname === "/api/admin/invites") {
      const user = await getOrCreateUser(request, env);
      return handleAdminInvites(request, env, user);
    }

    if (url.pathname === "/api/admin/renderers") {
      const user = await getOrCreateUser(request, env);
      return handleAdminRenderers(request, env, user);
    }

    if (url.pathname === "/api/admin/support") {
      const user = await getOrCreateUser(request, env);
      return handleAdminSupport(request, env, user);
    }

    if (url.pathname === "/api/admin/alerts") {
      const user = await getOrCreateUser(request, env);
      return handleAdminAlerts(request, env, user);
    }

    if (url.pathname === "/api/admin/backups") {
      const user = await getOrCreateUser(request, env);
      return handleAdminBackupRuns(request, env, user);
    }

    if (url.pathname.startsWith("/api/admin/jobs/") && url.pathname.endsWith("/output")) {
      const user = await getOrCreateUser(request, env);
      const jobId = url.pathname.slice("/api/admin/jobs/".length, -"/output".length);
      return handleAdminJobOutput(request, env, user, decodeURIComponent(jobId));
    }

    if (url.pathname === "/api/projects") {
      const user = await getOrCreateUser(request, env);
      return handleProjects(request, env, user);
    }

    if (url.pathname === "/api/assets") {
      const user = await getOrCreateUser(request, env);
      return handleAssets(request, env, user);
    }

    if (url.pathname.startsWith("/api/assets/")) {
      const user = await getOrCreateUser(request, env);
      return handleAssetById(request, env, user, url.pathname.slice("/api/assets/".length));
    }

    if (url.pathname === "/api/jobs") {
      const user = await getOrCreateUser(request, env);
      return handleJobs(request, env, user);
    }

    if (url.pathname === "/api/jobs/export") {
      const user = await getOrCreateUser(request, env);
      return handleExportJob(request, env, user, ctx);
    }

    if (url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/output")) {
      const user = await getOrCreateUser(request, env);
      const jobId = url.pathname.slice("/api/jobs/".length, -"/output".length);
      return handleJobOutput(request, env, user, decodeURIComponent(jobId));
    }

    if (url.pathname.startsWith("/api/jobs/")) {
      const user = await getOrCreateUser(request, env);
      return handleJobById(request, env, user, url.pathname.slice("/api/jobs/".length));
    }

    if (url.pathname === "/api/export_h265") {
      return json(
        {
          ok: false,
          code: "EXPORT_BACKEND_NOT_ENABLED",
          message: "Cloud H.265 export is not enabled yet."
        },
        { status: 501 }
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return json(
        {
          ok: false,
          code: "API_NOT_READY",
          message: "This API endpoint is not enabled yet."
        },
        { status: 404 }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
