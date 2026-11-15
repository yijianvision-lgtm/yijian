import assert from "node:assert/strict";
import { createNebulaLocalRecordApplier } from "../nebula-local-record-applier.js";
import {
  buildNebulaGraphNodeDeleteOperations, buildNebulaGraphLinkDeleteOperation,
  createNebulaGraphNodeRecordId, createNebulaGraphLinkRecordId, parseNebulaGraphRecordId
} from "../nebula-graph-sync.js";

let graph = { nodes: [{ id: "n1", title: "Root" }, { id: "n2", title: "Child" }, { id: "n3", title: "Other" }],
  links: [["n1", "n2"], ["n2", "n3"]] };
const writes = [];
const local = {
  async loadGraph() { return structuredClone(graph); },
  async saveGraph(nodes, links) { graph = { nodes, links }; writes.push(structuredClone(graph)); }
};
const applyRemote = createNebulaLocalRecordApplier({ local });
const fullGraph = { nodes: [{ id: "n1", title: "Root" }], links: [] };
assert.deepEqual(await applyRemote({ category: "graph", recordId: "main", payload: fullGraph, deleted: false }),
  { applied: true, deleted: false });
assert.deepEqual(graph, fullGraph);

graph = { nodes: [{ id: "n1", title: "Root" }, { id: "n2", title: "Child" }, { id: "n3", title: "Other" }],
  links: [["n1", "n2"], ["n2", "n3"]] };
const nodeId = createNebulaGraphNodeRecordId("n2");
assert.deepEqual(parseNebulaGraphRecordId(nodeId), { kind: "node", nodeId: "n2" });
const nodeOps = buildNebulaGraphNodeDeleteOperations(graph, "n2");
assert.equal(nodeOps.length, 3, "Deleting one node queues tombstones for both incident links and the node.");
for (const op of nodeOps) assert.equal(op.category, "graph");
const nodeResult = await applyRemote({ category: "graph", recordId: nodeId, payload: null, deleted: true });
assert.equal(nodeResult.element, "node");
assert.equal(nodeResult.removedLinks, 2);
assert.deepEqual(graph, { nodes: [{ id: "n1", title: "Root" }, { id: "n3", title: "Other" }], links: [] });

graph = { nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }], links: [["n1", "n2"], ["n2", "n3"]] };
const linkId = createNebulaGraphLinkRecordId("n1", "n2");
assert.deepEqual(parseNebulaGraphRecordId(linkId), { kind: "link", sourceId: "n1", targetId: "n2" });
assert.deepEqual(buildNebulaGraphLinkDeleteOperation("n1", "n2"),
  { category: "graph", recordId: linkId, kind: "delete" });
const linkResult = await applyRemote({ category: "graph", recordId: linkId, payload: null, deleted: true });
assert.equal(linkResult.element, "link");
assert.deepEqual(graph.links, [["n2", "n3"]]);

graph = { nodes: [{ id: "n1" }], links: [] };
await applyRemote({ category: "graph", recordId: createNebulaGraphNodeRecordId("n1"), payload: { id: "n1", title: "Updated" }, deleted: false });
assert.equal(graph.nodes[0].title, "Updated");
await assert.rejects(applyRemote({ category: "graph", recordId: createNebulaGraphNodeRecordId("n1"), payload: { id: "other" }, deleted: false }), /stable record ID/);
await assert.rejects(applyRemote({ category: "graph", recordId: "unknown", payload: { nodes: [] } }), /local graph schema/);
await assert.rejects(applyRemote({ category: "private-files", payload: {} }), /No reviewed local mapping/);
await assert.rejects(buildNebulaGraphNodeDeleteOperations({ nodes: [{ id: "n1" }], links: [["n1"]] }, "n1"), /endpoints/);
assert.equal(writes.length, 4);
console.log("NEBULA granular graph sync tombstone tests passed.");
