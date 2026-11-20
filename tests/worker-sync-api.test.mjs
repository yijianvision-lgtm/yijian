import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = ["nebula-worker-auth.js", "nebula-sync-consent.js", "nebula-d1-repository.js", "nebula-sync-device-repository.js", "nebula-sync-snapshot-repository.js", "nebula-r2-repository.js", "nebula-r2-cleanup.js"];
let source = await readFile(new URL("../deepseek-worker.js", import.meta.url), "utf8");
for (const file of files) source = source.replaceAll('"./' + file + '"', JSON.stringify(new URL("../" + file, import.meta.url).href));
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64url = bytes => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
const keyPair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
}, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
Object.assign(publicJwk, { kid: "sync-api-test-key", alg: "RS256", use: "sig", key_ops: ["verify"] });
const issuer = "https://sync-api-issuer.example";
const audience = "nebula-sync-api";
const azp = "https://sync-preview.example";
const now = Math.floor(Date.now() / 1000);
async function tokenFor(subject) {
  const head = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid: "sync-api-test-key", typ: "JWT" })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: issuer, aud: audience, sub: subject, azp, iat: now, exp: now + 300 })));
  const input = head + "." + claims;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, encoder.encode(input)));
  return input + "." + base64url(signature);
}
const tokenA = await tokenFor("user-a");
const tokenB = await tokenFor("user-b");
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(String(url), issuer + "/.well-known/jwks.json");
  return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "Content-Type": "application/json" } });
};

class MemoryD1 {
  consents = new Map();
  records = new Map();
  objects = new Map();
  cleanup = new Map();
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        const owner = values[0];
        return {
          async first() {
            // The consent-gated object SELECT contains both table names;
            // resolve its outer metadata table before its consent subquery.
            if (sql.includes("FROM nebula_objects")) return db.objects.get([owner, values[1], values[2]].join("|")) || null;
            // Resolve the outer records query before its consent subquery.
            if (sql.includes("FROM nebula_records")) return db.records.get([owner, values[1], values[2]].join("|")) || null;
            if (sql.includes("FROM nebula_sync_consents")) return db.consents.get(owner) || null;
            return null;
          },
          async all() {
            if (sql.includes("FROM nebula_records")) return { results: [...db.records.values()].filter(row => row.owner_id === owner && row.record_type === values[1] && (values.length < 3 || !sql.includes("record_id > ?") || row.record_id > values[2])).sort((a,b) => a.record_id.localeCompare(b.record_id)).slice(0, values.at(-1) || 50) };
            if (sql.includes("FROM nebula_objects")) return { results: [...db.objects.values()].filter(row => row.owner_id === owner && row.category === values[1]) };
            return { results: [] };
          },
          async run() {
            if (sql.startsWith("INSERT INTO nebula_sync_consents")) {
              db.consents.set(owner, {
                categories_json: values[1], status: values[2], confirmed_at: values[3],
                updated_at: values[4], revoked_at: values[5]
              });
            } else if (sql.startsWith("INSERT INTO nebula_records")) {
              const key = [owner, values[1], values[2]].join("|");
              if (!db.records.has(key)) {
                db.records.set(key, {
                  owner_id: owner, record_type: values[1], record_id: values[2],
                  payload_json: values[3], created_at: values[4], updated_at: values[5], deleted_at: null
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            } else if (sql.startsWith("UPDATE nebula_records SET payload_json = '{}'")) {
              const row = db.records.get([values[4], values[5], values[6]].join("|"));
              if (row && !row.deleted_at) { row.payload_json = "{}"; row.deleted_at = values[1]; row.updated_at = values[1]; return { meta: { changes: 1 } }; }
              return { meta: { changes: 0 } };
            } else if (sql.startsWith("UPDATE nebula_records")) {
              const key = [values[2], values[3], values[4]].join("|");
              const row = db.records.get(key);
              if (row && (row.updated_at === values[5] || row.deleted_at === values[6])) {
                row.payload_json = values[0];
                row.updated_at = values[1];
                row.deleted_at = null;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            } else if (sql.startsWith("INSERT INTO nebula_object_cleanup")) {
              if (sql.includes("SELECT owner_id, object_id")) {
                const row = db.objects.get([values[1], values[2], values[3]].join("|"));
                if (row?.status === "deleting") db.cleanup.set([values[1], values[2], values[3]].join("|"), {
                  owner_id: row.owner_id, object_id: row.object_id, category: row.category,
                  object_key: row.object_key, created_at: values[0], status: "pending", lease_expires_at: null, intent_kind: "delete"
                });
              } else {
                db.cleanup.set([owner, values[2], values[1]].join("|"), {
                  owner_id: owner, object_id: values[1], category: values[2], object_key: values[3],
                  created_at: values[4], status: "uploading"
                });
              }
            } else if (sql.startsWith("DELETE FROM nebula_object_cleanup")) {
              db.cleanup.delete([owner, values[1], values[2]].join("|"));
            } else if (sql.startsWith("INSERT INTO nebula_objects")) {
              db.objects.set([owner, values[2], values[1]].join("|"), {
                owner_id: owner, object_id: values[1], category: values[2], object_key: values[3],
                content_type: values[4], size_bytes: values[5], status: "active", created_at: values[6]
              });
            } else if (sql.startsWith("UPDATE nebula_records SET deleted_at")) {
              const row = db.records.get([values[2], values[3], values[4]].join("|"));
              if (row && !row.deleted_at) { row.deleted_at = values[0]; row.updated_at = values[1]; return { meta: { changes: 1 } }; }
              return { meta: { changes: 0 } };
            } else if (sql.startsWith("DELETE FROM nebula_objects")) {
              db.objects.delete([owner, values[1], values[2]].join("|"));
            } else if (sql.startsWith("UPDATE nebula_objects")) {
              const row = db.objects.get([owner, values[2], values[3]].join("|"));
              if (row) row.status = "deleting";
            }
            return { meta: { changes: 1 } };
          }
        };
      }
    };
  }
}
class MemoryR2 {
  values = new Map();
  async put(key, body, options) { this.values.set(key, { body: new Uint8Array(body), options }); }
  async get(key) { const value = this.values.get(key); return value ? { body: value.body } : null; }
  async delete(key) { this.values.delete(key); }
}
const db = new MemoryD1();
const bucket = new MemoryR2();
const env = {
  NEBULA_AUTH_MODE: "clerk-jwt",
  NEBULA_JWT_ISSUER: issuer,
  NEBULA_JWT_AUDIENCE: audience,
  NEBULA_JWKS_URL: issuer + "/.well-known/jwks.json",
  NEBULA_AUTHORIZED_PARTIES: JSON.stringify([azp]),
  NEBULA_OWNER_NAMESPACE_SECRET: "sync-api-test-owner-namespace-secret-32-bytes-minimum",
  NEBULA_DB: db,
  NEBULA_BUCKET: bucket,
  NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) }
};
async function call(path, { method = "GET", token = tokenA, body, contentType = "application/json", envOverride = env } = {}) {
  const headers = new Headers({ Authorization: "Bearer " + token });
  if (body !== undefined) headers.set("Content-Type", contentType);
  const request = new Request("https://worker.test" + path, {
    method, headers, ...(body === undefined ? {} : { body })
  });
  return worker.fetch(request, envOverride);
}

const deviceRows = new Map();
const deviceAcks = new Map();
const deviceApiDb = {
  batch: statements => db.batch(statements),
  prepare(sql) {
    if (sql.startsWith("INSERT INTO nebula_sync_devices")) return {
      bind(owner, id, at) { return { async run() {
        const key = owner + "|" + id;
        if (!deviceRows.has(key)) deviceRows.set(key, {
          device_id: id, status: "active", registered_at: at, last_seen_at: at, revoked_at: null
        });
        return { meta: { changes: 1 } };
      } }; }
    };
    if (sql.startsWith("SELECT device_id, status, registered_at")) return {
      bind(owner, id) { return { async first() { return deviceRows.get(owner + "|" + id) || null; } }; }
    };
    if (sql.startsWith("SELECT 1 AS active FROM nebula_sync_devices")) return {
      bind(owner, id) { return { async first() {
        const row = deviceRows.get(owner + "|" + id);
        return row?.status === "active" ? { active: 1 } : null;
      } }; }
    };
    if (sql.startsWith("SELECT device_id, registered_at, last_seen_at FROM nebula_sync_devices")) return {
      bind(owner) { return { async all() {
        return { results: [...deviceRows.entries()].filter(([key, row]) => key.startsWith(owner + "|") && row.status === "active").map(([, row]) => row) };
      } }; }
    };
    if (sql.startsWith("UPDATE nebula_sync_devices SET status = 'revoked'")) return {
      bind(at, _lastSeen, owner, id) { return { async run() {
        const row = deviceRows.get(owner + "|" + id);
        if (!row || row.status !== "active") return { meta: { changes: 0 } };
        row.status = "revoked"; row.revoked_at = at; row.last_seen_at = at;
        return { meta: { changes: 1 } };
      } }; }
    };
    if (sql.startsWith("INSERT INTO nebula_sync_device_acks")) return {
      bind(owner, id, type, sequence) { return { async run() {
        const device = deviceRows.get(owner + "|" + id);
        if (!device || device.status !== "active" || sequence > 0) return { meta: { changes: 0 } };
        deviceAcks.set([owner, id, type].join("|"), sequence);
        return { meta: { changes: 1 } };
      } }; }
    };
    if (sql.startsWith("SELECT a.acknowledged_seq")) return {
      bind(owner, id, type) { return { async first() {
        const row = deviceRows.get(owner + "|" + id);
        const key = [owner, id, type].join("|");
        return row?.status === "active" && deviceAcks.has(key) ? { acknowledged_seq: deviceAcks.get(key) } : null;
      } }; }
    };
    return db.prepare(sql);
  }
};

try {
  const deniedShared = await call("/sync/consent", {
    token: "shared-secret", envOverride: {
      NEBULA_AUTH_MODE: "shared", NEBULA_SYNC_TOKEN: "shared-secret",
      NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) }, NEBULA_DB: db
    }
  });
  assert.equal(deniedShared.status, 403, "A shared service token must never access per-user cloud data.");

  const emptyConsent = await call("/sync/consent");
  assert.equal(emptyConsent.status, 200);
  assert.equal((await emptyConsent.json()).consent, null);

  const missingConfirmation = await call("/sync/consent", {
    method: "POST", body: JSON.stringify({ status: "enabled", categories: ["graph"] })
  });
  assert.equal(missingConfirmation.status, 400, "Cloud sync activation must require an explicit confirmation flag.");

  const enabled = await call("/sync/consent", {
    method: "POST",
    body: JSON.stringify({ status: "enabled", confirm: true, categories: ["graph", "private-files"] })
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).consent.status, "enabled");

  // Simulate revocation after the request-start snapshot but before the D1
  // repository operation. The live ledger re-check must fail closed.
  let consentReads = 0;
  const revocationRaceDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          if (!sql.includes("FROM nebula_sync_consents")) return bound;
          return {
            ...bound,
            async first() {
              const row = await bound.first();
              consentReads += 1;
              return consentReads === 1 ? row : { ...row, status: "revoked" };
            }
          };
        }
      };
    }
  };
  const revokedDuringRequest = await call("/sync/records?type=graph", {
    envOverride: { ...env, NEBULA_DB: revocationRaceDb }
  });
  assert.equal(revokedDuringRequest.status, 403, "A D1 operation must re-check live consent after the request-start snapshot.");
  const backendTypeError = await call("/sync/records?type=graph", {
    envOverride: { ...env, NEBULA_DB: { prepare() { throw new TypeError("sensitive D1 SQL, table and binding details"); } } }
  });
  assert.equal(backendTypeError.status, 500, "Backend TypeErrors must remain server failures, not be misclassified as client input.");
  const backendTypeErrorBody = await backendTypeError.text();
  assert.match(backendTypeErrorBody, /Private sync operation failed/);
  assert.doesNotMatch(backendTypeErrorBody, /sensitive D1 SQL|table and binding details/,
    "Backend TypeError details must never be reflected to private sync API clients.");
  const backendConsentTypeError = await call("/sync/records?type=graph", {
    envOverride: { ...env, NEBULA_DB: { prepare() { throw new TypeError("consent table schema mismatch: missing status column"); } } }
  });
  assert.equal(backendConsentTypeError.status, 500,
    "An internal error mentioning consent must not be misclassified as a user authorization denial.");
  assert.match(await backendConsentTypeError.text(), /Private sync operation failed/);

  const putRecord = await call("/sync/records?type=graph", {
    method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1", payload: { title: "Knowledge graph" } })
  });
  assert.equal(putRecord.status, 200);
  const createdRecord = await putRecord.json();
  assert.equal(createdRecord.conflict, false, "A new record is created only when no remote version exists.");
  await new Promise(resolve => setTimeout(resolve, 5));
  const updateRecord = await call("/sync/records?type=graph", {
    method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1",
      payload: { title: "Knowledge graph v2" }, baseVersion: createdRecord.updatedAt })
  });
  assert.equal(updateRecord.status, 200, "A compare-and-swap update with the observed version must succeed.");
  const updatedRecord = await updateRecord.json();
  assert.notEqual(updatedRecord.updatedAt, createdRecord.updatedAt);
  await new Promise(resolve => setTimeout(resolve, 5));
  const staleUpdate = await call("/sync/records?type=graph", {
    method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1",
      payload: { title: "Stale overwrite" }, baseVersion: createdRecord.updatedAt })
  });
  assert.equal(staleUpdate.status, 409, "A stale client version must never silently overwrite a newer record.");
  const conflict = await staleUpdate.json();
  assert.equal(conflict.remoteVersion, updatedRecord.updatedAt);
  assert.deepEqual(conflict.remotePayload, { title: "Knowledge graph v2" });
  const listRecords = await call("/sync/records?type=graph");
  assert.equal(listRecords.status, 200);
  assert.equal((await listRecords.json()).records[0].recordId, "root-1");
  const missingDeviceChangePage = await call("/sync/changes?type=graph&after=0&limit=10");
  assert.equal(missingDeviceChangePage.status, 400,
    "Change-feed delivery must require a registered device identifier.");

  const deviceId = "123e4567-e89b-42d3-a456-426614174104";
  const deviceEnv = { ...env, NEBULA_DB: deviceApiDb };
  const registerDevice = await call("/sync/devices", {
    method: "POST", body: JSON.stringify({ deviceId }), envOverride: deviceEnv
  });
  assert.equal(registerDevice.status, 200, "Device registration route must pass the Worker route allowlist.");
  assert.equal((await registerDevice.json()).device.status, "active");
  const listDevices = await call("/sync/devices", { envOverride: deviceEnv });
  assert.equal(listDevices.status, 200);
  assert.equal((await listDevices.json()).devices.length, 1);
  const deviceChangePage = await call("/sync/changes?type=graph&after=0&deviceId=" + deviceId, { envOverride: deviceEnv });
  assert.equal(deviceChangePage.status, 200, "A registered device can request a delivered change page.");
  const invalidEmptyPageDevice = await call("/sync/changes?type=graph&after=0&deviceId=not-a-uuid", { envOverride: deviceEnv });
  assert.equal(invalidEmptyPageDevice.status, 400,
    "An empty change page must still validate that the supplied device identity is a UUID.");
  const initialAck = await call("/sync/acknowledgements", {
    method: "POST", body: JSON.stringify({ deviceId, recordType: "graph", sequence: 0 }), envOverride: deviceEnv
  });
  assert.equal(initialAck.status, 200, "Acknowledgement endpoint must be reachable through the Worker route allowlist.");
  const unissuedAck = await call("/sync/acknowledgements", {
    method: "POST", body: JSON.stringify({ deviceId, recordType: "graph", sequence: 1 }), envOverride: deviceEnv
  });
  assert.equal(unissuedAck.status, 409, "Worker must reject acknowledgement beyond the issued delivery ledger.");
  const revokeDevice = await call("/sync/devices/" + deviceId, { method: "DELETE", envOverride: deviceEnv });
  assert.equal(revokeDevice.status, 200);
  const reRegisterRevoked = await call("/sync/devices", {
    method: "POST", body: JSON.stringify({ deviceId }), envOverride: deviceEnv
  });
  assert.equal(reRegisterRevoked.status, 409, "A revoked device ID must not be reactivated through the API.");
  const invalidSnapshotCreate = await call("/sync/snapshots", {
    method: "POST", body: "{", envOverride: deviceEnv
  });
  assert.equal(invalidSnapshotCreate.status, 400,
    "The bootstrap snapshot collection route must pass the Worker route allowlist.");
  const invalidSnapshotComplete = await call("/sync/snapshots/123e4567-e89b-42d3-a456-426614174110/complete", {
    method: "POST", body: "{", envOverride: deviceEnv
  });
  assert.equal(invalidSnapshotComplete.status, 400,
    "The bootstrap snapshot completion route must pass the Worker route allowlist.");

  const invalidChangeCursor = await call("/sync/changes?type=graph&after=-1");
  assert.equal(invalidChangeCursor.status, 400, "Negative or malformed change-feed cursors must be rejected.");

  const deniedCategory = await call("/sync/records?type=private-notes");
  assert.equal(deniedCategory.status, 403, "Unconsented record categories must be rejected.");

  const uploaded = await call("/sync/objects?category=private-files", {
    method: "POST", body: "private file body", contentType: "text/plain"
  });
  assert.equal(uploaded.status, 201);
  const object = (await uploaded.json()).object;
  const objectPath = "/sync/objects/" + object.objectId + "?category=private-files";
  const downloaded = await call(objectPath);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), "private file body");

  const largerUploadBody = new Uint8Array(1024 * 1024 + 1);
  largerUploadBody.fill(7);
  const largerUpload = await call("/sync/objects?category=private-files", {
    method: "POST", body: largerUploadBody, contentType: "application/octet-stream"
  });
  assert.equal(largerUpload.status, 201, "Private file uploads above 1 MiB must be accepted up to the documented 10 MiB limit.");
  assert.equal((await largerUpload.json()).object.sizeBytes, largerUploadBody.byteLength);

  const enableB = await call("/sync/consent", {
    token: tokenB, method: "POST",
    body: JSON.stringify({ status: "enabled", confirm: true, categories: ["graph", "private-files"] })
  });
  assert.equal(enableB.status, 200, "A second account must be able to grant its own independent consent.");

  const foreignDownload = await call(objectPath, { token: tokenB });
  assert.equal(foreignDownload.status, 404, "A second authenticated user with matching consent must not download the first user's object.");

  const foreignList = await call("/sync/records?type=graph", { token: tokenB });
  assert.equal(foreignList.status, 200);
  assert.deepEqual((await foreignList.json()).records, [], "A second account with matching consent must see only its own records.");

  // Cross-account write/delete isolation: matching logical IDs remain in
  // separate owner namespaces, and guessed foreign object IDs are inert.
  const recordB = await call("/sync/records?type=graph", {
    token: tokenB, method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1", payload: { title: "Account B graph" } })
  });
  assert.equal(recordB.status, 200);
  const listRecordsBWithOwnRow = await call("/sync/records?type=graph", { token: tokenB });
  assert.equal(listRecordsBWithOwnRow.status, 200);
  assert.deepEqual((await listRecordsBWithOwnRow.json()).records.map(row => row.payload.title), ["Account B graph"],
    "B's list must contain B's same-ID record and never A's record.");
  const listRecordsAWithBothRows = await call("/sync/records?type=graph", { token: tokenA });
  assert.equal(listRecordsAWithBothRows.status, 200);
  assert.deepEqual((await listRecordsAWithBothRows.json()).records.map(row => row.payload.title), ["Knowledge graph v2"],
    "A's list must reflect A's own versioned update and remain isolated from B.");
  const listObjectsB = await call("/sync/objects?category=private-files", { token: tokenB });
  assert.equal(listObjectsB.status, 200);
  assert.deepEqual((await listObjectsB.json()).objects, [],
    "B's object listing must not reveal A's uploaded objects.");
  const ownerAId = [...db.consents.keys()].find(owner => db.records.has(owner + "|graph|root-1"));
  const ownerBId = [...db.consents.keys()].find(owner => owner !== ownerAId);
  assert.ok(ownerAId && ownerBId, "Both accounts must have distinct server-derived owner namespaces.");
  assert.equal(JSON.parse(db.records.get(ownerAId + "|graph|root-1").payload_json).title, "Knowledge graph v2",
    "Writing the same record ID as account B must not overwrite account A's record.");
  assert.equal(JSON.parse(db.records.get(ownerBId + "|graph|root-1").payload_json).title, "Account B graph");

  const deleteForeignRecord = await call("/sync/records?type=graph&id=root-1", {
    token: tokenB, method: "DELETE"
  });
  assert.equal(deleteForeignRecord.status, 200);
  assert.equal((await deleteForeignRecord.json()).deleted, true,
    "Account B may delete only its own same-ID record.");
  assert.equal(db.records.get(ownerBId + "|graph|root-1").deleted_at !== null, true,
    "Account B deletion must leave a versioned tombstone.");
  const tombstonesB = await call("/sync/records?type=graph", { token: tokenB });
  const deletedRecordB = (await tombstonesB.json()).records.find(row => row.recordId === "root-1");
  assert.equal(deletedRecordB.deleted, true, "Other devices must be able to discover the deletion tombstone.");
  assert.equal(deletedRecordB.payload, null, "Deleted record payload must not be exposed in tombstone listings.");
  const recreateWithoutVersion = await call("/sync/records?type=graph", {
    token: tokenB, method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1", payload: { title: "Unobserved resurrection" } })
  });
  assert.equal(recreateWithoutVersion.status, 409, "A create without observing the tombstone version must not resurrect deleted data.");
  const recreateWithVersion = await call("/sync/records?type=graph", {
    token: tokenB, method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1", payload: { title: "Explicitly restored graph" }, baseVersion: deletedRecordB.updatedAt })
  });
  assert.equal(recreateWithVersion.status, 200, "An explicit CAS update against the tombstone may restore the record.");
  const restoredB = (await call("/sync/records?type=graph", { token: tokenB })).json();
  assert.equal((await restoredB).records.find(row => row.recordId === "root-1").deleted, false);
  assert.equal(db.records.get(ownerAId + "|graph|root-1").deleted_at, null,
    "Account B deleting its own same-ID record must leave account A's record intact.");

  const overwriteForeignObject = await call(objectPath, {
    token: tokenB, method: "PUT", body: "attacker overwrite", contentType: "text/plain"
  });
  assert.equal(overwriteForeignObject.status, 405,
    "The object API must not expose an ID-addressed overwrite operation.");
  const deleteForeignObject = await call(objectPath, { token: tokenB, method: "DELETE" });
  assert.equal(deleteForeignObject.status, 200);
  assert.equal((await deleteForeignObject.json()).deleted, false,
    "Account B must not delete account A's object even when it knows the object ID.");
  assert.equal(bucket.values.has("owners/" + ownerAId + "/private-files/" + object.objectId), true,
    "A foreign delete attempt must not remove account A's R2 object.");
  const ownerARecordAfterForeignDelete = await call("/sync/records?type=graph");
  assert.equal(ownerARecordAfterForeignDelete.status, 200);
  assert.equal((await ownerARecordAfterForeignDelete.json()).records[0].recordId, "root-1",
    "A's record must remain readable after B's cross-account delete attempt.");

  // Search/export/backup/restore are deliberately not exposed yet. Assert
  // authenticated callers cannot reach speculative endpoints before those
  // features receive explicit owner-scoped implementations and tests.
  for (const unsupportedPath of [
    "/sync/search?q=system",
    "/sync/export",
    "/sync/backup",
    "/sync/backup/restore"
  ]) {
    const unsupported = await call(unsupportedPath, { token: tokenB });
    assert.equal(unsupported.status, 404,
      unsupportedPath + " must remain unavailable until its owner-scoped implementation is reviewed.");
  }

  const paused = await call("/sync/consent", { method: "POST", body: JSON.stringify({ status: "paused" }) });
  assert.equal(paused.status, 200);
  const blockedAfterPause = await call("/sync/records?type=graph");
  assert.equal(blockedAfterPause.status, 403, "Pausing consent must stop subsequent cloud data access.");

  const revoked = await call("/sync/consent", { method: "POST", body: JSON.stringify({ status: "revoked" }) });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).consent.status, "revoked");
  const removeAfterRevocation = await call(objectPath, { method: "DELETE" });
  assert.equal(removeAfterRevocation.status, 200, "Owners must retain the ability to delete their own cloud copies after revocation.");
  assert.equal(bucket.values.has("owners/" + [...db.consents.keys()][0] + "/private-files/" + object.objectId), false);
  const removeRecordAfterRevocation = await call("/sync/records?type=graph&id=root-1", { method: "DELETE" });
  assert.equal(removeRecordAfterRevocation.status, 200,
    "Owners must retain the ability to delete their own cloud records after revocation.");
  assert.equal(db.records.get([...db.consents.keys()][0] + "|graph|root-1").deleted_at !== null, true,
    "Revoked users must be able to tombstone their own cloud record without restoring sync consent.");
  console.log("NEBULA authenticated private sync API integration tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
