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
  const consentSnapshot = syncConsent || { enabled: false, categories: [] };
  if (typeof consentSnapshot !== "object" || !Array.isArray(consentSnapshot.categories)) {
    throw new TypeError("Invalid server-side cloud-sync consent snapshot.");
  }
  if (consentSnapshot.enabled === true &&
      (typeof consentSnapshot.confirmedAt !== "string" || !Number.isFinite(Date.parse(consentSnapshot.confirmedAt)))) {
    throw new TypeError("Enabled cloud-sync consent requires a valid confirmation timestamp.");
  }
  const consentEnabledSnapshot = consentSnapshot.enabled === true;
  const consentCategories = new Set(consentSnapshot.categories.filter(value => typeof value === "string"));
  const assertConsentedCategory = recordType => {
    if (!consentEnabledSnapshot) throw new Error("Cloud sync is not enabled for this account.");
    if (!consentCategories.has(recordType)) throw new Error("Cloud-sync consent does not cover this record category.");
  };

  return Object.freeze({
    async getRecord(recordType, recordId) {
      const type = assertRecordType(recordType);
      const id = assertRecordId(recordId);
      assertConsentedCategory(type);
      const row = await db.prepare(
        "SELECT record_type, record_id, payload_json, created_at, updated_at, deleted_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id = ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) LIMIT 1"
      ).bind(ownerId, type, id, ownerId, type).first();
      if (!row) return null;
      let payload = null;
      if (!row.deleted_at) {
        try { payload = JSON.parse(row.payload_json); }
        catch { throw new Error("Stored NEBULA record is invalid JSON."); }
      }
      return Object.freeze({
        recordType: row.record_type,
        recordId: row.record_id,
        payload,
        deleted: Boolean(row.deleted_at),
        createdAt: row.created_at,
        updatedAt: row.deleted_at || row.updated_at
      });
    },

    async listRecords(recordType, { after = null, limit = 50 } = {}) {
      const type = assertRecordType(recordType);
      assertConsentedCategory(type);
      const boundedLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 50));
      const cursor = after === null ? null : assertRecordId(after);
      const statement = cursor === null
        ? db.prepare("SELECT record_type, record_id, payload_json, created_at, updated_at, deleted_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) ORDER BY record_id LIMIT ?").bind(ownerId, type, ownerId, type, boundedLimit)
        : db.prepare("SELECT record_type, record_id, payload_json, created_at, updated_at, deleted_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id > ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) ORDER BY record_id LIMIT ?").bind(ownerId, type, cursor, ownerId, type, boundedLimit);
      const result = await statement.all();
      return (result.results || []).map(row => {
        let payload = null;
        if (!row.deleted_at) {
          try { payload = JSON.parse(row.payload_json); }
          catch { throw new Error("Stored NEBULA record is invalid JSON."); }
        }
        return Object.freeze({
          recordType: row.record_type,
          recordId: row.record_id,
          payload,
          deleted: Boolean(row.deleted_at),
          createdAt: row.created_at,
          updatedAt: row.deleted_at || row.updated_at
        });
      });
    },

    async putRecord(recordType, recordId, payload, { expectedUpdatedAt = null } = {}) {
      const type = assertRecordType(recordType);
      const id = assertRecordId(recordId);
      assertConsentedCategory(type);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Record payload must be an object.");
      if (expectedUpdatedAt !== null) timestamp(expectedUpdatedAt);
      const serialized = JSON.stringify(payload);
      if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) throw new RangeError("Record payload exceeds 256 KiB.");
      const observedNow = timestamp(now());
      const updatedAt = expectedUpdatedAt === null
        ? observedNow
        : new Date(Math.max(Date.parse(observedNow), Date.parse(expectedUpdatedAt) + 1)).toISOString();

      const mutation = expectedUpdatedAt === null
        ? db.prepare(
          "INSERT INTO nebula_records (owner_id, record_type, record_id, payload_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) AND NOT EXISTS (SELECT 1 FROM nebula_records r WHERE r.owner_id = ? AND r.record_type = ? AND r.record_id = ?) ON CONFLICT(owner_id, record_type, record_id) DO NOTHING"
        ).bind(ownerId, type, id, serialized, updatedAt, updatedAt, ownerId, type, ownerId, type, id)
        : db.prepare(
          "UPDATE nebula_records SET payload_json = ?, updated_at = ?, deleted_at = NULL WHERE owner_id = ? AND record_type = ? AND record_id = ? AND (updated_at = ? OR deleted_at = ?) AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?))"
        ).bind(serialized, updatedAt, ownerId, type, id, expectedUpdatedAt, expectedUpdatedAt, ownerId, type);
      const counter = db.prepare(
        "INSERT INTO nebula_sync_counters (owner_id, record_type, current_seq) SELECT ?, ?, 1 WHERE changes() > 0 ON CONFLICT(owner_id, record_type) DO UPDATE SET current_seq = current_seq + 1"
      ).bind(ownerId, type);
      const change = db.prepare(
        "INSERT INTO nebula_sync_changes (owner_id, record_type, sequence, record_id, record_version, operation, created_at) SELECT ?, ?, current_seq, ?, ?, 'upsert', ? FROM nebula_sync_counters WHERE owner_id = ? AND record_type = ? AND changes() > 0"
      ).bind(ownerId, type, id, updatedAt, observedNow, ownerId, type);
      if (typeof db.batch !== "function") throw new Error("Atomic D1 batch support is required for sync record mutations.");
      const results = await db.batch([mutation, counter, change]);
      const changes = Number(results?.[0]?.meta?.changes || 0);
      if (changes > 0) {
        const sequence = await db.prepare(
          "SELECT current_seq FROM nebula_sync_counters WHERE owner_id = ? AND record_type = ? LIMIT 1"
        ).bind(ownerId, type).first();
        return Object.freeze({ ok: true, conflict: false, changes, updatedAt, sequence: Number(sequence?.current_seq || 0) });
      }
      const liveConsent = await db.prepare(
        "SELECT 1 AS active FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?) LIMIT 1"
      ).bind(ownerId, type).first();
      if (!liveConsent) throw new Error("Cloud-sync consent does not cover this record category.");
      const remoteRow = await db.prepare(
        "SELECT payload_json, updated_at, deleted_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id = ? AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?)) LIMIT 1"
      ).bind(ownerId, type, id, ownerId, type).first();
      let remotePayload = null;
      if (remoteRow && !remoteRow.deleted_at) {
        try { remotePayload = JSON.parse(remoteRow.payload_json); }
        catch { throw new Error("Stored NEBULA record is invalid JSON."); }
      }
      return Object.freeze({
        ok: true, conflict: true, changes: 0,
        remoteVersion: remoteRow?.deleted_at || remoteRow?.updated_at || null,
        remotePayload,
        remoteDeleted: Boolean(remoteRow?.deleted_at)
      });
    },

    async deleteRecord(recordType, recordId) {
      const type = assertRecordType(recordType);
      const id = assertRecordId(recordId);
      // Owner-initiated deletion remains available after sync consent is
      // paused or revoked. The server-derived owner scope is still mandatory.
      const deletedAt = timestamp(now());
      const mutation = db.prepare(
        "UPDATE nebula_records SET payload_json = '{}', deleted_at = CASE WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END, updated_at = CASE WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END WHERE owner_id = ? AND record_type = ? AND record_id = ? AND deleted_at IS NULL"
      ).bind(deletedAt, deletedAt, deletedAt, deletedAt, ownerId, type, id);
      const counter = db.prepare(
        "INSERT INTO nebula_sync_counters (owner_id, record_type, current_seq) SELECT ?, ?, 1 WHERE changes() > 0 ON CONFLICT(owner_id, record_type) DO UPDATE SET current_seq = current_seq + 1"
      ).bind(ownerId, type);
      const change = db.prepare(
        "INSERT INTO nebula_sync_changes (owner_id, record_type, sequence, record_id, record_version, operation, created_at) SELECT ?, ?, current_seq, ?, (SELECT updated_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id = ?), 'delete', ? FROM nebula_sync_counters WHERE owner_id = ? AND record_type = ? AND changes() > 0"
      ).bind(ownerId, type, id, ownerId, type, id, deletedAt, ownerId, type);
      if (typeof db.batch !== "function") throw new Error("Atomic D1 batch support is required for sync record mutations.");
      const results = await db.batch([mutation, counter, change]);
      const deleted = Number(results?.[0]?.meta?.changes || 0) > 0;
      if (!deleted) return Object.freeze({ deleted: false, deletedAt });
      const row = await db.prepare(
        "SELECT updated_at FROM nebula_records WHERE owner_id = ? AND record_type = ? AND record_id = ? LIMIT 1"
      ).bind(ownerId, type, id).first();
      const sequence = await db.prepare(
        "SELECT current_seq FROM nebula_sync_counters WHERE owner_id = ? AND record_type = ? LIMIT 1"
      ).bind(ownerId, type).first();
      return Object.freeze({ deleted: true, deletedAt: row?.updated_at || deletedAt, sequence: Number(sequence?.current_seq || 0) });
    }
  });
}
