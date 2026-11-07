import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const local = await readFile(new URL("../nebula-local.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../deepseek-worker.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const preview = await readFile(new URL("../ui-preview-v1.html", import.meta.url), "utf8");

for (const store of ["graph","references","lectureSources","aiConversations","assets","meta","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations","extractionBatches","extractionItems","filterCases","filterDecisions","frameworks","frameworkVersions","nodePositions","relationEvidence"]) {
  assert.match(local, new RegExp('"'+store+'"'), "Missing IndexedDB store: "+store);
}
for (const api of ["exportFullBackup","previewFullBackup","restoreFullBackup","saveSource","linkNodeSource","createProposal","applyProposal","saveNodeVersion","saveLearningRecord","saveResearchSession","saveKnowledgeRelation","analyzeConversation","coachKnowledge","checkMnemonic","proposeCoachReview","proposeMnemonicReview","detectKnowledgeGaps","buildLearningQueue","searchResearch","fetchDeepSeekShare","createExtractionBatch","createExtractionItem","createExtractionFromParsedSource","analyzeFilterCaseDuplicates","recordFilterDuplicateDecision","suggestFilterCaseLocations","createFilterSuggestionProposal","applyFilterCaseProposal","createKnowledgeRelationProposal","createFilterRelationProposal","applyKnowledgeRelationProposal","recordFilterItemDisposition","finalizeFilterCase","createFrameworkFromCurrentGraph","syncFrameworkFromGraph","getFrameworkTree","getSpatialProjection","getMindContext","resolveExtractionEvidence","resolveNodeEvidence","resolveEvidenceLocator","analyzeFilterCaseWithAI","getFilterWorkbenchSnapshot","buildKnowledgeBrief","exportFrameworkMarkdown","createFilterCase","appendFilterDecision","createFramework","saveFrameworkVersion","saveNodePosition","createRelationEvidence"]) {
  assert.ok(local.includes(api), "Missing local API: "+api);
}
for (const route of ["/health","/analyze","/coach","/mnemonic","/research","/share"]) {
  assert.ok(worker.includes('"'+route+'"') || worker.includes("'"+route+"'"), "Missing Worker route: "+route);
}
assert.match(local, /NEBULA_FULL_BACKUP/);
assert.match(local, /SHA-256/);
assert.match(local, /lectureFolder/);
assert.match(local, /getAllStoresSnapshot/);
assert.match(local, /protocol!==\"https:\"/);
assert.match(local, /BACKUP_LOCAL_STORAGE_KEYS/);
assert.match(worker, /DEEPSEEK_API_KEY/);
assert.match(worker, /NEBULA_SYNC_TOKEN/);

const inlineScripts = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
assert.ok(inlineScripts.length >= 2, "Expected the app bootstrap and main module scripts.");
for (const match of inlineScripts) {
  const isModule = match[0].startsWith('<script type="module">');
  const args = isModule ? ["--input-type=module", "--check"] : ["--check"];
  const checked = spawnSync(process.execPath, args, { input: match[1], encoding: "utf8" });
  assert.equal(checked.status, 0, "Inline script syntax error: " + checked.stderr);
}


const previewScripts = [...preview.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
assert.ok(previewScripts.length >= 5, "Expected preview interaction and module scripts.");
for (const match of previewScripts) {
  const isModule = match[0].startsWith('<script type="module">');
  const args = isModule ? ["--input-type=module", "--check"] : ["--check"];
  const checked = spawnSync(process.execPath, args, { input: match[1], encoding: "utf8" });
  assert.equal(checked.status, 0, "Preview inline script syntax error: " + checked.stderr);
}
for (const marker of ['id="filter-workbench"','id="filterCaseList"','id="runDedupe"','id="runLocate"','id="createLocationProposal"','id="finalizeFilter"',"import { NEBULA_LOCAL } from './nebula-local.js'"]) {
  assert.ok(preview.includes(marker), "Missing Guanfu Mind preview feature: "+marker);
}
assert.ok(preview.includes("opacity:.17"), "Ghost quadrants should remain highly transparent.");
assert.ok(preview.includes("background:transparent!important"), "Focus core should not render as a heavy card.");

console.log("NEBULA backend contract checks passed.");

assert.match(local, /DB_VERSION = 5/);
assert.match(local, /FILTER_TRANSITIONS/);

assert.match(local, /buildReferenceExtractionCandidates/);
assert.match(local, /saveReferenceBeforeExtraction/);

assert.match(local, /extractionDice/);
assert.match(local, /matchType:exact\?"exact":"near_duplicate"/);

assert.match(local, /dimension:"lineage"/);
assert.match(local, /dimension:"time"/);
assert.match(local, /dimension:"space"/);
assert.match(local, /dimension:"horizontal"/);

assert.match(local, /sourceType==="ai_conversation"\?this\.getConversation/);
assert.match(local, /createExtractionFromParsedSource\(\{sourceId,referenceId:item\.id/);
assert.ok(preview.includes("let nodes=[['系统思维'"), "The spatial graph must be replaceable.");
assert.ok(preview.includes("localGraphNodes=ordered"), "Formal nodes must populate the 3D graph.");
assert.ok(preview.includes("idToIndex=new Map(ordered.map"), "Formal node IDs need stable spatial indices.");
assert.ok(preview.includes("saveNodePosition({frameworkId:framework.id,nodeId:node.id"), "Deterministic positions must persist.");
assert.ok(preview.includes("isDemoUniverse=true"), "Demo universe must be isolated.");
assert.ok(preview.includes("演示节点 · 非正式知识"), "Demo nodes must not appear as confirmed knowledge.");
assert.ok(preview.includes("temporalTarget"), "Time navigation requires an explicit temporal relation.");
assert.ok(!preview.includes("Math.abs(a.year-year)-Math.abs(b.year-year)"), "Nearest year alone must not create a time relation.");
assert.ok(preview.includes("deepseek-json-import"), "DeepSeek JSON imports must be identifiable.");
assert.ok(local.includes("parsedMessageCount"), "The tested local normalizer must report parsed message count.");
assert.ok(preview.includes("getCognitiveDashboard()"), "Dashboard must use local cognitive metrics.");
assert.ok(preview.includes("buildLearningQueue(50)"), "Learning workspace must read the real local queue.");
assert.ok(preview.includes("saveLearningRecord({nodeId:selectedLearningNode.id"), "Active recall must persist a real learning record.");
assert.ok(preview.includes("saveResearchSession({id:selectedResearchId"), "Research drafts must persist and retain identity.");
assert.ok(preview.includes("savePastedConversation"), "DeepSeek pasted conversations need a direct local intake path.");
assert.ok(preview.includes("logicStack=localNodePath(localGraphNodes[i].id).map(n=>n.id)"), "3D focus must synchronize the vertical framework path.");
assert.ok(preview.includes('id="detailParentMeta"'), "Node detail must show the actual parent node.");
assert.ok(preview.includes('id="detailChildMeta"'), "Node detail must show actual direct children.");
assert.ok(preview.includes('id="detailHorizontalMeta"'), "Node detail must show confirmed horizontal relation counts.");
assert.ok(preview.includes("syncFrameworkFromGraph(framework.id,{reason:\"正式图谱存在节点但框架根节点为空，恢复框架投影\"})"), "An empty stale framework projection must be repaired from the formal graph.");
assert.ok(!preview.includes('<div class="metric-value">36</div>'), "Static source counts must not be presented as real data.");
assert.ok(!preview.includes('<div class="metric-value">612</div>'), "Static relation counts must not be presented as real data.");


assert.match(preview, /getCognitiveDashboard\(\),NEBULA_LOCAL\.listKnowledgeRelations\(\),NEBULA_LOCAL\.getFilterWorkbenchSnapshot\(\),NEBULA_LOCAL\.loadGraph\(\)/, "Overview must fetch actual formal graph nodes before rendering its tree.");
assert.match(preview, /const nodes=Array\.isArray\(graph\?\.nodes\)\?graph\.nodes:\[\]/, "Overview tree must render a safe empty state when no formal nodes exist.");

assert.ok(preview.includes('activeSourceCategory==="all"?records:records.filter'), "Source category filters must change the actual visible record set.");
assert.ok(preview.includes('activeSourceCategory=row.dataset.sourceKind||"all"'), "Selecting a source category must update the active filter.");
assert.ok(preview.includes("const domainNeighbor=null"), "A shared domain tag must not fabricate a direct spatial relationship.");
assert.ok(preview.includes("领域标签："), "Domain context may be shown without pretending it is a confirmed spatial link.");
assert.ok(!preview.includes("备份范围确认（演示）"), "The active backup flow must not retain misleading demo-only handlers.");

assert.ok(local.includes("normalizeConversationExport"), "DeepSeek export normalization must live in the tested local data layer.");
assert.ok(preview.includes("NEBULA_LOCAL.normalizeConversationExport(raw,ext)"), "The file intake UI must use the tested DeepSeek normalizer.");


assert.ok(preview.includes("let nodePointerStart=null"), "3D node picking must track a pointer gesture before selection.");
assert.ok(preview.includes("Math.hypot(e.clientX-start.x,e.clientY-start.y)>6"), "Dragging to orbit must not accidentally select a node.");
assert.ok(preview.includes("renderer.domElement.addEventListener('pointerup'"), "Node selection must resolve on pointer release.");
assert.ok(preview.includes("matchMedia('(prefers-reduced-motion: reduce)').matches"), "Automatic camera rotation must respect reduced-motion preferences.");
assert.ok(preview.includes("pixelRatioForViewport"), "Renderer pixel ratio must adapt to viewport size.");
assert.ok(preview.includes("renderer.setPixelRatio(pixelRatioForViewport())"), "Renderer resolution must be recalculated on resize.");

const mindArchitecture = await readFile(new URL("../docs/MIND-V2-ARCHITECTURE.md", import.meta.url), "utf8");
assert.ok(mindArchitecture.includes("树（Framework / Tree）是骨架"), "MIND V2 must define the framework tree as a distinct semantic layer.");
assert.ok(mindArchitecture.includes("网（Relations / Network）是关系"), "MIND V2 must define typed many-to-many relations separately.");
assert.ok(mindArchitecture.includes("图（Universe Map / Spatial Map）是全局"), "MIND V2 must define spatial projection as a separate global map.");
assert.ok(mindArchitecture.includes("坐标不得创建或删除知识关系"), "Spatial coordinates must never fabricate knowledge semantics.");
assert.ok(mindArchitecture.includes("知识时间与学习时间分开记录"), "Knowledge time and learner time must remain distinct.");
assert.ok(mindArchitecture.includes("只有接受后才写入正式知识"), "AI proposals must require explicit user approval.");
assert.ok(mindArchitecture.includes("全局层") && mindArchitecture.includes("深入层"), "The spatial model must include global and recursive depth layers.");
