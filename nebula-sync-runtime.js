import { createNebulaAuthAdapter } from "./nebula-auth-adapter.js";
import { createNebulaSyncQueue } from "./nebula-sync-queue.js";
import { createNebulaRecordsTransport } from "./nebula-sync-records-transport.js";
import { createNebulaWorkerConsentStore } from "./nebula-worker-consent-store.js";
import { createNebulaLocalRecordApplier } from "./nebula-local-record-applier.js";
import { buildNebulaGraphNodeDeleteOperations, buildNebulaGraphLinkDeleteOperation, parseNebulaGraphRecordId, getNebulaGraphLinkEndpoints } from "./nebula-graph-sync.js";

function graphFromSnapshotRecords(records) {
  const nodes = new Map(), links = new Map();
  const linkKey = link => {
    const [source, target] = getNebulaGraphLinkEndpoints(link);
    return JSON.stringify([source, target]);
  };
  const ordered = [...records].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.recordId.localeCompare(b.recordId));
  for (const record of ordered) {
    const element = parseNebulaGraphRecordId(record.recordId);
    if (!element) {
      if (record.deleted) { nodes.clear(); links.clear(); continue; }
      if (!record.payload || !Array.isArray(record.payload.nodes) || !Array.isArray(record.payload.links))
        throw new Error("A graph snapshot record has an unsupported payload shape.");
      nodes.clear(); links.clear();
      for (const node of record.payload.nodes) {
        if (!node || node.id === undefined || node.id === null) throw new Error("A graph snapshot contains a node without a stable ID.");
        nodes.set(String(node.id), node);
      }
      for (const link of record.payload.links) links.set(linkKey(link), link);
      continue;
    }
    if (element.kind === "node") {
      if (record.deleted) {
        nodes.delete(element.nodeId);
        for (const [key, link] of links) {
          const [source, target] = getNebulaGraphLinkEndpoints(link);
          if (source === element.nodeId || target === element.nodeId) links.delete(key);
        }
      } else {
        if (!record.payload || String(record.payload.id) !== element.nodeId) throw new Error("A graph node record does not match its stable ID.");
        nodes.set(element.nodeId, record.payload);
      }
    } else if (record.deleted) links.delete(JSON.stringify([element.sourceId, element.targetId]));
    else {
      const key = JSON.stringify([element.sourceId, element.targetId]);
      if (linkKey(record.payload) !== key) throw new Error("A graph link record does not match its stable endpoints.");
      links.set(key, record.payload);
    }
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

export function createNebulaSyncRuntime({ local, provider, workerBaseUrl, fetchImpl = globalThis.fetch, applyRemote } = {}) {
  if (!local || typeof local.getSyncOutboxStore !== "function") throw new TypeError("NEBULA_LOCAL with a durable sync outbox is required.");
  if (!provider || typeof provider.getSession !== "function" || typeof provider.getAccessToken !== "function" || typeof provider.signIn !== "function" || typeof provider.signOut !== "function") throw new TypeError("A complete identity provider adapter is required.");
  const consentStore = createNebulaWorkerConsentStore({ baseUrl: workerBaseUrl, fetchImpl, getAccessToken: async () => (await provider.getSession()) ? provider.getAccessToken() : null });
  const auth = createNebulaAuthAdapter({ provider, consentStore });
  const send = createNebulaRecordsTransport({ baseUrl: workerBaseUrl, fetchImpl });
  const localApplier = applyRemote || createNebulaLocalRecordApplier({ local });
  const queue = createNebulaSyncQueue({ store: local.getSyncOutboxStore(), auth, send, applyRemote: localApplier });
  const previewSnapshots = new Map();
  async function getDeviceId() {
    let deviceId = await local.loadMeta?.("nebulaSyncDeviceId");
    if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
      deviceId = crypto.randomUUID();
      if (typeof local.saveMeta !== "function") throw new Error("A durable local metadata store is required for device identity.");
      await local.saveMeta("nebulaSyncDeviceId", deviceId);
    }
    return deviceId;
  }
  async function retrySnapshotCompletion() {
    const pending = await local.loadMeta?.("nebulaSnapshotCompletionPending");
    if (!pending || pending.status === "discarded") return { pending: false, discarded: pending?.status === "discarded" };
    if (pending.status === "completed") {
      const incremental = await syncGraphChanges({ after: pending.snapshotSequence, deviceId: pending.deviceId });
      return { pending: false, completed: true, recovered: true, incremental };
    }
    if (pending.status === "prepared") {
      const graph = await local.loadGraph();
      const checksum = graph ? await local.getGraphSnapshotChecksum(graph.nodes, graph.links) : null;
      if (checksum !== pending.expectedChecksum) {
        await local.saveMeta("nebulaSnapshotCompletionPending", { ...pending, status: "discarded" });
        return { pending: false, discarded: true };
      }
      await local.saveMeta("nebulaSnapshotCompletionPending", { ...pending, status: "localCommitted" });
    }
    if (pending.status !== "localCommitted") return { pending: true, reason: "snapshot-commit-state-unverified" };
    const token = await auth.getAccessToken();
    if (!token || !(await auth.canSyncCategory(pending.recordType))) return { pending: true, reason: "consent-or-session-unavailable" };
    const completed = await send.completeSnapshot({ snapshotId: pending.snapshotId, deviceId: pending.deviceId, appliedChecksum: pending.expectedChecksum, token });
    await local.saveMeta("nebulaSnapshotCompletionPending", { ...pending, status: "completed", completedAt: Date.now() });
    const incremental = await syncGraphChanges({ after: completed.snapshotSequence, deviceId: pending.deviceId });
    return { pending: false, completed: true, recovered: true, snapshotSequence: completed.snapshotSequence, incremental };
  }
  async function syncGraphChanges({ after = 0, deviceId } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("Invalid incremental sync watermark.");
    if (!(await auth.canSyncCategory("graph"))) throw new Error("Graph sync consent is not enabled.");
    const resolvedDeviceId = deviceId || await getDeviceId();
    let cursor = after, applied = 0, pages = 0;
    while (true) {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("A verified access token is required for incremental sync.");
      const page = await send.listChanges({ category: "graph", after: cursor, deviceId: resolvedDeviceId, limit: 50, token });
      if (!page.changes.length) {
        if (page.nextCursor !== cursor) throw new Error("Empty change page advanced its cursor unexpectedly.");
        break;
      }
      let expected = cursor + 1;
      for (const change of page.changes) {
        if (change.sequence !== expected || typeof change.recordId !== "string" ||
            typeof change.recordVersion !== "string" || !["upsert", "delete"].includes(change.operation)) {
          throw new Error("Incremental change page is not contiguous or contains invalid metadata.");
        }
        if (!(await auth.canSyncCategory("graph"))) throw new Error("Graph sync consent was revoked during incremental sync.");
        const freshToken = await auth.getAccessToken();
        if (!freshToken) throw new Error("The signed-in session ended during incremental sync.");
        const record = await send.getRecord({ category: "graph", recordId: change.recordId, token: freshToken });
        if (Date.parse(record.updatedAt) < Date.parse(change.recordVersion)) throw new Error("Fetched record version is older than its change-feed entry.");
        await localApplier({
          category: record.recordType, recordId: record.recordId,
          payload: record.payload, version: record.updatedAt, deleted: record.deleted
        });
        expected += 1;
        applied += 1;
      }
      const lastSequence = page.changes[page.changes.length - 1].sequence;
      if (page.nextCursor !== lastSequence) throw new Error("Change-feed cursor does not match its final sequence.");
      const ackToken = await auth.getAccessToken();
      if (!ackToken || !(await auth.canSyncCategory("graph"))) throw new Error("Consent or session was revoked before change acknowledgement.");
      await send.acknowledge({ deviceId: resolvedDeviceId, recordType: "graph", sequence: lastSequence, token: ackToken });
      cursor = lastSequence;
      pages += 1;
      if (page.changes.length < 50) break;
    }
    return Object.freeze({ applied, pages, acknowledgedSequence: cursor });
  }
  async function bootstrapGraphSnapshot() {
    await requireCategoryConsent("graph");
    if (typeof local.beginGraphSnapshot !== "function" || typeof local.stageGraphSnapshotChunk !== "function" ||
        typeof local.getGraphSnapshotChecksum !== "function" || typeof local.commitGraphSnapshot !== "function") {
      throw new Error("The local atomic graph snapshot API is unavailable.");
    }
    const retry = await retrySnapshotCompletion();
    if (retry.pending) return { committed: true, serverComplete: false, completionPending: true, retry };
    if (retry.completed) return { committed: true, serverComplete: true, recoveredCompletion: true, retry };
    const deviceId = await getDeviceId();
    let token = await auth.getAccessToken();
    if (!token) throw new Error("A verified access token is required.");
    await send.registerDevice({ deviceId, token });
    const snapshot = await send.createSnapshot({ deviceId, recordType: "graph", token });
    const manifest = snapshot.manifest;
    const records = [];
    let cursor = "", pages = 0;
    try {
      do {
        if (!(await auth.canSyncCategory("graph"))) throw new Error("Graph sync consent was revoked during snapshot download.");
        token = await auth.getAccessToken();
        if (!token) throw new Error("The signed-in session ended during snapshot download.");
        const page = await send.listSnapshotPage({ snapshotId: snapshot.snapshotId, deviceId, after: cursor, limit: manifest.pageSize, token });
        if (page.recordType !== "graph" || page.snapshotSequence !== snapshot.snapshotSequence) throw new Error("Snapshot page watermark or category changed.");
        records.push(...page.records);
        pages += 1;
        if (pages > manifest.pageCount) throw new Error("Snapshot returned more pages than its manifest.");
        if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor)) throw new Error("Snapshot cursor did not advance.");
        cursor = page.nextCursor || "";
        if (!page.hasMore && !page.complete) throw new Error("Snapshot final-page marker is inconsistent.");
        if (page.hasMore && page.complete) throw new Error("Snapshot page prematurely claimed completion.");
        if (!page.hasMore) break;
      } while (true);
      if (pages !== manifest.pageCount || records.length !== manifest.recordCount) throw new Error("Snapshot page count or record count differs from the trusted manifest.");
      if (await send.checksumSnapshotRecords(records) !== manifest.recordsChecksum) throw new Error("Snapshot record checksum does not match the server manifest.");
      const graph = graphFromSnapshotRecords(records);
      const expectedChecksum = await local.getGraphSnapshotChecksum(graph.nodes, graph.links);
      const chunks = Array.from({ length: manifest.pageCount }, (_, index) => {
        const start = Math.floor(index * graph.nodes.length / manifest.pageCount);
        const end = Math.floor((index + 1) * graph.nodes.length / manifest.pageCount);
        const linkStart = Math.floor(index * graph.links.length / manifest.pageCount);
        const linkEnd = Math.floor((index + 1) * graph.links.length / manifest.pageCount);
        return { nodes: graph.nodes.slice(start, end), links: graph.links.slice(linkStart, linkEnd) };
      });
      await local.beginGraphSnapshot({
        snapshotId: snapshot.snapshotId, expectedChunks: manifest.pageCount, expectedChecksum
      });
      for (let index = 0; index < chunks.length; index += 1) {
        if (!(await auth.canSyncCategory("graph"))) throw new Error("Graph sync consent was revoked before local commit.");
        await local.stageGraphSnapshotChunk({ snapshotId: snapshot.snapshotId, index, ...chunks[index] });
      }
      const pending = {
        snapshotId: snapshot.snapshotId, deviceId, recordType: "graph",
        snapshotSequence: snapshot.snapshotSequence, expectedChecksum, status: "prepared", createdAt: Date.now()
      };
      if (!(await auth.canSyncCategory("graph"))) throw new Error("Graph sync consent was revoked before local commit.");
      token = await auth.getAccessToken();
      if (!token) throw new Error("The signed-in session ended before local commit.");
      const activeDevices = await send.listDevices({ token });
      if (!activeDevices.some(device => device.deviceId === deviceId)) throw new Error("The sync device was revoked before local commit.");
      await local.saveMeta("nebulaSnapshotCompletionPending", pending);
      const committed = await local.commitGraphSnapshot({ snapshotId: snapshot.snapshotId });
      await local.saveMeta("nebulaSnapshotCompletionPending", { ...pending, status: "localCommitted", committedAt: Date.now() });
      try {
        token = await auth.getAccessToken();
        if (!token || !(await auth.canSyncCategory("graph"))) throw new Error("Graph sync consent or session is no longer active.");
        const completed = await send.completeSnapshot({ snapshotId: snapshot.snapshotId, deviceId, appliedChecksum: expectedChecksum, token });
        await local.saveMeta("nebulaSnapshotCompletionPending", { ...pending, status: "completed", completedAt: Date.now() });
        const incremental = await syncGraphChanges({ after: completed.snapshotSequence, deviceId });
        return { ...committed, serverComplete: true, snapshotSequence: completed.snapshotSequence, manifest, incremental };
      } catch (error) {
        return { ...committed, serverComplete: false, completionPending: true, snapshotSequence: snapshot.snapshotSequence, manifest, completionError: error.message };
      }
    } catch (error) {
      await local.abortGraphSnapshot(snapshot.snapshotId).catch(() => {});
      const pending = await local.loadMeta?.("nebulaSnapshotCompletionPending");
      if (pending?.snapshotId === snapshot.snapshotId && pending.status === "prepared") {
        // A crash or metadata-write failure can happen after the IndexedDB graph
        // transaction committed. Preserve the completion intent when the durable
        // graph already matches the prepared checksum; discard only an uncommitted
        // staging attempt whose target graph is not present.
        try {
          const graph = await local.loadGraph();
          const checksum = graph ? await local.getGraphSnapshotChecksum(graph.nodes, graph.links) : null;
          const status = checksum === pending.expectedChecksum ? "localCommitted" : "discarded";
          await local.saveMeta("nebulaSnapshotCompletionPending", {
            ...pending, status,
            ...(status === "localCommitted" ? { recoveredCommitAt: Date.now() } : {})
          });
        } catch {
          // Keep the prepared intent for retrySnapshotCompletion() to verify later.
        }
      }
      throw error;
    }
  }
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
    previewCloudRecords, applyCloudRecord, bootstrapGraphSnapshot, retrySnapshotCompletion, syncGraphChanges,
    drain: () => queue.drain(),
    async getStatus() {
      const [session, consent, pending] = await Promise.all([auth.getSession(), auth.getSyncConsent(), queue.list()]);
      return Object.freeze({ signedIn: Boolean(session), syncEnabled: consent.enabled, categories: consent.categories, pendingCount: pending.length, conflicts: pending.filter(item => item.status === "conflict").length, blocked: pending.filter(item => item.status === "blocked").length });
    }
  });
}
