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

const ingestionSource = await api.saveSource({ id: "src-ingestion-test", sourceType: "lecture", title: "Structured lecture sample" });
const ingestion = await api.createExtractionFromParsedSource({
  sourceId: ingestionSource.id,
  referenceId: "ref-ingestion-test",
  name: "Structured lecture sample",
  pages: [
    { page: 1, text: "第一段知识内容。包含可追溯的页码。\n\n第二段知识内容。" },
    { page: 2, text: "第三段知识内容，来自第二页。" }
  ],
  warnings: []
});
assert.equal(ingestion.status, "extracted");
assert.equal(ingestion.items.length, 3);
assert.equal(ingestion.filterCase.status, "extracted");
assert.equal(ingestion.filterCase.currentStage, "dedupe");
assert.equal(ingestion.items[0].locator.kind, "pdf_page");
assert.equal(ingestion.items[0].locator.page, 1);
assert.equal((await api.listExtractionItems(ingestion.id)).length, 3);
assert.equal((await api.getExtractionBatch(ingestion.id)).stats.completed, 3);

const mindmapSource = await api.saveSource({ id: "src-mindmap-test", sourceType: "lecture", title: "Mindmap sample" });
const mindmapIngestion = await api.createExtractionFromParsedSource({
  sourceId: mindmapSource.id,
  referenceId: "ref-mindmap-test",
  name: "Mindmap sample",
  tree: [
    { title: "总主题", parent: null, note: "根主题说明" },
    { title: "分支主题", parent: "总主题", note: "分支说明", sourcePart: "content.xml" }
  ]
});
assert.equal(mindmapIngestion.items.length, 2);
assert.equal(mindmapIngestion.items[1].locator.kind, "topic");
assert.deepEqual(mindmapIngestion.items[1].locator.topicPath, ["总主题", "分支主题"]);
assert.equal(mindmapIngestion.items[1].locator.sourcePart, "content.xml");


const duplicateSource = await api.saveSource({ id: "src-duplicate-test", sourceType: "lecture", title: "Duplicate comparison sample" });
const duplicateIngestion = await api.createExtractionFromParsedSource({
  sourceId: duplicateSource.id,
  referenceId: "ref-duplicate-test",
  name: "Duplicate comparison sample",
  pages: [{
    page: 1,
    text: "知识过滤必须先判断概念的定义、适用范围和来源语境，不能只因为文字相似就直接合并知识节点。\n\n知识过滤必须先判断概念的定义、适用范围以及来源语境，不能因为文字相似便直接合并知识节点。"
  }]
});
assert.equal(duplicateIngestion.items.length, 2);
const duplicateAnalysis = await api.analyzeFilterCaseDuplicates(duplicateIngestion.filterCase.id);
assert.equal(duplicateAnalysis.filterCase.status, "filtering");
assert.equal(duplicateAnalysis.pairs.length, 1);
assert.equal(duplicateAnalysis.pairs[0].matchType, "near_duplicate");
const duplicateDecision = await api.recordFilterDuplicateDecision(
  duplicateIngestion.filterCase.id,
  duplicateAnalysis.pairs[0].itemIds,
  "keep_separate",
  "语境不同，先保持独立。"
);
assert.equal(duplicateDecision.actor, "user");
assert.equal((await api.getFilterCase(duplicateIngestion.filterCase.id)).duplicateCandidates[0].resolution, "keep_separate");
assert.equal((await api.listExtractionItems(duplicateIngestion.id)).length, 2, "duplicate analysis must not delete or merge extraction items");


await api.saveGraph([
  { id: "art-root", name: "中国绘画艺术", coreWord: "绘画艺术", desc: "中国绘画史与艺术理论", level: 1, date: "中国绘画史" },
  { id: "art-wei-jin", name: "魏晋绘画理论", coreWord: "魏晋画论", desc: "魏晋南北朝时期的绘画理论与品评", parentId: "art-root", level: 2, date: "魏晋南北朝", domain: "艺术 绘画" },
  { id: "art-southern", name: "南朝绘画实践", coreWord: "南朝绘画", desc: "南朝人物画与绘画实践", parentId: "art-root", level: 2, date: "南朝", domain: "艺术 绘画" }
], []);
const locationSource = await api.saveSource({ id: "src-location-test", sourceType: "lecture", title: "魏晋画论材料" });
const locationIngestion = await api.createExtractionFromParsedSource({
  sourceId: locationSource.id, referenceId: "ref-location-test", name: "魏晋画论材料",
  tree: [{ title: "谢赫画品", parent: "魏晋绘画理论", note: "魏晋南北朝绘画品评与中国绘画艺术理论。", sourcePart: "content.xml" }]
});
await api.analyzeFilterCaseDuplicates(locationIngestion.filterCase.id);
const locationResult = await api.suggestFilterCaseLocations(locationIngestion.filterCase.id);
assert.ok(locationResult.summary.lineage >= 1, "lineage placement suggestions should be generated");
assert.ok(locationResult.summary.time >= 1, "time dimension suggestions should be generated");
assert.ok(locationResult.summary.space >= 1, "domain dimension suggestions should be generated");
assert.ok(locationResult.summary.horizontal >= 1, "horizontal relation suggestions should be generated");
const parentSuggestionIndex = locationResult.suggestions.findIndex(x => x.dimension === "lineage" && x.kind === "parent_candidate" && x.targetNodeId === "art-wei-jin");
assert.ok(parentSuggestionIndex >= 0, "topic parent should match the existing framework node");
const createProposal = await api.createFilterSuggestionProposal(locationIngestion.filterCase.id, parentSuggestionIndex);
assert.equal(createProposal.proposalType, "create");
assert.equal((await api.loadGraph()).nodes.some(x => x.name === "谢赫画品"), false, "AI suggestions must not write to the formal graph");
await assert.rejects(() => api.finalizeFilterCase(locationIngestion.filterCase.id), /审核提案未处理/);
await api.applyFilterCaseProposal(createProposal.id, "accept", "确认归入魏晋绘画理论");
const placedGraph = await api.loadGraph();
const placedNode = placedGraph.nodes.find(x => x.name === "谢赫画品");
assert.equal(placedNode.parentId, "art-wei-jin");
assert.equal((await api.listNodeSources(placedNode.id)).some(x => x.sourceId === locationSource.id), true, "accepted nodes must retain source links");
const finalizedFilterCase = await api.finalizeFilterCase(locationIngestion.filterCase.id);
assert.equal(finalizedFilterCase.status, "approved");
assert.equal(finalizedFilterCase.currentStage, "completed");
assert.equal(finalizedFilterCase.completionSummary.total, 1);

const relationProposal = await api.createKnowledgeRelationProposal(placedNode.id, "art-southern", {
  type: "historical_context", label: "时代与实践关联", reasoning: "用于核对画论与南朝绘画实践之间的历史关联。",
  evidenceSourceIds: [locationSource.id], evidence: { excerpt: "魏晋南北朝绘画品评与中国绘画艺术理论。", locator: { kind: "topic", topicIndex: 0 } }
});
assert.equal(relationProposal.proposalType, "relation");
const relationApplied = await api.applyKnowledgeRelationProposal(relationProposal.id, "accept", "确认作为待追溯的历史关联");
assert.ok(relationApplied.relation?.id);
assert.equal((await api.listRelationEvidence(relationApplied.relation.id)).length, 1, "accepted relation must retain its evidence locator");

const v5Backup = await api.exportFullBackup();
assert.equal((await api.previewFullBackup(v5Backup.blob)).schemaVersion, 5);

console.log("NEBULA IndexedDB runtime tests passed.");
