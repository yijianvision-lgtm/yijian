const OWNER_ID_PATTERN = /^own_[a-f0-9]{64}$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_CATEGORIES = 32;
const STATUSES = new Set(["enabled", "paused", "revoked"]);

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertUser(authContext) {
  if (!authContext || authContext.kind !== "user" ||
      typeof authContext.ownerId !== "string" || !OWNER_ID_PATTERN.test(authContext.ownerId)) {
    throw new TypeError("A verified user identity with a server-derived owner ID is required.");
  }
  return authContext.ownerId;
}

function normalizeCategories(categories) {
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > MAX_CATEGORIES) {
    throw new TypeError("Consent must include between 1 and 32 data categories.");
  }
  const normalized = [...new Set(categories)];
  if (normalized.length !== categories.length ||
      normalized.some(value => typeof value !== "string" || !CATEGORY_PATTERN.test(value))) {
    throw new TypeError("Consent categories must be unique valid category identifiers.");
  }
  return normalized.sort();
}

/**
 * Server-side consent ledger. Only verified identity is accepted as an owner
 * source; callers must invoke setConsent only after an authenticated,
 * explicit user confirmation. Client-provided owner IDs are never accepted.
 */
export function createNebulaSyncConsentRepository({ db, authContext, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A Cloudflare D1 database binding is required.");
  const ownerId = assertUser(authContext);

  return Object.freeze({
    async getConsent() {
      const row = await db.prepare(
        "SELECT categories_json, status, confirmed_at, updated_at, revoked_at FROM nebula_sync_consents WHERE owner_id = ? LIMIT 1"
      ).bind(ownerId).first();
      if (!row) return null;
      let categories;
      try { categories = JSON.parse(row.categories_json); }
      catch { throw new Error("Stored sync consent categories are invalid JSON."); }
      if (!Array.isArray(categories)) throw new Error("Stored sync consent categories are invalid.");
      return Object.freeze({
        enabled: row.status === "enabled",
        status: row.status,
        categories: Object.freeze(categories),
        confirmedAt: row.confirmed_at,
        updatedAt: row.updated_at,
        revokedAt: row.revoked_at || null
      });
    },

    async setConsent({ status, categories, confirmedAt } = {}) {
      if (!STATUSES.has(status)) throw new TypeError("Invalid sync consent status.");
      const safeCategories = normalizeCategories(categories);
      const confirmed = confirmedAt === undefined ? now() : confirmedAt;
      if (!validTimestamp(confirmed)) throw new TypeError("A valid explicit confirmation timestamp is required.");
      const updatedAt = now();
      if (!validTimestamp(updatedAt)) throw new TypeError("Repository clock returned an invalid timestamp.");
      const revokedAt = status === "revoked" ? updatedAt : null;
      await db.prepare(
        "INSERT INTO nebula_sync_consents (owner_id, categories_json, status, confirmed_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET categories_json = excluded.categories_json, status = excluded.status, confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at, revoked_at = excluded.revoked_at"
      ).bind(ownerId, JSON.stringify(safeCategories), status, confirmed, updatedAt, revokedAt).run();
      return Object.freeze({ status, enabled: status === "enabled", categories: Object.freeze(safeCategories), confirmedAt: confirmed, updatedAt, revokedAt });
    },

    async requireCategory(category) {
      if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) throw new TypeError("Invalid data category.");
      const consent = await this.getConsent();
      if (!consent || consent.status !== "enabled" || !consent.categories.includes(category)) {
        throw new Error("Active server-side cloud-sync consent is required for this category.");
      }
      return consent;
    }
  });
}
