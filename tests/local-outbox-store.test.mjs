import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "fake-indexeddb/auto";

globalThis.window = { dispatchEvent() {} };
await import("../nebula-local.js?env=source");
const firstStore = globalThis.NEBULA_LOCAL.getSyncOutboxStore();
const item = { id: "durable-1", category: "graph", recordId: "root", kind: "upsert",
  payload: { title: "private local note" }, status: "pending", attempts: 0 };
await firstStore.put(item);
assert.deepEqual(await firstStore.list(), [item], "Outbox item must persist in IndexedDB.");

const grouped = [
  { id: "atomic-group:0", category: "graph", recordId: "edge-1", kind: "delete", operationGroupId: "atomic-group", groupIndex: 0, groupSize: 2 },
  { id: "atomic-group:1", category: "graph", recordId: "node-1", kind: "delete", operationGroupId: "atomic-group", groupIndex: 1, groupSize: 2 }
];
await firstStore.putMany(grouped);
assert.deepEqual((await firstStore.list()).filter(row => row.operationGroupId === "atomic-group"), grouped,
  "A batch must be committed and persisted through the IndexedDB adapter.");

await assert.rejects(firstStore.putMany([
  { id: "must-rollback", category: "graph", recordId: "edge-2", kind: "delete" },
  { ...grouped[0] }
]), /Outbox batch transaction failed/i, "A duplicate key must abort the entire IndexedDB transaction.");
assert.equal((await firstStore.list()).some(row => row.id === "must-rollback"), false,
  "A failed IndexedDB batch must not leave its earlier requests committed.");
assert.equal((await firstStore.list()).some(row => row.id === "atomic-group:0"), true,
  "An existing outbox row must survive a failed batch transaction.");
await firstStore.remove("atomic-group:0");
await firstStore.remove("atomic-group:1");
await import("../nebula-local.js?env=source&reload=1");
const reopenedStore = globalThis.NEBULA_LOCAL.getSyncOutboxStore();
assert.deepEqual(await reopenedStore.list(), [item], "Outbox must survive module restart/reopen.");
await reopenedStore.remove("durable-1");
assert.deepEqual(await reopenedStore.list(), [], "Outbox deletion must persist.");
console.log("NEBULA IndexedDB sync outbox persistence tests passed.");
