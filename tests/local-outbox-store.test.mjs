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
await import("../nebula-local.js?env=source&reload=1");
const reopenedStore = globalThis.NEBULA_LOCAL.getSyncOutboxStore();
assert.deepEqual(await reopenedStore.list(), [item], "Outbox must survive module restart/reopen.");
await reopenedStore.remove("durable-1");
assert.deepEqual(await reopenedStore.list(), [], "Outbox deletion must persist.");
console.log("NEBULA IndexedDB sync outbox persistence tests passed.");
