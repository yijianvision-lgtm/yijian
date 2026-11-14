import { createNebulaAuthAdapter } from "./nebula-auth-adapter.js";
import { createNebulaSyncQueue } from "./nebula-sync-queue.js";
import { createNebulaRecordsTransport } from "./nebula-sync-records-transport.js";
import { createNebulaWorkerConsentStore } from "./nebula-worker-consent-store.js";
import { createNebulaLocalRecordApplier } from "./nebula-local-record-applier.js";

/**
 * Compose local persistence, provider-neutral identity, server consent, and
 * the records transport. Construction is side-effect-free: no login, consent
 * request, queue drain, or upload occurs until an explicit method is called.
 */
export function createNebulaSyncRuntime({
  local, provider, workerBaseUrl, fetchImpl = globalThis.fetch, applyRemote
} = {}) {
  if (!local || typeof local.getSyncOutboxStore !== "function") {
    throw new TypeError("NEBULA_LOCAL with a durable sync outbox is required.");
  }
  if (!provider || typeof provider.getSession !== "function" ||
      typeof provider.getAccessToken !== "function" ||
      typeof provider.signIn !== "function" || typeof provider.signOut !== "function") {
    throw new TypeError("A complete identity provider adapter is required.");
  }
  const consentStore = createNebulaWorkerConsentStore({
    baseUrl: workerBaseUrl,
    fetchImpl,
    getAccessToken: async () => {
      const session = await provider.getSession();
      if (!session) return null;
      return provider.getAccessToken();
    }
  });
  const auth = createNebulaAuthAdapter({ provider, consentStore });
  const send = createNebulaRecordsTransport({ baseUrl: workerBaseUrl, fetchImpl });
  const localApplier = applyRemote || createNebulaLocalRecordApplier({ local });
  const queue = createNebulaSyncQueue({
    store: local.getSyncOutboxStore(), auth, send, applyRemote: localApplier
  });

  return Object.freeze({
    auth,
    queue,
    signIn: (...args) => auth.signIn(...args),
    signOut: (...args) => auth.signOut(...args),
    getConsent: () => auth.getSyncConsent(),
    enableCloudSync: options => auth.enableCloudSync(options),
    disableCloudSync: () => auth.disableCloudSync(),
    enqueueRecord: ({ category, recordId, payload, baseVersion = null } = {}) =>
      queue.enqueue({ category, recordId, payload, baseVersion, kind: "upsert" }),
    enqueueCloudDelete: ({ category, recordId } = {}) =>
      queue.enqueue({ category, recordId, kind: "delete" }),
    listPending: () => queue.list(),
    resolveConflict: (id, resolution) => queue.resolveConflict(id, resolution),
    // Deliberately manual. Sign-in, consent activation, and enqueue never drain.
    drain: () => queue.drain(),
    async getStatus() {
      const [session, consent, pending] = await Promise.all([
        auth.getSession(), auth.getSyncConsent(), queue.list()
      ]);
      return Object.freeze({
        signedIn: Boolean(session),
        syncEnabled: consent.enabled,
        categories: consent.categories,
        pendingCount: pending.length,
        conflicts: pending.filter(item => item.status === "conflict").length,
        blocked: pending.filter(item => item.status === "blocked").length
      });
    }
  });
}
