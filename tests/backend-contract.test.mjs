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
for (const api of ["exportFullBackup","previewFullBackup","restoreFullBackup","saveSource","linkNodeSource","createProposal","applyProposal","saveNodeVersion","saveLearningRecord","saveResearchSession","saveKnowledgeRelation","analyzeConversation","coachKnowledge","checkMnemonic","proposeCoachReview","proposeMnemonicReview","detectKnowledgeGaps","buildLearningQueue","searchResearch","fetchDeepSeekShare","createExtractionBatch","createExtractionItem","createExtractionFromParsedSource","analyzeFilterCaseDuplicates","recordFilterDuplicateDecision","suggestFilterCaseLocations","createFilterSuggestionProposal","applyFilterCaseProposal","createKnowledgeRelationProposal","applyKnowledgeRelationProposal","recordFilterItemDisposition","finalizeFilterCase","createFrameworkFromCurrentGraph","syncFrameworkFromGraph","getFrameworkTree","getSpatialProjection","getMindContext","resolveExtractionEvidence","resolveNodeEvidence","resolveEvidenceLocator","analyzeFilterCaseWithAI","getFilterWorkbenchSnapshot","buildKnowledgeBrief","exportFrameworkMarkdown","createFilterCase","appendFilterDecision","createFramework","saveFrameworkVersion","saveNodePosition","createRelationEvidence"]) {
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
assert.match(preview, /#continuumFocus \\.continuum-quadrant\\{[^}]*opacity:\\.17/);
assert.match(preview, /#continuumFocus \\.continuum-core\\{[^}]*background:transparent/);

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
