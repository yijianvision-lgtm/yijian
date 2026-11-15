/**
 * NEBULA local-first sync outbox.
 *
 * This module never reads IndexedDB, starts network requests, or uploads data
 * on import. The app injects durable storage, identity/consent, and transport.
 * Upserts require category-scoped consent. Explicit owner deletion operations
 * may still run after consent revocation so users can remove their cloud copy.
 * HTTP 409 is preserved as a conflict; no last-write-wins overwrite occurs.
 */
const nowIso = clock => new Date(clock()).toISOString();
const clone = value => structuredClone(value);

function validateOperation(input) {
  if (!input || typeof input !== "object") throw new TypeError("A sync operation is required.");
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const recordId = typeof input.recordId === "string" ? input.recordId.trim() : "";
  const kind = input.kind;
  if (!category || !recordId) throw new TypeError("A category and record ID are required.");
  if (kind !== "upsert" && kind !== "delete") throw new TypeError("Unsupported sync operation.");
  if (kind === "upsert" && input.payload === undefined) throw new TypeError("An upsert requires a payload.");
  return { category, recordId, kind, payload: kind === "upsert" ? clone(input.payload) : null,
    baseVersion: input.baseVersion ?? null };
}

export function createNebulaSyncQueue({ store, auth, send, applyRemote, clock = Date.now, maxAttempts = 8 } = {}) {
  if (!store || typeof store.list !== "function" || typeof store.put !== "function" || typeof store.remove !== "function")
    throw new TypeError("A durable outbox store is required.");
  if (!auth || typeof auth.getSession !== "function" || typeof auth.getAccessToken !== "function" ||
      typeof auth.canSyncCategory !== "function") throw new TypeError("An identity and consent adapter is required.");
  if (typeof send !== "function") throw new TypeError("A sync transport is required.");
  let draining = null;

  async function enqueue(input) {
    const normalized = validateOperation(input);
    const id = input.id || "sync_" + crypto.randomUUID();
    const existing = (await store.list()).find(item => item.id === id);
    if (existing) throw new Error("Duplicate outbox operation ID.");
    const item = { id, ...normalized, status: "pending", attempts: 0, createdAt: nowIso(clock),
      updatedAt: nowIso(clock), nextAttemptAt: 0, lastError: null, conflict: null };
    await store.put(item);
    return clone(item);
  }

  // A grouped delete is committed as one durable unit. The caller supplies a
  // stable groupId so retrying the same intent reuses exactly the same IDs.
  async function enqueueMany(inputs, { groupId } = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 500)
      throw new TypeError("A batch must contain between 1 and 500 operations.");
    if (typeof groupId !== "string" || !/^[A-Za-z0-9._-]{1,96}$/.test(groupId))
      throw new TypeError("A stable, URL-safe operation group ID is required.");
    if (typeof store.putMany !== "function")
      throw new TypeError("The outbox store must support atomic batch writes.");
    const normalized = inputs.map(validateOperation);
    const ids = normalized.map((_, index) => "sync-group:" + groupId + ":" + index);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate operation IDs in batch.");
    const existingById = new Map((await store.list()).map(item => [item.id, item]));
    const present = ids.filter(id => existingById.has(id));
    if (present.length && present.length !== ids.length)
      throw new Error("A partial operation group exists; refusing to complete a non-atomic batch.");
    if (present.length === ids.length) {
      const replay = ids.map((id, index) => existingById.get(id));
      for (let index = 0; index < replay.length; index++) {
        const item = replay[index], operation = normalized[index];
        if (item.operationGroupId !== groupId || item.groupIndex !== index ||
            item.category !== operation.category || item.recordId !== operation.recordId ||
            item.kind !== operation.kind || item.baseVersion !== operation.baseVersion ||
            JSON.stringify(item.payload) !== JSON.stringify(operation.payload))
          throw new Error("Operation group ID was reused with different contents.");
      }
      return clone(replay);
    }
    const createdAt = nowIso(clock);
    const items = normalized.map((operation, index) => ({
      id: ids[index], ...operation, operationGroupId: groupId,
      groupIndex: index, groupSize: normalized.length,
      status: "pending", attempts: 0, createdAt, updatedAt: createdAt,
      nextAttemptAt: 0, lastError: null, conflict: null
    }));
    await store.putMany(items);
    return clone(items);
  }

  async function resolveConflict(id, resolution) {
    const item = (await store.list()).find(row => row.id === id);
    if (!item || item.status !== "conflict") throw new Error("No unresolved conflict exists for this operation.");
    if (resolution === "keep-cloud") {
      if (typeof applyRemote !== "function") {
        throw new Error("A local remote-version applier is required before keeping the cloud version.");
      }
      await applyRemote({
        category: item.category,
        recordId: item.recordId,
        payload: clone(item.conflict?.remotePayload ?? null),
        version: item.conflict?.remoteVersion ?? null,
        deleted: item.conflict?.remotePayload == null
      });
      await store.remove(id);
      return { resolved: true, action: "kept-cloud" };
    }
    if (resolution !== "keep-local") throw new Error("Choose keep-local or keep-cloud explicitly.");
    item.status = "pending";
    item.baseVersion = item.conflict?.remoteVersion ?? item.baseVersion;
    item.conflict = null;
    item.attempts = 0;
    item.nextAttemptAt = 0;
    item.lastError = null;
    item.updatedAt = nowIso(clock);
    await store.put(item);
    return { resolved: true, action: "queued-local-version" };
  }

  async function runDrain() {
    const session = await auth.getSession();
    if (!session) return { sent: 0, blocked: "sign-in-required" };
    const token = await auth.getAccessToken();
    if (!token) return { sent: 0, blocked: "token-unavailable" };
    let sent = 0;
    const items = (await store.list()).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    // A page/process may close while an operation is in flight. A persisted
    // "syncing" marker is not a permanent lock: restore it to pending and rely
    // on server-side create-only/CAS semantics for safe retry.
    for (const item of items) {
      if (item.status === "syncing") {
        item.status = "pending";
        item.lastError = "recovered-after-interruption";
        item.updatedAt = nowIso(clock);
        await store.put(item);
      }
      if (item.status === "conflict" || item.status === "blocked") continue;
      if (item.nextAttemptAt > clock()) continue;
      if (item.kind !== "delete" && !(await auth.canSyncCategory(item.category))) {
        item.status = "pending";
        item.lastError = "category-consent-required";
        item.updatedAt = nowIso(clock);
        await store.put(item);
        continue;
      }
      item.status = "syncing";
      item.updatedAt = nowIso(clock);
      await store.put(item);
      try {
        const response = await send({ operation: clone(item), token, idempotencyKey: item.id });
        const status = Number(response?.status ?? 200);
        if (status >= 200 && status < 300) {
          await store.remove(item.id);
          sent += 1;
          continue;
        }
        if (status === 409) {
          item.status = "conflict";
          item.conflict = { remoteVersion: response.remoteVersion ?? null,
            remotePayload: response.remotePayload ?? null };
          item.lastError = "version-conflict";
          item.updatedAt = nowIso(clock);
          await store.put(item);
          continue;
        }
        if (status === 401 || status === 403) {
          item.status = "blocked";
          item.lastError = status === 401 ? "authentication-required" : "authorization-denied";
          item.updatedAt = nowIso(clock);
          await store.put(item);
          break;
        }
        throw new Error("sync-http-" + status);
      } catch (error) {
        item.attempts += 1;
        item.status = item.attempts >= maxAttempts ? "blocked" : "pending";
        item.lastError = "transport-failed";
        item.nextAttemptAt = clock() + Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(item.attempts, 12)));
        item.updatedAt = nowIso(clock);
        await store.put(item);
      }
    }
    return { sent, blocked: null, remaining: (await store.list()).length };
  }

  return Object.freeze({
    enqueue,
    list: async () => clone(await store.list()),
    resolveConflict,
    drain() {
      if (!draining) draining = runDrain().finally(() => { draining = null; });
      return draining;
    }
  });
}
