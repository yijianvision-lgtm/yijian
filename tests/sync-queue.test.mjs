import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const moduleSource = await readFile(new URL("../nebula-sync-queue.js", import.meta.url), "utf8");
const { createNebulaSyncQueue } = await import("data:text/javascript;base64," + Buffer.from(moduleSource).toString("base64"));

const rows = new Map();
const store = {
  async list() { return [...rows.values()].map(x => structuredClone(x)); },
  async put(item) { rows.set(item.id, structuredClone(item)); },
  async putMany(items) {
    const ids = items.map(item => item.id);
    if (ids.some(id => rows.has(id)) || new Set(ids).size !== ids.length) throw new Error("atomic batch duplicate");
    const staged = items.map(item => [item.id, structuredClone(item)]);
    for (const [id, item] of staged) rows.set(id, item);
  },
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

// A grouped graph deletion is persisted atomically and keeps edge-before-node order.
const batchQueue = createNebulaSyncQueue({ store, auth, clock: () => now,
  send: async () => ({ status: 200 }) });
const deleteGroup = [
  { category: "graph", recordId: "graph-link:QQ:Qg", kind: "delete" },
  { category: "graph", recordId: "graph-link:QQ:Qw", kind: "delete" },
  { category: "graph", recordId: "graph-node:QQ", kind: "delete" }
];
const batch = await batchQueue.enqueueMany(deleteGroup, { groupId: "node-delete-A" });
assert.deepEqual(batch.map(item => item.groupIndex), [0, 1, 2]);
assert.ok(batch.every(item => item.operationGroupId === "node-delete-A" && item.groupSize === 3));
assert.equal(calls.length, 1, "Batch enqueue must not upload.");
const replay = await batchQueue.enqueueMany(deleteGroup, { groupId: "node-delete-A" });
assert.deepEqual(replay.map(item => item.id), batch.map(item => item.id),
  "Replaying the same group ID and contents must return the original operation IDs.");
await assert.rejects(batchQueue.enqueueMany([
  ...deleteGroup.slice(0, 2),
  { category: "graph", recordId: "graph-node:DIFFERENT", kind: "delete" }
], { groupId: "node-delete-A" }), /reused with different contents/);

const failedRows = new Map();
const failingAtomicStore = {
  async list() { return [...failedRows.values()]; },
  async put(item) { failedRows.set(item.id, item); },
  async putMany(items) {
    // Simulate a transaction abort: no staged item becomes visible.
    throw new Error("simulated-transaction-abort");
  },
  async remove(id) { failedRows.delete(id); }
};
const failingBatchQueue = createNebulaSyncQueue({ store: failingAtomicStore, auth,
  send: async () => ({ status: 200 }) });
await assert.rejects(failingBatchQueue.enqueueMany(deleteGroup, { groupId: "abort-group" }),
  /simulated-transaction-abort/);
assert.equal(failedRows.size, 0, "A failed atomic batch must leave no partial outbox rows.");

// A failed/conflicted edge tombstone must hold the remaining operations in
// its group; the node tombstone cannot overtake a failed relationship delete.
const orderedRows = new Map();
const orderedStore = {
  async list() { return [...orderedRows.values()].map(item => structuredClone(item)); },
  async put(item) { orderedRows.set(item.id, structuredClone(item)); },
  async putMany(items) {
    for (const item of items) orderedRows.set(item.id, structuredClone(item));
  },
  async remove(id) { orderedRows.delete(id); }
};
let failFirst = true;
const sentOrder = [];
const orderedQueue = createNebulaSyncQueue({ store: orderedStore, auth, clock: () => now,
  send: async ({ operation }) => {
    sentOrder.push(operation.recordId);
    if (failFirst && operation.recordId === "edge-1") return { status: 503 };
    return { status: 204 };
  }
});
await orderedQueue.enqueueMany([
  { category: "graph", recordId: "edge-1", kind: "delete" },
  { category: "graph", recordId: "edge-2", kind: "delete" },
  { category: "graph", recordId: "node-1", kind: "delete" }
], { groupId: "ordered-delete" });
await orderedQueue.drain();
assert.deepEqual(sentOrder, ["edge-1"],
  "A failed first edge must prevent later edges and the node tombstone from being sent.");
assert.equal((await orderedQueue.list()).length, 3);
now += 100000;
failFirst = false;
sentOrder.length = 0;
await orderedQueue.drain();
assert.deepEqual(sentOrder, ["edge-1", "edge-2", "node-1"],
  "After retry succeeds, the batch must drain in edge-before-node order.");
assert.equal((await orderedQueue.list()).length, 0);

assert.throws(() => createNebulaSyncQueue({ store, auth, send: null }), /transport/);
console.log("NEBULA local-first sync outbox tests passed.");
