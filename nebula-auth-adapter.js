/**
 * NEBULA identity adapter boundary.
 *
 * This module deliberately has no vendor SDK, network, browser-storage, or
 * cloud-sync side effects. A provider implementation is injected by the app.
 * Signing in never grants cloud-sync consent.
 */

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;
  const issuer = typeof session.issuer === "string" ? session.issuer.trim() : "";
  const subject = typeof session.subject === "string" ? session.subject.trim() : "";
  if (!issuer || !subject) return null;
  return Object.freeze({
    issuer,
    subject,
    displayName: typeof session.displayName === "string" ? session.displayName : null,
    email: typeof session.email === "string" ? session.email : null,
    expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : null
  });
}

function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return [...new Set(categories.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))].sort();
}

export function createNebulaAuthAdapter({ provider, consentStore } = {}) {
  if (!provider || typeof provider.getSession !== "function" ||
      typeof provider.getAccessToken !== "function" ||
      typeof provider.signIn !== "function" ||
      typeof provider.signOut !== "function") {
    throw new TypeError("A complete identity provider adapter is required.");
  }
  if (!consentStore || typeof consentStore.read !== "function" ||
      typeof consentStore.write !== "function" ||
      typeof consentStore.clear !== "function") {
    throw new TypeError("An explicit cloud-sync consent store is required.");
  }

  async function getSession() {
    return normalizeSession(await provider.getSession());
  }

  async function getSyncConsent() {
    const raw = await consentStore.read();
    if (!raw || raw.enabled !== true) return Object.freeze({ enabled: false, categories: [] });
    return Object.freeze({ enabled: true, categories: normalizeCategories(raw.categories) });
  }

  return Object.freeze({
    async signIn(...args) {
      // Authentication is intentionally isolated from consent and sync state.
      await provider.signIn(...args);
      return getSession();
    },

    async signOut(...args) {
      return provider.signOut(...args);
    },

    getSession,

    async getAccessToken() {
      const session = await getSession();
      if (!session) return null;
      const token = await provider.getAccessToken();
      return typeof token === "string" && token.trim() ? token : null;
    },

    getSyncConsent,

    async enableCloudSync({ categories, confirmed } = {}) {
      if (confirmed !== true) throw new Error("Explicit user confirmation is required to enable cloud sync.");
      const selected = normalizeCategories(categories);
      if (!selected.length) throw new Error("Select at least one data category before enabling cloud sync.");
      const session = await getSession();
      if (!session) throw new Error("Sign in before enabling cloud sync.");
      await consentStore.write({ enabled: true, categories: selected, confirmedAt: new Date().toISOString() });
      return getSyncConsent();
    },

    async disableCloudSync() {
      await consentStore.clear();
      return getSyncConsent();
    },

    async canSyncCategory(category) {
      if (typeof category !== "string" || !category.trim()) return false;
      if (!(await getSession())) return false;
      const consent = await getSyncConsent();
      return consent.enabled && consent.categories.includes(category.trim());
    }
  });
}
