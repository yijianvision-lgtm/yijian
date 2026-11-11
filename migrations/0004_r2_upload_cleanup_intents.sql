-- Durable cleanup intents for R2 uploads whose D1 metadata write may fail.
-- A reconciler must check nebula_objects before deleting any R2 key: a metadata
-- row means the upload committed and only the stale intent should be removed.
CREATE TABLE IF NOT EXISTS nebula_object_cleanup (
  owner_id TEXT NOT NULL
    CHECK (length(owner_id) = 68 AND substr(owner_id, 1, 4) = 'own_' AND substr(owner_id, 5) NOT GLOB '*[^0-9a-f]*'),
  object_id TEXT NOT NULL CHECK (length(object_id) = 36 AND object_id NOT GLOB '*[^0-9a-f-]*'),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 64 AND substr(category, 1, 1) GLOB '[a-z]' AND category NOT GLOB '*[^a-z0-9_-]*'),
  object_key TEXT NOT NULL CHECK (object_key = 'owners/' || owner_id || '/' || category || '/' || object_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, category, object_id),
  UNIQUE (object_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_nebula_object_cleanup_created
  ON nebula_object_cleanup (created_at, owner_id);
