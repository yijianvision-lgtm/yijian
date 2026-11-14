/**
 * NEBULA private records transport.
 * The caller injects fetch and a verified access token. This adapter only
 * supports owner-scoped records; it never uploads local files or scans data.
 */
async function parseJson(response) {
  const contentType = response.headers?.get?.("Content-Type") || "";
  if (!contentType.includes("application/json")) return {};
  return response.json().catch(() => ({}));
}
export function createNebulaRecordsTransport({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl)) throw new TypeError("A trusted HTTPS Worker base URL is required.");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const root = baseUrl.replace(/\/+$/, "");
  async function send({ operation, token } = {}) {
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
      method = "POST"; url = root + "/sync/records?" + query.toString();
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ recordType: category, recordId, payload: operation.payload, baseVersion: operation.baseVersion ?? null });
    } else if (operation.kind === "delete") {
      method = "DELETE"; query.set("id", recordId); url = root + "/sync/records?" + query.toString();
    } else throw new TypeError("Unsupported private records operation.");
    const response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }) });
    const result = await parseJson(response);
    return { status: response.status, remoteVersion: result.remoteVersion ?? null, remotePayload: result.remotePayload ?? null, deleted: result.deleted };
  }
  async function listRecords({ category, after = null, limit = 50, token } = {}) {
    if (typeof token !== "string" || !token.trim()) throw new Error("A verified access token is required.");
    if (typeof category !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(category)) throw new TypeError("Invalid record category.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Record page limit must be between 1 and 50.");
    if (after !== null && (typeof after !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(after))) throw new TypeError("Invalid record cursor.");
    const query = new URLSearchParams({ type: category, limit: String(limit) });
    if (after !== null) query.set("after", after);
    const response = await fetchImpl(root + "/sync/records?" + query.toString(), { method: "GET", headers: { Authorization: "Bearer " + token } });
    const result = await parseJson(response);
    if (!response.ok) throw new Error("Remote records read failed with HTTP " + response.status + ".");
    if (!Array.isArray(result.records)) throw new Error("Remote records response is malformed.");
    const records = result.records.map(record => {
      if (!record || record.recordType !== category || typeof record.recordId !== "string" || !record.recordId ||
          typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) ||
          !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new Error("Remote records response contains an invalid record.");
      return Object.freeze({ recordType: record.recordType, recordId: record.recordId, payload: record.payload, createdAt: record.createdAt, updatedAt: record.updatedAt });
    });
    return Object.freeze({ records, nextCursor: records.length === limit ? records[records.length - 1].recordId : null });
  }
  Object.defineProperty(send, "listRecords", { value: listRecords });
  return send;
}
