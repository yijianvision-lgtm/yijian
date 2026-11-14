import assert from "node:assert/strict";
import { createNebulaSyncRuntime } from "../nebula-sync-runtime.js";

const rows = new Map();
const appliedGraphs = [];
let localGraph = { nodes: [{ id: "local-1", name: "Local graph" }], links: [] };
const local = {
  async saveGraph(nodes, links) { localGraph = { nodes, links }; appliedGraphs.push({ nodes, links }); },
  async loadGraph() { return structuredClone(localGraph); },
  getSyncOutboxStore() {
    return {
      async list() { return [...rows.values()].map(value => structuredClone(value)); },
      async put(item) { rows.set(item.id, structuredClone(item)); },
      async remove(id) { rows.delete(id); }
    };
  }
};
let session = null;
let consent = null;
const requests = [];
const provider = {
  async getSession() { return session; },
  async getAccessToken() { return session ? "synthetic-session-token" : null; },
  async signIn() { session = { issuer: "https://issuer.example", subject: "user-a" }; },
  async signOut() { session = null; }
};
const fetchImpl = async (url, init = {}) => {
  requests.push({ url: String(url), init });
  if (String(url).endsWith("/sync/consent") && init.method === "GET") {
    return new Response(JSON.stringify({ consent }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).endsWith("/sync/consent") && init.method === "POST") {
    const body = JSON.parse(init.body);
    consent = body.status === "enabled"
      ? { status: "enabled", categories: body.categories, confirmedAt: "2026-11-15T00:00:00.000Z" }
      : { status: body.status, categories: consent?.categories ?? [], confirmedAt: consent?.confirmedAt ?? null };
    return new Response(JSON.stringify({ consent }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).includes("/sync/records") && init.method === "POST") {
    return new Response(JSON.stringify({ ok: true, conflict: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (String(url).includes("/sync/records") && init.method === "GET") {
    return new Response(JSON.stringify({ records: [{
      recordType: "graph", recordId: isDeleted ? "tombstone-preview" : "cloud-1",
      payload: isDeleted ? null : { nodes: [{ id: "cloud-1", name: "Cloud graph" }], links: [] },
      deleted: isDeleted,
      createdAt: "2026-11-14T00:00:00.000Z", updatedAt: isDeleted ? "2026-11-15T00:00:01.000Z" : "2026-11-15T00:00:00.000Z"
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error("Unexpected test request: " + url);
};

const runtime = createNebulaSyncRuntime({
  local, provider, workerBaseUrl: "https://nebula-worker.example", fetchImpl
});
assert.equal(requests.length, 0, "Runtime construction must not make network requests.");
await runtime.signIn();
assert.deepEqual(await runtime.getConsent(), { enabled: false, categories: [] },
  "Authentication must not imply cloud-sync consent.");
await runtime.enqueueRecord({ category: "graph", recordId: "root-1", payload: { title: "Synthetic local graph" } });
assert.equal(requests.filter(x => String(x.url).includes("/sync/records")).length, 0,
  "Enqueue must remain local and never upload by itself.");
await assert.doesNotReject(runtime.enableCloudSync({ categories: ["graph"], confirmed: true }));
assert.equal(consent.status, "enabled");
assert.equal(requests.filter(x => String(x.url).includes("/sync/records")).length, 0,
  "Granting consent alone must not drain the queue.");
const statusBeforeDrain = await runtime.getStatus();
assert.equal(statusBeforeDrain.pendingCount, 1);
assert.equal(statusBeforeDrain.syncEnabled, true);
const drained = await runtime.drain();
assert.equal(drained.sent, 1);
assert.equal((await runtime.listPending()).length, 0);
assert.equal(requests.filter(x => String(x.url).includes("/sync/records")).length, 1);
const preview = await runtime.previewCloudRecords({ category: "graph", limit: 10 });
assert.equal(preview.records.length, 1);
assert.equal(appliedGraphs.length, 0, "Preview must never mutate local graph data.");
await assert.rejects(runtime.applyCloudRecord({ preview, recordId: "cloud-1" }), /confirmation/);
assert.equal(appliedGraphs.length, 0, "Unconfirmed apply must not mutate local graph data.");
localGraph = { nodes: [{ id: "local-2", name: "Changed locally after preview" }], links: [] };
await assert.rejects(runtime.applyCloudRecord({ preview, recordId: "cloud-1", confirmed: true }), /local graph changed/);
assert.equal(appliedGraphs.length, 0, "A stale preview must not overwrite a newer local graph.");
const freshPreview = await runtime.previewCloudRecords({ category: "graph", limit: 10 });
const applied = await runtime.applyCloudRecord({ preview: freshPreview, recordId: "cloud-1", confirmed: true });
assert.equal(applied.applied, true);
assert.equal(appliedGraphs.length, 1);
assert.equal(appliedGraphs[0].nodes[0].name, "Cloud graph");
const deletedPreview = await runtime.previewCloudRecords({ category: "graph", limit: 10 });
const tombstone = { ...deletedPreview, records: [{ recordType: "graph", recordId: "tombstone-preview", payload: null, deleted: true, createdAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-15T00:00:01.000Z" }] };
const deletedApply = await runtime.applyCloudRecord({ preview: tombstone, recordId: "tombstone-preview", confirmed: true });
assert.equal(deletedApply.deleted, true);
assert.deepEqual(localGraph, { nodes: [], links: [] }, "A confirmed remote tombstone must clear the local graph.");
await runtime.disableCloudSync();
assert.equal(consent.status, "revoked");
assert.equal((await runtime.getStatus()).syncEnabled, false);
await runtime.signOut();
assert.equal((await runtime.getStatus()).signedIn, false);
console.log("NEBULA explicit sync runtime composition tests passed.");
