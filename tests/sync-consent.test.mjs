import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNebulaSyncConsentRepository } from "../nebula-sync-consent.js";

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
        run: async () => {
          this.row = {
            categories_json: values[1], status: values[2], confirmed_at: values[3],
            updated_at: values[4], revoked_at: values[5]
          };
          return { meta: { changes: 1 } };
        }
      };
    }};
  }
}

const ownerA = "own_" + "a".repeat(64);
const ownerB = "own_" + "b".repeat(64);
let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 10, 0, 0, tick++)).toISOString();
const db = new FakeD1();
const repo = createNebulaSyncConsentRepository({ db, authContext: { kind: "user", ownerId: ownerA }, now });

assert.equal(await repo.getConsent(), null);
const enabled = await repo.setConsent({ status: "enabled", categories: ["graph", "sources"] });
assert.equal(enabled.enabled, true);
assert.deepEqual(enabled.categories, ["graph", "sources"]);
assert.equal((await repo.requireCategory("graph")).status, "enabled");
await assert.rejects(repo.requireCategory("private-files"), /Active server-side cloud-sync consent/);

const paused = await repo.setConsent({ status: "paused", categories: ["graph", "sources"] });
assert.equal(paused.enabled, false);
await assert.rejects(repo.requireCategory("graph"), /Active server-side cloud-sync consent/);

const revoked = await repo.setConsent({ status: "revoked", categories: ["graph"] });
assert.equal(revoked.status, "revoked");
assert.ok(revoked.revokedAt);
await assert.rejects(repo.requireCategory("graph"), /Active server-side cloud-sync consent/);

for (const call of db.calls) assert.equal(call.values[0], ownerA, "Consent queries must use the server-derived owner.");
assert.ok(db.calls.every(call => /nebula_sync_consents/.test(call.sql)));
assert.throws(() => createNebulaSyncConsentRepository({ db, authContext: { kind: "shared-service" } }), /verified user identity/);
assert.throws(() => createNebulaSyncConsentRepository({ db, authContext: { kind: "user", ownerId: ownerB + "x" } }), /verified user identity/);
await assert.rejects(repo.setConsent({ status: "enabled", categories: [] }), /between 1 and 32/);
await assert.rejects(repo.setConsent({ status: "enabled", categories: ["graph", "graph"] }), /unique valid/);
await assert.rejects(repo.setConsent({ status: "anything", categories: ["graph"] }), /Invalid sync consent status/);
await assert.rejects(repo.setConsent({ status: "enabled", categories: ["graph"], confirmedAt: "not-a-date" }), /confirmation timestamp/);

const migration = await readFile(new URL("../migrations/0002_sync_consent_ledger.sql", import.meta.url), "utf8");
assert.match(migration, /PRIMARY KEY NOT NULL/);
assert.match(migration, /status IN \('enabled', 'paused', 'revoked'\)/);
assert.match(migration, /json_type\(categories_json\) = 'array'/);
assert.match(migration, /revoked_at TEXT/);

console.log("NEBULA server-side sync consent ledger tests passed.");
