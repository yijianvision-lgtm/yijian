import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createNebulaD1Repository } from "../nebula-d1-repository.js";
import { createNebulaSyncDeviceRepository } from "../nebula-sync-device-repository.js";
import { createNebulaSyncSnapshotRepository } from "../nebula-sync-snapshot-repository.js";
import { createNebulaSyncConsentRepository } from "../nebula-sync-consent.js";
import { reconcileNebulaR2UploadCleanup } from "../nebula-r2-cleanup.js";
import { createNebulaR2Repository } from "../nebula-r2-repository.js";

// Execute the actual Cloudflare D1 SQLite migrations and repository SQL against
// Node's SQLite engine. This is stronger than the contract mocks, but is still
// not a live Cloudflare D1 deployment test.
const db = new DatabaseSync(":memory:");
const migrations = [
  "0001_owner_scoped_records.sql",
  "0002_sync_consent_ledger.sql",
  "0003_owner_scoped_objects.sql",
  "0004_r2_upload_cleanup_intents.sql",
  "0005_r2_delete_intent_kind.sql",
  "0006_record_tombstones.sql"
];
for (const migration of migrations) {
  const sql = await readFile(new URL("../migrations/" + migration, import.meta.url), "utf8");
  db.exec(sql);
}
// Seed an existing object before migration 0007 to prove the table rebuild
// preserves already-uploaded private object metadata.
const migrationOwner = "own_" + "c".repeat(64);
const migrationObjectId = "123e4567-e89b-12d3-a456-426614174199";
const migrationObjectKey = "owners/" + migrationOwner + "/private-files/" + migrationObjectId;
db.prepare(
  "INSERT INTO nebula_objects (owner_id, object_id, category, object_key, content_type, size_bytes, status, created_at, updated_at) VALUES (?, ?, 'private-files', ?, 'application/pdf', 2048, 'active', ?, ?)"
).run(migrationOwner, migrationObjectId, migrationObjectKey, "2026-11-10T00:00:00.000Z", "2026-11-10T00:00:00.000Z");
const objectTombstoneMigration = await readFile(new URL("../migrations/0007_r2_object_tombstones.sql", import.meta.url), "utf8");
db.exec(objectTombstoneMigration);
const deviceAckMigration = await readFile(new URL("../migrations/0008_device_sync_acknowledgements.sql", import.meta.url), "utf8");
db.exec(deviceAckMigration);
const deviceDeliveryMigration = await readFile(new URL("../migrations/0009_device_delivery_ledger.sql", import.meta.url), "utf8");
db.exec(deviceDeliveryMigration);
const snapshotMigration = await readFile(new URL("../migrations/0010_sync_bootstrap_snapshots.sql", import.meta.url), "utf8");
db.exec(snapshotMigration);
const deviceId = "123e4567-e89b-12d3-a456-426614174100";
db.prepare("INSERT INTO nebula_sync_devices (owner_id, device_id, status, registered_at, last_seen_at) VALUES (?, ?, 'active', ?, ?)")
  .run(migrationOwner, deviceId, "2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z");
db.prepare("INSERT INTO nebula_sync_counters (owner_id, record_type, current_seq) VALUES (?, 'graph', 3)")
  .run(migrationOwner);
db.prepare("INSERT INTO nebula_sync_changes (owner_id, record_type, sequence, record_id, record_version, operation, created_at) VALUES (?, 'graph', 3, 'node-1', '2026-11-17T00:00:00.000Z', 'delete', '2026-11-17T00:00:00.000Z')")
  .run(migrationOwner);
db.prepare("INSERT INTO nebula_sync_device_acks (owner_id, device_id, record_type, acknowledged_seq, updated_at) VALUES (?, ?, 'graph', 2, ?)")
  .run(migrationOwner, deviceId, "2026-11-17T00:00:00.000Z");
assert.equal(db.prepare("SELECT acknowledged_seq FROM nebula_sync_device_acks WHERE owner_id = ? AND device_id = ? AND record_type = 'graph'")
  .get(migrationOwner, deviceId).acknowledged_seq, 2);
assert.throws(() => db.prepare("INSERT INTO nebula_sync_devices (owner_id, device_id, status, registered_at, last_seen_at) VALUES (?, 'not-a-uuid', 'active', ?, ?)")
  .run(migrationOwner, "2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z"),
  /CHECK constraint failed/, "Device identity must be a UUID-shaped opaque identifier.");
assert.throws(() => db.prepare("INSERT INTO nebula_sync_device_acks (owner_id, device_id, record_type, acknowledged_seq, updated_at) VALUES (?, ?, 'graph', -1, ?)")
  .run(migrationOwner, deviceId, "2026-11-17T00:00:00.000Z"),
  /CHECK constraint failed/, "Acknowledgement watermarks cannot be negative.");
assert.throws(() => db.prepare("DELETE FROM nebula_sync_devices WHERE owner_id = ? AND device_id = ?")
  .run(migrationOwner, deviceId),
  /FOREIGN KEY constraint failed|FOREIGN KEY constraint/i,
  "Device audit identity must not be physically removed while acknowledgements refer to it.");
const preservedObject = db.prepare("SELECT status, deleted_at, content_type, size_bytes FROM nebula_objects WHERE owner_id = ? AND object_id = ?").get(migrationOwner, migrationObjectId);
assert.equal(preservedObject.status, "active");
assert.equal(preservedObject.deleted_at, null);
assert.equal(preservedObject.content_type, "application/pdf");
assert.equal(preservedObject.size_bytes, 2048,
  "Migration 0007 must preserve pre-existing active object metadata without marking it deleted.");

const d1 = {
  prepare(sql) {
    return {
      bind(...values) {
        return {
          first() { return db.prepare(sql).get(...values) || null; },
          all() { return { results: db.prepare(sql).all(...values) }; },
          run() {
            const result = db.prepare(sql).run(...values);
            return { meta: { changes: Number(result.changes) } };
          }
        };
      }
    };
  },
  async batch(statements) {
    db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      db.exec("COMMIT");
      return results;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};

assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nebula_object_cleanup'").get(),
  "The R2 upload cleanup-intent migration must be applied in SQLite integration.");
assert.ok(db.prepare("PRAGMA table_info(nebula_object_cleanup)").all().some(column => column.name === "status"),
  "Cleanup intents must expose pending/quarantined state for fair scheduler batches.");

const ownerA = "own_" + "a".repeat(64);
const ownerB = "own_" + "b".repeat(64);
const authA = { kind: "user", ownerId: ownerA };
const authB = { kind: "user", ownerId: ownerB };
const now = () => "2026-11-11T00:00:00.000Z";
const consentA = createNebulaSyncConsentRepository({ db: d1, authContext: authA, now });
const consentB = createNebulaSyncConsentRepository({ db: d1, authContext: authB, now });

await consentA.setConsent({ status: "enabled", categories: ["graph"] });
await consentB.setConsent({ status: "enabled", categories: ["graph"] });
const repoA = createNebulaD1Repository({
  db: d1, authContext: authA,
  syncConsent: await consentA.getConsent(), now
});
const repoB = createNebulaD1Repository({
  db: d1, authContext: authB,
  syncConsent: await consentB.getConsent(), now
});

assert.equal((await repoA.putRecord("graph", "root", { title: "A private node" })).changes, 1);
const firstChange = db.prepare("SELECT sequence, record_id, operation FROM nebula_sync_changes WHERE owner_id = ? AND record_type = 'graph' ORDER BY sequence").get(ownerA);
assert.deepEqual(firstChange && { ...firstChange }, { sequence: 1, record_id: "root", operation: "upsert" },
  "A successful record write and its monotonic change-feed row must commit together.");
assert.equal(db.prepare("SELECT current_seq FROM nebula_sync_counters WHERE owner_id = ? AND record_type = 'graph'").get(ownerA).current_seq, 1);
const firstPage = await repoA.listChanges("graph", { after: 0, limit: 1 });
assert.deepEqual(firstPage.map(change => ({ sequence: change.sequence, recordId: change.recordId, operation: change.operation })),
  [{ sequence: 1, recordId: "root", operation: "upsert" }]);
assert.deepEqual(await repoA.listChanges("graph", { after: 1 }), [],
  "A monotonic cursor must not replay already acknowledged change sequence numbers.");
const deviceRepo = createNebulaSyncDeviceRepository({
  db: d1, authContext: authA, now: () => "2026-11-19T00:00:00.000Z"
});
const testDeviceId = "123e4567-e89b-42d3-a456-426614174102";
const registeredDevice = await deviceRepo.register(testDeviceId);
assert.equal(registeredDevice.status, "active");
assert.equal((await deviceRepo.listActive()).some(device => device.deviceId === testDeviceId), true);
assert.equal(await deviceRepo.recordIssuedChanges(testDeviceId, "graph", []), 0,
  "An active registered device may receive an empty page when no changes are pending.");
assert.equal(await deviceRepo.recordIssuedChanges(testDeviceId, "graph", [1]), 1);
assert.equal(await deviceRepo.recordIssuedChanges(testDeviceId, "graph", [1]), 1,
  "Replaying the same issued page must be idempotent.");
assert.equal((await deviceRepo.acknowledge(testDeviceId, "graph", 1)).acknowledgedSequence, 1);
await assert.rejects(deviceRepo.acknowledge(testDeviceId, "graph", 2),
  /exceeds contiguous changes issued/,
  "A device cannot acknowledge a sequence that was never issued to it.");
assert.equal((await deviceRepo.revoke(testDeviceId)).revoked, true);
await assert.rejects(deviceRepo.register(testDeviceId), /cannot be re-registered/,
  "A revoked device identity must not silently reactivate.");
await assert.rejects(deviceRepo.acknowledge(testDeviceId, "graph", 1),
  /exceeds contiguous changes issued/,
  "A revoked device cannot advance its acknowledgement.");
await assert.rejects(deviceRepo.recordIssuedChanges(testDeviceId, "graph", []),
  /Device is revoked/,
  "An empty page must not bypass active-device validation.");

// Page boundaries remain monotonic when a new record is written between reads.
const pageDeviceId = "123e4567-e89b-42d3-a456-426614174107";
await deviceRepo.register(pageDeviceId);
assert.equal(await deviceRepo.recordIssuedChanges(pageDeviceId, "graph", [1]), 1);
await repoA.putRecord("graph", "page-two", { title: "Sequence two" });
assert.equal(await deviceRepo.recordIssuedChanges(pageDeviceId, "graph", [2]), 1);
await repoA.putRecord("graph", "page-three", { title: "Sequence three" });
const secondPage = await repoA.listChanges("graph", { after: 2, limit: 1 });
assert.deepEqual(secondPage.map(change => change.sequence), [3]);
assert.equal(await deviceRepo.recordIssuedChanges(pageDeviceId, "graph", [3]), 1);
assert.equal((await deviceRepo.acknowledge(pageDeviceId, "graph", 3)).acknowledgedSequence, 3);

// Concurrent acknowledgements must converge monotonically regardless of arrival order.
const concurrentAckDevice = "123e4567-e89b-42d3-a456-426614174105";
await deviceRepo.register(concurrentAckDevice);
await deviceRepo.recordIssuedChanges(concurrentAckDevice, "graph", [1, 2, 3]);
const concurrentAcks = await Promise.all([
  deviceRepo.acknowledge(concurrentAckDevice, "graph", 1),
  deviceRepo.acknowledge(concurrentAckDevice, "graph", 3)
]);
assert.ok(concurrentAcks.every(result => result.acknowledgedSequence >= 1));
assert.equal(db.prepare("SELECT acknowledged_seq FROM nebula_sync_device_acks WHERE owner_id = ? AND device_id = ? AND record_type = 'graph'")
  .get(ownerA, concurrentAckDevice).acknowledged_seq, 3,
  "Concurrent acknowledgements must never move the stored watermark backwards.");

// Revocation racing with delivery may either win before issuance or follow a
// completed issuance, but a revoked device must never acknowledge afterward.
const revokeRaceDevice = "123e4567-e89b-42d3-a456-426614174106";
await deviceRepo.register(revokeRaceDevice);
const revokeDeliveryRace = await Promise.allSettled([
  deviceRepo.recordIssuedChanges(revokeRaceDevice, "graph", [1, 2, 3]),
  deviceRepo.revoke(revokeRaceDevice)
]);
assert.equal(revokeDeliveryRace[1].value.revoked, true);
await assert.rejects(deviceRepo.acknowledge(revokeRaceDevice, "graph", 3),
  /exceeds contiguous changes issued/);
await assert.rejects(deviceRepo.recordIssuedChanges(revokeRaceDevice, "graph", [1]),
  /Device is revoked/);

await assert.rejects(repoA.listChanges("graph", { after: -1 }), /Invalid change-feed cursor/);

// A new device bootstraps from a stable snapshot and then resumes the change feed
// strictly after the snapshot watermark, even while records mutate between pages.
const snapshotDeviceId = "123e4567-e89b-42d3-a456-426614174108";
const snapshotId = "123e4567-e89b-42d3-a456-426614174109";
await deviceRepo.register(snapshotDeviceId);
const snapshotRepo = createNebulaSyncSnapshotRepository({ db: d1, authContext: authA, now });
const snapshot = await snapshotRepo.create({ snapshotId, deviceId: snapshotDeviceId, recordType: "graph" });
assert.equal(snapshot.snapshotSequence, 3);
await assert.rejects(snapshotRepo.complete({ snapshotId, deviceId: snapshotDeviceId }),
  /cannot be completed/, "A device cannot acknowledge a snapshot before all pages are issued.");
const snapshotPage1 = await snapshotRepo.listPage({ snapshotId, deviceId: snapshotDeviceId, after: "", limit: 2 });
assert.equal(snapshotPage1.records.length, 2);
assert.equal(snapshotPage1.hasMore, true);
const snapshotReplay = await snapshotRepo.listPage({ snapshotId, deviceId: snapshotDeviceId, after: "", limit: 2 });
assert.deepEqual(snapshotReplay.records, snapshotPage1.records, "Retrying a page cursor must replay the same immutable snapshot page.");
await assert.rejects(snapshotRepo.listPage({ snapshotId, deviceId: snapshotDeviceId, after: "root", limit: 2 }),
  /requested sequentially/, "A snapshot client cannot skip forward to an unissued page cursor.");
const rootBeforeSnapshotUpdate = db.prepare("SELECT updated_at FROM nebula_records WHERE owner_id = ? AND record_type = 'graph' AND record_id = 'root'").get(ownerA).updated_at;
await repoA.putRecord("graph", "root", { title: "Root changed after snapshot" }, { expectedUpdatedAt: rootBeforeSnapshotUpdate });
const snapshotPage2 = await snapshotRepo.listPage({
  snapshotId, deviceId: snapshotDeviceId, after: snapshotPage1.nextCursor, limit: 2
});
assert.equal(snapshotPage2.records.length, 1);
assert.equal(snapshotPage2.records[0].recordId, "root");
assert.equal(snapshotPage2.records[0].payload.title, "A private node",
  "A concurrent update must not alter the immutable bootstrap snapshot.");
assert.equal(snapshotPage2.complete, true);
const completedSnapshot = await snapshotRepo.complete({ snapshotId, deviceId: snapshotDeviceId });
assert.equal(completedSnapshot.acknowledgedSequence, 3);
assert.deepEqual((await repoA.listChanges("graph", { after: completedSnapshot.acknowledgedSequence })).map(change => change.sequence), [4],
  "Changes committed after the snapshot watermark must be delivered as incremental changes.");
const purgedSnapshots = await snapshotRepo.purgeExpired({ limit: 10 });
assert.equal(purgedSnapshots, 0, "A live snapshot must not be purged before its expiry.");
assert.equal((await repoA.getRecord("graph", "root")).payload.title, "Root changed after snapshot",
  "The live record must reflect its post-snapshot mutation while the snapshot copy remains immutable.");
let snapshotClock = Date.parse("2026-11-11T00:00:00.000Z");
const expiringSnapshotRepo = createNebulaSyncSnapshotRepository({
  db: d1, authContext: authA, now: () => new Date(snapshotClock).toISOString()
});
const expiringSnapshotId = "123e4567-e89b-42d3-a456-426614174111";
await expiringSnapshotRepo.create({
  snapshotId: expiringSnapshotId, deviceId: snapshotDeviceId, recordType: "graph"
});
assert.ok(db.prepare("SELECT COUNT(*) AS count FROM nebula_sync_snapshot_records WHERE owner_id = ? AND snapshot_id = ?")
  .get(ownerA, expiringSnapshotId).count > 0);
snapshotClock += 25 * 60 * 60 * 1000;
assert.equal(await expiringSnapshotRepo.purgeExpired({ limit: 10 }), 1,
  "Expired bootstrap snapshots must be purged in bounded batches.");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_sync_snapshot_records WHERE owner_id = ? AND snapshot_id = ?")
  .get(ownerA, expiringSnapshotId).count, 0,
  "Purging a snapshot must cascade-delete its temporary record copies and page ledger.");

// Versioned record writes use create-only semantics followed by compare-and-swap.
// A stale writer receives the current remote version and payload instead of
// silently replacing another device's changes.
let versionClock = Date.parse("2026-11-15T00:00:00.000Z");
const versionRepo = createNebulaD1Repository({
  db: d1, authContext: authA, syncConsent: await consentA.getConsent(),
  now: () => new Date(versionClock += 1000).toISOString()
});
const initialVersion = (await versionRepo.getRecord("graph", "root")).updatedAt;
const versionUpdate = await versionRepo.putRecord("graph", "root", { title: "A private node v2" }, {
  expectedUpdatedAt: initialVersion
});
assert.equal(versionUpdate.conflict, false);
const staleWrite = await versionRepo.putRecord("graph", "root", { title: "stale device overwrite" }, {
  expectedUpdatedAt: initialVersion
});
assert.equal(staleWrite.conflict, true);
assert.equal(staleWrite.remoteVersion, versionUpdate.updatedAt);
assert.deepEqual(staleWrite.remotePayload, { title: "A private node v2" });
const blindCreate = await versionRepo.putRecord("graph", "root", { title: "blind overwrite" });
assert.equal(blindCreate.conflict, true, "A write without a base version must not replace an existing record.");
assert.deepEqual((await versionRepo.getRecord("graph", "root")).payload, { title: "A private node v2" });

assert.deepEqual((await repoB.listRecords("graph")), []);
assert.equal(await repoB.getRecord("graph", "root"), null);
assert.equal((await repoB.deleteRecord("graph", "root")).deleted, false,
  "A different owner must not delete another user's record.");
assert.equal((await repoA.getRecord("graph", "root")).payload.title, "A private node v2");
assert.equal((await repoA.deleteRecord("graph", "missing-record")).deleted, false,
  "Deleting a nonexistent owner-scoped record must report deleted:false.");

// Revoke consent after constructing the repository (stale in-memory snapshot).
// Every SQL operation must independently consult the live consent row.
await consentA.setConsent({ status: "revoked", categories: ["graph"] });
assert.equal(await repoA.getRecord("graph", "root"), null);
assert.deepEqual(await repoA.listRecords("graph"), []);
await assert.rejects(repoA.putRecord("graph", "blocked", { title: "must not persist" }), /consent does not cover/);
const deletion = await repoA.deleteRecord("graph", "root");
assert.equal(deletion.deleted, true);
const tombstone = db.prepare("SELECT deleted_at, payload_json FROM nebula_records WHERE owner_id = ? AND record_type = 'graph' AND record_id = 'root'").get(ownerA);
assert.ok(tombstone.deleted_at, "Owner-initiated deletion must retain a versioned tombstone.");
assert.equal(tombstone.payload_json, "{}", "Deleting a cloud record must scrub its former payload, retaining only the minimal tombstone.");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_records WHERE owner_id = ? AND record_type = 'graph' AND record_id = 'root'").get(ownerA).count, 1,
  "Revocation preserves the original record's minimal deletion marker without assuming no other test records exist.");

// Exercise the actual cleanup-claim SQL against SQLite, not only Fake D1.
const cleanupNow = Date.parse("2026-11-13T12:00:00.000Z");
const cleanupOld = "2026-11-13T10:00:00.000Z";
const cleanupKey = (id) => "owners/" + ownerA + "/private-files/" + id;
const insertCleanupIntent = (id) => db.prepare(
  "INSERT INTO nebula_object_cleanup (owner_id, object_id, category, object_key, created_at) VALUES (?, ?, 'private-files', ?, ?)"
).run(ownerA, id, cleanupKey(id), cleanupOld);

const committedId = "123e4567-e89b-12d3-a456-426614174101";
insertCleanupIntent(committedId);
db.prepare(
  "INSERT INTO nebula_objects (owner_id, object_id, category, object_key, content_type, size_bytes, status, created_at, updated_at) VALUES (?, ?, 'private-files', ?, 'text/plain', 1, 'active', ?, ?)"
).run(ownerA, committedId, cleanupKey(committedId), cleanupOld, cleanupOld);
const activeDeletes = [];
await reconcileNebulaR2UploadCleanup({
  db: d1, now: () => cleanupNow, bucket: { async delete(key) { activeDeletes.push(key); } }
});
assert.deepEqual(activeDeletes, [], "An active metadata row must prevent a cleanup delete.");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_objects WHERE object_id = ?").get(committedId).count, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_object_cleanup WHERE object_id = ?").get(committedId).count, 0);

const racedId = "123e4567-e89b-12d3-a456-426614174102";
insertCleanupIntent(racedId);
let releaseDelete;
let deleteStarted;
const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
const startedGate = new Promise(resolve => { deleteStarted = resolve; });
let racedDeleteCalls = 0;
const raceBucket = { async delete() { racedDeleteCalls += 1; deleteStarted(); await deleteGate; } };
const firstScheduler = reconcileNebulaR2UploadCleanup({
  db: d1, now: () => cleanupNow, bucket: raceBucket
});
await startedGate;
// The scheduler has atomically changed uploading -> processing. The upload's
// conditional metadata INSERT must now fail rather than publish a deleted object.
const blockedCommit = db.prepare(
  "INSERT INTO nebula_objects (owner_id, object_id, category, object_key, content_type, size_bytes, status, created_at, updated_at) SELECT ?, ?, 'private-files', ?, 'text/plain', 1, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM nebula_object_cleanup i WHERE i.owner_id = ? AND i.category = 'private-files' AND i.object_id = ? AND i.status = 'uploading')"
).run(ownerA, racedId, cleanupKey(racedId), cleanupOld, cleanupOld, ownerA, racedId);
assert.equal(Number(blockedCommit.changes), 0, "A scheduler claim must fence the upload metadata commit.");
const secondScheduler = await reconcileNebulaR2UploadCleanup({
  db: d1, now: () => cleanupNow, bucket: raceBucket
});
assert.equal(secondScheduler.scanned, 0, "A second scheduler must not claim an unexpired processing lease.");
assert.equal(racedDeleteCalls, 1, "Only one scheduler may issue the R2 delete for a claimed intent.");
releaseDelete();
await firstScheduler;
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_object_cleanup WHERE object_id = ?").get(racedId).count, 0);

// An expired processing lease may be reclaimed, but a stale worker must not
// clear the newer worker's lease when its delayed R2 delete eventually returns.
const leaseRaceId = "123e4567-e89b-12d3-a456-426614174106";
insertCleanupIntent(leaseRaceId);
let releaseOldDelete;
let releaseNewDelete;
let oldDeleteStarted;
let newDeleteStarted;
const oldDeleteGate = new Promise(resolve => { releaseOldDelete = resolve; });
const newDeleteGate = new Promise(resolve => { releaseNewDelete = resolve; });
const oldStartedGate = new Promise(resolve => { oldDeleteStarted = resolve; });
const newStartedGate = new Promise(resolve => { newDeleteStarted = resolve; });
const oldLeaseScheduler = reconcileNebulaR2UploadCleanup({
  db: d1, now: () => cleanupNow,
  bucket: { async delete() { oldDeleteStarted(); await oldDeleteGate; } }
});
await oldStartedGate;
const renewedLeaseTime = cleanupNow + 31 * 60 * 1000;
const newLeaseScheduler = reconcileNebulaR2UploadCleanup({
  db: d1, now: () => renewedLeaseTime,
  bucket: { async delete() { newDeleteStarted(); await newDeleteGate; } }
});
await newStartedGate;
releaseOldDelete();
await oldLeaseScheduler;
const renewedLease = db.prepare(
  "SELECT status, lease_expires_at FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?"
).get(ownerA, leaseRaceId);
assert.equal(renewedLease.status, "processing");
assert.equal(renewedLease.lease_expires_at, new Date(renewedLeaseTime + 30 * 60 * 1000).toISOString(),
  "A stale worker must not delete a cleanup row claimed under a newer lease.");
releaseNewDelete();
await newLeaseScheduler;
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?").get(ownerA, leaseRaceId).count, 0);

// An active upload that commits before the scheduler's claim remains protected.
const commitFirstId = "123e4567-e89b-12d3-a456-426614174103";
insertCleanupIntent(commitFirstId);
const uploadCommit = db.prepare(
  "INSERT INTO nebula_objects (owner_id, object_id, category, object_key, content_type, size_bytes, status, created_at, updated_at) SELECT ?, ?, 'private-files', ?, 'text/plain', 1, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM nebula_object_cleanup i WHERE i.owner_id = ? AND i.category = 'private-files' AND i.object_id = ? AND i.status = 'uploading')"
).run(ownerA, commitFirstId, cleanupKey(commitFirstId), cleanupOld, cleanupOld, ownerA, commitFirstId);
assert.equal(Number(uploadCommit.changes), 1);
const commitFirstDeletes = [];
await reconcileNebulaR2UploadCleanup({
  db: d1, now: () => cleanupNow, bucket: { async delete(key) { commitFirstDeletes.push(key); } }
});
assert.deepEqual(commitFirstDeletes, []);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_objects WHERE object_id = ?").get(commitFirstId).count, 1);

// Exercise the real SQLite consent predicate in the R2 metadata INSERT.
// Revocation during bucket.put must be observed by the final D1 commit itself.
await consentA.setConsent({ status: "enabled", categories: ["graph", "private-files"] });
const revocationRaceId = "123e4567-e89b-12d3-a456-426614174104";
const revocationRaceKey = cleanupKey(revocationRaceId);
const uploadedObjects = new Set();
const revocationRaceBucket = {
  async put(key) {
    uploadedObjects.add(key);
    await consentA.setConsent({ status: "revoked", categories: ["graph", "private-files"] });
  },
  async get(key) { return uploadedObjects.has(key) ? { body: new Uint8Array([1]) } : null; },
  async delete(key) { uploadedObjects.delete(key); }
};
const r2RepoA = createNebulaR2Repository({
  bucket: revocationRaceBucket, db: d1, authContext: authA, consentRepository: consentA,
  idFactory: () => revocationRaceId, now
});
await assert.rejects(
  r2RepoA.putObject({ category: "private-files", body: new Uint8Array([1]), contentType: "application/octet-stream" }),
  /Object upload did not complete/
);
assert.equal(uploadedObjects.has(revocationRaceKey), false,
  "R2 bytes written during a revoked upload must be compensated.");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_objects WHERE owner_id = ? AND object_id = ?").get(ownerA, revocationRaceId).count, 0,
  "The actual SQLite D1 metadata INSERT must reject a commit after consent revocation.");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?").get(ownerA, revocationRaceId).count, 0,
  "Successful compensation must clear the rejected upload intent.");

// A user-requested delete must atomically persist a pending cleanup intent.
// If R2 fails, the scheduled reconciler completes the deletion, preserves
// a payload-free object tombstone, and removes only the durable cleanup intent.
await consentA.setConsent({ status: "enabled", categories: ["graph", "private-files"] });
const durableDeleteId = "123e4567-e89b-12d3-a456-426614174105";
const durableDeleteKey = cleanupKey(durableDeleteId);
const deleteObjects = new Set();
let failFirstDelete = true;
const deleteBucket = {
  async put(key) { deleteObjects.add(key); },
  async get(key) { return deleteObjects.has(key) ? { body: new Uint8Array([7]) } : null; },
  async delete(key) {
    if (failFirstDelete) { failFirstDelete = false; throw new Error("simulated R2 delete outage"); }
    deleteObjects.delete(key);
  }
};
const deleteNow = () => "2026-11-12T11:59:30.000Z";
const durableDeleteRepo = createNebulaR2Repository({
  bucket: deleteBucket, db: d1, authContext: authA, consentRepository: consentA,
  idFactory: () => durableDeleteId, now: deleteNow
});
await durableDeleteRepo.putObject({ category: "private-files", body: new Uint8Array([7]) });
await assert.rejects(durableDeleteRepo.deleteObject("private-files", durableDeleteId), /simulated R2 delete outage/);
assert.equal(db.prepare("SELECT status FROM nebula_objects WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).status, "deleting");
assert.equal(db.prepare("SELECT status FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).status, "pending");
assert.equal(db.prepare("SELECT intent_kind FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).intent_kind, "delete");
assert.equal(deleteObjects.has(durableDeleteKey), true);
await reconcileNebulaR2UploadCleanup({
  db: d1, bucket: deleteBucket, now: () => Date.parse("2026-11-12T12:00:00.000Z")
});
assert.equal(deleteObjects.has(durableDeleteKey), false);
const objectTombstone = db.prepare("SELECT status, deleted_at, object_key, content_type, size_bytes FROM nebula_objects WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId);
assert.equal(objectTombstone.status, "deleted");
assert.ok(objectTombstone.deleted_at);
assert.equal(objectTombstone.object_key, durableDeleteKey, "The stable object key remains available for owner-scoped tombstone identity.");
assert.equal(objectTombstone.content_type, "application/octet-stream");
assert.equal(objectTombstone.size_bytes, 0, "Tombstones must scrub former content type and byte-size metadata.");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_objects WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).count, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).count, 0);
// The object listing path exposes the marker without content metadata, allowing
// another authorized device to learn that the object was deleted.
const objectListRepo = createNebulaR2Repository({
  bucket: deleteBucket, db: d1, authContext: authA, consentRepository: consentA, now
});
const listedTombstone = (await objectListRepo.listObjects("private-files")).find(item => item.objectId === durableDeleteId);
assert.equal(listedTombstone.deleted, true);
assert.equal(listedTombstone.contentType, null);
assert.equal(listedTombstone.sizeBytes, null);

// Revocation blocks record reads/writes but must not trap the owner's own data
// in cloud storage. The delete statement remains owner-scoped and consent-free.
const recordDeleteId = "record-after-revocation";
const enabledRecordConsent = await consentA.getConsent();
const recordRepoEnabled = createNebulaD1Repository({
  db: d1, authContext: authA, syncConsent: enabledRecordConsent, now
});
await recordRepoEnabled.putRecord("graph", recordDeleteId, { title: "Owner's cloud record" });
await consentA.setConsent({ status: "revoked", categories: ["graph", "private-files"] });
const recordRepoRevoked = createNebulaD1Repository({
  db: d1, authContext: authA, syncConsent: await consentA.getConsent(), now
});
await assert.rejects(recordRepoRevoked.getRecord("graph", recordDeleteId), /Cloud sync is not enabled/);
assert.equal((await recordRepoRevoked.deleteRecord("graph", recordDeleteId)).deleted, true);
const deletionChange = db.prepare("SELECT sequence, record_id, operation FROM nebula_sync_changes WHERE owner_id = ? AND record_type = 'graph' AND record_id = ? ORDER BY sequence DESC LIMIT 1").get(ownerA, recordDeleteId);
assert.equal(deletionChange.record_id, recordDeleteId);
assert.equal(deletionChange.operation, "delete");
assert.equal(deletionChange.sequence, db.prepare("SELECT current_seq FROM nebula_sync_counters WHERE owner_id = ? AND record_type = 'graph'").get(ownerA).current_seq,
  "Owner deletion after consent revocation must append the latest monotonic tombstone change.");
const revokedTombstone = db.prepare("SELECT deleted_at, payload_json FROM nebula_records WHERE owner_id = ? AND record_id = ?").get(ownerA, recordDeleteId);
assert.ok(revokedTombstone.deleted_at);
assert.equal(revokedTombstone.payload_json, "{}");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_records WHERE owner_id = ? AND record_id = ?").get(ownerA, recordDeleteId).count, 1);

db.close();
console.log("NEBULA SQLite migrations, consent and atomic R2 cleanup integration tests passed.");
