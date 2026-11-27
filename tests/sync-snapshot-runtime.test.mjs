import assert from "node:assert/strict";
import { createNebulaSyncRuntime } from "../nebula-sync-runtime.js";
import { createNebulaGraphNodeRecordId } from "../nebula-graph-sync.js";

const canonical = value => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
};
const checksum = async value => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
};
const records = Array.from({ length: 51 }, (_, i) => ({
  recordType: "graph", recordId: createNebulaGraphNodeRecordId("node-" + i),
  payload: { id: "node-" + i, title: "Node " + i }, deleted: false,
  createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:01.000Z"
})).sort((a,b) => a.recordId.localeCompare(b.recordId));
const manifest = {
  recordCount: records.length, pageSize: 50, pageCount: 2,
  recordsChecksum: await checksum(records), checksumAlgorithm: "sha-256-canonical-json-v1"
};
let failSecondPage = false, failCommit = false, failComplete = false;
let completeCalls = 0, commitCalls = 0;
const requests = [];
let localGraph = { nodes: [{ id: "old-graph" }], links: [] };
let session = null, consent = null;
const metadata = new Map(), staged = new Map();
const local = {
  async saveGraph(nodes, links) { localGraph = { nodes, links }; },
  async loadGraph() { return structuredClone(localGraph); },
  async loadMeta(key) { return metadata.get(key); },
  async saveMeta(key, value) { metadata.set(key, structuredClone(value)); },
  getSyncOutboxStore() {
    return { async list(){return[];}, async put(){}, async putMany(){}, async remove(){} };
  },
  async getGraphSnapshotChecksum(nodes, links) { return checksum({ nodes, links }); },
  async beginGraphSnapshot({ snapshotId, expectedChunks, expectedChecksum }) {
    staged.set(snapshotId, { expectedChunks, expectedChecksum, chunks: [] });
  },
  async stageGraphSnapshotChunk({ snapshotId, index, nodes, links }) {
    const item = staged.get(snapshotId);
    assert.equal(index, item.chunks.length);
    item.chunks.push({ nodes, links });
  },
  async commitGraphSnapshot({ snapshotId }) {
    commitCalls++;
    if (failCommit) throw new Error("synthetic local commit failure");
    const item = staged.get(snapshotId);
    const nodes = item.chunks.flatMap(x => x.nodes), links = item.chunks.flatMap(x => x.links);
    assert.equal(await checksum({ nodes, links }), item.expectedChecksum);
    localGraph = { nodes, links };
    staged.delete(snapshotId);
    return { committed: true, snapshotId, nodeCount: nodes.length, linkCount: links.length };
  },
  async abortGraphSnapshot(snapshotId) { staged.delete(snapshotId); return { aborted: true }; }
};
const deviceId = "123e4567-e89b-42d3-a456-426614174104";
const fetchImpl = async (url, init = {}) => {
  const u = new URL(String(url));
  requests.push({ path: u.pathname, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
  if (u.pathname === "/sync/consent" && (init.method || "GET") === "GET") {
    return new Response(JSON.stringify({ consent }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/sync/consent" && init.method === "POST") {
    const body = JSON.parse(init.body);
    consent = body.status === "enabled" ? { status: "enabled", categories: body.categories } : { status: body.status, categories: [] };
    return new Response(JSON.stringify({ consent }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/sync/devices" && init.method === "POST") {
    return new Response(JSON.stringify({ device: { deviceId, status: "active" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/sync/snapshots" && init.method === "POST") {
    return new Response(JSON.stringify({ snapshot: {
      snapshotId: deviceId, deviceId, recordType: "graph", snapshotSequence: 17, status: "active",
      manifest
    } }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/sync/snapshots/" + deviceId && init.method !== "POST") {
    const after = u.searchParams.get("after") || "";
    if (failSecondPage && after) return new Response(JSON.stringify({ error: "interrupted" }), { status: 503, headers: { "Content-Type": "application/json" } });
    const pageRecords = after ? records.slice(50) : records.slice(0, 50);
    const nextCursor = pageRecords.length ? pageRecords[pageRecords.length - 1].recordId : after || null;
    const hasMore = !after;
    return new Response(JSON.stringify({
      snapshotId: deviceId, recordType: "graph", snapshotSequence: 17,
      records: pageRecords, nextCursor, hasMore, complete: !hasMore
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/sync/snapshots/" + deviceId + "/complete" && init.method === "POST") {
    completeCalls++;
    if (failComplete) return new Response(JSON.stringify({ error: "temporary" }), { status: 503, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ snapshotId: deviceId, completed: true, snapshotSequence: 17 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.pathname === "/sync/changes") {
    return new Response(JSON.stringify({ changes: [], nextCursor: Number(u.searchParams.get("after")) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error("Unexpected request " + u.pathname);
};
const provider = {
  async getSession(){ return session; },
  async getAccessToken(){ return session ? "verified-token" : null; },
  async signIn(){ session = { issuer: "https://issuer.example", subject: "user-1" }; },
  async signOut(){ session = null; }
};
const runtime = createNebulaSyncRuntime({ local, provider, workerBaseUrl: "https://worker.example", fetchImpl });
await runtime.signIn();
await runtime.enableCloudSync({ categories: ["graph"], confirmed: true });

// Interrupted page delivery must not replace the existing graph or complete the server snapshot.
failSecondPage = true;
await assert.rejects(runtime.bootstrapGraphSnapshot(), /HTTP 503/);
assert.deepEqual(localGraph, { nodes: [{ id: "old-graph" }], links: [] });
assert.equal(completeCalls, 0);
failSecondPage = false;

// Local atomic commit failure must never acknowledge server completion.
failCommit = true;
await assert.rejects(runtime.bootstrapGraphSnapshot(), /synthetic local commit failure/);
assert.deepEqual(localGraph, { nodes: [{ id: "old-graph" }], links: [] });
assert.equal(completeCalls, 0);
failCommit = false;

// Server completion failure leaves a durable retry intent after local commit.
failComplete = true;
const result = await runtime.bootstrapGraphSnapshot();
assert.equal(result.committed, true);
assert.equal(result.serverComplete, false);
assert.equal(result.completionPending, true);
assert.equal(localGraph.nodes.length, 51);
assert.equal(completeCalls, 1);
failComplete = false;
const retried = await runtime.retrySnapshotCompletion();
assert.equal(retried.completed, true);
assert.equal(retried.completed, true);
assert.equal(retried.snapshotSequence, 17);
assert.equal(completeCalls, 2);
assert.equal((await local.loadMeta("nebulaSnapshotCompletionPending")).status, "completed");
assert.ok(commitCalls >= 3);
console.log("NEBULA snapshot runtime integration tests passed.");
