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
          typeof record.deleted !== "boolean" ||
          (!record.deleted && (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload))) ||
          (record.deleted && record.payload !== null)) throw new Error("Remote records response contains an invalid record.");
      return Object.freeze({ recordType: record.recordType, recordId: record.recordId, payload: record.payload, deleted: record.deleted, createdAt: record.createdAt, updatedAt: record.updatedAt });
    });
    return Object.freeze({ records, nextCursor: records.length === limit ? records[records.length - 1].recordId : null });
  }
  async function requestJson(path, { method = "GET", token, body } = {}) {
    if (typeof token !== "string" || !token.trim()) throw new Error("A verified access token is required.");
    const response = await fetchImpl(root + path, {
      method, headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await parseJson(response);
    if (!response.ok) throw new Error("Remote snapshot operation failed with HTTP " + response.status + ".");
    return result;
  }
  async function registerDevice({ deviceId, token } = {}) {
    const result = await requestJson("/sync/devices", { method: "POST", token, body: { deviceId } });
    if (result.device?.deviceId !== deviceId || result.device?.status !== "active") throw new Error("Remote device registration response is malformed.");
    return result.device;
  }
  async function createSnapshot({ deviceId, recordType, token } = {}) {
    const result = await requestJson("/sync/snapshots", { method: "POST", token, body: { deviceId, recordType } });
    const value = result.snapshot;
    const manifest = value?.manifest;
    if (!value || value.deviceId !== deviceId || value.recordType !== recordType ||
        !Number.isSafeInteger(value.snapshotSequence) || value.snapshotSequence < 0 ||
        !manifest || !Number.isSafeInteger(manifest.recordCount) || manifest.recordCount < 0 ||
        !Number.isSafeInteger(manifest.pageCount) || manifest.pageCount < 1 ||
        manifest.pageSize !== 50 || !/^[a-f0-9]{64}$/.test(manifest.recordsChecksum || "") ||
        manifest.checksumAlgorithm !== "sha-256-canonical-json-v1" ||
        manifest.pageCount !== Math.max(1, Math.ceil(manifest.recordCount / manifest.pageSize))) {
      throw new Error("Remote snapshot manifest is missing or invalid.");
    }
    return Object.freeze(value);
  }
  async function listSnapshotPage({ snapshotId, deviceId, after = "", limit = 50, token } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Snapshot page size must be between 1 and 50.");
    const query = new URLSearchParams({ deviceId, after, limit: String(limit) });
    const result = await requestJson("/sync/snapshots/" + encodeURIComponent(snapshotId) + "?" + query, { token });
    if (result.snapshotId !== snapshotId || !Array.isArray(result.records) ||
        typeof result.hasMore !== "boolean" || result.complete !== !result.hasMore ||
        (result.nextCursor !== null && typeof result.nextCursor !== "string")) {
      throw new Error("Remote snapshot page is malformed.");
    }
    return Object.freeze(result);
  }
  async function completeSnapshot({ snapshotId, deviceId, token } = {}) {
    const result = await requestJson("/sync/snapshots/" + encodeURIComponent(snapshotId) + "/complete", {
      method: "POST", token, body: { deviceId }
    });
    if (result.snapshotId !== snapshotId || result.completed !== true || !Number.isSafeInteger(result.snapshotSequence)) {
      throw new Error("Remote snapshot completion response is malformed.");
    }
    return Object.freeze(result);
  }
  async function listChanges({ category, after = 0, deviceId, limit = 50, token } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("Invalid change sequence.");
    const query = new URLSearchParams({ type: category, after: String(after), deviceId, limit: String(limit) });
    const result = await requestJson("/sync/changes?" + query, { token });
    if (!Array.isArray(result.changes) || !Number.isSafeInteger(result.nextCursor)) throw new Error("Remote change page is malformed.");
    return Object.freeze(result);
  }
  async function acknowledge({ deviceId, recordType, sequence, token } = {}) {
    return requestJson("/sync/acknowledgements", { method: "POST", token, body: { deviceId, recordType, sequence } });
  }
  async function checksumSnapshotRecords(records) {
    if (!Array.isArray(records)) throw new TypeError("Snapshot records must be an array.");
    const canonical = value => {
      if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
      if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
      return JSON.stringify(value);
    };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(records)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  Object.defineProperties(send, {
    listRecords: { value: listRecords }, registerDevice: { value: registerDevice },
    createSnapshot: { value: createSnapshot }, listSnapshotPage: { value: listSnapshotPage },
    completeSnapshot: { value: completeSnapshot }, listChanges: { value: listChanges },
    acknowledge: { value: acknowledge }, checksumSnapshotRecords: { value: checksumSnapshotRecords }
  });
  return send;
}
