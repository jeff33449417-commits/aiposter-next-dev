CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_export_per_user
ON jobs(owner_user_id, type)
WHERE type = 'export_h265'
  AND status IN ('queued', 'processing', 'waiting_renderer');

CREATE INDEX IF NOT EXISTS idx_jobs_export_queue_order
ON jobs(type, status, created_at)
WHERE type = 'export_h265'
  AND status IN ('queued', 'processing', 'waiting_renderer');
