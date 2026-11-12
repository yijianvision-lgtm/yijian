const OWNER_ID_PATTERN = /^own_[a-f0-9]{64}$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f-]{36}$/;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function assertOwner(authContext) {
  if (!authContext || authContext.kind !== "user" || typeof authContext.ownerId !== "string" ||
      !OWNER_ID_PATTERN.test(authContext.ownerId)) {
    throw new TypeError("A verified user identity with a server-derived owner ID is required.");
  }
  return authContext.ownerId;
}

function assertCategory(category) {
  if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) throw new TypeError("Invalid object category.");
  return category;
}

function assertObjectId(objectId) {
  if (typeof objectId !== "string" || !OBJECT_ID_PATTERN.test(objectId)) throw new TypeError("Invalid object ID.");
  return objectId;
}

async function readBodyLimited(body, maxBytes) {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new RangeError("Object exceeds the configured upload size limit.");
    return body;
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBytes) throw new RangeError("Object exceeds the configured upload size limit.");
    return new Uint8Array(body);
  }
  if (!body || typeof body.getReader !== "function") throw new TypeError("Object body must be bytes or a readable stream.");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("Object stream must yield Uint8Array chunks.");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError("Object exceeds the configured upload size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/**
 * Private R2 repository. Object keys are always derived internally from the
 * authenticated owner and generated object ID; callers never supply raw keys.
 */
export function createNebulaR2Repository({
  bucket, db, authContext, consentRepository, maxBytes = DEFAULT_MAX_BYTES,
  now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID()
} = {}) {
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" ||
      typeof bucket.delete !== "function") throw new TypeError("A private Cloudflare R2 bucket binding is required.");
  if (!db || typeof db.prepare !== "function") throw new TypeError("A Cloudflare D1 database binding is required.");
  if (!consentRepository || typeof consentRepository.requireCategory !== "function") {
    throw new TypeError("A server-side sync consent repository is required.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
    throw new RangeError("Object upload limit must be between 1 byte and 100 MiB.");
  }
  const ownerId = assertOwner(authContext);

  async function findMetadata(category, objectId) {
    return db.prepare(
      "SELECT object_id, category, object_key, content_type, size_bytes, created_at, status FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? LIMIT 1"
    ).bind(ownerId, category, objectId).first();
  }

  return Object.freeze({
    async putObject({ category, body, contentType = "application/octet-stream" } = {}) {
      const safeCategory = assertCategory(category);
      await consentRepository.requireCategory(safeCategory);
      if (typeof contentType !== "string" || contentType.length > 128 || /[\r\n]/.test(contentType)) {
        throw new TypeError("Invalid object content type.");
      }
      const bytes = await readBodyLimited(body, maxBytes);
      const objectId = assertObjectId(idFactory());
      const objectKey = "owners/" + ownerId + "/" + safeCategory + "/" + objectId;
      const createdAt = now();
      if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new TypeError("Invalid repository timestamp.");
      // Persist an uploading intent before touching R2. The scheduler will not
      // claim it until the one-hour upload window has elapsed. The final D1
      // metadata insert is conditional on this intent still being uploading.
      await db.prepare(
        "INSERT INTO nebula_object_cleanup (owner_id, object_id, category, object_key, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(ownerId, objectId, safeCategory, objectKey, createdAt).run();
      try {
        await bucket.put(objectKey, bytes, { httpMetadata: { contentType } });
        const committed = await db.prepare(
          "INSERT INTO nebula_objects (owner_id, object_id, category, object_key, content_type, size_bytes, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM nebula_object_cleanup i WHERE i.owner_id = ? AND i.category = ? AND i.object_id = ? AND i.status = 'uploading') AND EXISTS (SELECT 1 FROM nebula_sync_consents c, json_each(c.categories_json) AS allowed_category WHERE c.owner_id = ? AND c.status = 'enabled' AND allowed_category.value = ?)"
        ).bind(ownerId, objectId, safeCategory, objectKey, contentType, bytes.byteLength, createdAt, createdAt, ownerId, safeCategory, objectId, ownerId, safeCategory).run();
        if (Number(committed?.meta?.changes || 0) !== 1) {
          throw new Error("Upload authorization or cleanup intent changed before metadata commit.");
        }
      } catch (error) {
        try {
          await bucket.delete(objectKey);
          await db.prepare(
            "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ?"
          ).bind(ownerId, safeCategory, objectId).run();
        } catch {
          // If no scheduler has claimed the row, make failed compensation
          // immediately eligible for the next cleanup batch. Never overwrite
          // a concurrent scheduler's processing lease.
          try {
            await db.prepare(
              "UPDATE nebula_object_cleanup SET status = 'pending', lease_expires_at = NULL WHERE owner_id = ? AND category = ? AND object_id = ? AND status = 'uploading'"
            ).bind(ownerId, safeCategory, objectId).run();
          } catch {
            // The durable intent remains recoverable after its one-hour grace.
          }
        }
        throw new Error("Object upload did not complete; a durable cleanup intent was retained when compensation could not finish.", { cause: error });
      }
      // If intent deletion fails after metadata commit, the object is still
      // committed. Reconciliation checks active metadata and clears only the
      // stale intent; it must never delete the live object.
      try {
        await db.prepare(
          "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ?"
        ).bind(ownerId, safeCategory, objectId).run();
      } catch {
        // Safe to leave the intent: reconcilePendingUploads sees active metadata.
      }
      return Object.freeze({ objectId, category: safeCategory, contentType, sizeBytes: bytes.byteLength, createdAt });
    },

    async reconcilePendingUploads() {
      // User-scoped recovery handles only intents explicitly marked pending
      // after failed upload compensation. It must never inspect fresh uploads.
      const currentMs = Date.parse(now());
      if (!Number.isFinite(currentMs)) throw new TypeError("Invalid repository timestamp.");
      const leaseUntil = new Date(currentMs + 30 * 60 * 1000).toISOString();
      const result = await db.prepare(
        "SELECT owner_id, object_id, category, object_key, created_at FROM nebula_object_cleanup WHERE owner_id = ? AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?) OR (status = 'uploading' AND EXISTS (SELECT 1 FROM nebula_objects o WHERE o.owner_id = nebula_object_cleanup.owner_id AND o.category = nebula_object_cleanup.category AND o.object_id = nebula_object_cleanup.object_id AND o.status = 'active'))) ORDER BY created_at LIMIT 50"
      ).bind(ownerId, new Date(currentMs).toISOString()).all();
      const outcomes = [];
      for (const item of result.results || []) {
        const expectedKey = "owners/" + item.owner_id + "/" + item.category + "/" + item.object_id;
        if (item.owner_id !== ownerId ||
            !CATEGORY_PATTERN.test(item.category || "") ||
            !OBJECT_ID_PATTERN.test(item.object_id || "") ||
            item.object_key !== expectedKey ||
            typeof item.created_at !== "string" ||
            !Number.isFinite(Date.parse(item.created_at)) ||
            new Date(Date.parse(item.created_at)).toISOString() !== item.created_at) {
          await db.prepare(
            "UPDATE nebula_object_cleanup SET status = 'quarantined', lease_expires_at = NULL WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status IN ('pending', 'processing')"
          ).bind(item.owner_id, item.category, item.object_id, item.created_at).run();
          outcomes.push({ objectId: item.object_id, action: "invalid-quarantined" });
          continue;
        }

        const activeMetadata = await findMetadata(item.category, item.object_id);
        if (activeMetadata?.status === "active") {
          await db.prepare(
            "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status = 'uploading' AND EXISTS (SELECT 1 FROM nebula_objects o WHERE o.owner_id = ? AND o.category = ? AND o.object_id = ? AND o.status = 'active')"
          ).bind(ownerId, item.category, item.object_id, item.created_at, ownerId, item.category, item.object_id).run();
          outcomes.push({ objectId: item.object_id, action: "intent-cleared" });
          continue;
        }

        const claim = await db.prepare(
          "UPDATE nebula_object_cleanup SET status = 'processing', lease_expires_at = ? WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?)) AND NOT EXISTS (SELECT 1 FROM nebula_objects o WHERE o.owner_id = ? AND o.category = ? AND o.object_id = ? AND o.status = 'active')"
        ).bind(leaseUntil, ownerId, item.category, item.object_id, item.created_at, new Date(currentMs).toISOString(), ownerId, item.category, item.object_id).run();
        if (Number(claim?.meta?.changes || 0) !== 1) {
          const active = await findMetadata(item.category, item.object_id);
          if (active?.status === "active") {
            await db.prepare(
              "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status IN ('pending', 'processing')"
            ).bind(ownerId, item.category, item.object_id, item.created_at).run();
            outcomes.push({ objectId: item.object_id, action: "intent-cleared" });
          } else {
            outcomes.push({ objectId: item.object_id, action: "claim-skipped" });
          }
          continue;
        }

        try {
          await bucket.delete(expectedKey);
          // Finish any interrupted user-requested deletion only after R2 confirms.
          await db.prepare(
            "DELETE FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? AND status = 'deleting'"
          ).bind(ownerId, item.category, item.object_id).run();
          await db.prepare(
            "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ? AND created_at = ? AND status = 'processing' AND lease_expires_at = ?"
          ).bind(ownerId, item.category, item.object_id, item.created_at, leaseUntil).run();
          outcomes.push({ objectId: item.object_id, action: "orphan-removed" });
        } catch {
          outcomes.push({ objectId: item.object_id, action: "retry-pending" });
        }
      }
      return outcomes;
    },

    async getObject(category, objectId) {
      const safeCategory = assertCategory(category);
      const safeId = assertObjectId(objectId);
      await consentRepository.requireCategory(safeCategory);
      const row = await db.prepare(
        "SELECT o.object_id, o.category, o.object_key, o.content_type, o.size_bytes, o.created_at, o.status FROM nebula_objects o WHERE o.owner_id = ? AND o.category = ? AND o.object_id = ? AND o.status = 'active' AND EXISTS (SELECT 1 FROM nebula_sync_consents c, json_each(c.categories_json) AS allowed_category WHERE c.owner_id = o.owner_id AND c.status = 'enabled' AND allowed_category.value = o.category) LIMIT 1"
      ).bind(ownerId, safeCategory, safeId).first();
      if (!row || row.status !== "active") return null;
      const object = await bucket.get(row.object_key);
      if (!object) return null;
      // R2 is outside the D1 statement. Re-check after the object fetch so a
      // revocation during storage I/O cannot release a body to the caller.
      await consentRepository.requireCategory(safeCategory);
      return Object.freeze({
        objectId: row.object_id, category: row.category, contentType: row.content_type,
        sizeBytes: row.size_bytes, createdAt: row.created_at, body: object.body
      });
    },

    async listObjects(category, { after = null, limit = 50 } = {}) {
      const safeCategory = assertCategory(category);
      await consentRepository.requireCategory(safeCategory);
      const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 50));
      const cursor = after === null ? null : assertObjectId(after);
      const statement = cursor === null
        ? db.prepare("SELECT o.object_id, o.category, o.content_type, o.size_bytes, o.created_at FROM nebula_objects o WHERE o.owner_id = ? AND o.category = ? AND o.status = 'active' AND EXISTS (SELECT 1 FROM nebula_sync_consents c, json_each(c.categories_json) AS allowed_category WHERE c.owner_id = o.owner_id AND c.status = 'enabled' AND allowed_category.value = o.category) ORDER BY o.object_id LIMIT ?").bind(ownerId, safeCategory, boundedLimit)
        : db.prepare("SELECT o.object_id, o.category, o.content_type, o.size_bytes, o.created_at FROM nebula_objects o WHERE o.owner_id = ? AND o.category = ? AND o.status = 'active' AND o.object_id > ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c, json_each(c.categories_json) AS allowed_category WHERE c.owner_id = o.owner_id AND c.status = 'enabled' AND allowed_category.value = o.category) ORDER BY o.object_id LIMIT ?").bind(ownerId, safeCategory, cursor, boundedLimit);
      const result = await statement.all();
      return (result.results || []).map(row => Object.freeze({
        objectId: row.object_id, category: row.category, contentType: row.content_type,
        sizeBytes: row.size_bytes, createdAt: row.created_at
      }));
    },

    async deleteObject(category, objectId) {
      const safeCategory = assertCategory(category);
      const safeId = assertObjectId(objectId);
      // Deletion remains available after consent is paused/revoked so users can
      // remove their own cloud copies. Ownership is still enforced by D1.
      const row = await findMetadata(safeCategory, safeId);
      if (!row) return Object.freeze({ deleted: false });
      const updatedAt = now();
      if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
        throw new TypeError("Invalid repository timestamp.");
      }
      if (typeof db.batch !== "function") {
        throw new TypeError("D1 batch transactions are required for durable object deletion.");
      }
      // Atomically mark metadata deleting and persist a retry intent.
      await db.batch([
        db.prepare(
          "UPDATE nebula_objects SET status = 'deleting', updated_at = ? WHERE owner_id = ? AND category = ? AND object_id = ? AND status IN ('active', 'deleting')"
        ).bind(updatedAt, ownerId, safeCategory, safeId),
        db.prepare(
          "INSERT INTO nebula_object_cleanup (owner_id, object_id, category, object_key, created_at, status, lease_expires_at, intent_kind) SELECT owner_id, object_id, category, object_key, ?, 'pending', NULL, 'delete' FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? AND status = 'deleting' ON CONFLICT(owner_id, category, object_id) DO UPDATE SET created_at = CASE WHEN nebula_object_cleanup.status = 'processing' THEN nebula_object_cleanup.created_at ELSE excluded.created_at END, status = CASE WHEN nebula_object_cleanup.status = 'processing' THEN 'processing' ELSE 'pending' END, lease_expires_at = CASE WHEN nebula_object_cleanup.status = 'processing' THEN nebula_object_cleanup.lease_expires_at ELSE NULL END, intent_kind = 'delete'"
        ).bind(updatedAt, ownerId, safeCategory, safeId)
      ]);
      await bucket.delete(row.object_key);
      // If this final batch fails, the durable intent remains for scheduler retry.
      await db.batch([
        db.prepare(
          "DELETE FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ? AND status = 'deleting'"
        ).bind(ownerId, safeCategory, safeId),
        db.prepare(
          "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ?"
        ).bind(ownerId, safeCategory, safeId)
      ]);
      return Object.freeze({ deleted: true });
    }
  });
}
