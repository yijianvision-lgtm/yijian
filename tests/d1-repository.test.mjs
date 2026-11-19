import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNebulaD1Repository } from "../nebula-d1-repository.js";

class FakeD1 {
  calls = [];
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
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
const syncConsent = { enabled: true, categories: ["graph"], confirmedAt: "2026-11-10T00:00:00.000Z" };
const db = new FakeD1();
const repoA = createNebulaD1Repository({
  db,
  authContext: { kind: "user", ownerId: ownerA },
  syncConsent
});
assert.equal(await repoA.getRecord("graph", "node-1"), null);
assert.deepEqual(await repoA.listRecords("graph"), []);
assert.deepEqual(await repoA.listRecords("graph", { after: "node-0", limit: 1000 }), []);
assert.equal((await repoA.putRecord("graph", "node-1", { name: "A-owned", owner_id: ownerB })).ok, true);
assert.equal((await repoA.deleteRecord("graph", "node-1")).deleted, true);

await assert.rejects(repoA.getRecord("sources", "source-1"), /does not cover this record category/);
assert.equal(db.calls.length, 9, "A category without explicit consent must not reach D1.");

assert.equal(db.calls.length, 9);
for (const [index, call] of db.calls.entries()) {
  assert.equal(call.values[index === 4 ? 4 : 0], ownerA,
    "Every query must bind the server-derived owner ID; tombstone writes bind its timestamp before owner scope.");
  assert.match(call.sql, /owner_id/);
}
assert.match(db.calls[0].sql, /WHERE owner_id = \?/);
assert.match(db.calls[1].sql, /WHERE owner_id = \?/);
assert.match(db.calls[2].sql, /record_id > \?/);
assert.equal(db.calls[1].values[4], 50, "D1 list pages must have a bounded default size.");
assert.equal(db.calls[2].values[5], 50, "Caller-supplied page sizes must be capped.");
for (const call of db.calls.slice(0, 4)) {
  assert.match(call.sql, /nebula_sync_consents/);
  assert.match(call.sql, /json_each\(c\.categories_json\)/,
    "Every D1 read/write operation must enforce live consent and category membership in the same SQL statement.");
}
assert.deepEqual(db.calls[0].values.slice(-2), [ownerA, "graph"]);
assert.deepEqual(db.calls[3].values.slice(6, 8), [ownerA, "graph"]);
assert.deepEqual(db.calls[6].values.slice(4), [ownerA, "graph", "node-1"]);
assert.doesNotMatch(db.calls[6].sql, /nebula_sync_consents/,
  "Owner-initiated record deletion must remain available after consent revocation.");
await assert.rejects(repoA.putRecord("graph", "oversized", { data: "x".repeat(256 * 1024) }), /exceeds 256 KiB/);
assert.match(db.calls[3].sql, /INSERT INTO nebula_records \(owner_id,/);
assert.match(db.calls[3].sql, /NOT EXISTS \(SELECT 1 FROM nebula_records/);
assert.match(db.calls[3].sql, /ON CONFLICT\(owner_id, record_type, record_id\) DO NOTHING/);
assert.match(db.calls[6].sql, /UPDATE nebula_records SET payload_json = '\{\}'/);
assert.match(db.calls[6].sql, /deleted_at = CASE WHEN updated_at >= \?/);
assert.equal(db.calls[3].values[0], ownerA, "A client-supplied owner_id inside payload must not change the row owner.");

assert.match(db.calls[3].sql, /nebula_sync_consents/);

const casDb = new FakeD1();
const casRepo = createNebulaD1Repository({
  db: casDb, authContext: { kind: "user", ownerId: ownerA }, syncConsent,
  now: () => "2026-11-15T00:00:00.000Z"
});
await casRepo.putRecord("graph", "cas-node", { title: "create" });
assert.match(casDb.calls[0].sql, /NOT EXISTS \(SELECT 1 FROM nebula_records/,
  "First write must be create-only.");
const casUpdateDb = new FakeD1();
const casUpdateRepo = createNebulaD1Repository({
  db: casUpdateDb, authContext: { kind: "user", ownerId: ownerA }, syncConsent,
  now: () => "2026-11-15T00:01:00.000Z"
});
await casUpdateRepo.putRecord("graph", "cas-node", { title: "update" }, {
  expectedUpdatedAt: "2026-11-14T23:59:00.000Z"
});
assert.match(casUpdateDb.calls[0].sql, /^UPDATE nebula_records SET/);
assert.equal(casUpdateDb.calls[0].values[5], "2026-11-14T23:59:00.000Z",
  "Updates must compare the exact version read by the client.");
const sameClockRepo = createNebulaD1Repository({
  db: new FakeD1(), authContext: { kind: "user", ownerId: ownerA }, syncConsent,
  now: () => "2026-11-14T23:59:00.000Z"
});
const monotonic = await sameClockRepo.putRecord("graph", "same-ms", { title: "v2" }, {
  expectedUpdatedAt: "2026-11-14T23:59:00.000Z"
});
assert.ok(Date.parse(monotonic.updatedAt) > Date.parse("2026-11-14T23:59:00.000Z"),
  "A successful update must advance its version even when the wall clock has not advanced.");

const dbB = new FakeD1();
const repoB = createNebulaD1Repository({ db: dbB, authContext: { kind: "user", ownerId: ownerB }, syncConsent });
await repoB.getRecord("graph", "node-1");
assert.equal(dbB.calls[0].values[0], ownerB, "User B must be scoped to B's server-derived owner ID.");

assert.throws(() => createNebulaD1Repository({ db, authContext: { kind: "shared-service" } }), /verified user identity/);
const noConsentRepo = createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: ownerA } });
await assert.rejects(noConsentRepo.getRecord("graph", "node-1"), /Cloud sync is not enabled/);
assert.equal((await noConsentRepo.deleteRecord("graph", "node-1")).deleted, true,
  "Owner-initiated deletion remains available even when no active consent snapshot exists.");
const revokedRepo = createNebulaD1Repository({
  db, authContext: { kind: "user", ownerId: ownerA },
  syncConsent: { enabled: false, status: "revoked", categories: ["graph"], confirmedAt: "2026-11-10T00:00:00.000Z" }
});
await assert.rejects(revokedRepo.listRecords("graph"), /Cloud sync is not enabled/);
assert.equal((await revokedRepo.deleteRecord("graph", "node-1")).deleted, true);
assert.throws(() => createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: ownerB + "x" } }), /verified user identity/);
assert.throws(() => createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: "own_" + "g".repeat(64) } }), /verified user identity/);
await assert.rejects(createNebulaD1Repository({ db, authContext: { kind: "user", ownerId: ownerA }, syncConsent }).putRecord("graph", "node-1", []), /payload must be an object/);
await assert.rejects(repoA.getRecord("bad type", "node-1"), /Invalid record type/);
await assert.rejects(repoA.deleteRecord("graph", "../other-user"), /Invalid record ID/);

const migration = await readFile(new URL("../migrations/0001_owner_scoped_records.sql", import.meta.url), "utf8");
assert.match(migration, /PRIMARY KEY \(owner_id, record_type, record_id\)/);
assert.match(migration, /substr\(owner_id, 1, 4\) = 'own_'/);
assert.match(migration, /json_type\(payload_json\) = 'object'/);
assert.match(migration, /idx_nebula_records_owner_type_updated/);

console.log("NEBULA owner-scoped D1 repository contract tests passed.");
