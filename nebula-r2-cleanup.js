const OWNER_ID_PATTERN = /^own_[a-f0-9]{64}$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * System-only cleanup worker for stale R2 upload intents.
 * Never accept caller-supplied owner IDs or object keys: both are read from
 * the D1 cleanup ledger and the key is re-derived and compared before use.
 */
export async function reconcileNebulaR2UploadCleanup({
  bucket,
  db,
  now = () => Date.now(),
  staleAfterMs = 60 * 60 * 1000,
  limit = 50
} = {}) {
  if (!bucket || typeof bucket.delete !== "function") {
    throw new TypeError("A private R2 bucket binding is required.");
  }
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("A D1 database binding is required.");
  }
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 60 * 60 * 1000) {
    throw new RangeError("Upload cleanup grace period must be at least one hour.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("Upload cleanup batch size must be between 1 and 50.");
  }
  const currentTime = now();
  const currentMs = currentTime instanceof Date ? currentTime.getTime() : Number(currentTime);
  if (!Number.isFinite(currentMs)) throw new TypeError("Invalid cleanup clock.");
  const cutoff = new Date(currentMs - staleAfterMs).toISOString();
  const pending = await db.prepare(
    "SELECT owner_id, object_id, category, object_key, created_at FROM nebula_object_cleanup WHERE created_at <= ? ORDER BY created_at LIMIT ?"
  ).bind(cutoff, limit).all();

  const outcomes = [];
  for (const item of pending.results || []) {
    const { owner_id: ownerId, object_id: objectId, category, object_key: objectKey, created_at: createdAt } = item;
    const expectedKey = "owners/" + ownerId + "/" + category + "/" + objectId;
    if (!OWNER_ID_PATTERN.test(ownerId || "") ||
        !CATEGORY_PATTERN.test(category || "") ||
        !OBJECT_ID_PATTERN.test(objectId || "") ||
        objectKey !== expectedKey ||
        typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
      outcomes.push({ action: "invalid-intent" });
      continue;
    }

    try {
      const metadata = await db.prepare(
        "SELECT status FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? LIMIT 1"
      ).bind(ownerId, category, objectId).first();

      if (metadata?.status === "active") {
        await db.prepare(
          "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ?"
        ).bind(ownerId, category, objectId, createdAt).run();
        outcomes.push({ action: "intent-cleared" });
        continue;
      }

      await bucket.delete(expectedKey);
      await db.prepare(
        "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ?"
      ).bind(ownerId, category, objectId, createdAt).run();
      outcomes.push({ action: "orphan-removed" });
    } catch {
      // Keep the durable intent. A later scheduled run retries this item.
      outcomes.push({ action: "retry-pending" });
    }
  }
  return Object.freeze({
    scanned: (pending.results || []).length,
    outcomes: Object.freeze(outcomes)
  });
}
