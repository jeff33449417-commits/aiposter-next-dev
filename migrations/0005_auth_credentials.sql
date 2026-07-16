-- Per-user login passwords for invited/admin-provisioned accounts.
-- (Env-configured accounts keep their password in the AUTH_ACCOUNTS secret;
-- this table holds admin/invite-provisioned accounts, password stored HASHED.)
CREATE TABLE IF NOT EXISTS auth_credentials (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
