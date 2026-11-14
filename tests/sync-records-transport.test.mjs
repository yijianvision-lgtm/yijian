import assert from "node:assert/strict";
import { createNebulaRecordsTransport } from "../nebula-sync-records-transport.js";

const requests = [];
const send = createNebulaRecordsTransport({
  baseUrl: "https://nebula-test.example/",
  fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 3) return new Response(JSON.stringify({
      remoteVersion: "v2", remotePayload: { title: "Cloud version" }
    }), { status: 409, headers: { "Content-Type": "application/json" } });
    return requests.length === 2
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
});

await send({ token: "signed-token", operation: {
  kind: "upsert", category: "graph", recordId: "node-1", payload: { title: "New" }, baseVersion: null
} });
assert.equal(requests[0].url, "https://nebula-test.example/sync/records?type=graph");
assert.equal(requests[0].init.method, "POST");
assert.equal(requests[0].init.headers.Authorization, "Bearer signed-token");
assert.deepEqual(JSON.parse(requests[0].init.body), {
  recordType: "graph", recordId: "node-1", payload: { title: "New" }, baseVersion: null
});

await send({ token: "signed-token", operation: {
  kind: "delete", category: "graph", recordId: "node-1"
} });
assert.equal(requests[1].url, "https://nebula-test.example/sync/records?type=graph&id=node-1");
assert.equal(requests[1].init.method, "DELETE");

const conflict = await send({ token: "signed-token", operation: {
  kind: "upsert", category: "graph", recordId: "node-1", payload: { title: "Stale" }, baseVersion: "v1"
} });
assert.equal(conflict.status, 409);
assert.equal(conflict.remoteVersion, "v2");
assert.deepEqual(conflict.remotePayload, { title: "Cloud version" });

assert.throws(() => createNebulaRecordsTransport({ baseUrl: "http://insecure.example" }), /HTTPS/);
await assert.rejects(send({ token: "", operation: { kind: "delete", category: "graph", recordId: "node-1" } }), /access token/);
await assert.rejects(send({ token: "x", operation: { kind: "upsert", category: "../other", recordId: "x", payload: {} } }), /category/);
console.log("NEBULA Worker records transport tests passed.");
