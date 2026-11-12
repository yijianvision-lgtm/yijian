-- Distinguish upload compensation from explicit user-requested deletion.
-- Upload intents keep their one-hour safety grace; delete intents are eligible
-- immediately because the owner has already requested removal.
ALTER TABLE nebula_object_cleanup
  ADD COLUMN intent_kind TEXT NOT NULL DEFAULT 'upload'
  CHECK (intent_kind IN ('upload', 'delete'));

CREATE INDEX IF NOT EXISTS idx_nebula_object_cleanup_kind_status
  ON nebula_object_cleanup (intent_kind, status, created_at, lease_expires_at);
