import { createNebulaAuthAdapter } from "./nebula-auth-adapter.js";
import { createNebulaSyncQueue } from "./nebula-sync-queue.js";
import { createNebulaRecordsTransport } from "./nebula-sync-records-transport.js";
import { createNebulaWorkerConsentStore } from "./nebula-worker-consent-store.js";
import { createNebulaLocalRecordApplier } from "./nebula-local-record-applier.js";
import { buildNebulaGraphNodeDeleteOperations, buildNebulaGraphLinkDeleteOperation } from "./nebula-graph-sync.js";
export function createNebulaSyncRuntime({ local, provider, workerBaseUrl, fetchImpl = globalThis.fetch, applyRemote } = {}) {
  if (!local || typeof local.getSyncOutboxStore !== "function") throw new TypeError("NEBULA_LOCAL with a durable sync outbox is required.");
  if (!provider || typeof provider.getSession !== "function" || typeof provider.getAccessToken !== "function" || typeof provider.signIn !== "function" || typeof provider.signOut !== "function") throw new TypeError("A complete identity provider adapter is required.");
  const consentStore = createNebulaWorkerConsentStore({ baseUrl: workerBaseUrl, fetchImpl, getAccessToken: async () => (await provider.getSession()) ? provider.getAccessToken() : null });
  const auth = createNebulaAuthAdapter({ provider, consentStore });
  const send = createNebulaRecordsTransport({ baseUrl: workerBaseUrl, fetchImpl });
  const localApplier = applyRemote || createNebulaLocalRecordApplier({ local });
  const queue = createNebulaSyncQueue({ store: local.getSyncOutboxStore(), auth, send, applyRemote: localApplier });
  const previewSnapshots = new Map();
  async function requireCategoryConsent(category) {
    if (!(await auth.canSyncCategory(category))) throw new Error("Explicit cloud-sync consent is not enabled for this category.");
  }
  async function previewCloudRecords({ category, after = null, limit = 50 } = {}) {
    await requireCategoryConsent(category);
    if (!(await auth.getSession())) throw new Error("Sign-in is required to preview cloud records.");
    const token = await auth.getAccessToken();
    if (!token) throw new Error("A verified access token is required.");
    const page = await send.listRecords({ category, after, limit, token });
    const previewId = crypto.randomUUID();
    const localSnapshot = typeof local.loadGraph === "function" ? JSON.stringify(await local.loadGraph()) : null;
    previewSnapshots.set(previewId, localSnapshot);
    while (previewSnapshots.size > 20) previewSnapshots.delete(previewSnapshots.keys().next().value);
    return Object.freeze({ previewId, category, records: page.records, nextCursor: page.nextCursor, previewedAt: new Date().toISOString() });
  }
  async function applyCloudRecord({ preview, recordId, confirmed = false } = {}) {
    if (confirmed !== true) throw new Error("Explicit confirmation is required before applying a cloud record.");
    if (!preview || typeof preview.category !== "string" || !Array.isArray(preview.records)) throw new TypeError("A valid cloud-record preview is required.");
    await requireCategoryConsent(preview.category);
    if (typeof local.loadGraph !== "function" || !previewSnapshots.has(preview.previewId)) {
      throw new Error("A current local snapshot is required. Refresh the cloud preview before applying.");
    }
    const selected = preview.records.find(record => record.recordId === recordId);
    if (!selected) throw new Error("The selected record is not part of this preview.");
    if (!(await auth.getSession())) throw new Error("Sign-in is required to apply a cloud record.");
    const token = await auth.getAccessToken();
    if (!token) throw new Error("A verified access token is required.");
    let cursor = null, current = null;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await send.listRecords({ category: preview.category, after: cursor, limit: 50, token });
      current = page.records.find(record => record.recordId === recordId) || current;
      if (current || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (!current || current.updatedAt !== selected.updatedAt) throw new Error("The cloud record changed or was deleted after preview. Refresh the preview before applying.");
    const expectedLocalSnapshot = previewSnapshots.get(preview.previewId);
    const currentLocalSnapshot = JSON.stringify(await local.loadGraph());
    if (currentLocalSnapshot !== expectedLocalSnapshot) {
      throw new Error("The local graph changed after preview. Refresh the preview before applying.");
    }
    const result = await localApplier({ category: current.recordType, recordId: current.recordId, payload: current.payload, version: current.updatedAt, deleted: current.deleted === true });
    previewSnapshots.delete(preview.previewId);
    return Object.freeze({ ...result, recordId: current.recordId, version: current.updatedAt });
  }
  return Object.freeze({
    auth, queue,
    signIn: (...args) => auth.signIn(...args), signOut: (...args) => auth.signOut(...args),
    getConsent: () => auth.getSyncConsent(), enableCloudSync: options => auth.enableCloudSync(options), disableCloudSync: () => auth.disableCloudSync(),
    enqueueRecord: ({ category, recordId, payload, baseVersion = null } = {}) => queue.enqueue({ category, recordId, payload, baseVersion, kind: "upsert" }),
    enqueueCloudDelete: ({ category, recordId } = {}) => queue.enqueue({ category, recordId, kind: "delete" }),
    async enqueueGraphNodeDelete({ nodeId, groupId } = {}) {
      if (typeof local.loadGraph !== "function") throw new Error("A local graph reader is required for safe node deletion.");
      const graph = await local.loadGraph();
      return queue.enqueueMany(buildNebulaGraphNodeDeleteOperations(graph, nodeId), { groupId });
    },
    enqueueGraphLinkDelete({ sourceId, targetId, groupId } = {}) {
      return queue.enqueueMany([buildNebulaGraphLinkDeleteOperation(sourceId, targetId)], { groupId });
    },
    listPending: () => queue.list(), resolveConflict: (id, resolution) => queue.resolveConflict(id, resolution),
    previewCloudRecords, applyCloudRecord,
    drain: () => queue.drain(),
    async getStatus() {
      const [session, consent, pending] = await Promise.all([auth.getSession(), auth.getSyncConsent(), queue.list()]);
      return Object.freeze({ signedIn: Boolean(session), syncEnabled: consent.enabled, categories: consent.categories, pendingCount: pending.length, conflicts: pending.filter(item => item.status === "conflict").length, blocked: pending.filter(item => item.status === "blocked").length });
    }
  });
}
