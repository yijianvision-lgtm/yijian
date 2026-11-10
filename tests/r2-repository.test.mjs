import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNebulaR2Repository } from "../nebula-r2-repository.js";

const ownerA = "own_" + "a".repeat(64);
const ownerB = "own_" + "b".repeat(64);
const fixedId = "123e4567-e89b-12d3-a456-426614174000";
class FakeD1 {
  calls = [];
  row = null;
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
            object_id: values[1], category: values[2], object_key: values[3],
            content_type: values[4], size_bytes: values[5], status: "active", created_at: values[6]
          };
          return { meta: { changes: 1 } };
        }
      };
    }};
  }
}
class FakeR2 {
  objects = new Map();
  async put(key, body, options) { this.objects.set(key, { body, options }); }
  async get(key) { const value = this.objects.get(key); return value ? { body: value.body } : null; }
  async delete(key) { this.objects.delete(key); }
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

const migration = await readFile(new URL("../migrations/0003_owner_scoped_objects.sql", import.meta.url), "utf8");
assert.match(migration, /PRIMARY KEY \(owner_id, category, object_id\)/);
assert.match(migration, /object_key LIKE 'owners\/' \|\| owner_id/);
assert.match(migration, /status IN \('active', 'deleting'\)/);

console.log("NEBULA owner-scoped R2 repository contract tests passed.");
