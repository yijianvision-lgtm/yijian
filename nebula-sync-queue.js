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

export function createNebulaSyncQueue({ store, auth, send, clock = Date.now, maxAttempts = 8 } = {}) {
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

  async function resolveConflict(id, resolution) {
    const item = (await store.list()).find(row => row.id === id);
    if (!item || item.status !== "conflict") throw new Error("No unresolved conflict exists for this operation.");
    if (resolution === "keep-cloud") {
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
    for (const item of items) {
      if (item.status === "conflict" || item.status === "blocked" || item.status === "syncing") continue;
      if (item.nextAttemptAt > clock()) continue;
      if (item.kind !== "delete" && !(await auth.canSyncCategory(item.category))) {
        item.status = "blocked";
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
