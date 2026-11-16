-- Per-device sync acknowledgement foundation.
-- This schema is intentionally not wired to API writes or compaction yet.
-- Apply only to an isolated test D1 database after explicit approval.
-- Revoked devices remain as audit records; they are not silently deleted.

CREATE TABLE IF NOT EXISTS nebula_sync_devices (
  owner_id TEXT NOT NULL
    CHECK (length(owner_id) = 68 AND substr(owner_id, 1, 4) = 'own_' AND substr(owner_id, 5) NOT GLOB '*[^0-9a-f]*'),
  device_id TEXT NOT NULL
    CHECK (length(device_id) = 36 AND device_id GLOB '????????-????-????-????-????????????'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (owner_id, device_id),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
) WITHOUT ROWID;

-- A monotonically increasing sequence is scoped to one owner and record type.
-- It is distinct from wall-clock timestamps and record IDs.
CREATE TABLE IF NOT EXISTS nebula_sync_counters (
  owner_id TEXT NOT NULL
    CHECK (length(owner_id) = 68 AND substr(owner_id, 1, 4) = 'own_' AND substr(owner_id, 5) NOT GLOB '*[^0-9a-f]*'),
  record_type TEXT NOT NULL
    CHECK (length(record_type) BETWEEN 1 AND 64 AND substr(record_type, 1, 1) GLOB '[a-z]' AND record_type NOT GLOB '*[^a-z0-9_-]*'),
  current_seq INTEGER NOT NULL DEFAULT 0 CHECK (current_seq >= 0),
  PRIMARY KEY (owner_id, record_type)
) WITHOUT ROWID;

-- Append-only change feed. Every record upsert/delete must eventually append
-- one row in the same D1 batch as the record mutation.
CREATE TABLE IF NOT EXISTS nebula_sync_changes (
  owner_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  record_id TEXT NOT NULL,
  record_version TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, record_type, sequence),
  UNIQUE (owner_id, record_type, record_id, record_version)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_sync_changes_record
  ON nebula_sync_changes (owner_id, record_type, record_id, sequence);

-- Acknowledgements are per device and category. A missing row means sequence 0.
CREATE TABLE IF NOT EXISTS nebula_sync_device_acks (
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  acknowledged_seq INTEGER NOT NULL CHECK (acknowledged_seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, device_id, record_type),
  FOREIGN KEY (owner_id, device_id)
    REFERENCES nebula_sync_devices (owner_id, device_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_sync_device_acks_watermark
  ON nebula_sync_device_acks (owner_id, record_type, acknowledged_seq);
