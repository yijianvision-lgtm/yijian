import assert from "node:assert/strict";
import { createNebulaSyncQueue } from "../nebula-sync-queue.js";

const rows = new Map();
const store = {
  async list() { return [...rows.values()].map(x => structuredClone(x)); },
  async put(item) { rows.set(item.id, structuredClone(item)); },
  async remove(id) { rows.delete(id); }
};
let consent = true, session = true, token = "test-token", calls = [];
let now = 1000;
const auth = {
  async getSession() { return session ? { subject: "user-a" } : null; },
  async getAccessToken() { return token; },
  async canSyncCategory(category) { return consent && category === "graph"; }
};
const queue = createNebulaSyncQueue({
  store, auth, clock: () => now,
  send: async request => { calls.push(request); return { status: 200 }; }
});

const queued = await queue.enqueue({ id: "up-1", category: "graph", recordId: "root", kind: "upsert", payload: { title: "Local" } });
assert.equal(queued.status, "pending");
assert.equal(calls.length, 0, "Enqueue must never upload automatically.");
consent = false;
await queue.drain();
assert.equal(calls.length, 0, "Upserts must not upload without category consent.");
assert.equal((await queue.list())[0].status, "blocked");
consent = true;
const blocked = (await queue.list())[0];
blocked.status = "pending";
await store.put(blocked);
await queue.drain();
assert.equal(calls.length, 1);
assert.equal(calls[0].token, "test-token");
assert.equal(calls[0].idempotencyKey, "up-1");
assert.equal((await queue.list()).length, 0);

let conflictQueue = createNebulaSyncQueue({
  store, auth, clock: () => now,
  send: async () => ({ status: 409, remoteVersion: "v2", remotePayload: { title: "Cloud" } })
});
await conflictQueue.enqueue({ id: "conflict-1", category: "graph", recordId: "root", kind: "upsert", payload: { title: "Local v3" }, baseVersion: "v1" });
await conflictQueue.drain();
let conflict = (await conflictQueue.list())[0];
assert.equal(conflict.status, "conflict");
assert.equal(conflict.conflict.remoteVersion, "v2");
assert.equal(await conflictQueue.resolveConflict("conflict-1", "keep-cloud").then(x => x.action), "kept-cloud");
assert.equal((await conflictQueue.list()).length, 0);

await conflictQueue.enqueue({ id: "conflict-2", category: "graph", recordId: "root", kind: "upsert", payload: { title: "Local v4" }, baseVersion: "v1" });
await conflictQueue.drain();
await conflictQueue.resolveConflict("conflict-2", "keep-local");
conflict = (await conflictQueue.list())[0];
assert.equal(conflict.status, "pending");
assert.equal(conflict.baseVersion, "v2");

consent = false;
const deleteQueue = createNebulaSyncQueue({ store, auth, clock: () => now, send: async () => ({ status: 204 }) });
await deleteQueue.enqueue({ id: "delete-1", category: "graph", recordId: "root", kind: "delete" });
await deleteQueue.drain();
assert.equal((await deleteQueue.list()).length, 0, "Explicit owner deletion must remain possible after consent revocation.");

session = false;
await deleteQueue.enqueue({ id: "delete-2", category: "graph", recordId: "root-2", kind: "delete" });
assert.equal((await deleteQueue.drain()).blocked, "sign-in-required");
assert.equal((await deleteQueue.list()).length, 1);

assert.throws(() => createNebulaSyncQueue({ store, auth, send: null }), /transport/);
console.log("NEBULA local-first sync outbox tests passed.");
