CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_app_assignments (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  app_version_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'beta',
  role TEXT NOT NULL DEFAULT 'beta_user',
  status TEXT NOT NULL DEFAULT 'active',
  feature_overrides_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_version_id) REFERENCES app_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_user_app_assignments_version
  ON user_app_assignments(app_version_id);

INSERT OR IGNORE INTO app_versions
  (id, name, description, config_json, is_default, created_at, updated_at)
VALUES
  (
    'default',
    'AI Poster Default',
    'Default public beta editor configuration.',
    '{"theme":"default","templateSet":"default","entryPath":"/","enabledPanels":["text","image","video"],"branding":{"name":"AI Poster"}}',
    1,
    datetime('now'),
    datetime('now')
  ),
  (
    'beta_full',
    'AI Poster Beta Full',
    'Full beta access for selected testers.',
    '{"theme":"default","templateSet":"beta","entryPath":"/","enabledPanels":["text","image","video","export"],"branding":{"name":"AI Poster Beta"}}',
    0,
    datetime('now'),
    datetime('now')
  ),
  (
    'client_custom',
    'Client Custom Starter',
    'Starter configuration for a dedicated client web app.',
    '{"theme":"client","templateSet":"client-starter","entryPath":"/","enabledPanels":["text","image","video"],"branding":{"name":"Client AI Poster"}}',
    0,
    datetime('now'),
    datetime('now')
  );
