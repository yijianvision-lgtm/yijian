const OWNER_ID_PATTERN = /^own_[a-f0-9]{64}$/;
const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PAYLOAD_BYTES = 256 * 1024;

function assertRecordType(value) {
  if (typeof value !== "string" || !RECORD_TYPE_PATTERN.test(value)) throw new TypeError("Invalid record type.");
  return value;
}

function assertRecordId(value) {
  if (typeof value !== "string" || !RECORD_ID_PATTERN.test(value)) throw new TypeError("Invalid record ID.");
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new TypeError("Invalid timestamp.");
  return value;
}

/**
 * Create a D1 repository bound to a verified user identity.
 * ownerId is captured once from server-created authContext; no method accepts
 * an owner identifier from its caller.
 */
export function createNebulaD1Repository({ db, authContext, syncConsent, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A Cloudflare D1 database binding is required.");
  if (!authContext || authContext.kind !== "user" || typeof authContext.ownerId !== "string" ||
      !OWNER_ID_PATTERN.test(authContext.ownerId)) {
    throw new TypeError("A verified user identity with a server-derived owner ID is required.");
  }
  const ownerId = authContext.ownerId;
  if (!syncConsent || syncConsent.enabled !== true || !Array.isArray(syncConsent.categories) ||
      !syncConsent.categories.length || typeof syncConsent.confirmedAt !== "string" ||
      !Number.isFinite(Date.parse(syncConsent.confirmedAt))) {
    throw new TypeError("Server-verified, explicit cloud-sync consent is required.");
  }
  const consentCategories = new Set(syncConsent.categories.filter(value => typeof value === "string"));
  if (!consentCategories.size) throw new TypeError("Cloud-sync consent has no valid categories.");
  const assertConsentedCategory = recordType => {
    if (!consentCategories.has(recordType)) throw new Error("Cloud-sync consent does not cover this record category.");
  };

  return Object.freeze({
    async getRecord(recordType, recordId) {
      const type = assertRecordType(recordType);
      const id = assertRecordId(recordId);
      assertConsentedCategory(type);
      const row = await db.prepare(
        "SELECT record_type, record_id, payload_json, created_at, updated_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id = ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) LIMIT 1"
      ).bind(ownerId, type, id, ownerId, type).first();
      if (!row) return null;
      let payload;
      try { payload = JSON.parse(row.payload_json); }
      catch { throw new Error("Stored NEBULA record is invalid JSON."); }
      return Object.freeze({
        recordType: row.record_type,
        recordId: row.record_id,
        payload,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    },

    async listRecords(recordType, { after = null, limit = 50 } = {}) {
      const type = assertRecordType(recordType);
      assertConsentedCategory(type);
      const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 50));
      const cursor = after === null ? null : assertRecordId(after);
      const statement = cursor === null
        ? db.prepare("SELECT record_type, record_id, payload_json, created_at, updated_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) ORDER BY record_id LIMIT ?").bind(ownerId, type, ownerId, type, boundedLimit)
        : db.prepare("SELECT record_type, record_id, payload_json, created_at, updated_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id > ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) ORDER BY record_id LIMIT ?").bind(ownerId, type, cursor, ownerId, type, boundedLimit);
      const result = await statement.all();
      return (result.results || []).map(row => {
        let payload;
        try { payload = JSON.parse(row.payload_json); }
        catch { throw new Error("Stored NEBULA record is invalid JSON."); }
        return Object.freeze({
          recordType: row.record_type,
          recordId: row.record_id,
          payload,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        });
      });
    },

    async putRecord(recordType, recordId, payload) {
      const type = assertRecordType(recordType);
      const id = assertRecordId(recordId);
      assertConsentedCategory(type);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Record payload must be an object.");
      const serialized = JSON.stringify(payload);
      if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) throw new RangeError("Record payload exceeds 256 KiB.");
      const updatedAt = timestamp(now());
      const result = await db.prepare(
        "INSERT INTO nebula_records (owner_id, record_type, record_id, payload_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) ON CONFLICT(owner_id, record_type, record_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at"
      ).bind(ownerId, type, id, serialized, updatedAt, updatedAt, ownerId, type).run();
      return Object.freeze({ ok: true, changes: Number(result.meta?.changes || 0), updatedAt });
    },

    async deleteRecord(recordType, recordId) {
      const type = assertRecordType(recordType);
      const id = assertRecordId(recordId);
      assertConsentedCategory(type);
      const result = await db.prepare(
        "DELETE FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id = ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?))"
      ).bind(ownerId, type, id, ownerId, type).run();
      return Object.freeze({ deleted: Number(result.meta?.changes || 0) > 0 });
    }
  });
}
