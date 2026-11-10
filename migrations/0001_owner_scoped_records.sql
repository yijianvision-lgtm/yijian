-- NEBULA owner-scoped private records.
-- Apply only to an isolated test D1 database after explicit approval.
-- No Worker deployment or database creation is performed by this migration.

CREATE TABLE IF NOT EXISTS nebula_records (
  owner_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (length(record_type) BETWEEN 1 AND 64),
  record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 128),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object' AND length(payload_json) <= 262144),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, record_type, record_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_records_owner_type_updated
  ON nebula_records (owner_id, record_type, updated_at DESC, record_id);
