CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_owner_updated ON knowledge(owner_id, updated_at);

CREATE TABLE IF NOT EXISTS private_references (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_private_refs_owner_created ON private_references(owner_id, created_at);

-- Every row is scoped by the verified identity-provider subject (owner_id).
-- File objects use the same owner_id as the first R2 key segment.
-- Payload/file encryption is performed in the browser before upload.