import assert from "node:assert/strict";
import "fake-indexeddb/auto";

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};
globalThis.window = { dispatchEvent() {} };

// Seed a v4 database before loading the v5 module to verify non-destructive upgrade.
const legacyDb = await new Promise((resolve, reject) => {
  const req = indexedDB.open("nebula_local_v2", 4);
  req.onupgradeneeded = () => {
    const db = req.result;
    const keyed = new Set(["references","lectureSources","aiConversations","assets","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations"]);
    for (const name of ["graph","references","lectureSources","aiConversations","assets","meta","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations"]) {
      if (!db.objectStoreNames.contains(name)) {
        if (keyed.has(name)) db.createObjectStore(name, { keyPath: "id" });
        else db.createObjectStore(name);
      }
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
await new Promise((resolve, reject) => {
  const tx = legacyDb.transaction(["graph","sources"], "readwrite");
  tx.objectStore("graph").put({ id: "main", nodes: [{ id: "legacy-v4", name: "Preserved v4 node" }], links: [] }, "main");
  tx.objectStore("sources").put({ id: "legacy-v4-source", sourceType: "personal_note", title: "Preserved v4 source", createdAt: Date.now() });
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
legacyDb.close();

await import("../nebula-local.js");
const api = globalThis.NEBULA_LOCAL;
assert.ok(api, "NEBULA_LOCAL should be exposed after module load.");
const migratedGraph = await api.loadGraph();
assert.ok(migratedGraph.nodes.some(node => node.id === "legacy-v4"), "v4 graph data must survive the v5 upgrade.");
assert.equal((await api.getSource("legacy-v4-source")).title, "Preserved v4 source", "v4 source records must survive the v5 upgrade.");

await api.saveGraph([{ id: "base", name: "Base knowledge", desc: "Initial definition" }], []);
const conversation = await api.saveConversation({
  title: "Backup fixture",
  transcript: "A local-only conversation fixture.",
  blob: new Blob(["original attachment"], { type: "text/plain" })
});
const firstReview = await api.saveLearningRecord({ nodeId: "base", activityType: "recall", score: 1 });
assert.equal(firstReview.schedule.intervalDays, 1);
assert.ok(firstReview.schedule.nextReviewAt > Date.now());
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

const batch = await api.createExtractionBatch({ sourceId: "evidence-1", parserVersion: "test-parser" });
assert.equal(batch.status, "received");
const itemA = await api.createExtractionItem({ batchId: batch.id, sourceId: "evidence-1", title: "Concept A", excerpt: "A source-backed concept", locator: { page: 2 } });
const itemB = await api.createExtractionItem({ batchId: batch.id, sourceId: "evidence-1", title: "Concept B", excerpt: "A distinct concept" });
const filterCase = await api.createFilterCase({ inputItemIds: [itemA.id, itemB.id] });
await assert.rejects(() => api.updateFilterCase(filterCase.id, { status: "approved" }), /不允许从 extracted 直接变更/);
await api.updateExtractionBatch(batch.id, { status: "extracting" });
await api.updateExtractionBatch(batch.id, { status: "extracted" });
await api.updateFilterCase(filterCase.id, { status: "filtering", currentStage: "dedupe" });
await api.updateFilterCase(filterCase.id, { status: "needs_review", summary: "待用户审核" });
const decision = await api.appendFilterDecision({ filterCaseId: filterCase.id, decisionType: "locate", rationale: "Evidence-backed placement", evidenceIds: [itemA.id] });
assert.equal((await api.listFilterDecisions(filterCase.id)).length, 1);
assert.equal(decision.actor, "user");
const framework = await api.createFramework({ title: "Personal framework", rootNodeIds: ["target"] });
assert.ok(framework.versionId);
const frameworkVersions = await api.listFrameworkVersions(framework.id);
assert.equal(frameworkVersions.length, 1);
await api.saveNodePosition({ frameworkId: framework.id, nodeId: "target", level: 1, semanticCoordinates: { lineage: "root" }, layoutCoordinates: { x: 0, y: 0, z: 0 } });
assert.equal((await api.getNodePosition(framework.id, "target")).level, 1);
const relation = (await api.listKnowledgeRelations("target"))[0];
const relationEvidence = await api.createRelationEvidence({ relationId: relation.id, sourceId: "evidence-1", locator: "p.1", excerpt: "Evidence excerpt" });
assert.equal((await api.listRelationEvidence(relation.id))[0].id, relationEvidence.id);
const v5Backup = await api.exportFullBackup();
assert.equal((await api.previewFullBackup(v5Backup.blob)).schemaVersion, 5);

console.log("NEBULA IndexedDB runtime tests passed.");
