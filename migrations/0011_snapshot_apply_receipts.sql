-- Durable client-reported local application receipt for bootstrap snapshots.
-- This is an auditable checksum assertion, not cryptographic remote proof of local disk state.
ALTER TABLE nebula_sync_snapshots ADD COLUMN applied_checksum TEXT
  CHECK (applied_checksum IS NULL OR (length(applied_checksum) = 64 AND applied_checksum NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE nebula_sync_snapshots ADD COLUMN applied_at TEXT;
