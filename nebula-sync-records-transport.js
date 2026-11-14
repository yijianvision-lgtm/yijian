/**
 * NEBULA private records transport.
 * The caller injects fetch and a verified access token. This adapter only
 * supports owner-scoped records; it never uploads local files or scans data.
 */
export function createNebulaRecordsTransport({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl)) {
    throw new TypeError("A trusted HTTPS Worker base URL is required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const root = baseUrl.replace(/\/+$/, "");

  return async function send({ operation, token } = {}) {
    if (!operation || typeof operation !== "object") throw new TypeError("A sync operation is required.");
    if (typeof token !== "string" || !token.trim()) throw new Error("A verified access token is required.");
    const category = String(operation.category || "");
    const recordId = String(operation.recordId || "");
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(category)) throw new TypeError("Invalid record category.");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(recordId)) throw new TypeError("Invalid record ID.");
    const query = new URLSearchParams({ type: category });
    const headers = { Authorization: "Bearer " + token };
    let method, url, body;
    if (operation.kind === "upsert") {
      method = "POST";
      url = root + "/sync/records?" + query.toString();
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        recordType: category,
        recordId,
        payload: operation.payload,
        baseVersion: operation.baseVersion ?? null
      });
    } else if (operation.kind === "delete") {
      method = "DELETE";
      query.set("id", recordId);
      url = root + "/sync/records?" + query.toString();
    } else {
      throw new TypeError("Unsupported private records operation.");
    }
    const response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }) });
    let result = {};
    const contentType = response.headers?.get?.("Content-Type") || "";
    if (contentType.includes("application/json")) {
      try { result = await response.json(); } catch { result = {}; }
    }
    return {
      status: response.status,
      remoteVersion: result.remoteVersion ?? null,
      remotePayload: result.remotePayload ?? null,
      deleted: result.deleted
    };
  };
}
