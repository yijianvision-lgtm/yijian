import assert from "node:assert/strict";
import { reconcileNebulaR2UploadCleanup } from "../nebula-r2-cleanup.js";

const ownerA = "own_" + "a".repeat(64);
const ownerB = "own_" + "b".repeat(64);
const now = Date.parse("2026-11-12T12:00:00.000Z");
const old = "2026-11-12T10:00:00.000Z";
const fresh = "2026-11-12T11:30:00.000Z";

class FakeD1 {
  intents = [];
  metadata = new Map();
  deleted = [];
  prepare(sql) {
    let values = [];
    return {
      bind: (...args) => {
        values = args;
        return {
          all: async () => ({
            results: this.intents
              .filter(item => (item.status || "pending") === "pending" && item.created_at <= values[0])
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .slice(0, values[1])
          }),
          first: async () => this.metadata.get(values.join(":")) || null,
          run: async () => {
            if (sql.startsWith("DELETE FROM nebula_object_cleanup")) {
              this.intents = this.intents.filter(item =>
                !(item.owner_id === values[0] && item.category === values[1] &&
                  item.object_id === values[2] && item.created_at === values[3])
              );
            }
            if (sql.startsWith("UPDATE nebula_object_cleanup SET status = 'quarantined'")) {
              const item = this.intents.find(item =>
                item.owner_id === values[0] && item.category === values[1] &&
                item.object_id === values[2] && item.created_at === values[3] &&
                (item.status || "pending") === "pending"
              );
              if (item) item.status = "quarantined";
            }
            return { meta: { changes: 1 } };
          }
        };
      }
    };
  }
}
class FakeR2 {
  fail = new Set();
  deleted = [];
  async delete(key) {
    if (this.fail.has(key)) throw new Error("simulated R2 outage");
    this.deleted.push(key);
  }
}
const db = new FakeD1();
const bucket = new FakeR2();
const make = (owner, id, createdAt, category = "private-files") => ({
  owner_id: owner,
  object_id: id,
  category,
  object_key: "owners/" + owner + "/" + category + "/" + id,
  created_at: createdAt
});
const activeId = "123e4567-e89b-12d3-a456-426614174010";
const orphanId = "123e4567-e89b-12d3-a456-426614174011";
const failedId = "123e4567-e89b-12d3-a456-426614174012";
const freshId = "123e4567-e89b-12d3-a456-426614174013";
const invalidId = "123e4567-e89b-12d3-a456-426614174014";
db.intents = [
  make(ownerA, activeId, old),
  make(ownerB, orphanId, old),
  make(ownerA, failedId, old),
  make(ownerA, freshId, fresh),
  { ...make(ownerA, invalidId, old), object_key: "owners/" + ownerB + "/private-files/" + invalidId }
];
db.metadata.set([ownerA, "private-files", activeId].join(":"), { status: "active" });
bucket.fail.add("owners/" + ownerA + "/private-files/" + failedId);

const result = await reconcileNebulaR2UploadCleanup({
  db, bucket, now: () => now, limit: 50
});
assert.equal(result.scanned, 4, "Fresh intents must remain outside the stale cleanup window.");
assert.deepEqual(result.outcomes.map(item => item.action), [
  "intent-cleared", "orphan-removed", "retry-pending", "invalid-quarantined"
]);
assert.ok(bucket.deleted.includes("owners/" + ownerB + "/private-files/" + orphanId));
assert.ok(!bucket.deleted.includes("owners/" + ownerA + "/private-files/" + activeId),
  "Active metadata must protect a committed object.");
assert.ok(db.intents.some(item => item.object_id === failedId),
  "R2 failure must retain the intent for a later scheduled retry.");
assert.ok(db.intents.some(item => item.object_id === freshId),
  "Recent uploads must be protected by the grace period.");
assert.ok(db.intents.some(item => item.object_id === invalidId),
  "Invalid keys must never be passed to R2 or silently deleted.");

// Invalid rows are quarantined, not deleted, and no longer monopolize the
// oldest pending batch slots on subsequent scheduler runs.
assert.equal(db.intents.find(item => item.object_id === invalidId).status, "quarantined");
const backlogDb = new FakeD1();
const backlogBucket = new FakeR2();
backlogDb.intents = Array.from({ length: 55 }, (_, index) => ({
  ...make(ownerA, "123e4567-e89b-12d3-a456-" + String(index).padStart(12, "0"), old),
  object_key: "malformed/" + index
}));
const fairId = "123e4567-e89b-12d3-a456-426614174099";
backlogDb.intents.push(make(ownerB, fairId, old));
const firstBacklogRun = await reconcileNebulaR2UploadCleanup({
  db: backlogDb, bucket: backlogBucket, now: () => now, limit: 50
});
assert.equal(firstBacklogRun.scanned, 50);
assert.equal(backlogDb.intents.filter(item => item.status === "quarantined").length, 50);
const secondBacklogRun = await reconcileNebulaR2UploadCleanup({
  db: backlogDb, bucket: backlogBucket, now: () => now, limit: 50
});
assert.ok(backlogBucket.deleted.includes("owners/" + ownerB + "/private-files/" + fairId),
  "Quarantined malformed rows must not starve later valid cleanup intents.");
assert.ok(backlogDb.intents.some(item => item.object_id === fairId) === false);

bucket.fail.clear();
const retried = await reconcileNebulaR2UploadCleanup({ db, bucket, now: () => now });
assert.deepEqual(retried.outcomes.map(item => item.action), ["orphan-removed"]);
assert.ok(!db.intents.some(item => item.object_id === failedId));

await assert.rejects(
  reconcileNebulaR2UploadCleanup({ db, bucket, now: () => now, staleAfterMs: 1000 }),
  /at least one hour/
);
await assert.rejects(
  reconcileNebulaR2UploadCleanup({ db, bucket, now: () => now, limit: 51 }),
  /between 1 and 50/
);

console.log("NEBULA scheduled R2 cleanup reconciliation tests passed.");
