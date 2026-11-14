/**
 * Server-backed consent store for NEBULA's identity adapter.
 * Consent is read/written through the authenticated Worker ledger, never
 * inferred from sign-in state or trusted from a local-only flag.
 */
export function createNebulaWorkerConsentStore({ baseUrl, getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl)) throw new TypeError("A trusted HTTPS Worker base URL is required.");
  if (typeof getAccessToken !== "function" || typeof fetchImpl !== "function") throw new TypeError("Consent transport dependencies are required.");
  const endpoint = baseUrl.replace(/\/+$/, "") + "/sync/consent";

  async function request(body) {
    const token = await getAccessToken();
    if (typeof token !== "string" || !token.trim()) throw new Error("A signed-in access token is required for consent changes.");
    const response = await fetchImpl(endpoint, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let result = {};
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) throw new Error("Cloud-sync consent request was rejected.");
    return result.consent ?? null;
  }

  return Object.freeze({
    async read() {
      const consent = await request(null);
      return consent?.status === "enabled"
        ? { enabled: true, categories: Array.isArray(consent.categories) ? consent.categories : [],
            confirmedAt: consent.confirmedAt ?? null }
        : { enabled: false, categories: [] };
    },
    async write(value) {
      if (!value || value.enabled !== true || !Array.isArray(value.categories) || !value.categories.length) {
        throw new TypeError("Enabled consent requires explicit data categories.");
      }
      return request({ status: "enabled", confirm: true, categories: value.categories });
    },
    async clear() {
      return request({ status: "revoked" });
    }
  });
}
