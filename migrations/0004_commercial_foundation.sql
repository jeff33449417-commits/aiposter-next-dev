CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  exports_per_day INTEGER NOT NULL DEFAULT 0,
  concurrent_exports INTEGER NOT NULL DEFAULT 1,
  max_upload_mb INTEGER NOT NULL DEFAULT 10,
  retention_days INTEGER NOT NULL DEFAULT 7,
  features_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'business',
  billing_email TEXT,
  company_name TEXT,
  tax_id TEXT,
  payment_provider TEXT,
  external_customer_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_accounts_owner
  ON customer_accounts(owner_email);

CREATE INDEX IF NOT EXISTS idx_customer_accounts_status
  ON customer_accounts(status, plan);

CREATE TABLE IF NOT EXISTS customer_members (
  customer_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  invited_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, email),
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_customer_members_email
  ON customer_members(email, status);

CREATE TABLE IF NOT EXISTS commercial_invite_codes (
  code TEXT PRIMARY KEY,
  customer_id TEXT,
  email TEXT,
  plan TEXT NOT NULL DEFAULT 'business',
  role TEXT NOT NULL DEFAULT 'business_user',
  app_version_id TEXT NOT NULL DEFAULT 'default',
  max_redemptions INTEGER NOT NULL DEFAULT 1,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id),
  FOREIGN KEY (app_version_id) REFERENCES app_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_commercial_invite_codes_email
  ON commercial_invite_codes(email, status);

CREATE INDEX IF NOT EXISTS idx_commercial_invite_codes_customer
  ON commercial_invite_codes(customer_id, status);

CREATE TABLE IF NOT EXISTS commerce_invite_requests (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'dy.com.tw',
  idempotency_key TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, idempotency_key),
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id),
  FOREIGN KEY (invite_code) REFERENCES commercial_invite_codes(code)
);

CREATE INDEX IF NOT EXISTS idx_commerce_invite_requests_email
  ON commerce_invite_requests(email, status, created_at);

CREATE INDEX IF NOT EXISTS idx_commerce_invite_requests_customer
  ON commerce_invite_requests(customer_id, created_at);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  invoice_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'TWD',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  paid_at TEXT,
  external_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_status
  ON invoices(customer_id, status, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  invoice_id TEXT,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);

CREATE INDEX IF NOT EXISTS idx_payments_customer_status
  ON payments(customer_id, status, created_at);

CREATE TABLE IF NOT EXISTS export_workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  weight INTEGER NOT NULL DEFAULT 100,
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_export_workers_status
  ON export_workers(status, active_jobs, weight);

CREATE TABLE IF NOT EXISTS system_alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL DEFAULT 'warning',
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  related_job_id TEXT,
  related_email TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_system_alerts_status
  ON system_alerts(status, severity, created_at);

CREATE INDEX IF NOT EXISTS idx_system_alerts_related
  ON system_alerts(related_email, related_job_id);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  target TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_status
  ON backup_runs(status, started_at);

INSERT OR IGNORE INTO billing_plans
  (id, name, status, monthly_price_cents, currency, exports_per_day, concurrent_exports, max_upload_mb, retention_days, features_json, created_at, updated_at)
VALUES
  ('beta', 'Beta 測試方案', 'active', 0, 'TWD', 30, 1, 10, 7, '{"h265_export":true,"support_level":"beta"}', datetime('now'), datetime('now')),
  ('pro', 'Pro 商用方案', 'active', 99000, 'TWD', 300, 1, 10, 14, '{"h265_export":true,"support_level":"standard"}', datetime('now'), datetime('now')),
  ('business', 'Business 團隊方案', 'active', 499000, 'TWD', 1000, 2, 10, 30, '{"h265_export":true,"team_workspace":true,"support_level":"business"}', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO plan_limits
  (plan, projects, exports_per_day, ai_jobs_per_day, max_upload_mb, updated_at)
VALUES
  ('business', 1000, 1000, 5000, 1024, datetime('now'));

INSERT OR IGNORE INTO plan_features (plan, feature_name, enabled) VALUES
  ('business', 'poster_editor', 1),
  ('business', 'video_editor', 1),
  ('business', 'h265_export', 1),
  ('business', 'ai_generation', 1),
  ('business', 'custom_templates', 1),
  ('business', 'team_workspace', 1);
