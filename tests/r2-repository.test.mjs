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
  prepare(sql) {
    const call = { sql, values: [] };
    this.calls.push(call);
    return { bind: (...values) => {
      call.values = values;
      return {
        first: async () => this.row,
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.startsWith("INSERT")) this.row = {
            owner_id: values[0], object_id: values[1], category: values[2], object_key: values[3],
            content_type: values[4], size_bytes: values[5], status: "active", created_at: values[6]
          };
          else if (sql.startsWith("UPDATE nebula_objects")) {
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
  async put(key, body, options) { this.objects.set(key, { body, options }); }
  async get(key) { const value = this.objects.get(key); return value ? { body: value.body } : null; }
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
const consentRepository = { async requireCategory(category) { consentCalls.push(category); return { status: "enabled" }; } };
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
assert.equal((await repo.getObject("private-files", fixedId)).body.byteLength, 5);
assert.deepEqual(await repo.listObjects("private-files", { limit: 1000 }), []);
assert.ok(consentCalls.length >= 3);
assert.ok(db.calls.every(call => call.values[0] === ownerA), "Every D1 metadata operation must be owner-scoped.");
assert.ok(db.calls.every(call => !call.values.includes(ownerB)), "Client-supplied foreign owner IDs must never be used.");
await assert.rejects(repo.putObject({ category: "private-files", body: new Uint8Array(11) }), /size limit/);
await assert.rejects(repo.putObject({ category: "../other", body: new Uint8Array(1) }), /Invalid object category/);
await assert.rejects(repo.getObject("private-files", "../" + fixedId), /Invalid object ID/);
assert.throws(() => createNebulaR2Repository({ bucket, db, authContext: { kind: "shared-service" }, consentRepository }), /verified user identity/);
assert.throws(() => createNebulaR2Repository({ bucket, db, authContext: { kind: "user", ownerId: ownerA } }), /server-side sync consent/);

// R2 deletion failure leaves D1 metadata in "deleting" state; retry must
// resume cleanup instead of losing the object reference.
bucket.failDeletes = 1;
await assert.rejects(repo.deleteObject("private-files", fixedId), /simulated R2 delete failure/);
assert.equal(db.row.status, "deleting");
assert.ok(bucket.objects.has(expectedKey));
assert.deepEqual(await repo.deleteObject("private-files", fixedId), { deleted: true });
assert.equal(db.row, null);
assert.equal(bucket.objects.has(expectedKey), false);

// If R2 deletion succeeds but D1 metadata deletion fails, the retained
// "deleting" row makes the next idempotent retry safe.
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
assert.equal(bucket.objects.has(secondKey), false);
assert.deepEqual(await retryRepo.deleteObject("private-files", second.objectId), { deleted: true });
assert.equal(db.row, null);

const migration = await readFile(new URL("../migrations/0003_owner_scoped_objects.sql", import.meta.url), "utf8");
assert.match(migration, /PRIMARY KEY \(owner_id, category, object_id\)/);
assert.match(migration, /object_key LIKE 'owners\/' \|\| owner_id/);
assert.match(migration, /status IN \('active', 'deleting'\)/);

console.log("NEBULA owner-scoped R2 repository contract tests passed.");
