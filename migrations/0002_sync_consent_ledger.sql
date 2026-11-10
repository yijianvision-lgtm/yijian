-- Server-side explicit cloud-sync consent ledger.
-- Apply only to an isolated test D1 database after explicit approval.
-- Revocation is retained as a tombstone; it does not silently delete user data.
CREATE TABLE IF NOT EXISTS nebula_sync_consents (
  owner_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(owner_id) = 68 AND substr(owner_id, 1, 4) = 'own_' AND substr(owner_id, 5) NOT GLOB '*[^0-9a-f]*'),
  categories_json TEXT NOT NULL
    CHECK (json_valid(categories_json) AND json_type(categories_json) = 'array' AND length(categories_json) <= 4096),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'paused', 'revoked')),
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_sync_consents_status_updated
  ON nebula_sync_consents (status, updated_at);
