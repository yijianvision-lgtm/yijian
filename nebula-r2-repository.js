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
          "INSERT INTO nebula_objects (owner_id, object_id, category, object_key, content_type, size_bytes, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM nebula_object_cleanup i WHERE i.owner_id = ? AND i.category = ? AND i.object_id = ? AND i.status = 'uploading')"
        ).bind(ownerId, objectId, safeCategory, objectKey, contentType, bytes.byteLength, createdAt, createdAt, ownerId, safeCategory, objectId).run();
        if (Number(committed?.meta?.changes || 0) !== 1) {
          throw new Error("Upload intent was claimed before metadata commit.");
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
      const result = await db.prepare(
        "SELECT object_id, category, object_key FROM nebula_object_cleanup WHERE owner_id = ? ORDER BY created_at LIMIT 50"
      ).bind(ownerId).all();
      const outcomes = [];
      for (const pending of result.results || []) {
        const active = await findMetadata(pending.category, pending.object_id);
        if (active && active.status === "active") {
          await db.prepare(
            "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ?"
          ).bind(ownerId, pending.category, pending.object_id).run();
          outcomes.push({ objectId: pending.object_id, action: "intent-cleared" });
          continue;
        }
        await bucket.delete(pending.object_key);
        await db.prepare(
          "DELETE FROM nebula_object_cleanup WHERE owner_id = ? AND category = ? AND object_id = ?"
        ).bind(ownerId, pending.category, pending.object_id).run();
        outcomes.push({ objectId: pending.object_id, action: "orphan-removed" });
      }
      return outcomes;
    },

    async getObject(category, objectId) {
      const safeCategory = assertCategory(category);
      const safeId = assertObjectId(objectId);
      await consentRepository.requireCategory(safeCategory);
      const row = await findMetadata(safeCategory, safeId);
      if (!row || row.status !== "active") return null;
      const object = await bucket.get(row.object_key);
      if (!object) return null;
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
        ? db.prepare("SELECT object_id, category, content_type, size_bytes, created_at FROM nebula_objects WHERE owner_id = ? AND category = ? AND status = 'active' ORDER BY object_id LIMIT ?").bind(ownerId, safeCategory, boundedLimit)
        : db.prepare("SELECT object_id, category, content_type, size_bytes, created_at FROM nebula_objects WHERE owner_id = ? AND category = ? AND status = 'active' AND object_id > ? ORDER BY object_id LIMIT ?").bind(ownerId, safeCategory, cursor, boundedLimit);
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
      await db.prepare(
        "UPDATE nebula_objects SET status = 'deleting', updated_at = ? WHERE owner_id = ? AND category = ? AND object_id = ?"
      ).bind(now(), ownerId, safeCategory, safeId).run();
      await bucket.delete(row.object_key);
      await db.prepare(
        "DELETE FROM nebula_objects WHERE owner_id = ? AND category = ? AND object_id = ?"
      ).bind(ownerId, safeCategory, safeId).run();
      return Object.freeze({ deleted: true });
    }
  });
}
