-- Per-device delivery ledger. Acknowledgements may advance only across
-- a contiguous range of change-feed sequences issued to that active device.
-- Issuance is recorded before the response; the client acknowledgement is the
-- protocol-level receipt assertion. This is not proof of local durable storage.

CREATE TABLE IF NOT EXISTS nebula_sync_device_deliveries (
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  issued_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, device_id, record_type, sequence),
  FOREIGN KEY (owner_id, device_id)
    REFERENCES nebula_sync_devices (owner_id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, record_type, sequence)
    REFERENCES nebula_sync_changes (owner_id, record_type, sequence) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_sync_deliveries_ack
  ON nebula_sync_device_deliveries (owner_id, device_id, record_type, sequence);
