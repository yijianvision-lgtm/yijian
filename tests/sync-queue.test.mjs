import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const moduleSource = await readFile(new URL("../nebula-sync-queue.js", import.meta.url), "utf8");
const { createNebulaSyncQueue } = await import("data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64"));

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
assert.equal((await queue.list())[0].status, "pending");
assert.equal((await queue.list())[0].lastError, "category-consent-required");
consent = true;
await queue.drain();
assert.equal(calls.length, 1);
assert.equal(calls[0].token, "test-token");
assert.equal(calls[0].idempotencyKey, "up-1");
assert.equal((await queue.list()).length, 0);

const appliedRemote = [];
let conflictQueue = createNebulaSyncQueue({
  store, auth, clock: () => now,
  send: async () => ({ status: 409, remoteVersion: "v2", remotePayload: { title: "Cloud" } }),
  applyRemote: async update => { appliedRemote.push(update); }
});
await conflictQueue.enqueue({ id: "conflict-1", category: "graph", recordId: "root", kind: "upsert", payload: { title: "Local v3" }, baseVersion: "v1" });
await conflictQueue.drain();
let conflict = (await conflictQueue.list())[0];
assert.equal(conflict.status, "conflict");
assert.equal(conflict.conflict.remoteVersion, "v2");
assert.equal(await conflictQueue.resolveConflict("conflict-1", "keep-cloud").then(x => x.action), "kept-cloud");
assert.deepEqual(appliedRemote[0], { category: "graph", recordId: "root", payload: { title: "Cloud" }, version: "v2", deleted: false },
  "Choosing the cloud version must apply it to local storage before removing the conflict.");
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
const remainingAfterDelete = await deleteQueue.list();
assert.equal(remainingAfterDelete.some(item => item.id === "delete-1"), false,
  "Explicit owner deletion must remain possible after consent revocation.");
assert.equal(remainingAfterDelete.some(item => item.id === "conflict-2"), true,
  "Unresolved local upserts must remain queued while category consent is revoked.");

session = false;
await deleteQueue.enqueue({ id: "delete-2", category: "graph", recordId: "root-2", kind: "delete" });
assert.equal((await deleteQueue.drain()).blocked, "sign-in-required");
assert.deepEqual((await deleteQueue.list()).map(item => item.id).sort(), ["conflict-2", "delete-2"]);

// A process restart must recover a persisted in-flight marker.
await store.put({ id: "interrupted-1", category: "graph", recordId: "recovered", kind: "upsert",
  payload: { title: "Recovered" }, baseVersion: null, status: "syncing", attempts: 0,
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  nextAttemptAt: 0, lastError: null, conflict: null });
session = true;
consent = true;
const recoveryQueue = createNebulaSyncQueue({ store, auth, clock: () => now,
  send: async () => ({ status: 200 }) });
await recoveryQueue.drain();
assert.equal((await recoveryQueue.list()).some(item => item.id === "interrupted-1"), false,
  "An operation interrupted while syncing must be retried after restart.");

assert.throws(() => createNebulaSyncQueue({ store, auth, send: null }), /transport/);
console.log("NEBULA local-first sync outbox tests passed.");
