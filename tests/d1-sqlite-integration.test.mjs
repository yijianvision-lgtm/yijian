import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createNebulaD1Repository } from "../nebula-d1-repository.js";
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
  "0005_r2_delete_intent_kind.sql"
];
for (const migration of migrations) {
  const sql = await readFile(new URL("../migrations/" + migration, import.meta.url), "utf8");
  db.exec(sql);
}

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
assert.equal((await repoA.getRecord("graph", "root")).payload.title, "A private node");
assert.deepEqual((await repoB.listRecords("graph")), []);
assert.equal(await repoB.getRecord("graph", "root"), null);

// Revoke consent after constructing the repository (stale in-memory snapshot).
// Every SQL operation must independently consult the live consent row.
await consentA.setConsent({ status: "revoked", categories: ["graph"] });
assert.equal(await repoA.getRecord("graph", "root"), null);
assert.deepEqual(await repoA.listRecords("graph"), []);
assert.equal((await repoA.putRecord("graph", "blocked", { title: "must not persist" })).changes, 0);
assert.deepEqual(await repoA.deleteRecord("graph", "root"), { deleted: true });
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_records WHERE owner_id = ?").get(ownerA).count, 0,
  "Revocation blocks reads and writes but preserves the owner's ability to explicitly delete their own cloud data.");

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
// If R2 fails, the scheduled reconciler completes the deletion and removes
// both the inaccessible D1 metadata row and the durable intent.
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
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_objects WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).count, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_object_cleanup WHERE owner_id = ? AND object_id = ?").get(ownerA, durableDeleteId).count, 0);

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
assert.deepEqual(await recordRepoRevoked.deleteRecord("graph", recordDeleteId), { deleted: true });
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_records WHERE owner_id = ? AND record_id = ?").get(ownerA, recordDeleteId).count, 0);

db.close();
console.log("NEBULA SQLite migrations, consent and atomic R2 cleanup integration tests passed.");
