import assert from "node:assert/strict";
import "fake-indexeddb/auto";

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};
globalThis.window = { dispatchEvent() {} };

// Seed a v5 database before loading the v6 module to verify the exact production upgrade path.
const legacyDb = await new Promise((resolve, reject) => {
  const req = indexedDB.open("nebula_local_v2", 5);
  req.onupgradeneeded = () => {
    const db = req.result;
    const keyed = new Set(["references","lectureSources","aiConversations","assets","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations","extractionBatches","extractionItems","filterCases","filterDecisions","frameworks","frameworkVersions","nodePositions","relationEvidence"]);
    for (const name of ["graph","references","lectureSources","aiConversations","assets","meta","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations","extractionBatches","extractionItems","filterCases","filterDecisions","frameworks","frameworkVersions","nodePositions","relationEvidence"]) {
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
assert.ok(migratedGraph.nodes.some(node => node.id === "legacy-v4"), "v5 graph data must survive the v6 upgrade.");
assert.equal((await api.getSource("legacy-v4-source")).title, "Preserved v4 source", "v5 source records must survive the v6 upgrade.");

const deepseekMappingFixture = JSON.stringify({
  mapping: {
    userNode: { message: { author: { role: "user" }, content: { parts: ["请解释系统思维。"] } } },
    assistantNode: { message: { author: { role: "assistant" }, content: { parts: ["系统思维研究整体关系。"] } } }
  }
});
const normalizedMapping = api.normalizeConversationExport(deepseekMappingFixture, "json");
assert.equal(normalizedMapping.metadata.parsedMessageCount, 2);
assert.ok(normalizedMapping.transcript.includes("user: 请解释系统思维。"));
assert.ok(normalizedMapping.transcript.includes("assistant: 系统思维研究整体关系。"));
const normalizedArray = api.normalizeConversationExport(JSON.stringify({ messages: [
  { role: "user", content: [{ type: "text", text: "第一条消息" }] },
  { role: "assistant", content: { blocks: [{ text: "第二条消息" }] } }
] }), "json");
assert.equal(normalizedArray.metadata.parsedMessageCount, 2);
assert.ok(normalizedArray.transcript.includes("第一条消息"));
assert.ok(normalizedArray.transcript.includes("第二条消息"));
const malformedExport = api.normalizeConversationExport("{invalid", "json");
assert.equal(malformedExport.transcript, "{invalid");
assert.ok(malformedExport.metadata.jsonParseWarning);
const plainExport = api.normalizeConversationExport("user: hi\\nassistant: hello", "txt");
assert.equal(plainExport.transcript, "user: hi\\nassistant: hello");

await api.saveGraph([{ id: "base", name: "Base knowledge", desc: "Initial definition" }], []);
const conversation = await api.saveConversation({
  title: "Backup fixture",
  transcript: "A local-only conversation fixture.",
  blob: new Blob(["original attachment"], { type: "text/plain" })
});
assert.ok(conversation.extractionBatchId, "AI conversations should enter the extraction pipeline.");
assert.ok(conversation.extractionItemCount >= 1, "Conversation text should produce filter candidates.");
const conversationItems = await api.listExtractionItems(conversation.extractionBatchId);
const conversationEvidence = await api.resolveExtractionEvidence(conversationItems[0].id);
assert.equal(conversationEvidence.source.sourceType, "ai_conversation");
assert.equal(conversationEvidence.reference.id, conversation.id);
assert.ok(conversationEvidence.locatedText.includes("local-only conversation fixture."));
const extractionBatchCountBeforeDuplicate = (await api.listExtractionBatches("src_" + conversation.id)).length;
const localDb = await new Promise((resolve, reject) => {
  const req = indexedDB.open("nebula_local_v2");
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
await new Promise((resolve, reject) => {
  const tx = localDb.transaction("sources", "readwrite");
  tx.objectStore("sources").delete("src_" + conversation.id);
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const duplicateConversation = await api.saveConversation({title:"Legacy duplicate", transcript:"A local-only conversation fixture."});
assert.equal(duplicateConversation.duplicate, true);
assert.equal((await api.getSource("src_" + conversation.id)).sourceType, "ai_conversation", "Duplicate legacy conversations must recreate a missing source catalog entry.");
assert.equal((await api.listExtractionBatches("src_" + conversation.id)).length, extractionBatchCountBeforeDuplicate, "Duplicate imports must not create another extraction batch.");
localDb.close();
const firstReview = await api.saveLearningRecord({ nodeId: "base", activityType: "recall", score: 1 });
assert.equal(firstReview.schedule.intervalDays, 1);
assert.ok(firstReview.schedule.nextReviewAt > Date.now());
await api.saveLearningRecord({nodeId:"base",activityType:"recall",score:0,quality:0,answer:"Older overdue result",createdAt:Date.now()-2*86400000});
const dashboardSnapshot = await api.getCognitiveDashboard();
assert.equal(dashboardSnapshot.nodeCount, 1);
assert.equal(dashboardSnapshot.learningRecords, 2);
assert.equal(dashboardSnapshot.dueReviewCount, 0, "An older overdue attempt must not override a newer successful review.");
const learningQueue = await api.buildLearningQueue();
assert.ok(learningQueue.some(item => item.nodeId === "base"), "Formal nodes with structural gaps should appear in the learning queue.");
assert.equal(learningQueue.find(item => item.nodeId === "base").dueForReview, false, "Learning queue must follow the latest review result per node.");
const researchDraft = await api.saveResearchSession({title:"Local research draft",query:"Test a local research question",notes:"Evidence remains a draft."});
const updatedResearchDraft = await api.saveResearchSession({...researchDraft,notes:"Updated evidence note."});
assert.equal(updatedResearchDraft.id, researchDraft.id);
assert.equal((await api.listResearchSessions()).length, 1);

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
await api.saveGraph([{ id: "keep", name: "Keep current data" }, { id: "base", name: "Stale preview copy" }], []);
await api.restoreFullBackup(backup.blob, { mode: "merge", preferIncoming: true });
let graph = await api.loadGraph();
assert.ok(graph.nodes.some(node => node.id === "keep"), "Incoming-preferred preview sync must preserve preview-only nodes.");
assert.equal(graph.nodes.find(node => node.id === "base")?.name, "Base knowledge", "Incoming-preferred preview sync must refresh matching formal nodes from production.");

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
const mergeFramework = await api.createFramework({ title: "Merge placement fixture", rootNodeIds: ["source"] });
const sourcePlacement = await api.createFrameworkPlacement({ frameworkId: mergeFramework.id, nodeId: "source", role: "source-context" });
const mergePath = await api.createExplorationPath({ title: "Merge path fixture", frameworkId: mergeFramework.id, rootNodeId: "source" });
const mergeStep = await api.appendExplorationStep({ pathId: mergePath.id, toNodeId: "child", direction: "向内" });
const collapsingRelation = await api.saveKnowledgeRelation({ sourceNodeId: "source", targetNodeId: "target", type: "supports" });
const collapsePath = await api.createExplorationPath({ title: "Collapsed relation path", frameworkId: mergeFramework.id, rootNodeId: "source" });
const collapseStep = await api.appendExplorationStep({ pathId: collapsePath.id, toNodeId: "target", direction: "向外", relationId: collapsingRelation.id });
await api.saveKnowledgeRelation({ sourceNodeId: "source", targetNodeId: "child", type: "supports" });
const merge = await api.createProposal({
  proposalType: "merge",
  targetNodeId: "target",
  sourceNodeIds: ["source"],
  proposedSnapshot: { name: "Merged target" },
  reasoning: "Explicit merge mapping"
});
const graphBeforeMerge = await api.loadGraph();
await assert.rejects(() => api.applyProposal(merge.id, "accept", "runtime test"), /知识合并\/拆分尚未完成原子事务改造/);
graph = await api.loadGraph();
assert.deepEqual(graph, graphBeforeMerge, "Blocked merge must leave every graph node and edge unchanged.");
assert.equal((await api.listProposals("pending")).some(item => item.id === merge.id), true, "Blocked merge must remain pending for later atomic implementation.");
assert.ok((await api.listNodeSources("source")).some(link => link.sourceId === "evidence-1"), "Blocked merge must preserve source evidence.");
assert.ok((await api.listKnowledgeRelations("source")).some(link => link.targetNodeId === "target"), "Blocked merge must preserve original relations.");
assert.equal((await api.getExplorationPathSnapshot(mergePath.id)).path.rootNodeId, "source", "Blocked merge must preserve original exploration paths.");

const split = await api.createProposal({
  proposalType: "split",
  targetNodeId: "target",
  proposedNodes: [{ name: "Part A" }, { name: "Part B" }],
  reasoning: "Explicit split mapping"
});
const graphBeforeSplit = await api.loadGraph();
await assert.rejects(() => api.applyProposal(split.id, "accept", "runtime test"), /知识合并\/拆分尚未完成原子事务改造/);
graph = await api.loadGraph();
assert.deepEqual(graph, graphBeforeSplit, "Blocked split must leave every graph node and edge unchanged.");
assert.equal((await api.listProposals("pending")).some(item => item.id === split.id), true, "Blocked split must remain pending until atomic transaction support is complete.");

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
const horizontalIndex = locationResult.suggestions.findIndex(x => x.dimension === "horizontal" && x.targetNodeId && x.targetNodeId !== placedNode.id);
assert.ok(horizontalIndex >= 0, "a horizontal candidate should reference an existing formal node");
const relationReviewProposal = await api.createFilterRelationProposal(locationIngestion.filterCase.id, horizontalIndex);
assert.equal(relationReviewProposal.proposalType, "relation");
assert.equal((await api.listKnowledgeRelations(placedNode.id)).some(x => String(x.targetNodeId) === String(relationReviewProposal.relatedNodeId)), false, "horizontal suggestions must not create formal relations before review");
const reviewedRelation = await api.applyKnowledgeRelationProposal(relationReviewProposal.id, "accept", "确认存在横向知识联系");
assert.ok(reviewedRelation.relation?.id, "accepted horizontal proposal should create a formal relation");
assert.equal(reviewedRelation.relation.status, "confirmed", "A user-accepted relation proposal should record its confirmation state.");
assert.equal(reviewedRelation.relation.relationType, "unclassified", "Unknown legacy labels must remain explicitly unclassified.");
assert.ok(reviewedRelation.relation.relationType, "Every accepted relation must have a typed or explicitly unclassified semantic type.");
assert.equal((await api.listRelationEvidence(reviewedRelation.relation.id)).length, 1, "accepted relation must retain evidence locator");
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
assert.equal(relationApplied.relation.legacyRelationType, "historical_context", "The original free-form label must remain auditable.");
assert.equal(relationApplied.relation.relationType, "unclassified", "An unknown legacy label must not be promoted into a semantic type.");
assert.equal((await api.listRelationEvidence(relationApplied.relation.id)).length, 1, "accepted relation must retain its evidence locator");


const frameworkProjection = await api.createFrameworkFromCurrentGraph("绘画史框架", "四维空间联动测试");
const frameworkTree = await api.getFrameworkTree(frameworkProjection.id);
assert.ok(frameworkTree.nodeCount >= 4);
assert.equal(frameworkTree.modelMode, "framework-placement", "New frameworks must begin with independent contextual placements.");
assert.ok((await api.listFrameworkPlacements(frameworkProjection.id)).every(x => x.needsReview), "Legacy parentId projection must be explicitly reviewable rather than silently treated as final ontology.");
const mindContext = await api.getMindContext(placedNode.id, { frameworkId: frameworkProjection.id, activeDimension: "time", focusMode: "focus" });
assert.equal(mindContext.currentNodeId, placedNode.id);
assert.ok(mindContext.ancestorPath.some(x => x.id === "art-root"));
assert.equal(mindContext.activeDimension, "time");
const spatialProjection = await api.getSpatialProjection(frameworkProjection.id);
assert.ok(spatialProjection.nodes.some(x => x.id === placedNode.id));

assert.deepEqual(spatialProjection.dimensions, ["lineage", "time", "space", "horizontal"]);
const projectedPlacedNode = spatialProjection.nodes.find(x => x.id === placedNode.id);
assert.ok(projectedPlacedNode.semanticCoordinates.lineage[0].legacyProjection || projectedPlacedNode.semanticCoordinates.lineage.length > 0);
assert.equal(projectedPlacedNode.semanticCoordinates.space.value, null, "A domain label must not be misrepresented as physical/world location.");
assert.ok(Array.isArray(projectedPlacedNode.semanticCoordinates.horizontalRelationIds));

const originalParentId = placedNode.parentId;
const placementA = await api.createFrameworkPlacement({
  frameworkId: frameworkProjection.id, nodeId: placedNode.id, role: "main-topic",
  context: { view: "art-history", note: "第一条框架路径中的语境" }, needsReview: false
});
const placementB = await api.createFrameworkPlacement({
  frameworkId: frameworkProjection.id, nodeId: placedNode.id, role: "comparison",
  context: { view: "comparative-theory", note: "另一条框架路径中的语境" }, needsReview: false
});
assert.notEqual(placementA.id, placementB.id, "One knowledge identity may have multiple contextual placements.");
assert.equal((await api.listFrameworkPlacements(frameworkProjection.id, placedNode.id)).length, 3, "The framework seed placement and two additional contextual placements must coexist.");
const placementTree = await api.getFrameworkTree(frameworkProjection.id);
assert.equal(placementTree.modelMode, "framework-placement", "Framework navigation must use contextual placements when present.");
assert.equal(placementTree.roots.some(x => x.id === placedNode.id), true, "Placement tree entries must expose the stable knowledge object identity.");
assert.equal((await api.loadGraph()).nodes.find(x => x.id === placedNode.id).parentId, originalParentId, "Creating framework placements must not rewrite the knowledge object's legacy parentId.");
const cycleFramework = await api.createFramework({ title: "Placement cycle fixture", rootNodeIds: ["art-root", placedNode.id] });
const cyclePlacementA = await api.createFrameworkPlacement({ frameworkId: cycleFramework.id, nodeId: placedNode.id });
const cyclePlacementB = await api.createFrameworkPlacement({ frameworkId: cycleFramework.id, nodeId: "art-root" });
await api.updateFrameworkPlacement(cyclePlacementA.id, { parentPlacementId: cyclePlacementB.id });
await assert.rejects(() => api.updateFrameworkPlacement(cyclePlacementB.id, { parentPlacementId: cyclePlacementA.id }), /循环父子关系/);

const pathA = await api.createExplorationPath({ title: "从绘画史进入", frameworkId: frameworkProjection.id, rootNodeId: "art-root", context: { userIntent: "追踪绘画史脉络" } });
const pathB = await api.createExplorationPath({ title: "从时代背景进入", frameworkId: frameworkProjection.id, rootNodeId: "art-southern", context: { userIntent: "比较时代语境" } });
const stepA = await api.appendExplorationStep({ pathId: pathA.id, toNodeId: placedNode.id, direction: "向内", context: { question: "核心理论是什么" } });
const stepB = await api.appendExplorationStep({ pathId: pathB.id, toNodeId: placedNode.id, direction: "向外", context: { question: "与同时代实践如何关联" } });
assert.equal(stepA.toNodeId, stepB.toNodeId, "Different exploration paths must be able to reach the same stable knowledge object.");
assert.notEqual(stepA.id, stepB.id, "Each traversal must retain its own path-step identity.");
assert.equal((await api.loadGraph()).nodes.filter(x => x.id === placedNode.id).length, 1, "Revisiting an object through another path must not duplicate the knowledge object.");
const forkedPath = await api.forkExplorationPath(pathA.id, stepA.id, { title: "从谢赫画品继续分支" });
assert.equal(forkedPath.rootNodeId, placedNode.id);
assert.equal(forkedPath.parentPathId, pathA.id);
const pathSnapshot = await api.getExplorationPathSnapshot(pathA.id);
assert.equal(pathSnapshot.steps.length, 1);
await assert.rejects(() => api.appendExplorationStep({ pathId: pathA.id, toNodeId: "art-southern", direction: "向外", evidenceIds: ["missing-evidence-id"] }), /不存在的证据记录/);
assert.equal(pathSnapshot.branchPoints[0].canFork, true);
const pathMindContext = await api.getMindContext(null, { pathId: pathA.id });
assert.equal(pathMindContext.currentNodeId, placedNode.id, "Mind context should resolve the active exploration path rather than the legacy parentId chain.");
assert.equal(pathMindContext.explorationPathId, pathA.id);
assert.equal(pathMindContext.ancestorPath.at(-1).direction, "向内");

const versionBaseline = await api.saveNodeVersion({ ...placedNode, customSemanticField: "before" }, "版本完整性基线");
const versionChanged = await api.saveNodeVersion({ ...placedNode, customSemanticField: "after" }, "测试完整语义字段版本");
assert.ok(versionChanged.versionNumber > versionBaseline.versionNumber, "Changes outside the former narrow allow-list must create a version.");

const resolvedCandidate = await api.resolveExtractionEvidence(locationIngestion.items[0].id);
assert.equal(resolvedCandidate.source.id, locationSource.id);
assert.equal(resolvedCandidate.locator.kind, "topic");
assert.ok(resolvedCandidate.locatedText.includes("谢赫画品"));
const resolvedNodeEvidence = await api.resolveNodeEvidence(placedNode.id);
assert.ok(resolvedNodeEvidence.sources.length >= 1);
assert.equal(resolvedNodeEvidence.sources[0].source.id, locationSource.id);

const aiSource = await api.saveSource({ id: "src-ai-filter-test", sourceType: "lecture", title: "AI filter sample" });
const aiIngestion = await api.createExtractionFromParsedSource({
  sourceId: aiSource.id, referenceId: "ref-ai-filter-test", name: "AI filter sample",
  pages: [{ page: 1, text: "魏晋南北朝时期的绘画品评与艺术理论，涉及谢赫及其画品体系。" }]
});
await api.analyzeFilterCaseDuplicates(aiIngestion.filterCase.id);
await api.suggestFilterCaseLocations(aiIngestion.filterCase.id);
const originalFetch = globalThis.fetch;
let capturedAiPayload = null;
globalThis.fetch = async (url, init) => {
  capturedAiPayload = JSON.parse(init.body);
  return {
    ok: true,
    json: async () => ({ ok: true, result: {
      nodes: [{ id: "ai-new", name: "谢赫画品体系", coreWord: "画品体系", desc: "魏晋南北朝时期绘画品评理论。", parentId: "art-root", before: "承接早期人物画品评。", after: "影响后世绘画品评。", left: "关联人物画与绘画史。", right: "具体著作内容需核对原文。", date: "魏晋南北朝", needsReview: true }],
      links: [{ source: "ai-new", target: "art-southern", type: "historical_context", label: "画论与绘画实践的时代关联" }],
      mergeSuggestions: [],
      uncertain: ["具体文本内容需要原文逐条核对。"]
    } })
  };
};
let aiResult;
try {
  aiResult = await api.analyzeFilterCaseWithAI("https://worker.example", "test-token", aiIngestion.filterCase.id);
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(capturedAiPayload.existingNodes.length <= 30, true);
assert.ok(capturedAiPayload.text.includes("谢赫"));
assert.equal(aiResult.proposals.length, 1);
assert.equal(aiResult.relationProposals.length, 1);
assert.equal(aiResult.filterCase.aiProvider, "configured-worker");
assert.equal((await api.loadGraph()).nodes.some(x => x.name === "谢赫画品体系"), false, "AI analysis must remain proposal-only");
const aiNodeProposal = aiResult.proposals[0];
await api.applyFilterCaseProposal(aiNodeProposal.id, "accept", "核对材料后接受");
const aiRelationProposal = aiResult.relationProposals[0];
const aiRelationResult = await api.applyKnowledgeRelationProposal(aiRelationProposal.id, "accept", "确认时代关联");
assert.ok(aiRelationResult.relation?.id);
assert.equal((await api.listRelationEvidence(aiRelationResult.relation.id)).length, 1);
assert.equal((await api.finalizeFilterCase(aiIngestion.filterCase.id)).status, "approved");


const workbenchSnapshot = await api.getFilterWorkbenchSnapshot();
assert.ok(workbenchSnapshot.stats.caseCount >= 3);
assert.ok(workbenchSnapshot.cases.some(x => x.id === locationIngestion.filterCase.id));
const knowledgeBrief = await api.buildKnowledgeBrief("art-root");
assert.ok(knowledgeBrief.nodes.some(x => x.id === placedNode.id));
assert.ok(knowledgeBrief.evidence.length >= 1);
assert.ok(Array.isArray(knowledgeBrief.gaps));
const frameworkMarkdown = await api.exportFrameworkMarkdown(frameworkProjection.id);
assert.ok(frameworkMarkdown.includes("# 绘画史框架"));
assert.ok(frameworkMarkdown.includes("谢赫画品"));

const v5Backup = await api.exportFullBackup();
assert.equal((await api.previewFullBackup(v5Backup.blob)).schemaVersion, 6);

console.log("NEBULA IndexedDB runtime tests passed.");

// Preview and production must use independent IndexedDB databases.
const productionBeforePreview = await api.loadGraph();
assert.ok(productionBeforePreview?.nodes?.length, "Production fixture data must exist before preview isolation is checked.");
const previewModule = await import("../nebula-local.js?env=preview");
const previewApi = previewModule.NEBULA_LOCAL;
assert.equal(await previewApi.loadGraph(), null, "A fresh preview environment must not read production graph data.");
await previewApi.saveGraph([{ id: "preview-only", name: "Preview-only knowledge" }], []);
assert.deepEqual((await previewApi.loadGraph()).nodes.map(node => node.id), ["preview-only"]);
assert.deepEqual((await api.loadGraph()).nodes.map(node => node.id), productionBeforePreview.nodes.map(node => node.id), "Preview writes must not alter production graph data.");
await api.saveGraph([{ id: "production-only", name: "Production-only knowledge" }], []);
assert.deepEqual((await previewApi.loadGraph()).nodes.map(node => node.id), ["preview-only"], "Production writes must not leak into preview.");
console.log("NEBULA production/preview database isolation tests passed.");
