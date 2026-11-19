const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function assertDeviceId(value) {
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) throw new TypeError("Invalid device ID.");
  return value.toLowerCase();
}
function assertRecordType(value) {
  if (typeof value !== "string" || !RECORD_TYPE_PATTERN.test(value)) throw new TypeError("Invalid record type.");
  return value;
}
function assertNow(now) {
  const value = now();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("Invalid timestamp.");
  return value;
}

/** Device repository is permanently scoped to a verified server auth context. */
export function createNebulaSyncDeviceRepository({ db, authContext, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new TypeError("D1 with atomic batch support is required.");
  }
  if (authContext?.kind !== "user" || typeof authContext.ownerId !== "string" ||
      !/^own_[a-f0-9]{64}$/.test(authContext.ownerId)) {
    throw new TypeError("A verified server-derived owner identity is required.");
  }
  const ownerId = authContext.ownerId;

  return Object.freeze({
    async register(deviceId) {
      const id = assertDeviceId(deviceId);
      const at = assertNow(now);
      await db.prepare(
        "INSERT INTO nebula_sync_devices (owner_id, device_id, status, registered_at, last_seen_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT(owner_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at WHERE nebula_sync_devices.status = 'active'"
      ).bind(ownerId, id, at, at).run();
      const row = await db.prepare(
        "SELECT device_id, status, registered_at, last_seen_at, revoked_at FROM nebula_sync_devices WHERE owner_id = ? AND device_id = ? LIMIT 1"
      ).bind(ownerId, id).first();
      if (!row || row.status !== "active") throw new Error("Device has been revoked and cannot be re-registered.");
      return Object.freeze({ deviceId: row.device_id, status: row.status, registeredAt: row.registered_at, lastSeenAt: row.last_seen_at });
    },

    async revoke(deviceId) {
      const id = assertDeviceId(deviceId);
      const at = assertNow(now);
      const result = await db.prepare(
        "UPDATE nebula_sync_devices SET status = 'revoked', revoked_at = ?, last_seen_at = ? WHERE owner_id = ? AND device_id = ? AND status = 'active'"
      ).bind(at, at, ownerId, id).run();
      return Object.freeze({ revoked: Number(result?.meta?.changes || 0) > 0, deviceId: id, revokedAt: at });
    },

    async listActive() {
      const result = await db.prepare(
        "SELECT device_id, registered_at, last_seen_at FROM nebula_sync_devices WHERE owner_id = ? AND status = 'active' ORDER BY registered_at, device_id"
      ).bind(ownerId).all();
      return (result.results || []).map(row => Object.freeze({
        deviceId: row.device_id, registeredAt: row.registered_at, lastSeenAt: row.last_seen_at
      }));
    },

    async recordIssuedChanges(deviceId, recordType, sequences) {
      const id = assertDeviceId(deviceId);
      const type = assertRecordType(recordType);
      if (!Array.isArray(sequences) || sequences.length > 50 ||
          sequences.some((seq, index) => !Number.isSafeInteger(seq) || seq < 1 ||
            (index > 0 && seq !== sequences[index - 1] + 1))) {
        throw new TypeError("Issued change sequences must be a contiguous page of at most 50.");
      }
      if (!sequences.length) return 0;
      const at = assertNow(now);
      const statements = sequences.map(sequence => db.prepare(
        "INSERT INTO nebula_sync_device_deliveries (owner_id, device_id, record_type, sequence, issued_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM nebula_sync_devices d WHERE d.owner_id = ? AND d.device_id = ? AND d.status = 'active') ON CONFLICT(owner_id, device_id, record_type, sequence) DO NOTHING"
      ).bind(ownerId, id, type, sequence, at, ownerId, id));
      const results = await db.batch(statements);
      const total = results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
      if (total !== sequences.length) throw new Error("Device is revoked or change delivery could not be recorded.");
      return total;
    },

    async acknowledge(deviceId, recordType, sequence) {
      const id = assertDeviceId(deviceId);
      const type = assertRecordType(recordType);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("Invalid acknowledgement sequence.");
      const at = assertNow(now);
      const result = await db.prepare(
        "INSERT INTO nebula_sync_device_acks (owner_id, device_id, record_type, acknowledged_seq, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM nebula_sync_devices d WHERE d.owner_id = ? AND d.device_id = ? AND d.status = 'active') AND ? <= COALESCE((SELECT current_seq FROM nebula_sync_counters WHERE owner_id = ? AND record_type = ?), 0) AND (SELECT COUNT(*) FROM nebula_sync_device_deliveries x WHERE x.owner_id = ? AND x.device_id = ? AND x.record_type = ? AND x.sequence > COALESCE((SELECT acknowledged_seq FROM nebula_sync_device_acks a WHERE a.owner_id = ? AND a.device_id = ? AND a.record_type = ?), 0) AND x.sequence <= ?) = (? - COALESCE((SELECT acknowledged_seq FROM nebula_sync_device_acks a WHERE a.owner_id = ? AND a.device_id = ? AND a.record_type = ?), 0)) ON CONFLICT(owner_id, device_id, record_type) DO UPDATE SET acknowledged_seq = excluded.acknowledged_seq, updated_at = excluded.updated_at WHERE excluded.acknowledged_seq >= nebula_sync_device_acks.acknowledged_seq"
      ).bind(
        ownerId, id, type, sequence, at,
        ownerId, id, sequence, ownerId, type,
        ownerId, id, type, ownerId, id, type, sequence,
        sequence, ownerId, id, type
      ).run();
      const row = await db.prepare(
        "SELECT acknowledged_seq FROM nebula_sync_device_acks WHERE owner_id = ? AND device_id = ? AND record_type = ? LIMIT 1"
      ).bind(ownerId, id, type).first();
      const accepted = Boolean(row && Number(row.acknowledged_seq) >= sequence);
      if (!accepted) throw new Error("Acknowledgement exceeds contiguous changes issued to this active device.");
      return Object.freeze({ deviceId: id, recordType: type, acknowledgedSequence: Number(row.acknowledged_seq) });
    }
  });
}
