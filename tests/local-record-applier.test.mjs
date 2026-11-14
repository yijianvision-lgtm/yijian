import assert from "node:assert/strict";
import { createNebulaLocalRecordApplier } from "../nebula-local-record-applier.js";

const writes = [];
const local = { async saveGraph(nodes, links) { writes.push({ nodes, links }); } };
const applyRemote = createNebulaLocalRecordApplier({ local });
const graph = { nodes: [{ id: "n1", title: "Root" }], links: [{ source: "n1", target: "n2" }] };
assert.deepEqual(await applyRemote({ category: "graph", payload: graph, deleted: false }),
  { applied: true, deleted: false });
assert.deepEqual(writes[0], graph);
assert.deepEqual(await applyRemote({ category: "graph", payload: null, deleted: true }),
  { applied: true, deleted: true });
assert.deepEqual(writes[1], { nodes: [], links: [] });
await assert.rejects(applyRemote({ category: "private-files", payload: {} }), /No reviewed local mapping/);
await assert.rejects(applyRemote({ category: "graph", payload: { nodes: [] } }), /local graph schema/);
console.log("NEBULA local graph conflict applier tests passed.");
