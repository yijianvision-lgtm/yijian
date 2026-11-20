const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID_PATTERN = DEVICE_ID_PATTERN;
const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PAGE_SIZE = 50;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/** Privileged scheduled cleanup; deletes only expired temporary snapshot material. */
export async function purgeExpiredNebulaSyncSnapshots({ db, now = () => new Date().toISOString(), limit = 100 } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A D1 database binding is required.");
  const at = assertTimestamp(now());
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
  const result = await db.prepare(
    "DELETE FROM nebula_sync_snapshots WHERE (owner_id, snapshot_id) IN (SELECT owner_id, snapshot_id FROM nebula_sync_snapshots WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)"
  ).bind(at, boundedLimit).run();
  return Number(result?.meta?.changes || 0);
}

function assertUuid(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("Invalid " + label + ".");
  return value.toLowerCase();
}
function assertRecordType(value) {
  if (typeof value !== "string" || !RECORD_TYPE_PATTERN.test(value)) throw new TypeError("Invalid record type.");
  return value;
}
function assertCursor(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string" || !RECORD_ID_PATTERN.test(value)) throw new TypeError("Invalid snapshot cursor.");
  return value;
}
function assertTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("Invalid timestamp.");
  return value;
}

/**
 * Captures a stable owner/category snapshot in the same D1 batch that records
 * its monotonic change-feed watermark. Subsequent changes are read after that
 * watermark, avoiding keyset-pagination gaps caused by concurrent mutations.
 */
export function createNebulaSyncSnapshotRepository({ db, authContext, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new TypeError("D1 with atomic batch support is required.");
  }
  if (authContext?.kind !== "user" || typeof authContext.ownerId !== "string" ||
      !/^own_[a-f0-9]{64}$/.test(authContext.ownerId)) {
    throw new TypeError("A verified server-derived owner identity is required.");
  }
  const ownerId = authContext.ownerId;
  const getNow = () => assertTimestamp(now());

  return Object.freeze({
    async create({ snapshotId, deviceId, recordType }) {
      const sid = assertUuid(snapshotId, SNAPSHOT_ID_PATTERN, "snapshot ID");
      const did = assertUuid(deviceId, DEVICE_ID_PATTERN, "device ID");
      const type = assertRecordType(recordType);
      const createdAt = getNow();
      const expiresAt = new Date(Date.parse(createdAt) + SNAPSHOT_TTL_MS).toISOString();
      await db.batch([
        db.prepare(
          "INSERT INTO nebula_sync_snapshots (owner_id, snapshot_id, device_id, record_type, snapshot_seq, status, last_cursor, pages_complete, created_at, expires_at) SELECT ?, ?, ?, ?, COALESCE((SELECT current_seq FROM nebula_sync_counters WHERE owner_id = ? AND record_type = ?), 0), 'active', '', 0, ?, ? WHERE EXISTS (SELECT 1 FROM nebula_sync_devices d WHERE d.owner_id = ? AND d.device_id = ? AND d.status = 'active') AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = ?))"
        ).bind(ownerId, sid, did, type, ownerId, type, createdAt, expiresAt, ownerId, did, ownerId, type),
        db.prepare(
          "INSERT INTO nebula_sync_snapshot_records (owner_id, snapshot_id, record_id, payload_json, created_at, updated_at, deleted_at) SELECT r.owner_id, ?, r.record_id, r.payload_json, r.created_at, r.updated_at, r.deleted_at FROM nebula_records r JOIN nebula_sync_snapshots s ON s.owner_id = r.owner_id AND s.snapshot_id = ? WHERE r.owner_id = ? AND r.record_type = ? AND s.status = 'active'"
        ).bind(sid, sid, ownerId, type)
      ]);
      const row = await db.prepare(
        "SELECT snapshot_id, device_id, record_type, snapshot_seq, status, created_at, expires_at FROM nebula_sync_snapshots WHERE owner_id = ? AND snapshot_id = ? AND device_id = ? LIMIT 1"
      ).bind(ownerId, sid, did).first();
      if (!row) throw new Error("Snapshot could not be created for an active device with current category consent.");
      return Object.freeze({
        snapshotId: row.snapshot_id, deviceId: row.device_id, recordType: row.record_type,
        snapshotSequence: Number(row.snapshot_seq), status: row.status,
        createdAt: row.created_at, expiresAt: row.expires_at
      });
    },

    async listPage({ snapshotId, deviceId, after = "", limit = 50 }) {
      const sid = assertUuid(snapshotId, SNAPSHOT_ID_PATTERN, "snapshot ID");
      const did = assertUuid(deviceId, DEVICE_ID_PATTERN, "device ID");
      const cursor = assertCursor(after);
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_PAGE_SIZE, limit)) : MAX_PAGE_SIZE;
      const at = getNow();
      const session = await db.prepare(
        "SELECT s.snapshot_id, s.record_type, s.snapshot_seq, s.status, s.last_cursor, s.pages_complete, s.expires_at FROM nebula_sync_snapshots s JOIN nebula_sync_devices d ON d.owner_id = s.owner_id AND d.device_id = s.device_id WHERE s.owner_id = ? AND s.snapshot_id = ? AND s.device_id = ? AND d.status = 'active' AND s.expires_at > ? AND s.status = 'active' AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = s.owner_id AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = s.record_type)) LIMIT 1"
      ).bind(ownerId, sid, did, at).first();
      if (!session) throw new Error("Snapshot is unavailable, expired, revoked, or no longer consented.");

      let page = await db.prepare(
        "SELECT cursor_next, has_more, page_limit FROM nebula_sync_snapshot_pages WHERE owner_id = ? AND snapshot_id = ? AND cursor_after = ? LIMIT 1"
      ).bind(ownerId, sid, cursor).first();

      if (!page) {
        if (session.last_cursor !== cursor) throw new Error("Snapshot pages must be requested sequentially; refresh the current page cursor.");
        const result = await db.prepare(
          "SELECT record_id, payload_json, created_at, updated_at, deleted_at FROM nebula_sync_snapshot_records WHERE owner_id = ? AND snapshot_id = ? AND record_id > ? ORDER BY record_id LIMIT ?"
        ).bind(ownerId, sid, cursor, boundedLimit + 1).all();
        const rows = result.results || [];
        const hasMore = rows.length > boundedLimit;
        const selected = rows.slice(0, boundedLimit);
        const nextCursor = selected.length ? selected[selected.length - 1].record_id : cursor;
        await db.batch([
          db.prepare(
            "INSERT INTO nebula_sync_snapshot_pages (owner_id, snapshot_id, cursor_after, cursor_next, has_more, page_limit, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, snapshot_id, cursor_after) DO NOTHING"
          ).bind(ownerId, sid, cursor, nextCursor, hasMore ? 1 : 0, boundedLimit, at),
          db.prepare(
            "UPDATE nebula_sync_snapshots SET last_cursor = ?, pages_complete = ? WHERE owner_id = ? AND snapshot_id = ? AND status = 'active' AND last_cursor = ?"
          ).bind(nextCursor, hasMore ? 0 : 1, ownerId, sid, cursor)
        ]);
        page = await db.prepare(
          "SELECT cursor_next, has_more, page_limit FROM nebula_sync_snapshot_pages WHERE owner_id = ? AND snapshot_id = ? AND cursor_after = ? LIMIT 1"
        ).bind(ownerId, sid, cursor).first();
        if (!page) throw new Error("Snapshot page delivery could not be recorded.");
      }

      const pageRows = page.cursor_next === cursor ? { results: [] } : await db.prepare(
        "SELECT record_id, payload_json, created_at, updated_at, deleted_at FROM nebula_sync_snapshot_records WHERE owner_id = ? AND snapshot_id = ? AND record_id > ? AND record_id <= ? ORDER BY record_id"
      ).bind(ownerId, sid, cursor, page.cursor_next).all();
      const records = (pageRows.results || []).map(row => {
        let payload = null;
        if (!row.deleted_at) {
          try { payload = JSON.parse(row.payload_json); }
          catch { throw new Error("Stored snapshot record is invalid JSON."); }
        }
        return Object.freeze({
          recordType: session.record_type, recordId: row.record_id, payload,
          deleted: Boolean(row.deleted_at), createdAt: row.created_at,
          updatedAt: row.deleted_at || row.updated_at
        });
      });
      return Object.freeze({
        snapshotId: sid, recordType: session.record_type,
        snapshotSequence: Number(session.snapshot_seq), records,
        nextCursor: page.cursor_next || null, hasMore: Boolean(page.has_more),
        complete: !page.has_more
      });
    },

    async complete({ snapshotId, deviceId }) {
      const sid = assertUuid(snapshotId, SNAPSHOT_ID_PATTERN, "snapshot ID");
      const did = assertUuid(deviceId, DEVICE_ID_PATTERN, "device ID");
      const at = getNow();
      await db.batch([
        db.prepare(
          "UPDATE nebula_sync_snapshots SET status = 'completed', completed_at = ? WHERE owner_id = ? AND snapshot_id = ? AND device_id = ? AND status IN ('active', 'completed') AND pages_complete = 1 AND expires_at > ? AND EXISTS (SELECT 1 FROM nebula_sync_devices d WHERE d.owner_id = ? AND d.device_id = ? AND d.status = 'active') AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = ? AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = nebula_sync_snapshots.record_type))"
        ).bind(at, ownerId, sid, did, at, ownerId, did, ownerId),
        db.prepare(
          "INSERT INTO nebula_sync_device_acks (owner_id, device_id, record_type, acknowledged_seq, updated_at) SELECT s.owner_id, s.device_id, s.record_type, s.snapshot_seq, ? FROM nebula_sync_snapshots s WHERE s.owner_id = ? AND s.snapshot_id = ? AND s.device_id = ? AND s.status = 'completed' AND EXISTS (SELECT 1 FROM nebula_sync_devices d WHERE d.owner_id = s.owner_id AND d.device_id = s.device_id AND d.status = 'active') ON CONFLICT(owner_id, device_id, record_type) DO UPDATE SET acknowledged_seq = MAX(nebula_sync_device_acks.acknowledged_seq, excluded.acknowledged_seq), updated_at = excluded.updated_at"
        ).bind(at, ownerId, sid, did)
      ]);
      const row = await db.prepare(
        "SELECT s.snapshot_seq, s.status, a.acknowledged_seq FROM nebula_sync_snapshots s JOIN nebula_sync_devices d ON d.owner_id = s.owner_id AND d.device_id = s.device_id AND d.status = 'active' LEFT JOIN nebula_sync_device_acks a ON a.owner_id = s.owner_id AND a.device_id = s.device_id AND a.record_type = s.record_type WHERE s.owner_id = ? AND s.snapshot_id = ? AND s.device_id = ? AND s.status = 'completed' AND EXISTS (SELECT 1 FROM nebula_sync_consents c WHERE c.owner_id = s.owner_id AND c.status = 'enabled' AND EXISTS (SELECT 1 FROM json_each(c.categories_json) j WHERE j.value = s.record_type))"
      ).bind(ownerId, sid, did).first();
      if (!row) throw new Error("Snapshot cannot be completed until every page has been delivered to an active, consented device.");
      return Object.freeze({
        snapshotId: sid, completed: true, snapshotSequence: Number(row.snapshot_seq),
        acknowledgedSequence: Number(row.acknowledged_seq || 0)
      });
    },

    async purgeExpired({ limit = 100 } = {}) {
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
      const at = getNow();
      const result = await db.prepare(
        "DELETE FROM nebula_sync_snapshots WHERE owner_id = ? AND snapshot_id IN (SELECT snapshot_id FROM nebula_sync_snapshots WHERE owner_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?)"
      ).bind(ownerId, ownerId, at, boundedLimit).run();
      return Number(result?.meta?.changes || 0);
    }
  });
}
