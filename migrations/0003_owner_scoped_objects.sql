-- D1 metadata for private R2 objects. Raw object keys are server-generated.
-- Apply only to an isolated test D1 database after explicit approval.
CREATE TABLE IF NOT EXISTS nebula_objects (
  owner_id TEXT NOT NULL
    CHECK (length(owner_id) = 68 AND substr(owner_id, 1, 4) = 'own_' AND substr(owner_id, 5) NOT GLOB '*[^0-9a-f]*'),
  object_id TEXT NOT NULL CHECK (length(object_id) = 36 AND object_id NOT GLOB '*[^0-9a-f-]*'),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 64 AND substr(category, 1, 1) GLOB '[a-z]' AND category NOT GLOB '*[^a-z0-9_-]*'),
  object_key TEXT NOT NULL CHECK (object_key LIKE 'owners/' || owner_id || '/' || category || '/%'),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 128),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 104857600),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleting')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, category, object_id),
  UNIQUE (object_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nebula_objects_owner_category_created
  ON nebula_objects (owner_id, category, status, created_at DESC, object_id);
