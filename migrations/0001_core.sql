CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'free_user',
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'team_member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  name TEXT PRIMARY KEY,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_features (
  plan TEXT NOT NULL,
  feature_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan, feature_name),
  FOREIGN KEY (feature_name) REFERENCES feature_flags(name)
);

CREATE TABLE IF NOT EXISTS user_feature_overrides (
  user_id TEXT NOT NULL,
  feature_name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, feature_name),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (feature_name) REFERENCES feature_flags(name)
);

CREATE TABLE IF NOT EXISTS plan_limits (
  plan TEXT PRIMARY KEY,
  projects INTEGER NOT NULL,
  exports_per_day INTEGER NOT NULL,
  ai_jobs_per_day INTEGER NOT NULL,
  max_upload_mb INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  team_id TEXT,
  title TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  project_id TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  project_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_r2_key TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  exports_count INTEGER NOT NULL DEFAULT 0,
  ai_jobs_count INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  email TEXT,
  plan TEXT NOT NULL DEFAULT 'beta',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO feature_flags (name, description, enabled, created_at, updated_at) VALUES
  ('poster_editor', 'Poster editor access', 1, datetime('now'), datetime('now')),
  ('video_editor', 'Video editor access', 1, datetime('now'), datetime('now')),
  ('h265_export', 'H.265 export access', 0, datetime('now'), datetime('now')),
  ('ai_generation', 'AI generation access', 1, datetime('now'), datetime('now')),
  ('custom_templates', 'Custom template access', 0, datetime('now'), datetime('now')),
  ('team_workspace', 'Team workspace access', 0, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO plan_limits (plan, projects, exports_per_day, ai_jobs_per_day, max_upload_mb, updated_at) VALUES
  ('free', 3, 2, 5, 25, datetime('now')),
  ('beta', 20, 30, 100, 250, datetime('now')),
  ('pro', 200, 300, 1000, 1024, datetime('now'));

INSERT OR IGNORE INTO plan_features (plan, feature_name, enabled) VALUES
  ('free', 'poster_editor', 1),
  ('free', 'video_editor', 0),
  ('free', 'h265_export', 0),
  ('free', 'ai_generation', 1),
  ('free', 'custom_templates', 0),
  ('free', 'team_workspace', 0),
  ('beta', 'poster_editor', 1),
  ('beta', 'video_editor', 1),
  ('beta', 'h265_export', 0),
  ('beta', 'ai_generation', 1),
  ('beta', 'custom_templates', 1),
  ('beta', 'team_workspace', 0),
  ('pro', 'poster_editor', 1),
  ('pro', 'video_editor', 1),
  ('pro', 'h265_export', 1),
  ('pro', 'ai_generation', 1),
  ('pro', 'custom_templates', 1),
  ('pro', 'team_workspace', 1);
