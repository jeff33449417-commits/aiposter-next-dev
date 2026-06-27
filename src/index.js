const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};
const ACTIVE_EXPORT_STATUSES = ["queued", "processing", "waiting_renderer"];
const DEFAULT_EXPORT_BACKLOG_LIMIT = 50;
const DEFAULT_EXPORT_SECONDS_PER_JOB = 120;
const DEFAULT_VIDEO_UPLOAD_MB = 10;

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

function getAccessEmail(request) {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  return email ? email.trim().toLowerCase() : "";
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
    outputFilename: row?.output_r2_key ? `${row.id}_h265.mp4` : null
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
  await env.DB.prepare(
    `UPDATE jobs
     SET status = 'failed',
         error_message = 'Timed out while waiting for MP4 export. Please submit a new export.',
         updated_at = datetime('now')
     WHERE type = 'export_h265'
       AND status IN (${activeStatusPlaceholders()})
       AND datetime(updated_at) < datetime('now', ?)`
  ).bind(...ACTIVE_EXPORT_STATUSES, `-${timeoutMinutes} minutes`).run();
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

  const ahead = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM jobs
     WHERE type = 'export_h265'
       AND status IN (${activeStatusPlaceholders()})
       AND datetime(created_at) < datetime(?)`
  ).bind(...ACTIVE_EXPORT_STATUSES, job.created_at).first();
  const aheadCount = Number(ahead?.count || 0);
  const secondsPerJob = envNumber(env, "EXPORT_SECONDS_PER_JOB", DEFAULT_EXPORT_SECONDS_PER_JOB);
  return {
    position: aheadCount + 1,
    ahead: aheadCount,
    estimatedSeconds: Math.max(secondsPerJob, (aheadCount + 1) * secondsPerJob)
  };
}

async function serializeJobForResponse(env, row) {
  return serializeJobWithQueue(row, await exportQueueInfo(env, row));
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

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return json({
      ok: false,
      code: "INVALID_EXPORT_PAYLOAD",
      message: "Export payload must be JSON."
    }, { status: 400 });
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
      `SELECT id, mime_type, size_bytes FROM assets
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
    if ((sourceAsset.mime_type || "").startsWith("video/") && Number(sourceAsset.size_bytes || 0) > maxVideoBytes) {
      return json({
        ok: false,
        code: "EXPORT_SOURCE_TOO_LARGE",
        message: `MP4 輸出素材超過 ${envNumber(env, "MAX_VIDEO_UPLOAD_MB", DEFAULT_VIDEO_UPLOAD_MB)}MB，請先壓縮或縮短影片。`
      }, { status: 413 });
    }
  }

  const jobId = `job_${crypto.randomUUID()}`;
  const rendererUrl = (env.RENDERER_URL || "").trim();
  const initialStatus = rendererUrl ? "queued" : "waiting_renderer";
  const initialError = rendererUrl
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

  if (rendererUrl) {
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
      queue: rendererUrl
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

  const rendererUrl = (env.RENDERER_URL || "").trim();
  if (!rendererUrl) {
    await markJob(
      env,
      jobId,
      "waiting_renderer",
      "H.265 renderer service is not connected yet. Source asset is already stored in R2."
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

  try {
    const response = await fetch(rendererUrl, {
      method: "POST",
      headers: {
        "content-type": sourceAsset.mime_type || "video/webm",
        "x-aiposter-job-id": job.id,
        "x-aiposter-owner-user-id": job.owner_user_id,
        "x-aiposter-source-filename": filenameFromR2Key(sourceAsset.r2_key),
        "x-aiposter-duration-seconds": String(job.input?.settings?.durationSeconds || ""),
        "x-aiposter-frame-rate": String(job.input?.settings?.frameRate || ""),
        ...(env.RENDERER_TOKEN ? { authorization: `Bearer ${env.RENDERER_TOKEN}` } : {})
      },
      body: sourceObject.body
    });

    await processRendererResponse(env, job, response);
  } catch (error) {
    await markJob(env, jobId, "failed", error.message || "Renderer request failed.");
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
    if ((file.type || "").startsWith("video/") && file.size > maxVideoBytes) {
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
  return ["free", "beta", "pro"].includes(plan) ? plan : "beta";
}

function normalizeRole(role) {
  return ["free_user", "beta_user", "pro_user", "admin"].includes(role) ? role : "beta_user";
}

function normalizeStatus(status) {
  return ["active", "paused", "disabled"].includes(status) ? status : "active";
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
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; box-shadow: 0 10px 28px rgba(23,32,79,.06); }
    label { display: grid; gap: 6px; font-weight: 700; margin: 12px 0; }
    input, select, textarea { width: 100%; border: 1px solid #b8bfd6; border-radius: 6px; padding: 10px 12px; font: inherit; color: var(--ink); background: white; }
    textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    button { border: 0; background: var(--blue); color: white; border-radius: 6px; padding: 11px 16px; font-weight: 800; cursor: pointer; }
    button.secondary { background: #eef2ff; color: var(--ink); border: 1px solid #bcc7f4; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .muted { color: var(--muted); }
    .status { min-height: 24px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    code { background: #eef2ff; border-radius: 4px; padding: 2px 5px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } header { align-items: start; flex-direction: column; } }
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
              <option value="free">free</option>
            </select>
          </label>
          <label>角色
            <select name="role">
              <option value="beta_user">beta_user</option>
              <option value="pro_user">pro_user</option>
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
            <textarea name="featureOverrides">{"h265_export":false,"video_editor":true,"custom_templates":true}</textarea>
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
      <h2>目前使用者指派</h2>
      <div id="assignmentTable" class="muted">載入中...</div>
    </section>
    <section>
      <h2>Web App 版本</h2>
      <div id="versionTable" class="muted">載入中...</div>
    </section>
  </main>
  <script>
    const state = { versions: [], assignments: [] };
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

    async function loadAdmin() {
      const data = await api("/api/admin/overview");
      state.versions = data.versions || [];
      state.assignments = data.assignments || [];
      renderVersions();
      renderAssignments();
    }

    qs("#refreshButton").addEventListener("click", () => {
      loadAdmin().catch((error) => alert(error.message));
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
