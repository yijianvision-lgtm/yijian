import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const local = await readFile(new URL("../nebula-local.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../deepseek-worker.js", import.meta.url), "utf8");

for (const store of ["graph","references","lectureSources","aiConversations","assets","meta","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations"]) {
  assert.match(local, new RegExp('"'+store+'"'), "Missing IndexedDB store: "+store);
}
for (const api of ["exportFullBackup","previewFullBackup","restoreFullBackup","saveSource","linkNodeSource","createProposal","applyProposal","saveNodeVersion","saveLearningRecord","saveResearchSession","saveKnowledgeRelation","analyzeConversation","coachKnowledge","checkMnemonic","proposeCoachReview","proposeMnemonicReview","detectKnowledgeGaps","buildLearningQueue","searchResearch","fetchDeepSeekShare"]) {
  assert.ok(local.includes(api), "Missing local API: "+api);
}
for (const route of ["/analyze","/coach","/mnemonic","/research","/share"]) {
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
console.log("NEBULA backend contract checks passed.");
