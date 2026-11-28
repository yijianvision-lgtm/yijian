-- Preserve record deletions as versioned tombstones for multi-device sync.
-- Apply only to an isolated test D1 database after explicit approval.
ALTER TABLE nebula_records ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_nebula_records_owner_type_deleted_cursor
  ON nebula_records (owner_id, record_type, deleted_at, record_id);
