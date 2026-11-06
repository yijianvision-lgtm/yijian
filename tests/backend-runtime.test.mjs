import assert from "node:assert/strict";
import "fake-indexeddb/auto";

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};
globalThis.window = { dispatchEvent() {} };

await import("../nebula-local.js");
const api = globalThis.NEBULA_LOCAL;
assert.ok(api, "NEBULA_LOCAL should be exposed after module load.");

await api.saveGraph([{ id: "base", name: "Base knowledge", desc: "Initial definition" }], []);
const conversation = await api.saveConversation({
  title: "Backup fixture",
  transcript: "A local-only conversation fixture.",
  blob: new Blob(["original attachment"], { type: "text/plain" })
});
await api.saveLearningRecord({ nodeId: "base", activityType: "recall", score: 1 });
await api.saveResearchSession({ title: "Research fixture", query: "knowledge graph" });

const backup = await api.exportFullBackup();
assert.ok(backup.blob.size > 0);
const preview = await api.previewFullBackup(backup.blob);
assert.equal(preview.valid, true);
assert.ok(preview.manifest.aiConversations >= 1);
assert.ok(preview.manifest.learningRecords >= 1);

const tampered = JSON.parse(await backup.blob.text());
tampered.stores.graph[0].value.nodes[0].name = "tampered";
await assert.rejects(() => api.previewFullBackup(tampered), /完整性校验失败/);

await api.saveGraph([{ id: "keep", name: "Keep current data" }], []);
await api.restoreFullBackup(backup.blob, { mode: "merge" });
let graph = await api.loadGraph();
assert.ok(graph.nodes.some(node => node.id === "keep"));
assert.ok(graph.nodes.some(node => node.id === "base"));

await api.restoreFullBackup(backup.blob, { mode: "replace" });
graph = await api.loadGraph();
assert.deepEqual(graph.nodes.map(node => node.id), ["base"]);
const restoredConversation = await api.getConversation(conversation.id);
assert.equal(restoredConversation.blob.size, "original attachment".length);

await api.saveGraph([
  { id: "target", name: "Target" },
  { id: "source", name: "Source", parentId: "target" },
  { id: "child", name: "Child", parentId: "source" }
], []);
await api.saveSource({ id: "evidence-1", sourceType: "personal_note", title: "Evidence note" });
await api.linkNodeSource({ nodeId: "source", sourceId: "evidence-1", evidenceLocator: "p.1" });
await api.saveKnowledgeRelation({ sourceNodeId: "source", targetNodeId: "child", type: "supports" });
const merge = await api.createProposal({
  proposalType: "merge",
  targetNodeId: "target",
  sourceNodeIds: ["source"],
  proposedSnapshot: { name: "Merged target" },
  reasoning: "Explicit merge mapping"
});
await api.applyProposal(merge.id, "accept", "runtime test");
graph = await api.loadGraph();
assert.ok(!graph.nodes.some(node => node.id === "source"));
assert.equal(graph.nodes.find(node => node.id === "child").parentId, "target");
assert.ok((await api.listNodeSources("target")).some(link => link.sourceId === "evidence-1"));
assert.ok((await api.listKnowledgeRelations("target")).some(link => link.targetNodeId === "child"));

const split = await api.createProposal({
  proposalType: "split",
  targetNodeId: "target",
  proposedNodes: [{ name: "Part A" }, { name: "Part B" }],
  reasoning: "Explicit split mapping"
});
await api.applyProposal(split.id, "accept", "runtime test");
graph = await api.loadGraph();
assert.ok(graph.nodes.some(node => node.id === "target" && node.name === "Part A"));
assert.ok(graph.nodes.some(node => node.name === "Part B"));
console.log("NEBULA IndexedDB runtime tests passed.");
