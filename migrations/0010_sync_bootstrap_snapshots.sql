-- Immutable per-device bootstrap snapshots.
-- A snapshot captures the category sequence watermark and record rows in one D1 batch.
-- Snapshot material is temporary and must expire; no tombstone compaction depends on it.

CREATE TABLE IF NOT EXISTS nebula_sync_snapshots (
  owner_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL CHECK (snapshot_seq >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired')),
  last_cursor TEXT NOT NULL DEFAULT '',
  pages_complete INTEGER NOT NULL DEFAULT 0 CHECK (pages_complete IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (owner_id, snapshot_id),
  FOREIGN KEY (owner_id, device_id)
    REFERENCES nebula_sync_devices (owner_id, device_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_sync_snapshots_expiry
  ON nebula_sync_snapshots (status, expires_at);

CREATE TABLE IF NOT EXISTS nebula_sync_snapshot_records (
  owner_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_id, snapshot_id, record_id),
  FOREIGN KEY (owner_id, snapshot_id)
    REFERENCES nebula_sync_snapshots (owner_id, snapshot_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS nebula_sync_snapshot_pages (
  owner_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  cursor_after TEXT NOT NULL DEFAULT '',
  cursor_next TEXT NOT NULL DEFAULT '',
  has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
  page_limit INTEGER NOT NULL CHECK (page_limit BETWEEN 1 AND 50),
  issued_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, snapshot_id, cursor_after),
  FOREIGN KEY (owner_id, snapshot_id)
    REFERENCES nebula_sync_snapshots (owner_id, snapshot_id) ON DELETE CASCADE
) WITHOUT ROWID;
