import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createNebulaD1Repository } from "../nebula-d1-repository.js";
import { createNebulaSyncConsentRepository } from "../nebula-sync-consent.js";
import { reconcileNebulaR2UploadCleanup } from "../nebula-r2-cleanup.js";

// Execute the actual Cloudflare D1 SQLite migrations and repository SQL against
// Node's SQLite engine. This is stronger than the contract mocks, but is still
// not a live Cloudflare D1 deployment test.
const db = new DatabaseSync(":memory:");
const migrations = [
  "0001_owner_scoped_records.sql",
  "0002_sync_consent_ledger.sql",
  "0003_owner_scoped_objects.sql",
  "0004_r2_upload_cleanup_intents.sql"
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
assert.deepEqual(await repoA.deleteRecord("graph", "root"), { deleted: false });
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_records WHERE owner_id = ?").get(ownerA).count, 1,
  "Revocation must block reads and mutations without deleting existing cloud data.");

// Re-enable A and verify normal deletion is restored.
await consentA.setConsent({ status: "enabled", categories: ["graph"] });
assert.deepEqual(await repoA.deleteRecord("graph", "root"), { deleted: true });
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nebula_records WHERE owner_id = ?").get(ownerA).count, 0);

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

db.close();
console.log("NEBULA SQLite migrations, consent and atomic R2 cleanup integration tests passed.");
