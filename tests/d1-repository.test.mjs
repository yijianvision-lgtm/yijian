import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNebulaD1Repository } from "../nebula-d1-repository.js";

class FakeD1 {
  calls = [];
  prepare(sql) {
    const call = { sql, values: [] };
    this.calls.push(call);
    return {
      bind: (...values) => {
        call.values = values;
        return {
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } })
        };
      }
    };
  }
}

const ownerA = "own_" + "a".repeat(64);
const ownerB = "own_" + "b".repeat(64);
const db = new FakeD1();
const repoA = createNebulaD1Repository({
  db,
  authContext: { kind: "user", ownerId: ownerA }
});
assert.equal(await repoA.getRecord("graph", "node-1"), null);
assert.deepEqual(await repoA.listRecords("graph"), []);
assert.deepEqual(await repoA.listRecords("graph", { after: "node-0", limit: 1000 }), []);
assert.equal((await repoA.putRecord("graph", "node-1", { name: "A-owned", owner_id: ownerB })).ok, true);
assert.deepEqual(await repoA.deleteRecord("graph", "node-1"), { deleted: true });

assert.equal(db.calls.length, 5);
for (const call of db.calls) {
  assert.equal(call.values[0], ownerA, "Every query must bind the server-derived owner ID as its first parameter.");
  assert.match(call.sql, /owner_id/);
}
assert.match(db.calls[0].sql, /WHERE owner_id = \?/);
assert.match(db.calls[1].sql, /WHERE owner_id = \?/);
assert.match(db.calls[2].sql, /record_id > \?/);
assert.equal(db.calls[1].values[2], 50, "D1 list pages must have a bounded default size.");
assert.equal(db.calls[2].values[3], 50, "Caller-supplied page sizes must be capped.");
await assert.rejects(repoA.putRecord("graph", "oversized", { data: "x".repeat(256 * 1024) }), /exceeds 256 KiB/);
assert.match(db.calls[3].sql, /INSERT INTO nebula_records \(owner_id,/);
assert.match(db.calls[3].sql, /ON CONFLICT\(owner_id, record_type, record_id\)/);
assert.match(db.calls[4].sql, /DELETE FROM nebula_records WHERE owner_id = \?/);
assert.equal(db.calls[3].values[0], ownerA, "A client-supplied owner_id inside payload must not change the row owner.");

const dbB = new FakeD1();
const repoB = createNebulaD1Repository({ db: dbB, authContext: { kind: "user", ownerId: ownerB } });
await repoB.getRecord("graph", "node-1");
assert.equal(dbB.calls[0].values[0], ownerB, "User B must be scoped to B's server-derived owner ID.");

assert.throws(() => createNebulaD1Repository({ db, authContext: { kind: "shared-service" } }), /verified user identity/);
assert.throws(() => createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: ownerB + "x" } }), /verified user identity/);
assert.throws(() => createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: "own_" + "g".repeat(64) } }), /verified user identity/);
await assert.rejects(createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: ownerA } }).putRecord("graph", "node-1", []), /payload must be an object/);
await assert.rejects(repoA.getRecord("bad type", "node-1"), /Invalid record type/);
await assert.rejects(repoA.deleteRecord("graph", "../other-user"), /Invalid record ID/);

const migration = await readFile(new URL("../migrations/0001_owner_scoped_records.sql", import.meta.url), "utf8");
assert.match(migration, /PRIMARY KEY \\(owner_id, record_type, record_id\\)/);
assert.match(migration, /substr\\(owner_id, 1, 4\\) = 'own_'/);
assert.match(migration, /json_type\\(payload_json\\) = 'object'/);
assert.match(migration, /idx_nebula_records_owner_type_updated/);

console.log("NEBULA owner-scoped D1 repository contract tests passed.");
