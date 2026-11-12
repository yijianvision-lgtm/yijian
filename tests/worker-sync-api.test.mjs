import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = ["nebula-worker-auth.js", "nebula-sync-consent.js", "nebula-d1-repository.js", "nebula-r2-repository.js", "nebula-r2-cleanup.js"];
let source = await readFile(new URL("../deepseek-worker.js", import.meta.url), "utf8");
for (const file of files) source = source.replaceAll('"./' + file + '"', JSON.stringify(new URL("../" + file, import.meta.url).href));
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64url = bytes => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
const keyPair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
}, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
Object.assign(publicJwk, { kid: "sync-api-test-key", alg: "RS256", use: "sig", key_ops: ["verify"] });
const issuer = "https://sync-api-issuer.example";
const audience = "nebula-sync-api";
const azp = "https://sync-preview.example";
const now = Math.floor(Date.now() / 1000);
async function tokenFor(subject) {
  const head = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid: "sync-api-test-key", typ: "JWT" })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: issuer, aud: audience, sub: subject, azp, iat: now, exp: now + 300 })));
  const input = head + "." + claims;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, encoder.encode(input)));
  return input + "." + base64url(signature);
}
const tokenA = await tokenFor("user-a");
const tokenB = await tokenFor("user-b");
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(String(url), issuer + "/.well-known/jwks.json");
  return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "Content-Type": "application/json" } });
};

class MemoryD1 {
  consents = new Map();
  records = new Map();
  objects = new Map();
  cleanup = new Map();
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        const owner = values[0];
        return {
          async first() {
            // The consent-gated object SELECT contains both table names;
            // resolve its outer metadata table before its consent subquery.
            if (sql.includes("FROM nebula_objects")) return db.objects.get([owner, values[1], values[2]].join("|")) || null;
            if (sql.includes("FROM nebula_sync_consents")) return db.consents.get(owner) || null;
            if (sql.includes("FROM nebula_records")) return db.records.get([owner, values[1], values[2]].join("|")) || null;
            return null;
          },
          async all() {
            if (sql.includes("FROM nebula_records")) return { results: [...db.records.values()].filter(row => row.owner_id === owner && row.record_type === values[1]) };
            if (sql.includes("FROM nebula_objects")) return { results: [...db.objects.values()].filter(row => row.owner_id === owner && row.category === values[1]) };
            return { results: [] };
          },
          async run() {
            if (sql.startsWith("INSERT INTO nebula_sync_consents")) {
              db.consents.set(owner, {
                categories_json: values[1], status: values[2], confirmed_at: values[3],
                updated_at: values[4], revoked_at: values[5]
              });
            } else if (sql.startsWith("INSERT INTO nebula_records")) {
              db.records.set([owner, values[1], values[2]].join("|"), {
                owner_id: owner, record_type: values[1], record_id: values[2],
                payload_json: values[3], created_at: values[4], updated_at: values[5]
              });
            } else if (sql.startsWith("INSERT INTO nebula_object_cleanup")) {
              if (sql.includes("SELECT owner_id, object_id")) {
                const row = db.objects.get([values[1], values[2], values[3]].join("|"));
                if (row?.status === "deleting") db.cleanup.set([values[1], values[2], values[3]].join("|"), {
                  owner_id: row.owner_id, object_id: row.object_id, category: row.category,
                  object_key: row.object_key, created_at: values[0], status: "pending", lease_expires_at: null
                });
              } else {
                db.cleanup.set([owner, values[2], values[1]].join("|"), {
                  owner_id: owner, object_id: values[1], category: values[2], object_key: values[3],
                  created_at: values[4], status: "uploading"
                });
              }
            } else if (sql.startsWith("DELETE FROM nebula_object_cleanup")) {
              db.cleanup.delete([owner, values[1], values[2]].join("|"));
            } else if (sql.startsWith("INSERT INTO nebula_objects")) {
              db.objects.set([owner, values[2], values[1]].join("|"), {
                owner_id: owner, object_id: values[1], category: values[2], object_key: values[3],
                content_type: values[4], size_bytes: values[5], status: "active", created_at: values[6]
              });
            } else if (sql.startsWith("DELETE FROM nebula_records")) {
              db.records.delete([owner, values[1], values[2]].join("|"));
            } else if (sql.startsWith("DELETE FROM nebula_objects")) {
              db.objects.delete([owner, values[1], values[2]].join("|"));
            } else if (sql.startsWith("UPDATE nebula_objects")) {
              const row = db.objects.get([owner, values[2], values[3]].join("|"));
              if (row) row.status = "deleting";
            }
            return { meta: { changes: 1 } };
          }
        };
      }
    };
  }
}
class MemoryR2 {
  values = new Map();
  async put(key, body, options) { this.values.set(key, { body: new Uint8Array(body), options }); }
  async get(key) { const value = this.values.get(key); return value ? { body: value.body } : null; }
  async delete(key) { this.values.delete(key); }
}
const db = new MemoryD1();
const bucket = new MemoryR2();
const env = {
  NEBULA_AUTH_MODE: "clerk-jwt",
  NEBULA_JWT_ISSUER: issuer,
  NEBULA_JWT_AUDIENCE: audience,
  NEBULA_JWKS_URL: issuer + "/.well-known/jwks.json",
  NEBULA_AUTHORIZED_PARTIES: JSON.stringify([azp]),
  NEBULA_OWNER_NAMESPACE_SECRET: "sync-api-test-owner-namespace-secret-32-bytes-minimum",
  NEBULA_DB: db,
  NEBULA_BUCKET: bucket,
  NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) }
};
async function call(path, { method = "GET", token = tokenA, body, contentType = "application/json", envOverride = env } = {}) {
  const headers = new Headers({ Authorization: "Bearer " + token });
  if (body !== undefined) headers.set("Content-Type", contentType);
  const request = new Request("https://worker.test" + path, {
    method, headers, ...(body === undefined ? {} : { body })
  });
  return worker.fetch(request, envOverride);
}

try {
  const deniedShared = await call("/sync/consent", {
    token: "shared-secret", envOverride: {
      NEBULA_AUTH_MODE: "shared", NEBULA_SYNC_TOKEN: "shared-secret",
      NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) }, NEBULA_DB: db
    }
  });
  assert.equal(deniedShared.status, 403, "A shared service token must never access per-user cloud data.");

  const emptyConsent = await call("/sync/consent");
  assert.equal(emptyConsent.status, 200);
  assert.equal((await emptyConsent.json()).consent, null);

  const missingConfirmation = await call("/sync/consent", {
    method: "POST", body: JSON.stringify({ status: "enabled", categories: ["graph"] })
  });
  assert.equal(missingConfirmation.status, 400, "Cloud sync activation must require an explicit confirmation flag.");

  const enabled = await call("/sync/consent", {
    method: "POST",
    body: JSON.stringify({ status: "enabled", confirm: true, categories: ["graph", "private-files"] })
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).consent.status, "enabled");

  // Simulate revocation after the request-start snapshot but before the D1
  // repository operation. The live ledger re-check must fail closed.
  let consentReads = 0;
  const revocationRaceDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          if (!sql.includes("FROM nebula_sync_consents")) return bound;
          return {
            ...bound,
            async first() {
              const row = await bound.first();
              consentReads += 1;
              return consentReads === 1 ? row : { ...row, status: "revoked" };
            }
          };
        }
      };
    }
  };
  const revokedDuringRequest = await call("/sync/records?type=graph", {
    envOverride: { ...env, NEBULA_DB: revocationRaceDb }
  });
  assert.equal(revokedDuringRequest.status, 403, "A D1 operation must re-check live consent after the request-start snapshot.");

  const putRecord = await call("/sync/records?type=graph", {
    method: "POST",
    body: JSON.stringify({ recordType: "graph", recordId: "root-1", payload: { title: "Knowledge graph" } })
  });
  assert.equal(putRecord.status, 200);
  const listRecords = await call("/sync/records?type=graph");
  assert.equal(listRecords.status, 200);
  assert.equal((await listRecords.json()).records[0].recordId, "root-1");

  const deniedCategory = await call("/sync/records?type=private-notes");
  assert.equal(deniedCategory.status, 403, "Unconsented record categories must be rejected.");

  const uploaded = await call("/sync/objects?category=private-files", {
    method: "POST", body: "private file body", contentType: "text/plain"
  });
  assert.equal(uploaded.status, 201);
  const object = (await uploaded.json()).object;
  const objectPath = "/sync/objects/" + object.objectId + "?category=private-files";
  const downloaded = await call(objectPath);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), "private file body");

  const largerUploadBody = new Uint8Array(1024 * 1024 + 1);
  largerUploadBody.fill(7);
  const largerUpload = await call("/sync/objects?category=private-files", {
    method: "POST", body: largerUploadBody, contentType: "application/octet-stream"
  });
  assert.equal(largerUpload.status, 201, "Private file uploads above 1 MiB must be accepted up to the documented 10 MiB limit.");
  assert.equal((await largerUpload.json()).object.sizeBytes, largerUploadBody.byteLength);

  const enableB = await call("/sync/consent", {
    token: tokenB, method: "POST",
    body: JSON.stringify({ status: "enabled", confirm: true, categories: ["graph", "private-files"] })
  });
  assert.equal(enableB.status, 200, "A second account must be able to grant its own independent consent.");

  const foreignDownload = await call(objectPath, { token: tokenB });
  assert.equal(foreignDownload.status, 404, "A second authenticated user with matching consent must not download the first user's object.");

  const foreignList = await call("/sync/records?type=graph", { token: tokenB });
  assert.equal(foreignList.status, 200);
  assert.deepEqual((await foreignList.json()).records, [], "A second account with matching consent must see only its own records.");

  const paused = await call("/sync/consent", { method: "POST", body: JSON.stringify({ status: "paused" }) });
  assert.equal(paused.status, 200);
  const blockedAfterPause = await call("/sync/records?type=graph");
  assert.equal(blockedAfterPause.status, 403, "Pausing consent must stop subsequent cloud data access.");

  const revoked = await call("/sync/consent", { method: "POST", body: JSON.stringify({ status: "revoked" }) });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).consent.status, "revoked");
  const removeAfterRevocation = await call(objectPath, { method: "DELETE" });
  assert.equal(removeAfterRevocation.status, 200, "Owners must retain the ability to delete their own cloud copies after revocation.");
  assert.equal(bucket.values.has("owners/" + [...db.consents.keys()][0] + "/private-files/" + object.objectId), false);
  console.log("NEBULA authenticated private sync API integration tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
