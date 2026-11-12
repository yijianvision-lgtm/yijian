import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNebulaR2Repository } from "../nebula-r2-repository.js";

const ownerA = "own_" + "a".repeat(64);
const ownerB = "own_" + "b".repeat(64);
const fixedId = "123e4567-e89b-12d3-a456-426614174000";
class FakeD1 {
  calls = [];
  row = null;
  failMetadataDelete = 0;
  failMetadataInsert = 0;
  failCleanupDelete = 0;
  consentEnabled = true;
  cleanup = new Map();
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  prepare(sql) {
    const call = { sql, values: [] };
    this.calls.push(call);
    return { bind: (...values) => {
      call.values = values;
      return {
        first: async () => this.row,
        all: async () => sql.includes("FROM nebula_object_cleanup")
          ? ({ results: [...this.cleanup.values()].filter(item =>
              item.owner_id === values[0] &&
              (sql.includes("status = 'pending'") ? (
                item.status === "pending" ||
                (item.status === "processing" && item.lease_expires_at <= values[1]) ||
                (item.status === "uploading" && this.row?.object_id === item.object_id && this.row?.status === "active")
              ) : true)
            ) })
          : ({ results: [] }),
        run: async () => {
          if (sql.startsWith("INSERT INTO nebula_object_cleanup")) {
            if (sql.includes("SELECT owner_id, object_id")) {
              if (this.row?.status === "deleting" && this.row.owner_id === values[1] &&
                  this.row.category === values[2] && this.row.object_id === values[3]) {
                this.cleanup.set(values[3], {
                  owner_id: this.row.owner_id, object_id: this.row.object_id,
                  category: this.row.category, object_key: this.row.object_key,
                  created_at: values[0], status: "pending", lease_expires_at: null, intent_kind: "delete"
                });
              }
            } else {
              const item = { owner_id: values[0], object_id: values[1], category: values[2], object_key: values[3], created_at: values[4], status: "uploading" };
              this.cleanup.set(values[1], item);
            }
          } else if (sql.startsWith("DELETE FROM nebula_object_cleanup")) {
            if (this.failCleanupDelete > 0) {
              this.failCleanupDelete -= 1;
              throw new Error("simulated cleanup intent delete failure");
            }
            this.cleanup.delete(values[2]);
          } else if (sql.startsWith("UPDATE nebula_object_cleanup SET status = 'processing'")) {
            const item = this.cleanup.get(values[3]);
            if (item && item.owner_id === values[1] && item.category === values[2] &&
                item.created_at === values[4] &&
                (item.status === "pending" ||
                 (item.status === "processing" && item.lease_expires_at <= values[5])) &&
                this.row?.status !== "active") {
              item.status = "processing";
              item.lease_expires_at = values[0];
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          else if (sql.startsWith("UPDATE nebula_object_cleanup SET status = 'pending'")) {
            const item = this.cleanup.get(values[2]);
            if (item && item.status === "uploading") {
              item.status = "pending";
              item.lease_expires_at = null;
            }
          } else if (sql.startsWith("INSERT INTO nebula_objects")) {
            if (this.failMetadataInsert > 0) {
              this.failMetadataInsert -= 1;
              throw new Error("simulated metadata insert failure");
            }
            if (sql.includes("nebula_sync_consents") && !this.consentEnabled) {
              return { meta: { changes: 0 } };
            }
            this.row = {
              owner_id: values[0], object_id: values[1], category: values[2], object_key: values[3],
              content_type: values[4], size_bytes: values[5], status: "active", created_at: values[6]
            };
          } else if (sql.startsWith("UPDATE nebula_objects")) {
            if (this.row) this.row.status = "deleting";
          } else if (sql.startsWith("DELETE FROM nebula_objects")) {
            if (this.failMetadataDelete > 0) {
              this.failMetadataDelete -= 1;
              throw new Error("simulated metadata delete failure");
            }
            this.row = null;
          }
          return { meta: { changes: 1 } };
        }
      };
    }};
  }
}
class FakeR2 {
  objects = new Map();
  failDeletes = 0;
  beforePut = null;
  beforeGet = null;
  async put(key, body, options) {
    if (this.beforePut) await this.beforePut(key, body, options);
    this.objects.set(key, { body, options });
  }
  async get(key) {
    if (this.beforeGet) await this.beforeGet(key);
    const value = this.objects.get(key);
    return value ? { body: value.body } : null;
  }
  async delete(key) {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("simulated R2 delete failure");
    }
    this.objects.delete(key);
  }
}
const db = new FakeD1();
const bucket = new FakeR2();
const consentCalls = [];
const consentRepository = { async requireCategory(category) {
  consentCalls.push(category);
  if (!db.consentEnabled) throw new Error("Active server-side cloud-sync consent is required for this category.");
  return { status: "enabled" };
} };
const repo = createNebulaR2Repository({
  bucket, db, authContext: { kind: "user", ownerId: ownerA }, consentRepository, maxBytes: 10,
  idFactory: () => fixedId, now: () => "2026-11-10T00:00:00.000Z"
});
const stored = await repo.putObject({ category: "private-files", body: new TextEncoder().encode("hello"), contentType: "text/plain" });
assert.equal(stored.objectId, fixedId);
const expectedKey = "owners/" + ownerA + "/private-files/" + fixedId;
assert.ok(bucket.objects.has(expectedKey));
assert.equal(db.calls[0].values[0], ownerA);
assert.equal(db.calls[0].values[3], expectedKey);
const firstMetadataCommit = db.calls.find(call => call.sql.startsWith("INSERT INTO nebula_objects"));
assert.match(firstMetadataCommit.sql, /nebula_sync_consents/,
  "The final metadata commit must atomically re-check the live server-side consent ledger.");
assert.deepEqual(firstMetadataCommit.values.slice(-2), [ownerA, "private-files"]);
assert.equal((await repo.getObject("private-files", fixedId)).body.byteLength, 5);
assert.deepEqual(await repo.listObjects("private-files", { limit: 1000 }), []);
assert.ok(db.calls.some(call => call.sql.includes("FROM nebula_objects o") && call.sql.includes("nebula_sync_consents")),
  "Object listing must be fenced by the live consent ledger in its D1 query.");
assert.ok(consentCalls.length >= 3);
assert.ok(db.calls.every(call => call.values[0] === ownerA), "Every D1 metadata operation must be owner-scoped.");
assert.ok(db.calls.every(call => !call.values.includes(ownerB)), "Client-supplied foreign owner IDs must never be used.");
await assert.rejects(repo.putObject({ category: "private-files", body: new Uint8Array(11) }), /size limit/);
await assert.rejects(repo.putObject({ category: "../other", body: new Uint8Array(1) }), /Invalid object category/);
await assert.rejects(repo.getObject("private-files", "../" + fixedId), /Invalid object ID/);
assert.throws(() => createNebulaR2Repository({ bucket, db, authContext: { kind: "shared-service" }, consentRepository }), /verified user identity/);
assert.throws(() => createNebulaR2Repository({ bucket, db, authContext: { kind: "user", ownerId: ownerA } }), /server-side sync consent/);

// R2 deletion failure leaves a durable pending intent. User-scoped
// reconciliation must finish it without requiring the user to retry manually.
bucket.failDeletes = 1;
await assert.rejects(repo.deleteObject("private-files", fixedId), /simulated R2 delete failure/);
assert.equal(db.row.status, "deleting");
assert.equal(db.cleanup.get(fixedId).status, "pending");
assert.ok(bucket.objects.has(expectedKey));
assert.deepEqual(await repo.reconcilePendingUploads(), [
  { objectId: fixedId, action: "orphan-removed" }
]);
assert.equal(db.row, null);
assert.equal(db.cleanup.has(fixedId), false);
assert.equal(bucket.objects.has(expectedKey), false);

// If R2 deletion succeeds but the final D1 batch fails, the durable intent
// remains; reconciliation repeats the idempotent R2 delete and finishes.
const secondId = "123e4567-e89b-12d3-a456-426614174001";
const retryRepo = createNebulaR2Repository({
  bucket, db, authContext: { kind: "user", ownerId: ownerA }, consentRepository,
  idFactory: () => secondId, now: () => "2026-11-10T00:00:00.000Z"
});
const second = await retryRepo.putObject({ category: "private-files", body: new Uint8Array([1]) });
const secondKey = "owners/" + ownerA + "/private-files/" + second.objectId;
db.failMetadataDelete = 1;
await assert.rejects(retryRepo.deleteObject("private-files", second.objectId), /simulated metadata delete failure/);
assert.equal(db.row.status, "deleting");
assert.equal(db.cleanup.get(second.objectId).status, "pending");
assert.equal(bucket.objects.has(secondKey), false);
assert.deepEqual(await retryRepo.reconcilePendingUploads(), [
  { objectId: second.objectId, action: "orphan-removed" }
]);
assert.equal(db.row, null);
assert.equal(db.cleanup.has(second.objectId), false);

// If the D1 metadata insert and immediate R2 compensation both fail, the
// pre-written cleanup intent must survive and allow a later retry to remove
// the otherwise unindexed R2 object.
const thirdId = "123e4567-e89b-12d3-a456-426614174002";
const recoveryRepo = createNebulaR2Repository({
  bucket, db, authContext: { kind: "user", ownerId: ownerA }, consentRepository,
  idFactory: () => thirdId, now: () => "2026-11-10T00:00:00.000Z"
});
const thirdKey = "owners/" + ownerA + "/private-files/" + thirdId;
db.failMetadataInsert = 1;
bucket.failDeletes = 1;
await assert.rejects(
  recoveryRepo.putObject({ category: "private-files", body: new Uint8Array([2]) }),
  /durable cleanup intent/
);
assert.ok(bucket.objects.has(thirdKey), "Fault injection should leave the R2 object for recovery.");
assert.ok(db.cleanup.has(thirdId), "Cleanup intent must survive failed compensation.");
assert.equal(db.cleanup.get(thirdId).status, "pending",
  "Failed immediate compensation must move an unclaimed intent into the retry queue.");
assert.deepEqual(await recoveryRepo.reconcilePendingUploads(), [
  { objectId: thirdId, action: "orphan-removed" }
]);
assert.equal(bucket.objects.has(thirdKey), false);
assert.equal(db.cleanup.has(thirdId), false);

// User-scoped recovery must not select or delete a fresh upload intent.
const freshIntentId = "123e4567-e89b-12d3-a456-426614174004";
const freshIntentKey = "owners/" + ownerA + "/private-files/" + freshIntentId;
db.cleanup.set(freshIntentId, {
  owner_id: ownerA, object_id: freshIntentId, category: "private-files",
  object_key: freshIntentKey, created_at: "2026-11-10T00:00:00.000Z", status: "uploading"
});
await bucket.put(freshIntentKey, new Uint8Array([9]), {});
assert.deepEqual(await recoveryRepo.reconcilePendingUploads(), []);
assert.ok(bucket.objects.has(freshIntentKey),
  "User-scoped recovery must never delete an uploading intent.");

// A stale cleanup intent after successful metadata commit must never delete
// the active object; reconciliation only clears the intent.
const fourthId = "123e4567-e89b-12d3-a456-426614174003";
const committedRepo = createNebulaR2Repository({
  bucket, db, authContext: { kind: "user", ownerId: ownerA }, consentRepository,
  idFactory: () => fourthId, now: () => "2026-11-10T00:00:00.000Z"
});
db.failCleanupDelete = 1;
const fourth = await committedRepo.putObject({ category: "private-files", body: new Uint8Array([3]) });
assert.equal(fourth.objectId, fourthId);
const fourthKey = "owners/" + ownerA + "/private-files/" + fourthId;
assert.ok(bucket.objects.has(fourthKey));
assert.equal(db.row.status, "active");
assert.deepEqual(await committedRepo.reconcilePendingUploads(), [
  { objectId: fourthId, action: "intent-cleared" }
]);
assert.ok(bucket.objects.has(fourthKey), "A committed object must not be removed by cleanup reconciliation.");

// A revocation during the R2 read must be re-checked before returning the body.
bucket.beforeGet = async () => { db.consentEnabled = false; };
await assert.rejects(committedRepo.getObject("private-files", fourthId), /Active server-side cloud-sync consent/);
bucket.beforeGet = null;
db.consentEnabled = true;

// Revoking consent while R2 is receiving the bytes must block the final D1
// metadata commit. The uploaded bytes are compensated and the intent removed.
const fifthId = "123e4567-e89b-12d3-a456-426614174005";
const fifthKey = "owners/" + ownerA + "/private-files/" + fifthId;
const revocationRaceRepo = createNebulaR2Repository({
  bucket, db, authContext: { kind: "user", ownerId: ownerA }, consentRepository,
  idFactory: () => fifthId, now: () => "2026-11-10T00:00:00.000Z"
});
db.consentEnabled = true;
bucket.beforePut = async () => { db.consentEnabled = false; };
await assert.rejects(
  revocationRaceRepo.putObject({ category: "private-files", body: new Uint8Array([5]) }),
  /Object upload did not complete/
);
bucket.beforePut = null;
assert.equal(bucket.objects.has(fifthKey), false,
  "An upload finishing after consent revocation must be compensated.");
assert.equal(db.cleanup.has(fifthId), false,
  "A rejected post-revocation upload must not retain an active cleanup intent.");
db.consentEnabled = true;

const migration = await readFile(new URL("../migrations/0003_owner_scoped_objects.sql", import.meta.url), "utf8");
assert.match(migration, /PRIMARY KEY \(owner_id, category, object_id\)/);
assert.match(migration, /object_key LIKE 'owners\/' \|\| owner_id/);
assert.match(migration, /status IN \('active', 'deleting'\)/);

const cleanupMigration = await readFile(new URL("../migrations/0004_r2_upload_cleanup_intents.sql", import.meta.url), "utf8");
assert.match(cleanupMigration, /CREATE TABLE IF NOT EXISTS nebula_object_cleanup/);
assert.match(cleanupMigration, /PRIMARY KEY \(owner_id, category, object_id\)/);

console.log("NEBULA owner-scoped R2 repository contract tests passed.");
