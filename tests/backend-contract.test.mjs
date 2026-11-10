import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const local = await readFile(new URL("../nebula-local.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../deepseek-worker.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const preview = await readFile(new URL("../ui-preview-v1.html", import.meta.url), "utf8");
const currentPreview = await readFile(new URL("../ui-preview-v42-7.html", import.meta.url), "utf8");
const performancePreview = await readFile(new URL("../ui-preview-v42-8.html", import.meta.url), "utf8");

for (const store of ["graph","references","lectureSources","aiConversations","assets","meta","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations","extractionBatches","extractionItems","filterCases","filterDecisions","frameworks","frameworkVersions","nodePositions","relationEvidence","frameworkPlacements","explorationPaths","explorationSteps"]) {
  assert.match(local, new RegExp('"'+store+'"'), "Missing IndexedDB store: "+store);
}
for (const api of ["exportFullBackup","previewFullBackup","restoreFullBackup","saveSource","linkNodeSource","createProposal","applyProposal","saveNodeVersion","saveLearningRecord","saveResearchSession","saveKnowledgeRelation","analyzeConversation","chatLearningCoach","coachKnowledge","checkMnemonic","proposeCoachReview","proposeMnemonicReview","detectKnowledgeGaps","buildLearningQueue","searchResearch","fetchDeepSeekShare","createExtractionBatch","createExtractionItem","createExtractionFromParsedSource","analyzeFilterCaseDuplicates","recordFilterDuplicateDecision","suggestFilterCaseLocations","createFilterSuggestionProposal","applyFilterCaseProposal","createKnowledgeRelationProposal","createFilterRelationProposal","applyKnowledgeRelationProposal","recordFilterItemDisposition","finalizeFilterCase","createFrameworkFromCurrentGraph","syncFrameworkFromGraph","getFrameworkTree","getSpatialProjection","getMindContext","resolveExtractionEvidence","resolveNodeEvidence","resolveEvidenceLocator","analyzeFilterCaseWithAI","getFilterWorkbenchSnapshot","buildKnowledgeBrief","exportFrameworkMarkdown","createFilterCase","appendFilterDecision","createFramework","saveFrameworkVersion","saveNodePosition","createRelationEvidence","createFrameworkPlacement","listFrameworkPlacements","migrateLegacyFrameworkPlacements","createExplorationPath","appendExplorationStep","listExplorationPaths","listExplorationSteps","forkExplorationPath","getExplorationPathSnapshot"]) {
  assert.ok(local.includes(api), "Missing local API: "+api);
}
for (const route of ["/health","/analyze","/coach","/mnemonic","/research","/share","/chat"]) {
  assert.ok(worker.includes('"'+route+'"') || worker.includes("'"+route+"'"), "Missing Worker route: "+route);
}
assert.match(local, /NEBULA_FULL_BACKUP/);
assert.match(local, /SHA-256/);
assert.match(local, /lectureFolder/);
assert.match(local, /getAllStoresSnapshot/);
assert.match(local, /protocol!==\"https:\"/);
assert.match(local, /BACKUP_LOCAL_STORAGE_KEYS/);
assert.match(local, /const missingStores=STORES\.filter/ , "Replace restore must reject incomplete backups before opening a write transaction.");
assert.match(local, /当前数据未被修改/ , "Incomplete replace restore must explicitly guarantee no current data was modified.");
assert.match(local, /安全保护：知识合并\/拆分尚未完成原子事务改造/ , "Non-atomic merge/split must remain blocked until transaction safety is implemented.");
assert.ok(currentPreview.includes("import { NEBULA_LOCAL } from './nebula-local.js?env=preview'"), "V42.7 must use its own IndexedDB environment.");

assert.match(worker, /DEEPSEEK_API_KEY/);
assert.match(worker, /NEBULA_SYNC_TOKEN/);
assert.match(worker, /url\.pathname === "\/chat"/);
assert.match(worker, /Unauthorized: invalid NEBULA access token/);
assert.ok(worker.includes("async function limitRequestBody(request, maxBytes)"), "Worker must enforce a streaming request-body ceiling.");
assert.ok(worker.includes("limitRequestBody(request, 1024 * 1024)"), "Worker POST routes must enforce the 1 MiB body ceiling.");
assert.ok(worker.includes("async function readJsonLimited(response, maxBytes = 8 * 1024 * 1024)"), "Worker must bound upstream response bodies before JSON parsing.");
assert.ok(worker.includes("async function checkRateLimit(request, env, cors)"), "Worker must enforce a configured rate-limit binding.");
assert.ok(worker.includes("NEBULA_RATE_LIMITER.limit"), "Worker must invoke the Cloudflare rate-limit binding.");
assert.ok(worker.includes("Rate limit exceeded"), "Worker must return a 429 response when rate limited.");
assert.match(worker, /status: 413/, "Oversized Worker requests must be rejected before JSON parsing.");
const coachRouteStart = worker.indexOf('if (url.pathname === "/coach" || url.pathname === "/mnemonic") {');
const coachAuthBlock = worker.slice(coachRouteStart, worker.indexOf("if (!env.DEEPSEEK_API_KEY)", coachRouteStart));
assert.ok(coachRouteStart >= 0 && coachAuthBlock.includes('request.method !== "POST"') && coachAuthBlock.includes("NEBULA_SYNC_TOKEN") && coachAuthBlock.includes("Unauthorized: invalid NEBULA access token"), "Coach and mnemonic routes must require POST and the shared access token before calling the AI provider.");

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


// The retired V7 learning preview was intentionally removed; do not test a deleted artifact.


const currentPreviewScripts = [...currentPreview.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const currentPreviewImportMaps = currentPreviewScripts.filter(match => /\btype=["']importmap["']/.test(match[1]));
assert.ok(currentPreviewImportMaps.length >= 1, "V42.7 must retain its Three.js import map.");
for (const match of currentPreviewImportMaps) assert.doesNotThrow(() => JSON.parse(match[2]), "V42.7 import map must be valid JSON.");
const currentPreviewExecutableScripts = currentPreviewScripts.filter(match => !/\btype=["']importmap["']/.test(match[1]));
assert.ok(currentPreviewExecutableScripts.length >= 5, "Expected V42.7 executable scripts.");
for (const match of currentPreviewExecutableScripts) {
  const isModule = /\btype=["']module["']/.test(match[1]);
  const args = isModule ? ["--input-type=module", "--check"] : ["--check"];
  const checked = spawnSync(process.execPath, args, { input: match[2], encoding: "utf8" });
  assert.equal(checked.status, 0, "V42.7 inline script syntax error: " + checked.stderr);
}
assert.ok(currentPreviewScripts.length >= 5, "Expected V42.7 preview scripts.");
// Import Maps are JSON and were validated above; executable script bodies are checked separately.
assert.ok(currentPreview.includes("nebula-local.js?env=preview"), "V42.7 must use its isolated IndexedDB environment.");
assert.ok(currentPreview.includes("updateCoreScreenAnchor"), "V42.7 must retain the approved core-screen anchoring mechanism.");
assert.ok(currentPreview.includes("blur(9px)") && currentPreview.includes("brightness(.48)") && currentPreview.includes("1.9s"), "V42.7 must retain the approved A4 reveal baseline.");

const performancePreviewScripts = [...performancePreview.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
assert.ok(performancePreviewScripts.length >= 5, "V42.8 must retain the full preview script set.");
for (const match of performancePreviewScripts) {
  if (/\btype=["']importmap["']/.test(match[1])) {
    assert.doesNotThrow(() => JSON.parse(match[2]), "V42.8 import map must be valid JSON.");
    continue;
  }
  const isModule = /\btype=["']module["']/.test(match[1]);
  const args = isModule ? ["--input-type=module", "--check"] : ["--check"];
  const checked = spawnSync(process.execPath, args, { input: match[2], encoding: "utf8" });
  assert.equal(checked.status, 0, "V42.8 inline script syntax error: " + checked.stderr);
}
assert.ok(performancePreview.includes("updateCoreScreenAnchor"), "V42.8 must preserve the approved center-anchor mechanism.");
assert.ok(performancePreview.includes("blur(9px)") && performancePreview.includes("brightness(.48)") && performancePreview.includes("1.9s"), "V42.8 must preserve the approved A4 visual baseline.");
assert.ok(performancePreview.includes("scale.x+=(target-scale.x)*.032"), "V42.8 must retain equivalent X-axis scale interpolation.");
assert.ok(performancePreview.includes("scale.y+=(target-scale.y)*.032") && performancePreview.includes("scale.z+=(target-scale.z)*.032"), "V42.8 must retain equivalent Y/Z scale interpolation.");
assert.ok(!performancePreview.includes("s.scale.lerp(new THREE.Vector3(target,target,target),.032)"), "V42.8 must not allocate a new Vector3 for every node on every animation frame.");
const performanceAnchorStart = performancePreview.indexOf("function updateCoreScreenAnchor(){");
const performanceAnimateStart = performancePreview.indexOf("function animate(){");
const performanceAnchorBody = performancePreview.slice(performanceAnchorStart, performanceAnimateStart);
assert.ok(performancePreview.includes("const anchorWorld=new THREE.Vector3()") && performancePreview.includes("const anchorProjected=new THREE.Vector3()"), "V42.8 must preallocate anchor-projection scratch vectors.");
assert.ok(!performanceAnchorBody.includes("new THREE.Vector3") && !performanceAnchorBody.includes(".clone()"), "V42.8 center-anchor correction must not allocate or clone vectors on each focused frame.");
const performanceAnimateStart = performancePreview.indexOf("function animate(){");
const performanceResizeStart = performancePreview.indexOf("function resize(){", performanceAnimateStart);
const performanceAnimateBody = performancePreview.slice(performanceAnimateStart, performanceResizeStart);
assert.ok(performancePreview.includes("const focusTargetWorld=new THREE.Vector3()"), "V42.8 must preallocate focus-animation scratch vectors.");
assert.ok(!performanceAnimateBody.includes("new THREE.Vector3") && !performanceAnimateBody.includes(".clone()"), "V42.8 animation loop must not allocate or clone vectors per frame.");
assert.ok(!performanceAnimateBody.includes("spheres.forEach("), "V42.8 animation loop must not create a per-frame forEach callback.");

console.log("NEBULA backend contract checks passed.");

assert.match(local, /DB_VERSION = 6/);
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

const charter = await readFile(new URL("../docs/GUANFU-MIND-DESIGN-CHARTER.md", import.meta.url), "utf8");
const mindArchitecture = await readFile(new URL("../docs/MIND-V2-ARCHITECTURE.md", import.meta.url), "utf8");
const identityContract = await readFile(new URL("../docs/NEBULA-IDENTITY-ISOLATION-CONTRACT.md", import.meta.url), "utf8");
assert.ok(identityContract.includes("不得把客户端提交的 `userId`、`ownerId`、`tenantId`") || identityContract.includes("不得把客户端提交的 `userId`"), "Identity contract must reject client-supplied owner identity.");
assert.ok(identityContract.includes("精确匹配受信任的 `issuer (iss)`") && identityContract.includes("`audience (aud)`"), "Identity contract must require issuer and audience validation.");
assert.ok(identityContract.includes("每个读取、更新、删除和关联查询都必须把 `owner_id` 放入 SQL 条件"), "D1 access must be owner-scoped in every operation.");
assert.ok(identityContract.includes("owners/{owner_id}/"), "R2 objects must use a server-derived owner namespace.");
assert.ok(identityContract.includes("两个独立测试用户 A、B"), "Cross-tenant negative tests must cover two independent users.");
assert.ok(identityContract.includes("不可接正式后台"), "Production backend activation must remain gated.");
assert.ok(charter.includes("稳定知识身份"), "The current charter must require stable knowledge identity.");
assert.ok(charter.includes("同一个知识对象可从多条路径抵达"), "The current charter must support the same object across multiple exploration paths.");
assert.ok(charter.includes("不同框架可为同一对象提供不同上下文位置"), "The current charter must support multiple framework contexts for one object.");
assert.ok(charter.includes("探索路径负责记录用户如何抵达"), "The current charter must model recursive exploration paths independently.");
assert.ok(charter.includes("四向四维是一个东西") && ["瞻前","顾后","左顾","右盼"].every(label => charter.includes(label)), "The current charter must preserve the unified four-direction/four-dimension model and its four original names.");
assert.ok(charter.includes("坐标本身不构成语义关系"), "Spatial coordinates must never fabricate knowledge semantics.");
assert.ok(charter.includes("AI 不得未经确认直接覆盖用户知识"), "AI proposals must require explicit user approval.");
assert.ok(mindArchitecture.includes("唯一主要 parentId"), "The legacy V2 architecture should remain available as a historical implementation reference.");
assert.ok(charter.includes("旧 V2.0 文档作为历史方案"), "The current charter must explicitly supersede conflicting legacy V2 constraints.");

assert.ok(local.includes('schemaVersion:6'), "Full backups must include the new path and placement stores.");
assert.ok(local.includes("const relationType=relationTypes.has(suppliedType)?suppliedType:\"unclassified\""), "Unknown legacy relation labels must not become invented semantic types.");
assert.ok(local.includes('legacyRelationType'), "Legacy free-form relation labels must be preserved without being promoted to verified semantics.");
assert.ok(local.includes('const comparable=x=>JSON.stringify(x??null)'), "Node version comparison must include every persisted semantic field.");
assert.ok(local.includes('parentPlacementId'), "Framework membership must be modeled independently from node parentId.");
assert.ok(local.includes('explorationSteps'), "Exploration traversal must be persisted separately from knowledge object identity.");

assert.match(worker, /const supportedPath = \[["']\/analyze["'], ["']\/coach["'], ["']\/mnemonic["'], ["']\/research["'], ["']\/chat["']\]/, "The /chat route must pass the Worker allowlist.");
assert.match(worker, /env\.CLAUDE_API_KEY/, "Claude must use a server-side secret.");
assert.match(worker, /https:\/\/api\.anthropic\.com\/v1\/messages/, "Claude Messages API adapter must exist.");
assert.match(worker, /provider === "claude"/, "The chat gateway must select the requested provider.");

assert.match(local, /provider:payload\.provider===\"claude\"\?\"claude\":\"deepseek\"/, "The local chat bridge must pass through an explicit DeepSeek or Claude provider choice.");
