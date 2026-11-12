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
  const leaseUntil = new Date(currentMs + 30 * 60 * 1000).toISOString();
  const pending = await db.prepare(
    "SELECT owner_id, object_id, category, object_key, created_at, status FROM nebula_object_cleanup WHERE (status = 'pending' AND created_at <= ?) OR (status = 'uploading' AND created_at <= ?) OR (status = 'processing' AND lease_expires_at <= ?) ORDER BY created_at LIMIT ?"
  ).bind(cutoff, cutoff, new Date(currentMs).toISOString(), limit).all();

  const outcomes = [];
  for (const item of pending.results || []) {
    const { owner_id: ownerId, object_id: objectId, category, object_key: objectKey, created_at: createdAt } = item;
    const expectedKey = "owners/" + ownerId + "/" + category + "/" + objectId;
    if (!OWNER_ID_PATTERN.test(ownerId || "") ||
        !CATEGORY_PATTERN.test(category || "") ||
        !OBJECT_ID_PATTERN.test(objectId || "") ||
        objectKey !== expectedKey ||
        typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
        new Date(Date.parse(createdAt)).toISOString() !== createdAt) {
      // Quarantine malformed rows so they remain visible for operator review
      // without permanently occupying the oldest pending batch slots.
      try {
        await db.prepare(
          "UPDATE nebula_object_cleanup SET status = 'quarantined', lease_expires_at = NULL WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status IN ('pending', 'uploading', 'processing')"
        ).bind(ownerId, category, objectId, createdAt).run();
        outcomes.push({ action: "invalid-quarantined" });
      } catch {
        outcomes.push({ action: "invalid-quarantine-retry" });
      }
      continue;
    }

    try {
      // Fast path for already-committed uploads. The claim below repeats this
      // protection in its own atomic SQL predicate to close the race window.
      const existingMetadata = await db.prepare(
        "SELECT status FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? LIMIT 1"
      ).bind(ownerId, category, objectId).first();
      if (existingMetadata?.status === "active") {
        await db.prepare(
          "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status IN ('uploading', 'pending')"
        ).bind(ownerId, category, objectId, createdAt).run();
        outcomes.push({ action: "intent-cleared" });
        continue;
      }

      // Claim the intent atomically. Upload metadata can only commit while its
      // intent is still "uploading"; once claimed, that commit is rejected.
      // The NOT EXISTS predicate prevents claiming an already-committed object.
      const claim = await db.prepare(
        "UPDATE nebula_object_cleanup SET status = 'processing', lease_expires_at = ? WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND ((status IN ('pending', 'uploading') AND created_at <= ?) OR (status = 'processing' AND lease_expires_at <= ?)) AND NOT EXISTS (SELECT 1 FROM nebula_objects o WHERE o.owner_id = ? AND o.category = ? AND o.object_id = ? AND o.status = 'active')"
      ).bind(leaseUntil, ownerId, category, objectId, createdAt, cutoff, new Date(currentMs).toISOString(), ownerId, category, objectId).run();
      if (Number(claim?.meta?.changes || 0) !== 1) {
        const metadata = await db.prepare(
          "SELECT status FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? LIMIT 1"
        ).bind(ownerId, category, objectId).first();
        if (metadata?.status === "active") {
          await db.prepare(
            "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status IN ('uploading', 'pending')"
          ).bind(ownerId, category, objectId, createdAt).run();
          outcomes.push({ action: "intent-cleared" });
        } else {
          outcomes.push({ action: "claim-skipped" });
        }
        continue;
      }

      await bucket.delete(expectedKey);
      // User-requested deletes also use this ledger. Remove their inaccessible
      // metadata only after the R2 delete succeeds; retain the lease if D1 fails.
      await db.prepare(
        "DELETE FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? AND status = 'deleting'"
      ).bind(ownerId, category, objectId).run();
      await db.prepare(
        "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status = 'processing' AND lease_expires_at = ?"
      ).bind(ownerId, category, objectId, createdAt, leaseUntil).run();
      outcomes.push({ action: "orphan-removed" });
    } catch {
      // Keep the durable processing lease; a later run retries after expiry.
      outcomes.push({ action: "retry-pending" });
    }
  }
  return Object.freeze({
    scanned: (pending.results || []).length,
    outcomes: Object.freeze(outcomes)
  });
}
